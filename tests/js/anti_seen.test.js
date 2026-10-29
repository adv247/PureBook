'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

function boot(extra = {}) {
    const sent = [];
    // A fresh class per boot: the script patches WebSocket.prototype.send, so sharing one would stack wrappers.
    class FakeWebSocket { send(data) { sent.push(data); } }
    const calls = [];
    class FakeResponse { constructor(body, init) { this.body = body; this.init = init; } }
    class FakeXhr {
        open(method, url) { this.url = url; }
        send(body) { calls.push('xhr:' + this.url); }
        dispatchEvent() {}
    }
    const w = load('anti_seen.js', Object.assign({
        ArrayBuffer, Uint8Array,
        document: { cookie: 'datr=x; c_user=1000123; xs=y' },
        navigator: { sendBeacon() { calls.push('beacon'); return true; } },
        WebSocket: FakeWebSocket,
        XMLHttpRequest: FakeXhr,
        Response: FakeResponse,
        fetch(url) { calls.push('fetch:' + url); return Promise.resolve('real'); },
    }, extra));
    return { w, calls, Xhr: FakeXhr, sent, socket: () => new FakeWebSocket() };
}

// ---- MQTT helpers (a PUBLISH packet is the only thing the script touches) ----
function publish(topic, bodyText, qos = 1) {
    const t = Buffer.from(topic);
    const body = Buffer.from(bodyText);
    const rem = 2 + t.length + (qos ? 2 : 0) + body.length;
    const len = [];
    let x = rem;
    do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; len.push(d); } while (x > 0);
    return new Uint8Array(Buffer.concat([
        Buffer.from([0x30 | (qos << 1), ...len, t.length >> 8, t.length & 255]), t,
        qos ? Buffer.from([0, 7]) : Buffer.alloc(0), body,
    ]));
}
function unpublish(bytes) {
    const buf = Buffer.from(bytes);
    let i = 1;
    while (buf[i] & 128) i++;
    i++;
    const tl = (buf[i] << 8) | buf[i + 1];
    const topic = buf.subarray(i + 2, i + 2 + tl).toString();
    const qos = (buf[0] >> 1) & 3;
    const p = i + 2 + tl + (qos ? 2 : 0);
    return { topic, body: buf.subarray(p).toString(), qos, id: qos ? [buf[p - 2], buf[p - 1]] : null };
}
const lsReq = (tasks, type = 3) => JSON.stringify({ app_id: '772021112871879', payload: JSON.stringify({ epoch_id: 123, data_trace_id: null, tasks }), request_id: 5, type });
const task = (label, payload) => ({ label, payload: JSON.stringify(payload), queue_name: '1', task_id: 1, failure_count: null });
const SEEN = task('21', { thread_id: 61550000000000001, last_read_watermark_ts: 1700000000000, sync_group: 1 });
const SEND = task('46', { thread_id: 99, otid: '1', send_type: 1, text: 'hello' });

test('typing frames (type 4, with thread_key) are dropped', () => {
    const { w, sent, socket } = boot();
    const typing = JSON.stringify({ app_id: '1', payload: JSON.stringify({ label: '3', payload: JSON.stringify({ thread_key: 5, is_group_thread: 0, is_typing: 1 }) }), request_id: 6, type: 4 });
    socket().send(publish('/ls_req', typing));
    assert.equal(sent.length, 0);
    assert.equal(w.__pbPrivacy.blocked, 1);
});

test("'seen' is rewritten to the user's own id instead of dropped, and keeps the packet shape", () => {
    const { sent, socket } = boot();
    socket().send(publish('/ls_req', lsReq([SEEN])));
    assert.equal(sent.length, 1, 'the request still goes out, so the reply to it still comes back');
    const out = unpublish(sent[0]);
    assert.equal(out.topic, '/ls_req');
    assert.equal(out.qos, 1);
    assert.deepEqual(out.id, [0, 7], 'packet id kept');
    const inner = JSON.parse(JSON.parse(out.body).payload);
    const marker = JSON.parse(inner.tasks[0].payload);
    assert.equal(marker.thread_id, '1000123', 'points at the user, not at the chat');
    assert.equal(inner.tasks[0].label, '21');
});

