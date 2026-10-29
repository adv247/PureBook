package com.eepiemi.materialbook.utils

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.core.net.toUri
import com.eepiemi.materialbook.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder

// Short-link and affiliate-redirect hosts. They only exist to bounce to the real page, so they are
// expanded (without loading the page) before the link leaves the app.
private val SHORT_LINK_HOSTS = Regex(
    """^(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rb\.gy|cutt\.ly|shorturl\.at|tiny\.cc|s\.id|t\.ly|lnkd\.in|vk\.cc|shope\.ee|s\.shopee\.vn|shp\.ee|vn\.shp\.ee|lzd\.co|s\.lazada\.vn|vt\.tiktok\.com|vm\.tiktok\.com|s\.tiktok\.com|s\.click\.aliexpress\.com|a\.aliexpress\.com|amzn\.to|amzn\.asia|a\.co|go\.isclix\.com|fast\.accesstrade\.com\.vn|ad\.admitad\.com|click\.linksynergy\.com|go\.ecotrackings\.com|invl\.me)$""",
    RegexOption.IGNORE_CASE,
)

// Wrappers that carry the real destination in a query parameter (Facebook's own l.facebook.com is
// handled by fbRedirectSanitizer).
private val REDIRECT_WRAPPERS: List<Pair<Regex, List<String>>> = listOf(
    Regex("""^(?:www\.)?google\.[a-z.]+$""", RegexOption.IGNORE_CASE) to listOf("q", "url"),
    Regex("""(?:^|\.)shopee\.[a-z.]+$""", RegexOption.IGNORE_CASE) to listOf("redirect", "url"),
    Regex("""(?:^|\.)lazada\.[a-z.]+$""", RegexOption.IGNORE_CASE) to listOf("url", "redirect"),
    Regex("""(?:^|\.)aliexpress\.[a-z.]+$""", RegexOption.IGNORE_CASE) to listOf("dl_target_url", "url"),
    Regex("""^go\.isclix\.com$""", RegexOption.IGNORE_CASE) to listOf("url"),
    Regex("""(?:^|\.)accesstrade\.[a-z.]+$""", RegexOption.IGNORE_CASE) to listOf("url"),
    Regex("""^ad\.admitad\.com$""", RegexOption.IGNORE_CASE) to listOf("ulp"),
    Regex("""^click\.linksynergy\.com$""", RegexOption.IGNORE_CASE) to listOf("murl"),
    Regex("""(?:^|\.)awin1\.com$""", RegexOption.IGNORE_CASE) to listOf("ued"),
    Regex("""^go\.ecotrackings\.com$""", RegexOption.IGNORE_CASE) to listOf("url"),
)

// Affiliate (commission) and ad-click parameters, any site. Social trackers (fbclid, utm_*, ...)
// are already removed by fbRedirectSanitizer.
private val AFFILIATE_PARAMS = setOf(
    "smtt", "sp_atk", "xptdk", "uls_trackid", "mmp_pid", "gads_t_sig", "sub_aff_id",
    "laz_trackid", "mkttid", "exlaz", "adjust_t", "adjust_tracker", "adjust_campaign",
    "af_xp", "clickid", "affid", "ttclid", "twclid", "yclid", "wbraid", "gbraid", "mc_cid",
    "_ga", "_gl", "fb_action_ids", "fb_action_types", "fb_source",
)
private val AFFILIATE_PREFIXES = listOf("aff_", "affiliate", "pk_", "mtm_", "hsa_", "vero_")
private val SUB_ID = Regex("""^sub_id\d*$""")

