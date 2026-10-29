(function () {
    'use strict';
    // Anti-seen / anti-typing: stops Messenger from telling the other side that you read a chat
    // or are typing. Hooks every path the web client can use:
    //   - fetch, XMLHttpRequest and navigator.sendBeacon (legacy ajax + GraphQL mutations)
    //   - WebSocket.send: modern Messenger sends both signals as MQTT PUBLISH on topic /ls_req
    //     (LightSpeed "tasks": mark-thread-read carries last_read_watermark_ts, typing carries
    //     is_typing). A frame is dropped only when EVERY task in it is a seen/typing task, so a
    //     message send is never lost. Frames are never re-encoded (ids exceed 2^53).
    // Patching the prototypes also covers sockets that were opened before this script ran.
    // Switch at runtime: window.__pbPrivacy.blockSeen / .blockTyping = false.
    try {
        if (window.__pbAntiSeen) return;
        const cfg = window.__pbPrivacy = Object.assign({ blockSeen: true, blockTyping: true, debug: false, blocked: 0 }, window.__pbPrivacy);
        window.__pbAntiSeen = true;

        const SEEN_URL = /\/ajax\/mercury\/(change_read_status|mark_seen|mark_folder_as_read)|\/ajax\/messaging\/mark_|\/ajax\/mercury\/read_receipts/i;
        const TYPING_URL = /\/ajax\/messaging\/typ\.php|\/ajax\/mercury\/typing|\/typ\.php/i;
        const SEEN_NAME = /(MarkAsRead|MarkThreadRead|MarkThreadsRead|MarkSeen|ReadReceipt|ThreadReadState|ReadWatermark|SetThreadRead|MarkRead)/i;
        const TYPING_NAME = /(TypingIndicator|SendTyping|ThreadTyping|SetTyping|TypingState)/i;
        const GRAPHQL_URL = /graphql|\/api\/|\/ajax\//i;

        function log(kind, what) {
            cfg.blocked++;
            if (cfg.debug) { try { console.debug('[PureBook] blocked ' + kind + ':', what); } catch (e) {} }
        }

        function bodyText(body) {
            if (body == null) return '';
            if (typeof body === 'string') return body;
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                const out = [];
                body.forEach((v, k) => { if (typeof v === 'string') out.push(k + '=' + v); });
                return out.join('&');
            }
            return null; // Blob / stream: cannot be read synchronously
        }

        function friendlyName(text) {
            const m = /fb_api_req_friendly_name=([^&]+)/.exec(text || '');
            if (!m) return '';
            try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
        }

        function blockHttp(url, text) {
            url = String(url || '');
            if (cfg.blockSeen && SEEN_URL.test(url)) return 'seen';
            if (cfg.blockTyping && TYPING_URL.test(url)) return 'typing';
            if (text && GRAPHQL_URL.test(url)) {
                const name = friendlyName(text);
                if (name) {
                    if (cfg.blockSeen && SEEN_NAME.test(name)) return 'seen';
                    if (cfg.blockTyping && TYPING_NAME.test(name)) return 'typing';
                }
            }
            return '';
        }

        // ---- MQTT /ls_req ----
        function classifyTask(task) {
            if (!task) return '';
            let p = task.payload;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
            if (p && typeof p === 'object') {
                if ('last_read_watermark_ts' in p) return 'seen';
                if ('is_typing' in p) return 'typing';
            }
            return '';
        }

        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

        function mqttVerdict(bytes) {
            if (!decoder) return '';
            const text = decoder.decode(bytes);
            const i = text.indexOf('{');
            const j = text.lastIndexOf('}');
            if (i < 0 || j < i || text.indexOf('/ls_req') < 0 && text.indexOf('tasks') < 0) return '';
            let tasks = null;
            try {
                const outer = JSON.parse(text.slice(i, j + 1));
                const inner = typeof outer.payload === 'string' ? JSON.parse(outer.payload) : outer.payload;
                tasks = inner && inner.tasks;
            } catch (e) { return ''; }
            if (!Array.isArray(tasks) || !tasks.length) return '';
            let kind = '';
            for (const t of tasks) {
                const k = classifyTask(t);
                if (!k) return '';                        // a real task rides in this frame: let it through
                if (k === 'seen' && !cfg.blockSeen) return '';
                if (k === 'typing' && !cfg.blockTyping) return '';
                kind = k;
            }
            return kind;
        }

        // ---- fetch ----
        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
            const fakeBody = url => /graphql/i.test(url) ? '{"data":{},"extensions":{"is_final":true}}' : 'for (;;);{"__ar":1,"payload":null}';
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
                    const text = bodyText(init && init.body);
                    if (text !== null) {
                        const kind = blockHttp(url, text);
                        if (kind) { log(kind, url); return Promise.resolve(new Response(fakeBody(url), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    } else if (typeof Request !== 'undefined' && input instanceof Request && GRAPHQL_URL.test(url)) {
                        const self = this;
                        const args = arguments;
                        return input.clone().text().then(t => {
                            const kind = blockHttp(url, t);
                            if (kind) { log(kind, url); return new Response(fakeBody(url), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
                            return origFetch.apply(self, args);
                        }, () => origFetch.apply(self, args));
                    }
                } catch (e) {}
                return origFetch.apply(this, arguments);
            };
        }

        // ---- XMLHttpRequest ----
        const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (XHR) {
            const origOpen = XHR.open;
            const origSend = XHR.send;
            XHR.open = function (method, url) {
                try { this.__pbUrl = String(url); } catch (e) {}
                return origOpen.apply(this, arguments);
            };
            XHR.send = function (body) {
                try {
                    const text = bodyText(body);
                    const kind = text !== null ? blockHttp(this.__pbUrl, text) : '';
                    if (kind) {
                        log(kind, this.__pbUrl);
                        const xhr = this;
                        const raw = /graphql/i.test(xhr.__pbUrl) ? '{"data":{}}' : 'for (;;);{"__ar":1,"payload":null}';
                        const value = xhr.responseType === 'json' ? { data: {} } : raw;
                        const def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
                        def('readyState', 4); def('status', 200); def('statusText', 'OK');
                        def('response', value); def('responseURL', xhr.__pbUrl);
                        if (xhr.responseType === '' || xhr.responseType === 'text') def('responseText', raw);
                        setTimeout(() => {
                            ['readystatechange', 'load', 'loadend'].forEach(type => {
                                try { xhr.dispatchEvent(typeof ProgressEvent !== 'undefined' && type !== 'readystatechange' ? new ProgressEvent(type) : new Event(type)); } catch (e) {}
                            });
                        }, 0);
                        return;
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        }

        // ---- sendBeacon ----
        if (navigator.sendBeacon) {
            const origBeacon = navigator.sendBeacon;
            navigator.sendBeacon = function (url, data) {
                try {
                    const text = bodyText(data);
                    const kind = text !== null ? blockHttp(url, text) : blockHttp(url, '');
                    if (kind) { log(kind, url); return true; }
                } catch (e) {}
                return origBeacon.apply(navigator, arguments);
            };
        }

        // ---- WebSocket (MQTT) ----
        const WS = window.WebSocket && window.WebSocket.prototype;
        if (WS) {
            const origWsSend = WS.send;
            WS.send = function (data) {
                try {
                    let bytes = null;
                    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
                    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                    if (bytes) {
                        const kind = mqttVerdict(bytes);
                        if (kind) { log(kind, 'ws /ls_req'); return; }
                    }
                } catch (e) {}
                return origWsSend.apply(this, arguments);
            };
        }
    } catch (err) {
        try { console.warn('[PureBook] anti_seen failed', err); } catch (e) {}
    }
})();
