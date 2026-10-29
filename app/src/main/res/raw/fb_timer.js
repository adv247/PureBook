(function () {
    'use strict';
    // Stealth usage timer. Counts the time Facebook is actually on screen. Stays invisible except
    // for the last 2 minutes before every 30-minute mark of continuous use: a small countdown
    // pill on the right edge, then a break reminder with the account's own name at the mark.
    // A pause of idleResetMin minutes (app in background) starts a new session.
    // Settings: window.__pbTimerCfg = { enabled, intervalMin, warnSec, idleResetMin } (set before this runs).
    try {
        if (window.__pbTimer) return;
        const cfg = Object.assign({ enabled: true, intervalMin: 30, warnSec: 120, idleResetMin: 5 }, window.__pbTimerCfg);
        if (!cfg.enabled) return;
        window.__pbTimer = true;

        const KEY = 'pb_timer_v1';
        const INTERVAL = cfg.intervalMin * 60000;
        const WARN = cfg.warnSec * 1000;
        const IDLE = cfg.idleResetMin * 60000;

        function load() {
            try { return Object.assign({ active: 0, last: 0, marks: 0, name: '' }, JSON.parse(localStorage.getItem(KEY) || '{}')); }
            catch (e) { return { active: 0, last: 0, marks: 0, name: '' }; }
        }
        const st = load();
        function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
        if (Date.now() - st.last > IDLE) { st.active = 0; st.marks = 0; }

        // The account name: Facebook's own page data first (the logged-in account, not a name
        // that happens to be on screen), then the last name seen, then a neutral word.
        function fromRequire() {
            try {
                const m = window.require && window.require('CurrentUserInitialData');
                if (m && (m.NAME || m.SHORT_NAME)) return m.NAME || m.SHORT_NAME;
            } catch (e) {}
            return '';
        }
        function fromScripts() {
            try {
                const scripts = document.scripts;
                for (let i = 0; i < scripts.length; i++) {
                    const t = scripts[i].textContent;
                    if (!t || t.indexOf('CurrentUserInitialData') < 0) continue;
                    const block = /"CurrentUserInitialData"\s*,\s*\[\s*\]\s*,\s*\{([^}]*)\}/.exec(t);
                    if (!block) continue;
                    const n = /"NAME"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(block[1]) || /"SHORT_NAME"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(block[1]);
                    if (n) return JSON.parse('"' + n[1] + '"');
                }
            } catch (e) {}
            return '';
        }
        function displayName() {
            const name = (fromRequire() || fromScripts() || '').trim();
            if (name && /\D/.test(name)) { if (st.name !== name) { st.name = name; save(); } return name; }
            return st.name || 'bạn';
        }

        // ---- UI ----
        let pill = null;
        function showPill(text) {
            if (!pill) {
                pill = document.createElement('div');
                pill.style.cssText = 'position:fixed;right:6px;top:42%;z-index:2147483000;padding:3px 8px;' +
                    'border-radius:12px;background:rgba(24,25,26,.88);color:#e4e6eb;font:600 11px/16px system-ui,sans-serif;' +
                    'letter-spacing:.2px;pointer-events:none;opacity:.92;box-shadow:0 1px 4px rgba(0,0,0,.35);';
                (document.body || document.documentElement).appendChild(pill);
            }
            pill.textContent = '\u23F1 ' + text;
        }
        function hidePill() { if (pill) { pill.remove(); pill = null; } }

        let dialog = null;
        function showBreak(totalMinutes) {
            if (dialog) return;
            const name = displayName();
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px;';
            const card = document.createElement('div');
            card.style.cssText = 'background:#242526;border-radius:16px;padding:24px;max-width:320px;width:100%;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.5);font-family:system-ui,sans-serif;';
            const title = document.createElement('div');
            title.textContent = 'Nghỉ ngơi mắt nhé, ' + name + '!';
            title.style.cssText = 'font-size:18px;font-weight:700;color:#ffffff;margin-bottom:10px;letter-spacing:-0.2px;';
            const desc = document.createElement('div');
            desc.textContent = 'Bạn đã lướt Facebook liên tục ' + totalMinutes + ' phút.';
            desc.style.cssText = 'font-size:14px;color:#b0b3b8;margin-bottom:22px;line-height:1.45;';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;';
            function button(label, primary, onClick) {
                const b = document.createElement('button');
                b.textContent = label;
                b.style.cssText = 'flex:1;border:0;border-radius:10px;padding:11px 0;font-size:14px;font-weight:600;' +
                    (primary ? 'background:#2d88ff;color:#fff;' : 'background:#3a3b3c;color:#e4e6eb;');
                b.addEventListener('click', onClick);
                return b;
            }
            const close = () => { overlay.remove(); dialog = null; };
            row.appendChild(button('Tiếp tục', false, close));
            row.appendChild(button('Nghỉ ngơi', true, () => { st.active = 0; st.marks = 0; save(); close(); }));
            card.appendChild(title); card.appendChild(desc); card.appendChild(row);
            overlay.appendChild(card);
            (document.body || document.documentElement).appendChild(overlay);
            dialog = overlay;
        }

        function fmt(ms) {
            const s = Math.max(0, Math.ceil(ms / 1000));
            return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        }

        // One second of on-screen time.
        function tick(visible) {
            if (dialog && dialog.isConnected === false) dialog = null; // removed by a page re-render
            if (!visible) return;
            st.active += 1000;
            st.last = Date.now();
            const reached = Math.floor(st.active / INTERVAL);
            if (reached > st.marks) {
                st.marks = reached;
                hidePill();
                showBreak(Math.round(st.active / 60000));
            } else {
                const remaining = (st.marks + 1) * INTERVAL - st.active;
                if (remaining <= WARN && !dialog) showPill(fmt(remaining)); else hidePill();
            }
            if (st.active % 5000 === 0) save();
        }

        setInterval(() => tick(document.visibilityState === 'visible'), 1000);
        document.addEventListener('visibilitychange', save);
        window.addEventListener('pagehide', save);
        window.__pbTimerApi = { tick, state: st, displayName };
    } catch (err) {
        try { console.warn('[PureBook] fb_timer failed', err); } catch (e) {}
    }
})();
