package ai.esteef.esteefcast

import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** A friend's PC, paired with an invite code and reached through the EsteefCast service. */
data class RemoteHost(val hostId: String, val name: String, val token: String)

/** The EsteefCast service: pairing, presence and the connection-setup relay. */
object Service {
    private var client: OkHttpClient? = null
    private val main = Handler(Looper.getMainLooper())

    fun url(ctx: Context): String {
        val custom = ctx.getSharedPreferences("ecast", Context.MODE_PRIVATE).getString("serviceUrl", null)
        return (custom?.takeIf { it.isNotBlank() } ?: ctx.getString(R.string.service_url)).trimEnd('/')
    }

    fun configured(ctx: Context) = url(ctx).startsWith("wss://") && !url(ctx).contains("YOUR-", ignoreCase = true)

    /** OkHttp client that trusts only the service's own certificate (pinned, shipped in the app). */
    @Synchronized
    fun http(ctx: Context): OkHttpClient {
        client?.let { return it }
        val cert = ctx.resources.openRawResource(R.raw.service_cert).use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("service", cert) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, tm)
            // The service is reached by IP or a home DDNS name, so match the pinned certificate itself.
            .hostnameVerifier { _, session ->
                (session.peerCertificates.firstOrNull() as? X509Certificate)?.encoded?.contentEquals(cert.encoded) == true
            }
            .connectTimeout(6, TimeUnit.SECONDS)
            .pingInterval(10, TimeUnit.SECONDS)
            .build()
            .also { client = it }
    }

    fun viewerRequest(ctx: Context): Request = Request.Builder().url(url(ctx) + "/viewer").build()

    /** Sends one message and waits for the first reply that [done] accepts. Reply arrives on the main thread. */
    fun ask(ctx: Context, msg: JSONObject, done: (JSONObject) -> Boolean, result: (JSONObject?) -> Unit) {
        var finished = false
        val finish = { r: JSONObject? -> main.post { if (!finished) { finished = true; result(r) } } }
        val ws = http(ctx).newWebSocket(viewerRequest(ctx), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(msg.toString()) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (_: Exception) { return }
                if (done(m)) { finish(m); webSocket.close(1000, null) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { finish(null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finish(null) }
        })
        main.postDelayed({ if (!finished) { ws.cancel(); finish(null) } }, 10000)
    }

    /** Friendly text for the service's error reasons. */
    fun reason(code: String?, hostName: String = "the PC"): String = when (code) {
        "bad-code" -> "That code isn't right, or it has expired. Codes work once, within 24 hours."
        "host-offline" -> "The PC that made this code is off, or EsteefCast isn't running on it."
        "offline" -> "$hostName is off, or EsteefCast isn't running on it."
        "unauthorized" -> "$hostName no longer allows this TV. Ask for a new invite code."
        "slow-down" -> "Too many tries. Wait a minute and try again."
        "timeout" -> "$hostName didn't answer. Try again."
        null -> "Can't reach the EsteefCast service. Check this TV's internet connection."
        else -> "Something went wrong ($code)."
    }
}

/** Friends' PCs this TV has paired with. */
object RemoteHosts {
    fun load(ctx: Context): List<RemoteHost> {
        val raw = ctx.getSharedPreferences("ecast", Context.MODE_PRIVATE).getString("remote", "[]")
        val arr = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("hostId"); val token = o.optString("token")
            if (id.isBlank() || token.isBlank()) null else RemoteHost(id, o.optString("name", "Friend's PC"), token)
        }
    }

    fun save(ctx: Context, h: RemoteHost) = write(ctx, load(ctx).filterNot { it.hostId == h.hostId } + h)

    fun remove(ctx: Context, hostId: String) = write(ctx, load(ctx).filterNot { it.hostId == hostId })

    private fun write(ctx: Context, list: List<RemoteHost>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("hostId", it.hostId).put("name", it.name).put("token", it.token)) }
        ctx.getSharedPreferences("ecast", Context.MODE_PRIVATE).edit().putString("remote", arr.toString()).apply()
    }
}
