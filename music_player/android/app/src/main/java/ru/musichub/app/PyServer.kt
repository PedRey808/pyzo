package ru.musichub.app

import android.content.Context
import android.os.Environment
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Встроенный Python-сервер MusicHub (тот же код, что и на компьютере). */
object PyServer {
    const val PORT = 8765
    const val URL_BASE = "http://127.0.0.1:$PORT"

    @Volatile private var started = false
    @Volatile var startError: String? = null
        private set

    /** Запускает сервер (один раз за жизнь процесса). Вызывать НЕ из главного потока. */
    fun ensureStarted(ctx: Context) {
        synchronized(this) {
            if (started) return
            started = true
        }
        try {
            if (!Python.isStarted()) Python.start(AndroidPlatform(ctx))
            val appDir = ctx.filesDir.absolutePath
            val music = File(ctx.getExternalFilesDir(Environment.DIRECTORY_MUSIC) ?: ctx.filesDir, "MusicHub")
            music.mkdirs()
            Python.getInstance()
                .getModule("musichub.android_main")
                .callAttr("start_in_background", appDir, music.absolutePath, PORT)
        } catch (e: Throwable) {
            startError = e.toString()
        }
    }

    fun isReady(): Boolean = try {
        val c = URL("$URL_BASE/static/icon.svg").openConnection() as HttpURLConnection
        c.connectTimeout = 500
        c.readTimeout = 1000
        val ok = c.responseCode == 200
        c.disconnect()
        ok
    } catch (e: Exception) {
        false
    }

    fun waitReady(timeoutMs: Long = 60_000): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (startError != null) return false
            if (isReady()) return true
            Thread.sleep(250)
        }
        return false
    }
}
