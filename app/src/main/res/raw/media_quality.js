(function () {
    'use strict';
    // Highest-quality media the page already knows about. Facebook's GraphQL answers (and the JSON
    // embedded in the page) describe a video with several URLs, among them the muxed HD file
    // ("browser_native_hd_url", "playable_url_quality_hd", "hd_src") and a photo with several sizes
    // ("viewer_image", "photo_image", "full_image": uri + width + height). The player only fetches
    // what it needs for the current connection, so the best URL is often never requested.
    // This script reads those answers, keeps the best URL per media id, and exposes:
    //   window.__pbHdUrlFor(id?)    -> HD video URL for the video on screen (or null)
    //   window.__pbImageUrlFor(id?) -> largest photo URL for the photo on screen (or null)
    // download_content.js prefers them. Nothing is requested here: only data the page received
    // is read. The field names are Facebook's, not a published API: when they change this simply
    // finds nothing and downloads fall back to what the player fetched.
    try {
        if (window.__pbMediaQuality) return;
        window.__pbMediaQuality = true;

        const HD_KEYS = ['browser_native_hd_url', 'playable_url_quality_hd', 'hd_src', 'hd_src_no_ratelimit'];
        const SD_KEYS = ['browser_native_sd_url', 'playable_url', 'sd_src', 'sd_src_no_ratelimit'];
        const IMAGE_KEYS = ['viewer_image', 'photo_image', 'full_image'];
        const MARKERS = /browser_native_hd_url|playable_url|hd_src|sd_src|viewer_image|photo_image|full_image/;
        const WATCH_URL = /graphql|\/api\/|\/ajax\//i;
        // Only Facebook's own hosts: a page script must not be able to point a download elsewhere.
        const ALLOWED_URL = /^https:\/\/[a-z0-9.-]+\.(?:fbcdn\.net|fbsbx\.com|facebook\.com)\//i;
        const MAX_BODY = 3000000;
        const MAX_ENTRIES = 60;
        const MAX_NODES = 30000;

        const entries = new Map(); // media id -> { hd, sd, image, imageArea }

        function entryFor(id) {
            let e = entries.get(id);
            if (e) { entries.delete(id); } else { e = { hd: null, sd: null, image: null, imageArea: 0 }; }
            entries.set(id, e); // most recently touched last
            while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
            return e;
        }

        const isId = v => typeof v === 'string' && /^\d{6,}$/.test(v);
        const allowed = v => typeof v === 'string' && ALLOWED_URL.test(v);

        function walk(root) {
            let found = 0, seen = 0;
            const stack = [[root, '']];
            while (stack.length && seen < MAX_NODES) {
                const [node, hint] = stack.pop();
                seen++;
                if (!node || typeof node !== 'object') continue;
                if (Array.isArray(node)) {
                    for (let i = 0; i < node.length; i++) stack.push([node[i], hint]);
                    continue;
                }
                const id = isId(node.id) ? node.id : isId(node.video_id) ? node.video_id : isId(node.videoId) ? node.videoId : hint;
                if (id) {
                    for (const k of HD_KEYS) if (allowed(node[k])) { entryFor(id).hd = node[k]; found++; break; }
                    for (const k of SD_KEYS) if (allowed(node[k])) { entryFor(id).sd = node[k]; found++; break; }
                    for (const k of IMAGE_KEYS) {
                        const img = node[k];
                        if (img && typeof img === 'object' && allowed(img.uri)) {
                            const area = (Number(img.width) || 0) * (Number(img.height) || 0);
                            const e = entryFor(id);
                            if (!e.image || area > e.imageArea) { e.image = img.uri; e.imageArea = area; found++; }
                        }
                    }
                }
                for (const k in node) {
                    const v = node[k];
                    if (v && typeof v === 'object') stack.push([v, id]);
                }
            }
            return found;
        }

        // A GraphQL answer: JSON, sometimes behind "for (;;);", sometimes one JSON object per line.
        function parseText(text) {
            if (typeof text !== 'string' || text.length > MAX_BODY || !MARKERS.test(text)) return 0;
            const t = text.replace(/^\s*for\s*\(;;\);/, '').trim();
            if (t[0] === '{' || t[0] === '[') {
                try { return walk(JSON.parse(t)); } catch (e) { /* maybe several documents: below */ }
            }
            let found = 0;
            t.split('\n').forEach(line => {
                const s = line.trim();
                if (s[0] !== '{' && s[0] !== '[') return;
                try { found += walk(JSON.parse(s)); } catch (e) { /* not JSON */ }
            });
            return found;
        }

        // The media the page is showing, from its address.
        function currentId() {
            const href = String((window.location && window.location.href) || '');
            const m = /\/reel\/(\d{6,})/.exec(href) ||
                /\/videos\/(?:[^/?#]+\/)?(\d{6,})/.exec(href) ||
                /[?&]v=(\d{6,})/.exec(href) ||
                /[?&]fbid=(\d{6,})/.exec(href) ||
                /\/photos?\/(?:[^/?#]+\/)?(\d{6,})/.exec(href);
            return m ? m[1] : null;
        }

        const lookup = (id, field) => {
            const e = entries.get(String(id || currentId() || ''));
            return (e && e[field]) || null;
        };
        window.__pbHdUrlFor = id => lookup(id, 'hd');
        window.__pbImageUrlFor = id => lookup(id, 'image');
        window.__pbMediaQualityApi = { parse: parseText, entries: entries, currentId: currentId };

        const noop = () => {};

        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
            window.fetch = function (input) {
                const p = origFetch.apply(this, arguments);
                try {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (WATCH_URL.test(url)) {
                        p.then(res => {
                            try {
                                const len = Number(res && res.headers && res.headers.get && res.headers.get('content-length'));
                                if (len > MAX_BODY) return;
                                res.clone().text().then(parseText, noop);
                            } catch (e) { /* leave the answer alone */ }
                        }, noop);
                    }
                } catch (e) { /* never get in the page's way */ }
                return p;
            };
        }

        const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (XHR) {
            const origOpen = XHR.open;
            const origSend = XHR.send;
            XHR.open = function (method, url) {
                try { this.__pbMq = WATCH_URL.test(String(url)); } catch (e) { /* ignore */ }
                return origOpen.apply(this, arguments);
            };
            XHR.send = function () {
                try {
                    if (this.__pbMq) {
                        this.addEventListener('load', () => {
                            try { if (this.responseType === '' || this.responseType === 'text') parseText(this.responseText); } catch (e) { /* ignore */ }
                        });
                    }
                } catch (e) { /* ignore */ }
                return origSend.apply(this, arguments);
            };
        }

        // Data the page was delivered with (the first video of a page load is usually in here).
        function scanInline() {
            try {
                const nodes = document.querySelectorAll('script[type="application/json"]');
                for (let i = 0; i < nodes.length && i < 60; i++) parseText(nodes[i].textContent);
            } catch (e) { /* ignore */ }
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanInline);
        else scanInline();
        setTimeout(scanInline, 1500);
    } catch (err) {
        try { console.warn('[PureBook] media_quality failed', err); } catch (e) { /* ignore */ }
    }
})();
