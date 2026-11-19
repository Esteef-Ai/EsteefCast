package ai.esteef.esteefcast

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Home screen: lists PCs found on the network plus any added by address. */
class MainActivity : Activity() {
    private val hosts = LinkedHashMap<String, Host>()
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var discovery: Discovery
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build()
    private var focusedKey: String? = null

    private val tick = object : Runnable {
        override fun run() {
            probeManual()
            // Forget PCs that stopped answering discovery.
            val now = System.currentTimeMillis()
            val stale = hosts.values.filter { !it.manual && now - it.lastSeen > 7000 }.map { it.key }
            if (stale.isNotEmpty()) { stale.forEach { hosts.remove(it) }; render() }
            main.postDelayed(this, 3000)
        }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(56), dp(40), dp(56), dp(32))
        }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(ImageView(this).apply { setImageResource(R.drawable.ic_launcher) }, LinearLayout.LayoutParams(dp(56), dp(56)))
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18), 0, 0, 0) }
        titles.addView(TextView(this).apply {
            text = "EsteefCast"; setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f); setTextColor(getColor(R.color.text)); typeface = Typeface.DEFAULT_BOLD
        })
        titles.addView(TextView(this).apply {
            text = "by Esteef.Ai"; setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); setTextColor(getColor(R.color.muted)); letterSpacing = 0.08f
        })
        header.addView(titles)
        root.addView(header)

        root.addView(TextView(this).apply {
            text = "Choose a PC to watch"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f); setTextColor(getColor(R.color.text))
            setPadding(0, dp(28), 0, dp(4))
        })
        status = TextView(this).apply {
            text = "Looking for PCs on your network…"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f); setTextColor(getColor(R.color.muted))
            setPadding(0, 0, 0, dp(16))
        }
        root.addView(status)

        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(list) }
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        val addBtn = item("Enter address", "Use this if your PC doesn't show up. EsteefCast on the PC shows its address.").apply {
            id = View.generateViewId()
            setOnClickListener { askAddress() }
        }
        root.addView(addBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        setContentView(root)

        ManualHosts.load(this).forEach { (ip, port) ->
            hosts["$ip:$port"] = Host(ip, port, ip, sharing = false, title = "", manual = true, reachable = false)
        }
        discovery = Discovery(this) { h -> onDiscovered(h) }
        render()
    }

    override fun onResume() {
        super.onResume()
        discovery.start()
        main.post(tick)
    }

    override fun onPause() {
        super.onPause()
        discovery.stop()
        main.removeCallbacks(tick)
    }

    private fun onDiscovered(h: Host) {
        val old = hosts[h.key]
        hosts[h.key] = h.copy(manual = old?.manual ?: false)
        if (old == null || old.name != h.name || old.sharing != h.sharing || old.title != h.title || !old.reachable) render()
        else hosts[h.key] = hosts[h.key]!!.copy(lastSeen = h.lastSeen)
    }

    private fun probeManual() {
        for (h in hosts.values.filter { it.manual }) {
            val req = Request.Builder().url("http://${h.ip}:${h.port}/info").build()
            http.newCall(req).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    main.post { hosts[h.key]?.let { if (it.reachable) { hosts[h.key] = it.copy(reachable = false); render() } } }
                }
                override fun onResponse(call: Call, response: Response) {
                    val body = response.use { it.body?.string() } ?: return
                    val o = try { JSONObject(body) } catch (_: Exception) { return }
                    main.post {
                        val cur = hosts[h.key] ?: return@post
                        val next = cur.copy(name = o.optString("name", cur.name), sharing = o.optBoolean("sharing"), title = o.optString("title"), reachable = true, lastSeen = System.currentTimeMillis())
                        if (next.copy(lastSeen = 0) != cur.copy(lastSeen = 0)) { hosts[h.key] = next; render() } else hosts[h.key] = next
                    }
                }
            })
        }
    }

    private fun item(title: String, sub: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        isFocusable = true
        isClickable = true
        setBackgroundResource(R.drawable.item_bg)
        setPadding(dp(24), dp(16), dp(24), dp(16))
        addView(TextView(context).apply {
            text = title; setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f); setTextColor(getColor(R.color.text)); typeface = Typeface.DEFAULT_BOLD
        })
        addView(TextView(context).apply {
            text = sub; setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setTextColor(getColor(R.color.muted))
        })
    }

    private fun render() {
        focusedKey = (currentFocus?.tag as? String) ?: focusedKey
        list.removeAllViews()
        val sorted = hosts.values.sortedWith(compareByDescending<Host> { it.sharing }.thenBy { it.name.lowercase() })
        val found = sorted.count { !it.manual || it.reachable }
        status.text = when {
            found == 0 -> "Looking for PCs on your network… Open EsteefCast on your PC."
            found == 1 -> "1 PC found"
            else -> "$found PCs found"
        }
        var toFocus: View? = null
        for (h in sorted) {
            val sub = when {
                h.manual && !h.reachable -> "${h.ip} · not answering right now (hold OK to remove)"
                h.sharing -> "Sharing now${if (h.title.isNotBlank()) ": ${h.title}" else ""}"
                else -> "Online · not sharing yet"
            }
            val v = item(h.name, sub).apply {
                tag = h.key
                setOnClickListener { open(h) }
                if (h.manual) setOnLongClickListener { confirmRemove(h); true }
            }
            list.addView(v, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
            if (h.key == focusedKey) toFocus = v
        }
        (toFocus ?: list.getChildAt(0))?.requestFocus()
    }

    private fun open(h: Host) {
        startActivity(Intent(this, PlayerActivity::class.java)
            .putExtra("ip", h.ip).putExtra("port", h.port).putExtra("name", h.name))
    }

    private fun confirmRemove(h: Host) {
        AlertDialog.Builder(this)
            .setTitle("Remove ${h.name}?")
            .setMessage("${h.ip}:${h.port} will no longer be listed.")
            .setPositiveButton("Remove") { _, _ -> ManualHosts.remove(this, h.ip, h.port); hosts.remove(h.key); render() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun askAddress() {
        val input = EditText(this).apply {
            hint = "e.g. 192.168.1.20"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_DONE
            setSingleLine()
            setTextColor(getColor(R.color.text))
            setHintTextColor(getColor(R.color.muted))
        }
        val box = LinearLayout(this).apply { setPadding(dp(24), dp(8), dp(24), 0); addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)) }
        val dlg = AlertDialog.Builder(this)
            .setTitle("PC address")
            .setMessage("Type the address shown in EsteefCast on your PC.")
            .setView(box)
            .setPositiveButton("Connect", null)
            .setNegativeButton("Cancel", null)
            .create()
        val submit = {
            val parsed = ManualHosts.parse(input.text.toString())
            if (parsed == null) input.error = "That doesn't look like an address"
            else {
                ManualHosts.add(this, parsed.first, parsed.second)
                val key = "${parsed.first}:${parsed.second}"
                if (hosts[key] == null) hosts[key] = Host(parsed.first, parsed.second, parsed.first, false, "", manual = true, reachable = false)
                else hosts[key] = hosts[key]!!.copy(manual = true)
                focusedKey = key
                render(); probeManual(); dlg.dismiss()
                open(hosts[key]!!)
            }
        }
        input.setOnEditorActionListener { _, action, ev ->
            if (action == EditorInfo.IME_ACTION_DONE || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { submit(); true } else false
        }
        dlg.setOnShowListener { dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { submit() } }
        dlg.show()
        input.requestFocus()
    }
}
