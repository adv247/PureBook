(function () {
    'use strict';
    // Anti-seen / anti-typing: stops Messenger from telling the other side that you read a chat,
    // are typing, or viewed a story. Hooks every path the web client can use:
    //   - fetch, XMLHttpRequest and navigator.sendBeacon (legacy ajax + GraphQL mutations)
    //   - WebSocket.prototype.send: Messenger sends both signals as MQTT PUBLISH on /ls_req.
    //       typing  (outer type 4, task payload has thread_key): the frame is dropped; nothing
    //                waits for an answer to it.
    //       seen    (outer type 3, task label "21" = mark thread read): the frame is NOT dropped,
    //                because the client waits for the reply to that request. The read marker is
    //                rewritten to point at the user's own id, a thread that does not exist, so the
    //                request completes normally and no chat is marked as read. Other tasks that
    //                travel in the same frame (a message being sent) are left untouched.
    // Large ids (> 2^53) are never re-serialised through JSON when that would change them: those
    // frames are edited as text instead.
    // Patching the prototypes also covers sockets that were opened before this script ran.
    // Switch at runtime: window.__pbPrivacy.blockSeen / .blockTyping / .blockStories = false.
    try {
        if (window.__pbAntiSeen) return;
        const cfg = window.__pbPrivacy = Object.assign({ blockSeen: true, blockTyping: true, blockStories: true, debug: false, blocked: 0 }, window.__pbPrivacy);
        window.__pbAntiSeen = true;

        const SEEN_URL = /\/ajax\/mercury\/(change_read_status|mark_seen|mark_folder_as_read)|\/ajax\/messaging\/mark_|\/ajax\/mercury\/read_receipts/i;
        const TYPING_URL = /\/ajax\/messaging\/typ\.php|\/ajax\/mercury\/typing|\/typ\.php/i;
        const SEEN_NAME = /(MarkAsRead|MarkThreadRead|MarkThreadsRead|MarkSeen|ReadReceipt|ThreadReadState|ReadWatermark|SetThreadRead|MarkRead)/i;
        const TYPING_NAME = /(TypingIndicator|SendTyping|ThreadTyping|SetTyping|TypingState)/i;
        const STORY_NAME = /(StoriesUpdateSeenState|Stor(?:y|ies)\w*Seen\w*Mutation|StoryViewerSeen)/i;
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
                    if (cfg.blockStories && STORY_NAME.test(name)) return 'story';
                    if (cfg.blockSeen && SEEN_NAME.test(name)) return 'seen';
                    if (cfg.blockTyping && TYPING_NAME.test(name)) return 'typing';
                }
            }
            return '';
        }

        // ---- MQTT /ls_req over WebSocket ----
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
        const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

        function parse(text) {
            if (typeof text !== 'string') return null;
            try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
        }

        // One PUBLISH packet that fills the whole frame; anything else is left alone.
        function parsePublish(bytes) {
            if (bytes.length < 4 || (bytes[0] >> 4) !== 3) return null;
            const qos = (bytes[0] >> 1) & 3;
            let i = 1, mult = 1, rem = 0, b;
            do {
                if (i >= bytes.length || i > 4) return null;
                b = bytes[i++];
                rem += (b & 127) * mult;
                mult *= 128;
            } while (b & 128);
            if (i + rem !== bytes.length) return null;
            const tl = (bytes[i] << 8) | bytes[i + 1];
            const topic = decoder.decode(bytes.subarray(i + 2, i + 2 + tl));
            let p = i + 2 + tl;
            let id = null;
            if (qos > 0) { id = [bytes[p], bytes[p + 1]]; p += 2; }
            return { head: bytes[0], topic: topic, id: id, body: bytes.subarray(p) };
        }

        function buildPublish(pkt, bodyBytes) {
            const topic = encoder.encode(pkt.topic);
            const rem = 2 + topic.length + (pkt.id ? 2 : 0) + bodyBytes.length;
            const len = [];
            let x = rem;
            do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; len.push(d); } while (x > 0);
            const out = new Uint8Array(1 + len.length + rem);
            let o = 0;
            out[o++] = pkt.head;
            len.forEach(v => { out[o++] = v; });
            out[o++] = topic.length >> 8;
            out[o++] = topic.length & 255;
            out.set(topic, o); o += topic.length;
            if (pkt.id) { out[o++] = pkt.id[0]; out[o++] = pkt.id[1]; }
            out.set(bodyBytes, o);
            return out;
        }

        function userId() {
            const m = /(?:^|;\s*)c_user=(\d+)/.exec(String(document.cookie || ''));
            return m ? m[1] : null;
        }

        const isSeenTask = t => !!t && String(t.label) === '21';
        const isTypingTask = t => {
            const p = t && parse(t.payload);
            return !!p && ('is_typing' in p || 'thread_key' in p) && !('last_read_watermark_ts' in p);
        };

        function isTypingFrame(outer) {
            if (outer.type === 4) {                      // fire-and-forget request
                const task = parse(outer.payload);
                const p = task && parse(task.payload);
                return !!p && ('thread_key' in p || 'is_typing' in p);
            }
            const body = parse(outer.payload);
            return !!body && Array.isArray(body.tasks) && body.tasks.length > 0 && body.tasks.every(isTypingTask);
        }

        // New frame text with every "mark thread read" task pointed at the user's own id, or null.
        function rewriteSeen(outerText, outer) {
            if (outer.type !== 3 || typeof outer.payload !== 'string') return null;
            const body = parse(outer.payload);
            if (!body || !Array.isArray(body.tasks) || !body.tasks.some(isSeenTask)) return null;
            const uid = userId();
            if (!uid) return null;
            const fake = JSON.stringify({ thread_id: uid, last_read_watermark_ts: Date.now() });
            if (JSON.stringify(body) === outer.payload && JSON.stringify(outer) === outerText) {
                body.tasks.forEach(t => { if (isSeenTask(t)) t.payload = fake; });
                outer.payload = JSON.stringify(body);
                return JSON.stringify(outer);
            }
            // Ids too large for a double: edit the text instead of re-serialising it.
            let hits = 0;
            const inner = outer.payload.replace(/("label"\s*:\s*"21"\s*,\s*"payload"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (m, head) => { hits++; return head + JSON.stringify(fake); });
            const literal = JSON.stringify(outer.payload);
            if (!hits || outerText.indexOf(literal) < 0) return null;
            return outerText.replace(literal, () => JSON.stringify(inner));
        }

        // 'drop' | Uint8Array (frame to send instead) | null (send as it is)
        function inspectFrame(bytes) {
            if (!decoder || !encoder) return null;
            const pkt = parsePublish(bytes);
            if (!pkt || pkt.topic !== '/ls_req') return null;
            const text = decoder.decode(pkt.body);
            const outer = parse(text);
            if (!outer) return null;
            if (cfg.blockTyping && isTypingFrame(outer)) { log('typing', 'ws /ls_req'); return 'drop'; }
            if (cfg.blockSeen) {
                const next = rewriteSeen(text, outer);
                if (next) { log('seen', 'ws /ls_req'); return buildPublish(pkt, encoder.encode(next)); }
                // No user id to point the marker at: drop the frame only when nothing else rides in it.
                const body = parse(outer.payload);
                if (outer.type === 3 && body && Array.isArray(body.tasks) && body.tasks.length && body.tasks.every(isSeenTask) && !userId()) {
                    log('seen', 'ws /ls_req (dropped)');
                    return 'drop';
                }
            }
            return null;
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
                        const verdict = inspectFrame(bytes);
                        if (verdict === 'drop') return;
                        if (verdict) return origWsSend.call(this, verdict.buffer);
                    }
                } catch (e) {}
                return origWsSend.apply(this, arguments);
            };
        }
    } catch (err) {
        try { console.warn('[PureBook] anti_seen failed', err); } catch (e) {}
    }
})();
