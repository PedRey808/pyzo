package ru.musichub.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val reqYandexLogin = 42

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0F0F14"))
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: ""
                if (host == "127.0.0.1") return false
                // вход в Spotify открываем прямо в приложении, после него Spotify вернёт на 127.0.0.1
                if (host == "spotify.com" || host.endsWith(".spotify.com")) return false
                // остальные внешние ссылки (инструкции и т.п.) — в обычный браузер
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "MusicHubAndroid")
        web.loadDataWithBaseURL(null, page("♪ MusicHub", "Запускаю…"), "text/html", "utf-8", null)

        askPermissions()
        startPlaybackService()

        Thread {
            PyServer.ensureStarted(applicationContext)
            val ok = PyServer.waitReady()
            runOnUiThread {
                if (ok) web.loadUrl(PyServer.URL_BASE + "/")
                else web.loadDataWithBaseURL(
                    null,
                    page("Не удалось запустить", PyServer.startError ?: "Сервер не ответил. Перезапустите приложение."),
                    "text/html", "utf-8", null
                )
            }
        }.start()
    }

    private fun page(title: String, text: String): String {
        val esc = text.replace("&", "&amp;").replace("<", "&lt;")
        return """<html><body style="background:#0f0f14;color:#ececf1;font-family:sans-serif;display:flex;
            |align-items:center;justify-content:center;height:90vh;flex-direction:column;text-align:center;padding:16px">
            |<h2>$title</h2><p style="color:#9a9aab">$esc</p></body></html>""".trimMargin()
    }

    private fun askPermissions() {
        val need = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) need += Manifest.permission.POST_NOTIFICATIONS
        if (Build.VERSION.SDK_INT <= 28 &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) need += Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (need.isNotEmpty()) requestPermissions(need.toTypedArray(), 1)
    }

    private fun startPlaybackService() {
        val i = Intent(this, PlaybackService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
        } catch (e: Exception) {
            // без уведомления тоже работает, просто система может раньше выгрузить приложение
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true) // не закрываем — музыка играет дальше
    }

    override fun onDestroy() {
        if (isFinishing) stopService(Intent(this, PlaybackService::class.java))
        web.destroy()
        super.onDestroy()
    }

    private fun jsToast(msg: String) = runOnUiThread {
        web.evaluateJavascript("typeof toast==='function'&&toast(${JSONObject.quote(msg)})", null)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != reqYandexLogin) return
        val token = data?.getStringExtra(YandexLoginActivity.EXTRA_TOKEN)
        if (resultCode == RESULT_OK && !token.isNullOrBlank()) {
            web.evaluateJavascript("typeof onYandexToken==='function'&&onYandexToken(${JSONObject.quote(token)})", null)
        } else {
            jsToast("Вход в Яндекс отменён")
        }
    }

    /** Цвет строки состояния и навигации под тему приложения. */
    @Suppress("DEPRECATION")
    private fun applySystemBars(color: Int, dark: Boolean) {
        window.statusBarColor = color
        window.navigationBarColor = color
        var flags = window.decorView.systemUiVisibility
        flags = if (dark) flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                else flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags = if (dark) flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                    else flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        window.decorView.systemUiVisibility = flags
        web.setBackgroundColor(color)
    }

    /** Методы, доступные из JavaScript как window.MusicHubAndroid. */
    inner class Bridge {
        @JavascriptInterface
        fun setTheme(color: String, dark: Boolean) {
            val parsed = try { Color.parseColor(color.trim()) } catch (e: Exception) { return }
            runOnUiThread { applySystemBars(parsed, dark) }
        }

        @JavascriptInterface
        fun yandexLogin() {
            runOnUiThread {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(this@MainActivity, YandexLoginActivity::class.java), reqYandexLogin)
            }
        }

        @JavascriptInterface
        fun download(path: String, name: String) {
            Thread {
                try {
                    val saved = saveToMusic(path, name)
                    jsToast("Сохранено в «Музыка/MusicHub»: $saved")
                } catch (e: Exception) {
                    jsToast("Не удалось сохранить: ${e.message}")
                }
            }.start()
        }
    }

    private fun saveToMusic(path: String, name: String): String {
        val conn = URL(PyServer.URL_BASE + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 300_000
        if (conn.responseCode != 200) {
            val err = conn.errorStream?.bufferedReader()?.readText().orEmpty()
            val detail = try { JSONObject(err).optString("detail", err) } catch (e: Exception) { err }
            throw IllegalStateException(detail.ifBlank { "ошибка ${conn.responseCode}" })
        }
        val mime = (conn.contentType ?: "audio/mpeg").substringBefore(";").trim()
        val ext = when (mime) {
            "audio/mp4" -> "m4a"
            "audio/aac" -> "aac"
            "audio/ogg" -> "ogg"
            "audio/flac" -> "flac"
            "audio/webm" -> "webm"
            else -> "mp3"
        }
        val fileName = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().ifEmpty { "track" }.take(150) + "." + ext
        conn.inputStream.use { input ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                writeMediaStore(input, fileName, mime)
            } else {
                writeLegacy(input, fileName)
            }
        }
        conn.disconnect()
        return fileName
    }

    private fun writeMediaStore(input: InputStream, fileName: String, mime: String) {
        val values = ContentValues().apply {
            put(MediaStore.Audio.Media.DISPLAY_NAME, fileName)
            put(MediaStore.Audio.Media.MIME_TYPE, mime)
            put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/MusicHub")
            put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val resolver = contentResolver
        val uri: Uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("нет доступа к папке «Музыка»")
        try {
            resolver.openOutputStream(uri)!!.use { out -> input.copyTo(out) }
            values.clear()
            values.put(MediaStore.Audio.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
    }

    @Suppress("DEPRECATION")
    private fun writeLegacy(input: InputStream, fileName: String) {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MusicHub")
        dir.mkdirs()
        val file = File(dir, fileName)
        FileOutputStream(file).use { out -> input.copyTo(out) }
        MediaScannerConnection.scanFile(this, arrayOf(file.absolutePath), null, null)
    }
}
