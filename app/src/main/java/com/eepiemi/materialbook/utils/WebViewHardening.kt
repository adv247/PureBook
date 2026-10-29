package com.eepiemi.materialbook.utils

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.eepiemi.materialbook.R
import com.multiplatform.webview.web.WebViewState

// Scripts that have to exist before Facebook's own code runs: they wrap WebSocket / fetch /
// addEventListener, and Messenger opens its socket during page load. The script bundle only runs
// once the page has finished loading, which is too late for the first socket and for the handlers
// Facebook registers up front. Each script guards against a second run, so the bundle's later copy
// is a no-op.
private val EARLY_SCRIPTS = intArrayOf(R.raw.anti_reload, R.raw.anti_seen)

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
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    runCatching {
        val script = EARLY_SCRIPTS.joinToString("\n") { id ->
            webView.resources.openRawResource(id).bufferedReader().use { it.readText() }
        }
        WebViewCompat.addDocumentStartJavaScript(webView, script, EARLY_ORIGINS)
    }
}
