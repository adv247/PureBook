(function () {
    'use strict';
    // Free text copy. Facebook's mobile pages often leave post text impossible to select
    // (long-press does nothing). This (1) switches text selection back on for post text and
    // (2) adds a fallback: hold a finger on a post's text and a sheet opens with the full post
    // in a box where any part can be selected, plus "copy selection" / "copy all" buttons.
    // If the page's own long-press selection works, it is left alone.
    try {
        if (window.__pbTextSelect) return;
        window.__pbTextSelect = true;

        const HOLD_MS = 550;
        const MOVE_TOLERANCE = 12;
        const POST = 'div[role="article"], div[data-tracking-duration-id]';
        const COMMENT = '[role="comment"], [aria-label*="comment" i], [data-sigil*="comment"], [data-comment-preview], [data-pagelet*="Comment"]';
        const IGNORE = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="menu"], [role="dialog"], [role="textbox"], [contenteditable="true"], [aria-label*="menu" i], #pb-copy-sheet';
        const TEXT_SELECTORS = ['[data-ad-preview="message"]', '[data-ad-rendering-role="story_message"]', '.userContent', '.story_body_container', '.native-text'];

        // 1) Selection switched back on for post text.
        const style = document.createElement('style');
        style.id = 'pb-text-select-style';
        style.textContent =
            '.native-text, .native-text *, [data-ad-preview="message"], [data-ad-preview="message"] *,' +
            '[data-ad-rendering-role="story_message"], [data-ad-rendering-role="story_message"] *,' +
            '.userContent, .userContent *, .story_body_container, .story_body_container * {' +
            '-webkit-user-select:text !important;user-select:text !important;-webkit-touch-callout:default !important;}' +
            '#pb-copy-sheet, #pb-copy-sheet * {-webkit-user-select:text !important;user-select:text !important;}';
        (document.head || document.documentElement).appendChild(style);
        // Some Facebook handlers cancel selectstart; the selection itself is the default action.
        document.addEventListener('selectstart', e => { e.stopImmediatePropagation(); }, true);

        function clean(raw) {
            if (!raw) return '';
            return raw.replace(/\u00a0/g, ' ').replace(/[\u200b\u200c\u200d]/g, '')
                .replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        }
        function postText(container) {
            for (const sel of TEXT_SELECTORS) {
                let best = '';
                container.querySelectorAll(sel).forEach(n => {
                    const t = clean(n.innerText || n.textContent);
                    if (t.length > best.length) best = t;
                });
                if (best) return best;
            }
            return clean(container.innerText || container.textContent);
        }

        // 2) The copy sheet.
        function copy(text) {
            if (!text) return false;
            if (window.FaceboostPage) window.FaceboostPage.postMessage(JSON.stringify({ call: 'copyText', text: text }));
            else if (window.ClipboardBridge && window.ClipboardBridge.copyText) window.ClipboardBridge.copyText(text);
            else { try { navigator.clipboard.writeText(text); } catch (e) { return false; } }
            return true;
        }
        function el(tag, css, text) {
            const n = document.createElement(tag);
            if (css) n.style.cssText = css;
            if (text) n.textContent = text;
            return n;
        }
        function closeSheet() {
            const old = document.getElementById('pb-copy-sheet');
            if (old) old.remove();
        }
        function openSheet(text) {
            closeSheet();
            const wrap = el('div', 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;');
            wrap.id = 'pb-copy-sheet';
            wrap.addEventListener('click', e => { if (e.target === wrap) closeSheet(); });
            const sheet = el('div', 'width:100%;box-sizing:border-box;background:#242526;border-radius:16px 16px 0 0;padding:14px 14px 18px;' +
                'font-family:system-ui,sans-serif;max-height:85vh;display:flex;flex-direction:column;gap:10px;');
            sheet.appendChild(el('div', 'color:#e4e6eb;font-size:15px;font-weight:700;', 'Sao chép văn bản'));
            sheet.appendChild(el('div', 'color:#b0b3b8;font-size:12px;', 'Chạm giữ vào chữ rồi kéo để chọn đoạn cần sao chép.'));
            const box = el('textarea', 'width:100%;box-sizing:border-box;min-height:140px;max-height:45vh;resize:none;border:1px solid #3e4042;' +
                'border-radius:10px;background:#18191a;color:#e4e6eb;font-size:15px;line-height:1.45;padding:10px;');
            box.readOnly = true;
            box.setAttribute('inputmode', 'none');
            box.value = text;
            sheet.appendChild(box);
            const row = el('div', 'display:flex;flex-wrap:wrap;gap:8px;');
            function button(label, primary, onClick) {
                const b = el('button', 'flex:1 1 30%;border:0;border-radius:10px;padding:11px 6px;font-size:13px;font-weight:600;' +
                    (primary ? 'background:#2d88ff;color:#fff;' : 'background:#3a3b3c;color:#e4e6eb;'), label);
                b.addEventListener('click', () => onClick(b, label));
                return b;
            }
            function done(b, label) { b.textContent = 'Đã sao chép ✓'; setTimeout(() => { b.textContent = label; }, 1200); }
            row.appendChild(button('Chọn tất cả', false, () => { box.focus(); box.select(); }));
            row.appendChild(button('Sao chép phần chọn', true, (b, label) => {
                const sel = box.value.substring(box.selectionStart, box.selectionEnd);
                if (copy(sel || box.value)) done(b, label);
            }));
            row.appendChild(button('Sao chép tất cả', false, (b, label) => { if (copy(box.value)) done(b, label); }));
            sheet.appendChild(row);
            sheet.appendChild(button('Đóng', false, closeSheet));
            sheet.lastChild.style.flex = 'none';
            wrap.appendChild(sheet);
            (document.body || document.documentElement).appendChild(wrap);
        }
        window.__pbOpenCopySheet = openSheet;

        // Long press on post text (not on links, buttons, menus or comments).
        let timer = null, startX = 0, startY = 0, target = null, suppressMenu = 0;
        function clear() { if (timer) { clearTimeout(timer); timer = null; } target = null; }
        function postOf(node) {
            if (!node || node.nodeType !== 1) return null;
            if (node.closest(IGNORE) || node.closest(COMMENT)) return null;
            return node.closest(POST);
        }
        document.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) { clear(); return; }
            const post = postOf(e.target);
            if (!post) { clear(); return; }
            startX = e.touches[0].clientX; startY = e.touches[0].clientY; target = e.target;
            timer = setTimeout(() => {
                timer = null;
                let sel = '';
                try { sel = String(window.getSelection() || ''); } catch (err) {}
                const p = target && postOf(target);
                target = null;
                if (sel.length > 0 || !p) return;       // the page's own selection works: leave it
                const text = postText(p);
                if (!text) return;
                suppressMenu = Date.now() + 1500;
                document.dispatchEvent(new Event('touchcancel')); // cancel copy_post_text's copy-all timer
                openSheet(text);
            }, HOLD_MS);
        }, { passive: true });
        document.addEventListener('touchmove', e => {
            if (!timer) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) clear();
        }, { passive: true });
        ['touchend', 'touchcancel'].forEach(t => document.addEventListener(t, clear, { passive: true }));
        document.addEventListener('contextmenu', e => { if (Date.now() < suppressMenu) e.preventDefault(); }, true);
    } catch (err) {
        try { console.warn('[PureBook] text_select failed', err); } catch (e) {}
    }
})();
