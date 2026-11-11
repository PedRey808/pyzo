package ru.musichub.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Экран входа в Яндекс. После входа Яндекс перенаправляет на
 * music.yandex.ru/#access_token=<токен>&... — перехватываем этот адрес и возвращаем токен.
 */
class YandexLoginActivity : Activity() {
    companion object {
        const val EXTRA_TOKEN = "token"
        // официальный клиент Яндекс Музыки — через него работает библиотека yandex-music
        const val OAUTH_URL =
            "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d"
        private val TOKEN_RE = Regex("access_token=([^&#\\s]+)")
    }

    private var done = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Вход в Яндекс"
        val web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (check(url)) return true
                val scheme = request.url.scheme ?: ""
                if (scheme != "http" && scheme != "https") {
                    // например, «Войти через приложение Яндекс»
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (e: Exception) { }
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (!check(url)) super.onPageStarted(view, url, favicon)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                check(url)
            }
        }
        web.loadUrl(OAUTH_URL)
    }

    private fun check(url: String?): Boolean {
        if (done || url == null || !url.contains("access_token=")) return false
        val token = TOKEN_RE.find(url)?.groupValues?.get(1) ?: return false
        done = true
        setResult(RESULT_OK, Intent().putExtra(EXTRA_TOKEN, Uri.decode(token)))
        finish()
        return true
    }
}
