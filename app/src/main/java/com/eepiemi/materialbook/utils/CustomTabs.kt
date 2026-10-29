package com.eepiemi.materialbook.utils

import android.content.Context
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri

private val WEB_URL = Regex("""^https?://[^\s/?#]+""", RegexOption.IGNORE_CASE)

/** An http(s) link with a host: the only kind a Custom Tab opens. */
fun isWebUrl(url: String): Boolean = WEB_URL.containsMatchIn(url.trim())

/**
 * Opens [url] in a Custom Tab: the default browser's tab drawn over the app, with the browser's
 * own cookies instead of the app's Facebook login. The link goes through [LinkResolver] first
 * (cleaned, short links expanded, the store's own app when installed), so the tab opens once it
 * is resolved; true only means "on its way". Returns false for anything that isn't a web link.
 */
fun openInCustomTab(context: Context, url: String): Boolean {
    if (!isWebUrl(url)) return false
    LinkResolver.open(context, url, viaTab = true)
    return true
}

/** The Custom Tab itself, with no cleaning or expanding. False when no browser can show it. */
internal fun launchCustomTab(context: Context, url: String): Boolean = runCatching {
    CustomTabsIntent.Builder()
        .setShowTitle(true)
        .setShareState(CustomTabsIntent.SHARE_STATE_ON)
        .build()
        .launchUrl(context, url.toUri())
}.isSuccess
