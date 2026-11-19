package ai.esteef.esteefcast

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.UUID

const val DISCOVERY_PORT = 47800
const val DEFAULT_PORT = 47801

/** A PC running EsteefCast. */
data class Host(
    val ip: String,
    val port: Int,
    val name: String,
    val sharing: Boolean,
    val title: String,
    val manual: Boolean = false,
    val reachable: Boolean = true,
    val lastSeen: Long = System.currentTimeMillis(),
) {
    val key get() = "$ip:$port"
}

object Identity {
    fun deviceId(ctx: Context): String {
        val p = ctx.getSharedPreferences("ecast", Context.MODE_PRIVATE)
        return p.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            p.edit().putString("deviceId", it).apply()
        }
    }

    fun deviceName(ctx: Context): String {
        val n = try { Settings.Global.getString(ctx.contentResolver, "device_name") } catch (_: Exception) { null }
        return n?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    }
}

/** PCs the viewer typed in by address; remembered between launches. */
object ManualHosts {
    fun load(ctx: Context): List<Pair<String, Int>> {
        val raw = ctx.getSharedPreferences("ecast", Context.MODE_PRIVATE).getString("manual", "[]")
        val arr = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            o.optString("ip").takeIf { it.isNotBlank() }?.let { it to o.optInt("port", DEFAULT_PORT) }
        }
    }

    fun add(ctx: Context, ip: String, port: Int) {
        val list = load(ctx).filterNot { it.first == ip && it.second == port } + (ip to port)
        save(ctx, list)
    }

    fun remove(ctx: Context, ip: String, port: Int) = save(ctx, load(ctx).filterNot { it.first == ip && it.second == port })

    private fun save(ctx: Context, list: List<Pair<String, Int>>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("ip", it.first).put("port", it.second)) }
        ctx.getSharedPreferences("ecast", Context.MODE_PRIVATE).edit().putString("manual", arr.toString()).apply()
    }

    /** Accepts "192.168.0.5", "192.168.0.5:47801" or a host name. */
    fun parse(text: String): Pair<String, Int>? {
        val t = text.trim().removePrefix("http://").removePrefix("ws://").trimEnd('/')
        if (t.isEmpty() || t.contains(' ')) return null
        val idx = t.lastIndexOf(':')
        return if (idx > 0) {
            val port = t.substring(idx + 1).toIntOrNull() ?: return null
            if (port !in 1..65535) null else t.substring(0, idx) to port
        } else t to DEFAULT_PORT
    }
}

/** Finds PCs by broadcasting on the local network every two seconds. */
class Discovery(private val ctx: Context, private val onHost: (Host) -> Unit) {
    @Volatile private var running = false
    private var thread: Thread? = null
    private val main = Handler(Looper.getMainLooper())

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "ecast-discovery").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
    }

    private fun broadcastAddresses(): Set<InetAddress> {
        val out = mutableSetOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) ia.broadcast?.let { out.add(it) }
            }
        } catch (_: Exception) {}
        return out
    }

    private fun loop() {
        val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("ecast")?.apply { setReferenceCounted(false) }
        try { lock?.acquire() } catch (_: Exception) {}
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket().apply { broadcast = true; soTimeout = 400 }
            val ask = "ESTEEFCAST_DISCOVER".toByteArray()
            val buf = ByteArray(4096)
            var nextSend = 0L
            while (running) {
                val now = System.currentTimeMillis()
                if (now >= nextSend) {
                    for (addr in broadcastAddresses()) {
                        try { socket.send(DatagramPacket(ask, ask.size, addr, DISCOVERY_PORT)) } catch (_: Exception) {}
                    }
                    nextSend = now + 2000
                }
                try {
                    val pkt = DatagramPacket(buf, buf.size)
                    socket.receive(pkt)
                    val o = JSONObject(String(pkt.data, 0, pkt.length, Charsets.UTF_8))
                    if (o.optString("app") != "EsteefCast") continue
                    val host = Host(
                        ip = pkt.address.hostAddress ?: continue,
                        port = o.optInt("port", DEFAULT_PORT),
                        name = o.optString("name", "PC"),
                        sharing = o.optBoolean("sharing"),
                        title = o.optString("title"),
                    )
                    main.post { onHost(host) }
                } catch (_: SocketTimeoutException) {
                } catch (_: Exception) {
                    if (!running) break
                }
            }
        } catch (_: Exception) {
        } finally {
            socket?.close()
            try { lock?.release() } catch (_: Exception) {}
        }
    }
}