// Parameters that are only tracking on shopping sites (functional elsewhere).
private val SHOP_HOST = Regex(
    """(?:^|\.)(?:shopee|lazada|tiki|sendo|tiktok|aliexpress|amazon|shp)\.[a-z.]+$|^(?:shope\.ee|lzd\.co|amzn\.to|a\.co)$""",
    RegexOption.IGNORE_CASE,
)
private val TIKTOK_HOST = Regex("""(?:^|\.)tiktok\.com$""", RegexOption.IGNORE_CASE)
private val AMAZON_HOST = Regex("""(?:^|\.)amazon\.[a-z.]+$""", RegexOption.IGNORE_CASE)
private val SHOP_PARAMS = setOf(
    "spm", "scm", "algo_pvid", "algo_exp_id", "pdp_ext_f", "pdp_npi", "sk", "terminal_id",
    "afsmartredirect", "gatewayadapt", "browser_id",
)
private val TIKTOK_PARAMS = setOf(
    "_t", "_r", "_d", "is_from_webapp", "sender_device", "sender_web_id", "is_copy_url", "u_code",
    "tt_from", "refer", "enter_from", "social_share_type", "sec_user_id", "timestamp", "checksum",
    "embed_source", "link_reflow_popup_iteration_sharer",
)
private val AMAZON_PARAMS = setOf(
    "tag", "linkcode", "linkid", "ref_", "ref", "qid", "sr", "crid", "sprefix", "content-id",
    "creative", "creativeasin", "camp",
)

private fun hostOf(url: String): String? =
    runCatching { URI(url.trim()).host?.lowercase() }.getOrNull()

private fun isHttp(url: String): Boolean =
    url.startsWith("https://", ignoreCase = true) || url.startsWith("http://", ignoreCase = true)

private fun isAffiliateParam(rawName: String, host: String): Boolean {
    val name = runCatching { URLDecoder.decode(rawName, "UTF-8") }.getOrDefault(rawName).lowercase()
    if (name in AFFILIATE_PARAMS || SUB_ID.matches(name) || AFFILIATE_PREFIXES.any { name.startsWith(it) }) return true
    if (!SHOP_HOST.containsMatchIn(host)) return false
    if (name in SHOP_PARAMS || name.startsWith("af_")) return true
    if (TIKTOK_HOST.containsMatchIn(host) && (name in TIKTOK_PARAMS || name.startsWith("share_"))) return true
    if (AMAZON_HOST.containsMatchIn(host) && (name in AMAZON_PARAMS || name.startsWith("pd_rd_") || name.startsWith("pf_rd_"))) return true
    return false
}

/** [link] without affiliate / commission parameters; the rest of it is kept byte for byte. */
fun stripAffiliateParams(link: String): String {
    val host = hostOf(link) ?: return link
    val fragmentStart = link.indexOf('#').takeIf { it >= 0 } ?: link.length
    val queryStart = link.indexOf('?').takeIf { it in 0 until fragmentStart } ?: return link
    val kept = link.substring(queryStart + 1, fragmentStart)
        .split('&')
        .filter { it.isNotEmpty() && !isAffiliateParam(it.substringBefore('='), host) }
    return link.substring(0, queryStart) +
        (if (kept.isEmpty()) "" else "?" + kept.joinToString("&")) +
        link.substring(fragmentStart)
}

private fun queryParam(link: String, name: String): String? {
    val query = link.substringAfter('?', "").substringBefore('#')
    for (pair in query.split('&')) {
        if (pair.substringBefore('=') == name) {
            val raw = pair.substringAfter('=', "")
            return runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrNull()
        }
    }
    return null
}

/** Pass 1: peels redirect wrappers (up to 4 nested) down to the real destination. */
fun unwrapRedirectors(link: String): String {
    var current = link
    for (i in 0 until 4) {
        val snapshot = current
        val host = hostOf(snapshot) ?: return snapshot
        var next: String? = null
        for ((hostRegex, names) in REDIRECT_WRAPPERS) {
            if (!hostRegex.containsMatchIn(host)) continue
            for (name in names) {
                val value = queryParam(snapshot, name)
                if (value != null && isHttp(value)) { next = value; break }
            }
            if (next != null) break
        }
        current = next ?: return snapshot
    }
    return current
}

/** Both passes: unwrap redirectors, then strip tracking and affiliate parameters. */
fun cleanLink(link: String): String =
    stripAffiliateParams(fbRedirectSanitizer(unwrapRedirectors(fbRedirectSanitizer(link))))

