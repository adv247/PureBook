(function () {
    'use strict';
    // Anti auto-reload: when the app comes back to the foreground Facebook reacts to
    // visibilitychange by refreshing the feed (and scrolling it back to the top). This stops
    // Facebook's own handlers from seeing the "visible" event, while PureBook's scripts (PiP,
    // lock-screen audio, timer) still get every event through the gate below.
    //  - "hidden" events are left alone, so Facebook still pauses videos when you leave.
    //  - Videos that were playing when the app was hidden are resumed on return, because
    //    Facebook's handler that would have resumed them is the one being blocked.
    //  - A page restored from the back/forward cache (pageshow with persisted) is treated the same.
    // Unlike pinning document.visibilityState, nothing is faked, so code that reads it keeps
    // working. Turn off at runtime: window.__pbAntiReloadCfg = { enabled: false } before load.
    // Installed at document start (WebViewHardening.kt) and again by the script bundle; the
    // guard below makes the second run a no-op.
    try {
        if (window.__pbAntiReload) return;
        const cfg = window.__pbAntiReloadCfg = Object.assign({ enabled: true }, window.__pbAntiReloadCfg);
        if (!cfg.enabled) return;
        window.__pbAntiReload = true;

        const TYPES = ['visibilitychange', 'webkitvisibilitychange', 'freeze', 'resume', 'pageshow'];
        const MAX_REMEMBERED = 8;
        const ours = []; // [target, type, listener] registered by PureBook scripts
        const opts = {
            // A listener registered by Facebook's code comes from a script with a URL: its CDN, or
            // the page itself for inline scripts. PureBook's scripts are evaluated from the app
            // (no URL in the stack). When in doubt (no stack at all) it counts as Facebook's.
            fromPage: function () {
                const stack = String(new Error().stack || '');
                return !stack || /https?:\/\//i.test(stack);
            },
        };

        const origAdd = EventTarget.prototype.addEventListener;
        const origRemove = EventTarget.prototype.removeEventListener;

        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (listener && TYPES.indexOf(type) !== -1 && (this === document || this === window) && !opts.fromPage()) {
                ours.push([this, type, listener]);
                return;
            }
            return origAdd.call(this, type, listener, options);
        };
        EventTarget.prototype.removeEventListener = function (type, listener, options) {
            if (TYPES.indexOf(type) !== -1) {
                for (let i = ours.length - 1; i >= 0; i--) {
                    if (ours[i][0] === this && ours[i][1] === type && ours[i][2] === listener) ours.splice(i, 1);
                }
            }
            return origRemove.call(this, type, listener, options);
        };

        let wasPlaying = [];
        function gate(e) {
            const restore = e.type === 'pageshow';
            const visible = document.visibilityState === 'visible';
            if (!restore && !visible) {
                wasPlaying = Array.prototype.filter.call(document.querySelectorAll('video'), v => !v.paused && !v.ended).slice(0, MAX_REMEMBERED);
            }
            ours.slice().forEach(entry => {
                if (entry[1] !== e.type) return;
                try { typeof entry[2] === 'function' ? entry[2].call(entry[0], e) : entry[2].handleEvent(e); } catch (err) {}
            });
            const blockable = restore ? e.persisted === true : visible;
            if (!blockable) return;
            e.stopImmediatePropagation();
            const inPip = document.body && document.body.hasAttribute('data-astryx-pip-active');
            if (!inPip) {
                wasPlaying.forEach(v => {
                    if (v.hasAttribute('data-astryx-handoff-muted')) return; // lock-screen handoff owns it
                    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (err) {}
                });
            }
            wasPlaying = []; // never keep elements alive longer than one hide/show cycle
        }
        TYPES.forEach(t => origAdd.call(window, t, gate, true));

        window.__pbAntiReloadApi = { gate, ours, opts };
    } catch (err) {
        try { console.warn('[PureBook] anti_reload failed', err); } catch (e) {}
    }
})();
