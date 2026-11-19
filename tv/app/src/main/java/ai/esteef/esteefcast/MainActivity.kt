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
import android.widget.Toast
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
            probeRemote()
            // Forget PCs that stopped answering discovery.
            val now = System.currentTimeMillis()
            val stale = hosts.values.filter { !it.manual && !it.remote && now - it.lastSeen > 7000 }.map { it.key }
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

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val addBtn = item("Enter address", "If your PC doesn't show up. The PC app shows its address.").apply {
            setOnClickListener { askAddress() }
        }
        val friendBtn = item("Add a friend's PC", "Type the invite code your friend made in EsteefCast.").apply {
            setOnClickListener { askCode() }
        }
        actions.addView(addBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(6) })
        actions.addView(friendBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(6) })
        root.addView(actions, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        setContentView(root)

        ManualHosts.load(this).forEach { (ip, port) ->
            hosts["$ip:$port"] = Host(ip, port, ip, sharing = false, title = "", manual = true, reachable = false)
        }
        RemoteHosts.load(this).forEach { r ->
            val h = Host("", 0, r.name, sharing = false, title = "", reachable = false, remoteId = r.hostId, token = r.token)
            hosts[h.key] = h
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

    private fun probeRemote() {
        val remote = hosts.values.filter { it.remote }
        if (remote.isEmpty() || !Service.configured(this)) return
        val ids = org.json.JSONArray().apply { remote.forEach { put(it.remoteId) } }
        Service.ask(this, org.json.JSONObject().put("type", "status").put("hostIds", ids), { it.optString("type") == "status" }) { r ->
            val map = r?.optJSONObject("hosts")
            var changed = false
            for (h in hosts.values.filter { it.remote }) {
                val o = map?.optJSONObject(h.remoteId!!)
                val next = if (o == null) h.copy(reachable = false)
                    else h.copy(reachable = o.optBoolean("online"), name = o.optString("name", h.name).ifBlank { h.name }, sharing = o.optBoolean("sharing"), title = o.optString("title"))
                if (next.copy(lastSeen = 0) != h.copy(lastSeen = 0)) { hosts[h.key] = next; changed = true }
            }
            if (changed) render()
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
        val found = sorted.count { (!it.manual && !it.remote) || it.reachable }
        status.text = when {
            found == 0 -> "Looking for PCs on your network… Open EsteefCast on your PC."
            found == 1 -> "1 PC found"
            else -> "$found PCs found"
        }
        var toFocus: View? = null
        for (h in sorted) {
            val sub = when {
                h.remote && !h.reachable -> "Friend's PC · off right now (hold OK to remove)"
                h.remote && h.sharing -> "Friend's PC · sharing now${if (h.title.isNotBlank()) ": ${h.title}" else ""}"
                h.remote -> "Friend's PC · online, not sharing yet"
                h.manual && !h.reachable -> "${h.ip} · not answering right now (hold OK to remove)"
                h.sharing -> "Sharing now${if (h.title.isNotBlank()) ": ${h.title}" else ""}"
                else -> "Online · not sharing yet"
            }
            val v = item(h.name, sub).apply {
                tag = h.key
                setOnClickListener { open(h) }
                if (h.manual || h.remote) setOnLongClickListener { confirmRemove(h); true }
            }
            list.addView(v, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
            if (h.key == focusedKey) toFocus = v
        }
        (toFocus ?: list.getChildAt(0))?.requestFocus()
    }

    private fun open(h: Host) {
        val i = Intent(this, PlayerActivity::class.java).putExtra("name", h.name)
        if (h.remote) i.putExtra("remoteId", h.remoteId).putExtra("token", h.token)
        else i.putExtra("ip", h.ip).putExtra("port", h.port)
        startActivity(i)
    }

    private fun confirmRemove(h: Host) {
        AlertDialog.Builder(this)
            .setTitle("Remove ${h.name}?")
            .setMessage(if (h.remote) "You'll need a new invite code to watch it again." else "${h.ip}:${h.port} will no longer be listed.")
            .setPositiveButton("Remove") { _, _ ->
                if (h.remote) RemoteHosts.remove(this, h.remoteId!!) else ManualHosts.remove(this, h.ip, h.port)
                hosts.remove(h.key); render()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun askCode() {
        if (!Service.configured(this)) {
            AlertDialog.Builder(this).setTitle("Not available")
                .setMessage("This copy of EsteefCast isn't set up for watching from another home.")
                .setPositiveButton("OK", null).show()
            return
        }
        val input = EditText(this).apply {
            hint = "e.g. BEAR-4821"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_DONE
            setSingleLine()
            setTextColor(getColor(R.color.text))
            setHintTextColor(getColor(R.color.muted))
        }
        val box = LinearLayout(this).apply { setPadding(dp(24), dp(8), dp(24), 0); addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)) }
        val dlg = AlertDialog.Builder(this)
            .setTitle("Add a friend's PC")
            .setMessage("Your friend makes a code in EsteefCast on their PC (Friends outside your home → Create invite code). Type it here.")
            .setView(box)
            .setPositiveButton("Add", null)
            .setNegativeButton("Cancel", null)
            .create()
        var busy = false
        val submit = submit@{
            if (busy) return@submit
            val code = input.text.toString().trim()
            if (code.length < 6) { input.error = "Type the whole code, like BEAR-4821"; return@submit }
            busy = true
            dlg.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
            val msg = org.json.JSONObject().put("type", "redeem").put("code", code)
                .put("deviceId", Identity.deviceId(this)).put("name", Identity.deviceName(this))
            Service.ask(this, msg, { it.optString("type") == "paired" || it.optString("type") == "error" }) { r ->
                busy = false
                dlg.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
                if (r?.optString("type") == "paired") {
                    val rh = RemoteHost(r.optString("hostId"), r.optString("hostName", "Friend's PC"), r.optString("token"))
                    RemoteHosts.save(this, rh)
                    val h = Host("", 0, rh.name, sharing = false, title = "", reachable = true, remoteId = rh.hostId, token = rh.token)
                    hosts[h.key] = h
                    focusedKey = h.key
                    dlg.dismiss()
                    Toast.makeText(this, "Added ${rh.name}", Toast.LENGTH_LONG).show()
                    render(); probeRemote()
                } else {
                    input.error = Service.reason(r?.optString("reason"))
                }
            }
        }
        input.setOnEditorActionListener { _, action, ev ->
            if (action == EditorInfo.IME_ACTION_DONE || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { submit(); true } else false
        }
        dlg.setOnShowListener { dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { submit() } }
        dlg.show()
        input.requestFocus()
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