fun isShortLink(url: String): Boolean {
    val host = hostOf(url) ?: return false
    if (SHORT_LINK_HOSTS.matches(host)) return true
    return TIKTOK_HOST.containsMatchIn(host) && runCatching { URI(url).path.orEmpty().startsWith("/t/") }.getOrDefault(false)
}

private class AppTarget(val hosts: Regex, val packages: List<String>)

// Stores' own apps: the link is handed straight to the app when it is installed.
private val APP_TARGETS = listOf(
    AppTarget(
        Regex("""(?:^|\.)(?:shopee\.[a-z.]+|shp\.ee|shope\.ee)$""", RegexOption.IGNORE_CASE),
        listOf("com.shopee.vn", "com.shopee.id", "com.shopee.th", "com.shopee.my", "com.shopee.ph", "com.shopee.sg", "com.shopee.tw", "com.shopee.br"),
    ),
    AppTarget(
        Regex("""(?:^|\.)(?:lazada\.[a-z.]+|lzd\.co)$""", RegexOption.IGNORE_CASE),
        listOf("com.lazada.android"),
    ),
    AppTarget(TIKTOK_HOST, listOf("com.zhiliaoapp.musically", "com.ss.android.ugc.trill")),
)

object LinkResolver {
    private const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
    private const val TIMEOUT_MS = 4000

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /**
     * Opens a link that leaves the app: cleaned first, short links expanded off the main thread,
     * then the matching store app if it is installed, otherwise a Custom Tab or the browser.
     * Returns at once; the opening happens when the link is resolved.
     */
    fun open(context: Context, url: String, viaTab: Boolean) {
        val cleaned = cleanLink(url)
        if (!isShortLink(cleaned)) {
            openFinal(context, cleaned, viaTab)
            return
        }
        scope.launch {
            val resolved = runCatching { unshorten(cleaned) }.getOrDefault(cleaned)
            openFinal(context, cleanLink(resolved), viaTab)
        }
    }

    /** Follows redirects one hop at a time with HEAD (never loading the page), at most [maxHops]. */
    suspend fun unshorten(url: String, maxHops: Int = 5): String = withContext(Dispatchers.IO) {
        var current = url
        var hops = 0
        while (hops < maxHops && isShortLink(current)) {
            val next = redirectTarget(current) ?: break
            current = next
            hops++
        }
        current
    }

    private fun redirectTarget(url: String): String? {
        if (!isHttp(url)) return null
        // Some shorteners answer HEAD with 403/405/501: ask again with GET (the body is never read).
        for (method in arrayOf("HEAD", "GET")) {
            var connection: HttpURLConnection? = null
            try {
                connection = URL(url).openConnection() as HttpURLConnection
                connection.instanceFollowRedirects = false
                connection.requestMethod = method
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                connection.setRequestProperty("User-Agent", USER_AGENT)
                val code = connection.responseCode
                if (code in 300..399) {
                    val location = connection.getHeaderField("Location") ?: return null
                    return URI(url).resolve(location).toString()
                }
                if (method == "HEAD" && (code == 403 || code == 405 || code == 501)) continue
                return null
            } catch (e: Exception) {
                if (method == "GET") return null
            } finally {
                connection?.disconnect()
            }
        }
        return null
    }

    private fun openFinal(context: Context, url: String, viaTab: Boolean) {
        if (openInInstalledApp(context, url)) return
        val opened = if (viaTab) launchCustomTab(context, url) || launchBrowser(context, url) else launchBrowser(context, url)
        if (!opened) Toast.makeText(context, R.string.open_external_failed_toast, Toast.LENGTH_SHORT).show()
    }

    private fun openInInstalledApp(context: Context, url: String): Boolean {
        val host = hostOf(url) ?: return false
        val target = APP_TARGETS.firstOrNull { it.hosts.containsMatchIn(host) } ?: return false
        for (pkg in target.packages) {
            val intent = Intent(Intent.ACTION_VIEW, url.toUri())
                .setPackage(pkg)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(intent)
                return true
            } catch (e: ActivityNotFoundException) {
                // not installed: try the next package
            } catch (e: SecurityException) {
                // not allowed to start it: try the next package
            }
        }
        return false
    }
}