test('a frame that also sends a message keeps the message untouched', () => {
    const { sent, socket } = boot();
    socket().send(publish('/ls_req', lsReq([SEEN, SEND])));
    const inner = JSON.parse(JSON.parse(unpublish(sent[0]).body).payload);
    assert.equal(JSON.parse(inner.tasks[0].payload).thread_id, '1000123');
    assert.deepEqual(inner.tasks[1], SEND, 'the send task is byte-for-byte the same');
});

test('ids larger than 2^53 are not corrupted by the rewrite', () => {
    const { sent, socket } = boot();
    const innerRaw = '{"epoch_id":7203943333000000123,"data_trace_id":null,"tasks":[{"label":"21","payload":"{\\"thread_id\\":61550000000000001,\\"last_read_watermark_ts\\":1700000000000,\\"sync_group\\":1}","queue_name":"1","task_id":1,"failure_count":null}]}';
    const outerRaw = '{"app_id":"772021112871879","payload":' + JSON.stringify(innerRaw) + ',"request_id":5,"type":3}';
    assert.notEqual(JSON.stringify(JSON.parse(innerRaw)), innerRaw, 'precondition: a JSON round trip would change this frame');
    socket().send(publish('/ls_req', outerRaw));
    const text = unpublish(sent[0]).body;
    assert.ok(text.includes('7203943333000000123'), 'epoch_id digits intact');
    assert.ok(!text.includes('61550000000000001'), 'the chat id is gone');
    assert.ok(text.includes('1000123'));
});

test('frames that are not read/typing pass through byte for byte', () => {
    const { sent, socket } = boot();
    const frames = [
        publish('/ls_req', lsReq([SEND])),
        publish('/t_ms', '{"hello":1}'),
        publish('/ls_req', lsReq([SEND]), 0),
    ];
    frames.forEach(f => socket().send(f));
    assert.equal(sent.length, 3);
    frames.forEach((f, i) => assert.deepEqual(Buffer.from(sent[i]), Buffer.from(f)));
});

test('a frame carrying several MQTT packets is left alone', () => {
    const { sent, socket } = boot();
    const a = publish('/ls_req', lsReq([SEEN]));
    const joined = new Uint8Array(Buffer.concat([Buffer.from(a), Buffer.from(a)]));
    socket().send(joined);
    assert.deepEqual(Buffer.from(sent[0]), Buffer.from(joined));
});

test('without the switches nothing is touched', () => {
    const { sent, socket } = boot({ __pbPrivacy: { blockSeen: false, blockTyping: false } });
    const f = publish('/ls_req', lsReq([SEEN]));
    socket().send(f);
    assert.deepEqual(Buffer.from(sent[0]), Buffer.from(f));
});

test('without a user id a lone seen frame is dropped, a mixed one is passed', () => {
    const { sent, socket } = boot({ document: { cookie: '' } });
    socket().send(publish('/ls_req', lsReq([SEEN])));
    assert.equal(sent.length, 0);
    const mixed = publish('/ls_req', lsReq([SEEN, SEND]));
    socket().send(mixed);
    assert.deepEqual(Buffer.from(sent[0]), Buffer.from(mixed), 'never lose a message to hide a read marker');
});

test('HTTP: read/typing/story requests get a fake success, others go through', async () => {
    const { w, calls, Xhr } = boot();
    const gql = name => 'fb_api_req_friendly_name=' + name + '&doc_id=1';
    const fake = await w.fetch('/api/graphql/', { method: 'POST', body: gql('MessengerThreadMarkAsReadMutation') });
    assert.ok(fake.body.includes('is_final'));
    const story = await w.fetch('/api/graphql/', { method: 'POST', body: gql('storiesUpdateSeenStateMutation') });
    assert.ok(story.body.includes('is_final'));
    const typing = await w.fetch('/ajax/messaging/typ.php', { method: 'POST', body: 'typ=1' });
    assert.ok(typing.body.startsWith('for (;;);'));
    assert.equal(await w.fetch('/api/graphql/', { method: 'POST', body: gql('CometFeedQuery') }), 'real');
    const x = new Xhr();
    x.open('POST', '/ajax/mercury/change_read_status.php');
    x.send('a=1');
    assert.deepEqual(calls, ['fetch:/api/graphql/'], 'only the feed query reached the network');
    assert.equal(w.navigator.sendBeacon('/ajax/mercury/mark_seen.php', 'x=1'), true);
    assert.ok(!calls.includes('beacon'));
});
