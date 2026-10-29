(function () {
    'use strict';
    // Link privacy: unwraps Facebook / affiliate redirect wrappers and strips tracking and
    // affiliate (commission) parameters from links in posts, comments, groups and chats.
    // Two passes: 1) unwrap redirect wrappers, 2) strip tracking + affiliate parameters.
    // Short links (bit.ly, shope.ee, vt.tiktok.com...) cannot be expanded from a page (CORS hides
    // the redirect target), so they are only cleaned here; native code resolves them.
    try {
        if (window.__pbLinkPrivacy) return;
        window.__pbLinkPrivacy = true;

        const FB_HOST = /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|messenger\.com|fbcdn\.net|fbsbx\.com)$/i;
        const SHIM_HOST = /^(l|lm)\.facebook\.com$/i;

        // Redirect wrappers: [host regex, parameter names that carry the real destination].
        const WRAPPERS = [
            [/^(l|lm)\.facebook\.com$/i, ['u']],
            [/^(www\.)?google\.[a-z.]+$/i, ['q', 'url']],
            [/(^|\.)shopee\.[a-z.]+$/i, ['redirect', 'url']],
            [/(^|\.)lazada\.[a-z.]+$/i, ['url', 'redirect']],
            [/(^|\.)aliexpress\.[a-z.]+$/i, ['dl_target_url', 'url']],
            [/^go\.isclix\.com$/i, ['url']],
            [/(^|\.)accesstrade\.[a-z.]+$/i, ['url']],
            [/^ad\.admitad\.com$/i, ['ulp']],
            [/^click\.linksynergy\.com$/i, ['murl']],
            [/(^|\.)awin1\.com$/i, ['ued']],
            [/^go\.ecotrackings\.com$/i, ['url']],
        ];

        // Short-link hosts (expanded natively, not here).
        const SHORT_HOST = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rb\.gy|cutt\.ly|shorturl\.at|tiny\.cc|s\.id|t\.ly|lnkd\.in|vk\.cc|shope\.ee|s\.shopee\.vn|shp\.ee|vn\.shp\.ee|lzd\.co|s\.lazada\.vn|vt\.tiktok\.com|vm\.tiktok\.com|s\.tiktok\.com|s\.click\.aliexpress\.com|a\.aliexpress\.com|amzn\.to|amzn\.asia|a\.co|go\.isclix\.com|fast\.accesstrade\.com\.vn|ad\.admitad\.com|click\.linksynergy\.com|go\.ecotrackings\.com|invl\.me)$/i;

        const SHOP_HOST = /(^|\.)(shopee|lazada|tiki|sendo|tiktok|aliexpress|amazon|shp)\.[a-z.]+$|^(shope\.ee|lzd\.co|amzn\.to|a\.co)$/i;
        const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;
        const AMAZON_HOST = /(^|\.)amazon\.[a-z.]+$/i;

        // Social / ad-click trackers, any site.
        const TRACK_EXACT = new Set([
            'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', 'ttclid', 'twclid',
            'yclid', 'wbraid', 'gbraid', '_ga', '_gl', 'mibextid', '__tn__', 'rdid',
            'fb_action_ids', 'fb_action_types', 'fb_source',
        ]);
        const TRACK_PREFIX = ['utm_', '__cft__', '__xts__', 'aff_', 'affiliate', 'pk_', 'mtm_', 'hsa_', 'vero_'];

        // Affiliate / commission parameters, any site.
        const AFF_EXACT = new Set([
            'smtt', 'sp_atk', 'xptdk', 'uls_trackid', 'mmp_pid', 'gads_t_sig', 'sub_aff_id',
            'laz_trackid', 'mkttid', 'exlaz', 'adjust_t', 'adjust_tracker', 'adjust_campaign',
            'af_xp', 'clickid', 'affid',
        ]);
        const AFF_REGEX = /^sub_id\d*$/;

        // Only on shopping hosts: functional on other sites.
        const SHOP_EXACT = new Set(['spm', 'scm', 'algo_pvid', 'algo_exp_id', 'pdp_ext_f', 'pdp_npi',
            'sk', 'terminal_id', 'afsmartredirect', 'gatewayadapt', 'browser_id']);
        const SHOP_PREFIX = ['af_'];
        const TIKTOK_EXACT = new Set(['_t', '_r', '_d', 'is_from_webapp', 'sender_device', 'sender_web_id',
            'is_copy_url', 'u_code', 'tt_from', 'refer', 'enter_from', 'social_share_type',
            'sec_user_id', 'timestamp', 'checksum', 'embed_source', 'link_reflow_popup_iteration_sharer']);
        const TIKTOK_PREFIX = ['share_'];
        const AMAZON_EXACT = new Set(['tag', 'linkcode', 'linkid', 'ref_', 'ref', 'qid', 'sr', 'crid',
            'sprefix', 'content-id', 'creative', 'creativeasin', 'camp']);
        const AMAZON_PREFIX = ['pd_rd_', 'pf_rd_'];

        const startsWithAny = (s, list) => list.some(p => s.startsWith(p));

        function isTrackingParam(name, host) {
            const n = name.toLowerCase();
            if (TRACK_EXACT.has(n) || startsWithAny(n, TRACK_PREFIX)) return true;
            if (AFF_EXACT.has(n) || AFF_REGEX.test(n)) return true;
            if (SHOP_HOST.test(host)) {
                if (SHOP_EXACT.has(n) || startsWithAny(n, SHOP_PREFIX)) return true;
                if (TIKTOK_HOST.test(host) && (TIKTOK_EXACT.has(n) || startsWithAny(n, TIKTOK_PREFIX))) return true;
                if (AMAZON_HOST.test(host) && (AMAZON_EXACT.has(n) || startsWithAny(n, AMAZON_PREFIX))) return true;
            }
            return false;
        }

        function parse(u) {
            try { return new URL(u, location.href); } catch (e) { return null; }
        }

        // Pass 1: peel redirect wrappers (up to 4 nested).
        function unwrap(u) {
            for (let i = 0; i < 4; i++) {
                const url = parse(u);
                if (!url || !/^https?:$/.test(url.protocol)) return u;
                let next = null;
                for (const [hostRe, names] of WRAPPERS) {
                    if (!hostRe.test(url.hostname)) continue;
                    for (const name of names) {
                        let v = url.searchParams.get(name);
                        if (!v) continue;
                        if (!/^https?:\/\//i.test(v)) {
                            try { v = decodeURIComponent(v); } catch (e) {}
                        }
                        if (/^https?:\/\//i.test(v)) { next = v; break; }
                    }
                    if (next) break;
                }
                if (!next) return url.href;
                u = next;
            }
            return u;
        }

        // Pass 2: drop tracking and affiliate parameters, keep every other byte of the query.
        function strip(u) {
            const url = parse(u);
            if (!url || !/^https?:$/.test(url.protocol) || !url.search) return u;
            const host = url.hostname.toLowerCase();
            const parts = url.search.slice(1).split('&');
            const kept = parts.filter(part => {
                if (!part) return false;
                let name = part.split('=')[0];
                try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (e) {}
                return !isTrackingParam(name, host);
            });
            if (kept.length === parts.length) return u;
            url.search = kept.length ? '?' + kept.join('&') : '';
            return url.href;
        }

        function clean(u) { return strip(unwrap(u)); }
        function isShort(u) {
            const url = parse(u);
            if (!url) return false;
            return SHORT_HOST.test(url.hostname) || (TIKTOK_HOST.test(url.hostname) && /^\/t\//.test(url.pathname));
        }
        function shouldHandle(href) {
            const url = parse(href);
            if (!url || !/^https?:$/.test(url.protocol)) return false;
            return SHIM_HOST.test(url.hostname) || !FB_HOST.test(url.hostname);
        }

        window.__pbCleanUrl = clean;
        window.__pbIsShortUrl = isShort;

        function processAnchor(a) {
            if (a.dataset.pbClean === '1') return;
            const href = a.href;
            if (!href || !shouldHandle(href)) { a.dataset.pbClean = '1'; return; }
            const cleaned = clean(href);
            if (cleaned !== href) {
                // Show the clean link when the visible text is the raw link itself.
                if (a.children.length === 0 && (a.textContent || '').trim() === href) a.textContent = cleaned;
                a.href = cleaned;
            }
            if (isShort(cleaned)) a.dataset.pbShort = '1';
            a.dataset.pbClean = '1';
        }

        function scan(root) {
            if (root.nodeType !== 1) return;
            if (root.tagName === 'A') processAnchor(root);
            root.querySelectorAll('a[href]:not([data-pb-clean])').forEach(processAnchor);
        }

        // Facebook swaps the href for its l.facebook.com shim on touch/mouse down, after our scan,
        // so the final cleaning happens on click, before Facebook's own handlers.
        document.addEventListener('click', function (e) {
            if (e.defaultPrevented) return;
            const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a || !shouldHandle(a.href)) return;
            const cleaned = clean(a.href);
            if (cleaned === a.href && !SHIM_HOST.test(parse(a.href).hostname)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            window.location.assign(cleaned);
        }, true);

        scan(document.body);
        let pending = [];
        let scheduled = false;
        new MutationObserver(mutations => {
            for (const m of mutations) for (const n of m.addedNodes) if (n.nodeType === 1) pending.push(n);
            if (scheduled || !pending.length) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                const batch = pending;
                pending = [];
                batch.forEach(scan);
            });
        }).observe(document.body, { childList: true, subtree: true });
    } catch (err) {
        try { console.warn('[PureBook] link_privacy failed', err); } catch (e) {}
    }
})();
