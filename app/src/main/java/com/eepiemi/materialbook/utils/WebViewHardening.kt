package com.eepiemi.materialbook.utils

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.multiplatform.webview.web.WebViewState

// Scripts that run at document start, before Facebook's own code. None for now: anti_reload.js and
// anti_seen.js used to be listed here, but wrapping fetch / WebSocket / addEventListener before the
// page starts left the feed empty and slow. Add a raw resource id here to load it early again.
private val EARLY_SCRIPTS = intArrayOf()

// Wildcard rules match subdomains only, so the bare domains are listed too.
private val EARLY_ORIGINS = setOf(
    "https://facebook.com", "https://*.facebook.com",
    "https://messenger.com", "https://*.messenger.com",
)

/**
 * Settings every WebView in the app gets, called from its onCreated. File access and Safe
 * Browsing are compose-webview's defaults today; they are set here explicitly so a library
 * update can't change them unnoticed. Geolocation is switched off on the WebView itself:
 * Facebook doesn't need it and nothing in the app would grant the prompt.
 */
fun hardenWebView(state: WebViewState, webView: WebView) {
    state.webSettings.androidWebSettings.apply {
        allowFileAccess = false
        safeBrowsingEnabled = true
    }
    state.webSettings.allowFileAccessFromFileURLs = false
    state.webSettings.allowUniversalAccessFromFileURLs = false
    webView.settings.setGeolocationEnabled(false)
    installEarlyScripts(webView)
}

/** Runs the early scripts at document start on Facebook / Messenger pages, where supported. */
fun installEarlyScripts(webView: WebView) {
    if (EARLY_SCRIPTS.isEmpty()) return
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    runCatching {
        val script = EARLY_SCRIPTS.joinToString("\n") { id ->
            webView.resources.openRawResource(id).bufferedReader().use { it.readText() }
        }
        WebViewCompat.addDocumentStartJavaScript(webView, script, EARLY_ORIGINS)
    }
}
