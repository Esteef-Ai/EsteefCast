package ai.esteef.esteefcast

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioAttributes
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
import org.webrtc.RendererCommon
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.TimeUnit

/** Full-screen player. Talks the host's protocol over a WebSocket and receives WebRTC. */
class PlayerActivity : Activity() {
    companion object { private const val TAG = "EsteefCast" }

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).pingInterval(5, TimeUnit.SECONDS).build()

    private var ip = ""
    private var port = DEFAULT_PORT
    private var remoteId: String? = null
    private var token: String? = null
    private var stun: List<String> = emptyList()
    private var opened = false
    private var hostName = "your PC"

    private lateinit var renderer: SurfaceViewRenderer
    private lateinit var overlay: LinearLayout
    private lateinit var message: TextView
    private lateinit var statsView: TextView

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var adm: JavaAudioDeviceModule? = null
    private var pc: PeerConnection? = null
    private var ws: WebSocket? = null
    private var videoTrack: VideoTrack? = null
    private var closed = false
    private var remoteSet = false
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private var lastBytes = 0L
    private var lastTs = 0.0

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)

        remoteId = intent.getStringExtra("remoteId")
        token = intent.getStringExtra("token")
        ip = intent.getStringExtra("ip") ?: ""
        if (remoteId == null && ip.isEmpty()) { finish(); return }
        port = intent.getIntExtra("port", DEFAULT_PORT)
        hostName = intent.getStringExtra("name") ?: hostName

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        renderer = SurfaceViewRenderer(this)
        root.addView(renderer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))

        overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(getColor(R.color.bg))
        }
        overlay.addView(ImageView(this).apply { setImageResource(R.drawable.ic_launcher) }, LinearLayout.LayoutParams(dp(88), dp(88)))
        message = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f); setTextColor(getColor(R.color.text)); gravity = Gravity.CENTER
            setPadding(dp(48), dp(24), dp(48), 0)
        }
        overlay.addView(message)
        overlay.addView(TextView(this).apply {
            text = "Press Back to choose another PC"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setTextColor(getColor(R.color.muted)); setPadding(0, dp(18), 0, 0)
        })
        root.addView(overlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        statsView = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setTextColor(getColor(R.color.text)); typeface = Typeface.MONOSPACE
            setBackgroundColor(0xD00E0F11.toInt()); setPadding(dp(14), dp(10), dp(14), dp(10)); visibility = View.GONE
        }
        root.addView(statsView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply { setMargins(dp(24), dp(24), 0, 0) })
        setContentView(root)

        initWebRtc()
        show("Connecting to $hostName…")
        connect()
        main.postDelayed(statsTick, 1000)
    }

    // ---------- WebRTC setup ----------
    private fun initWebRtc() {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions())
        val egl = EglBase.create()
        eglBase = egl
        // Media playback, not a phone call: full-range stereo through the TV speakers.
        adm = JavaAudioDeviceModule.builder(applicationContext)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
            .setUseStereoOutput(true)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .createAudioDeviceModule()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoDecoderFactory(TvDecoderFactory(egl.eglBaseContext))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, false, false))
            .createPeerConnectionFactory()
        renderer.init(egl.eglBaseContext, null)
        renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        renderer.setEnableHardwareScaler(false)
    }

    // ---------- signaling ----------
    private fun hello(): String = JSONObject().put("type", "hello").put("kind", "tv")
        .put("deviceId", Identity.deviceId(this))
        .put("name", Identity.deviceName(this)).toString()

    private fun connect() {
        if (closed) return
        val remote = remoteId != null
        // At home: straight to the PC. Away: through the EsteefCast service, which passes messages both ways.
        val req = if (remote) Service.viewerRequest(this) else Request.Builder().url("ws://$ip:$port/ws").build()
        val client = if (remote) Service.http(this) else http
        opened = false
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (remote) {
                    webSocket.send(JSONObject().put("type", "open").put("hostId", remoteId).put("token", token)
                        .put("deviceId", Identity.deviceId(this@PlayerActivity))
                        .put("name", Identity.deviceName(this@PlayerActivity)).toString())
                } else webSocket.send(hello())
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (_: Exception) { return }
                main.post {
                    if (webSocket !== ws) return@post
                    when (msg.optString("type")) {
                        "opened" -> {
                            opened = true
                            val arr = msg.optJSONArray("stun")
                            stun = (0 until (arr?.length() ?: 0)).map { arr!!.getString(it) }
                            show("Contacting $hostName…")
                            webSocket.send(hello())
                        }
                        "relay-error" -> {
                            val reason = msg.optString("reason")
                            show(Service.reason(reason, hostName) + if (reason == "offline") "\nTrying again…" else "")
                            if (reason == "unauthorized") closed = true
                        }
                        else -> onSignal(msg)
                    }
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(webSocket)
        })
    }

    private fun lost(socket: WebSocket) {
        main.post {
            if (socket !== ws || closed) return@post
            ws = null
            closePeer()
            if (remoteId != null && !opened && overlay.visibility == View.VISIBLE && message.text.contains("Trying again")) {
                // keep the reason the service gave
            } else if (remoteId != null) show("Can't reach the EsteefCast service.\nCheck this TV's internet connection. Trying again…")
            else show("Can't reach $hostName.\nMake sure EsteefCast is running on the PC. Trying again…")
            main.postDelayed({ connect() }, if (remoteId != null) 5000 else 2500)
        }
    }

    private fun send(o: JSONObject) { ws?.send(o.toString()) }

    private fun onSignal(msg: JSONObject) {
        when (msg.optString("type")) {
            "pending" -> {
                hostName = msg.optString("hostName", hostName)
                show("Waiting for someone at $hostName to allow this TV…\n(A prompt is showing on the PC.)")
            }
            "denied" -> { show("$hostName didn't allow this TV."); closed = true }
            "full" -> {
                hostName = msg.optString("hostName", hostName)
                show("$hostName already has ${msg.optInt("max")} TVs watching.\nTry again when one of them stops.")
                closed = true
            }
            "welcome", "state" -> {
                hostName = msg.optString("hostName", hostName)
                if (!msg.optBoolean("sharing")) { closePeer(); show("$hostName isn't sharing right now.\nIt will appear here as soon as it starts.") }
                else if (pc == null) show("Starting the picture…")
            }
            "offer" -> onOffer(msg.optString("sdp"))
            "candidate" -> {
                val c = IceCandidate(msg.optString("sdpMid"), msg.optInt("sdpMLineIndex"), msg.optString("candidate"))
                Log.i(TAG, "remote candidate " + c.sdp.take(90))
                if (remoteSet) pc?.addIceCandidate(c) else pendingCandidates.add(c)
            }
            "stopped" -> { closePeer(); show("$hostName stopped sharing.\nIt will appear here when it starts again.") }
        }
    }

    // ---------- peer connection ----------
    private fun onOffer(sdp: String) {
        closePeer()
        val f = factory ?: return
        // Away: STUN lets both sides find their public address so the video can go direct.
        val ice = if (remoteId != null && stun.isNotEmpty()) listOf(PeerConnection.IceServer.builder(stun).createIceServer()) else emptyList()
        val config = PeerConnection.RTCConfiguration(ice).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val peer = f.createPeerConnection(config, observer) ?: run { show("Couldn't start the video player."); return }
        pc = peer
        remoteSet = false
        peer.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() {
                main.post {
                    if (pc !== peer) return@post
                    remoteSet = true
                    pendingCandidates.forEach { peer.addIceCandidate(it) }
                    pendingCandidates.clear()
                    peer.createAnswer(object : SdpAdapter() {
                        override fun onCreateSuccess(desc: SessionDescription) {
                            val tuned = SessionDescription(desc.type, stereoOpus(desc.description))
                            peer.setLocalDescription(object : SdpAdapter() {
                                override fun onSetSuccess() {
                                    main.post { send(JSONObject().put("type", "answer").put("sdp", tuned.description)) }
                                }
                            }, tuned)
                        }
                    }, MediaConstraints())
                }
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    /** Ask for stereo Opus at full quality in our answer. */
    private fun stereoOpus(sdp: String): String {
        val opus = Regex("a=rtpmap:(\\d+) opus/48000", RegexOption.IGNORE_CASE).find(sdp)?.groupValues?.get(1) ?: return sdp
        return sdp.split("\r\n").joinToString("\r\n") { line ->
            if (line.startsWith("a=fmtp:$opus ")) {
                val parts = line.substringAfter(' ').split(';').filterNot { it.startsWith("stereo=") || it.startsWith("sprop-stereo=") || it.startsWith("maxaveragebitrate=") }
                "a=fmtp:$opus " + (parts + listOf("stereo=1", "sprop-stereo=1", "maxaveragebitrate=510000")).joinToString(";")
            } else line
        }
    }

    private val observer = object : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            Log.i(TAG, "local candidate " + c.sdp.take(90))
            main.post { send(JSONObject().put("type", "candidate").put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)) }
        }
        override fun onTrack(transceiver: RtpTransceiver) {
            val track = transceiver.receiver.track()
            if (track is VideoTrack) main.post {
                videoTrack?.removeSink(renderer)
                videoTrack = track
                track.addSink(renderer)
            }
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            main.post {
                Log.i(TAG, "connection $state")
                when (state) {
                    PeerConnection.PeerConnectionState.CONNECTED -> overlay.visibility = View.GONE
                    PeerConnection.PeerConnectionState.FAILED -> {
                        show(if (remoteId != null) "Can't get a direct connection to $hostName's network.\nSome internet providers block this. Trying again…" else "The picture dropped. Reconnecting…")
                        main.postDelayed({ send(JSONObject().put("type", "request")) }, 1500)
                    }
                    else -> {}
                }
            }
        }
        override fun onSignalingChange(s: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(b: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
        override fun onAddStream(s: MediaStream) {}
        override fun onRemoveStream(s: MediaStream) {}
        override fun onDataChannel(d: DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
    }

    private fun closePeer() {
        videoTrack?.removeSink(renderer)
        videoTrack = null
        pc?.dispose()
        pc = null
        remoteSet = false
        pendingCandidates.clear()
        lastBytes = 0; lastTs = 0.0
        renderer.clearImage()
    }

    // ---------- UI ----------
    private fun show(text: String) {
        message.text = text
        overlay.visibility = View.VISIBLE
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_INFO || keyCode == KeyEvent.KEYCODE_MENU) {
            statsView.visibility = if (statsView.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private val statsTick = object : Runnable {
        override fun run() {
            val peer = pc
            if (peer != null) peer.getStats { report -> main.post { showStats(report) } }
            main.postDelayed(this, 1000)
        }
    }

    /** The network route ICE picked, e.g. "192.168.0.48 -> 192.168.0.174 host". */
    private fun route(report: RTCStatsReport): String {
        val all = report.statsMap
        for (s in all.values) {
            if (s.type != "transport") continue
            val pair = all[s.members["selectedCandidatePairId"] as? String ?: continue] ?: continue
            val l = all[pair.members["localCandidateId"] as? String ?: continue]?.members ?: continue
            val r = all[pair.members["remoteCandidateId"] as? String ?: continue]?.members ?: continue
            val rtt = (pair.members["currentRoundTripTime"] as? Number)?.toDouble()?.let { " %.0f ms".format(it * 1000) } ?: ""
            return "${l["address"]} -> ${r["address"]}:${r["port"]} ${r["candidateType"]}$rtt"
        }
        return "no route yet"
    }

    private fun showStats(report: RTCStatsReport) {
        var line = ""
        for (s in report.statsMap.values) {
            if (s.type != "inbound-rtp" || s.members["kind"] != "video") continue
            val m = s.members
            val bytes = (m["bytesReceived"] as? Number)?.toLong() ?: 0L
            val ts = s.timestampUs / 1000.0
            val mbps = if (lastTs > 0 && ts > lastTs) (bytes - lastBytes) * 8 / ((ts - lastTs) / 1000.0) / 1e6 else 0.0
            lastBytes = bytes; lastTs = ts
            val emitted = (m["jitterBufferEmittedCount"] as? Number)?.toDouble() ?: 0.0
            val buffer = if (emitted > 0) ((m["jitterBufferDelay"] as? Number)?.toDouble() ?: 0.0) / emitted * 1000 else 0.0
            val codecId = m["codecId"] as? String
            val codec = codecId?.let { report.statsMap[it]?.members?.get("mimeType") as? String } ?: ""
            // Where frames go missing: lost packets (network) vs slow decode (TV chip).
            val num = { k: String -> (m[k] as? Number)?.toDouble() ?: 0.0 }
            val decoded = num("framesDecoded")
            val decodeMs = if (decoded > 0) num("totalDecodeTime") / decoded * 1000 else 0.0
            val net = String.format(
                "lost %.0f  nack %.0f  pli %.0f  freezes %.0f  recv %.0f  dec %.0f  decode %.1f ms",
                num("packetsLost"), num("nackCount"), num("pliCount"), num("freezeCount"), num("framesReceived"), decoded, decodeMs,
            )
            line = String.format(
                "%s×%s  %s fps  %.1f Mbps\n%s  %s\nbuffer %.0f ms  dropped %s\n%s\n%s\n%s",
                m["frameWidth"] ?: "?", m["frameHeight"] ?: "?", (m["framesPerSecond"] as? Number)?.toInt() ?: 0, mbps,
                codec.removePrefix("video/"), m["decoderImplementation"] ?: "", buffer, m["framesDropped"] ?: 0, net,
                if (remoteId != null) "$hostName (away)" else "$hostName ($ip)", route(report),
            )
        }
        if (line.isNotEmpty()) {
            statsView.text = line
            Log.i(TAG, "stats " + line.replace("\n", " | "))
        }
    }

    override fun onDestroy() {
        closed = true
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, "bye")
        ws = null
        closePeer()
        renderer.release()
        factory?.dispose()
        adm?.release()
        eglBase?.release()
        super.onDestroy()
    }

    /** SdpObserver with no-op defaults. */
    private open class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.w(TAG, "sdp create failed: $error") }
        override fun onSetFailure(error: String?) { Log.w(TAG, "sdp set failed: $error") }
    }
}
