'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeDocument } = require('./helpers');

const HD = 'https://video.xx.fbcdn.net/v/t42.9040-2/hd.mp4?efg=abc';
const SD = 'https://video.xx.fbcdn.net/v/t42.9040-2/sd.mp4?efg=def';

function boot(extra = {}) {
    const document = makeDocument();
    document.readyState = 'complete';
    document.querySelectorAll = () => [];
    const calls = { cloned: 0 };
    class FakeXhr {
        open(method, url) { this.url = url; }
        send() {}
        addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; }
    }
    const globals = Object.assign({
        document,
        location: { href: 'https://m.facebook.com/' },
        XMLHttpRequest: FakeXhr,
        fetch: () => Promise.resolve({ headers: { get: () => null }, clone() { calls.cloned++; return { text: () => Promise.resolve(globals.__body || '') }; } }),
    }, extra);
    const w = load('media_quality.js', globals);
    return { w, api: w.__pbMediaQualityApi, calls, globals, FakeXhr };
}
const graphql = obj => 'for (;;);' + JSON.stringify(obj);

test('keeps the HD and SD URL of a video under its id, behind the for(;;); prefix', () => {
    const { w, api } = boot();
    const found = api.parse(graphql({ data: { video: { id: '1234567890', browser_native_hd_url: HD, browser_native_sd_url: SD } } }));
    assert.equal(found, 2);
    assert.equal(w.__pbHdUrlFor('1234567890'), HD);
    assert.equal(w.__pbHdUrlFor('999999999'), null, 'another video gets nothing');
});

test('reads one JSON document per line', () => {
    const { w, api } = boot();
    const lines = [
        JSON.stringify({ data: { node: { id: '111111111', playable_url_quality_hd: HD } } }),
        'not json at all',
        JSON.stringify({ data: { node: { id: '222222222', hd_src: HD.replace('hd.mp4', 'hd2.mp4') } } }),
    ].join('\n');
    assert.equal(api.parse(lines), 2);
    assert.equal(w.__pbHdUrlFor('111111111'), HD);
    assert.ok(w.__pbHdUrlFor('222222222').includes('hd2.mp4'));
});

test('a field nested under a video without its own id takes the nearest id above it', () => {
    const { w, api } = boot();
    api.parse(JSON.stringify({ video: { id: '333333333', media: { deep: [{ browser_native_hd_url: HD }] } } }));
    assert.equal(w.__pbHdUrlFor('333333333'), HD);
});

test('URLs outside Facebook hosts or not https are never accepted', () => {
    const { w, api } = boot();
    const evil = ['https://evil.example.com/v.mp4', 'http://video.xx.fbcdn.net/v.mp4', 'https://fbcdn.net.evil.com/v.mp4', 'javascript:alert(1)'];
    evil.forEach((u, i) => api.parse(JSON.stringify({ video: { id: String(500000000 + i), browser_native_hd_url: u } })));
    evil.forEach((u, i) => assert.equal(w.__pbHdUrlFor(String(500000000 + i)), null, u));
});

test('the media on screen is found from the page address', () => {
    const { w, api } = boot();
    api.parse(JSON.stringify({ video: { id: '987654321', browser_native_hd_url: HD } }));
    w.location.href = 'https://m.facebook.com/reel/987654321';
    assert.equal(w.__pbHdUrlFor(), HD);
    w.location.href = 'https://www.facebook.com/watch/?v=987654321';
    assert.equal(w.__pbHdUrlFor(), HD);
    w.location.href = 'https://www.facebook.com/someone/videos/a-title/987654321/';
    assert.equal(w.__pbHdUrlFor(), HD);
    w.location.href = 'https://m.facebook.com/';
    assert.equal(w.__pbHdUrlFor(), null, 'no id in the address: never guess');
});

test('the largest photo wins', () => {
    const { w, api } = boot();
    const small = 'https://scontent.xx.fbcdn.net/v/small.jpg';
    const big = 'https://scontent.xx.fbcdn.net/v/big.jpg';
    api.parse(JSON.stringify({ photo: { id: '444444444', viewer_image: { uri: small, width: 480, height: 320 } } }));
    api.parse(JSON.stringify({ photo: { id: '444444444', viewer_image: { uri: big, width: 2048, height: 1365 } } }));
    api.parse(JSON.stringify({ photo: { id: '444444444', photo_image: { uri: small, width: 200, height: 200 } } }));
    assert.equal(w.__pbImageUrlFor('444444444'), big);
});

test('memory is bounded: only the most recent media are kept', () => {
    const { w, api } = boot();
    for (let i = 0; i < 200; i++) api.parse(JSON.stringify({ video: { id: String(100000000 + i), browser_native_hd_url: HD } }));
    assert.ok(api.entries.size <= 60);
    assert.equal(w.__pbHdUrlFor('100000199'), HD, 'the newest is kept');
    assert.equal(w.__pbHdUrlFor('100000000'), null, 'the oldest is gone');
});

test('garbage, huge or unrelated bodies are ignored without throwing', () => {
    const { api } = boot();
    assert.equal(api.parse('{broken browser_native_hd_url'), 0);
    assert.equal(api.parse(null), 0);
    assert.equal(api.parse('{"hello":"world"}'), 0);
    assert.equal(api.parse('x'.repeat(3000001) + 'browser_native_hd_url'), 0);
});

test('fetch still returns the original answer untouched, and graphql answers are read', async () => {
    const { w, api, calls, globals } = boot();
    globals.__body = graphql({ data: { video: { id: '606060606', browser_native_hd_url: HD } } });
    const res = await w.fetch('https://www.facebook.com/api/graphql/', { method: 'POST' });
    assert.equal(typeof res.clone, 'function', 'the very same response object comes back');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(w.__pbHdUrlFor('606060606'), HD);
    const before = calls.cloned;
    await w.fetch('https://static.xx.fbcdn.net/rsrc.php/app.js');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.cloned, before, 'other requests are not read');
});

test('XMLHttpRequest answers are read after they load', () => {
    const { w, FakeXhr } = boot();
    const xhr = new FakeXhr();
    xhr.open('POST', '/api/graphql/');
    xhr.send();
    xhr.responseType = '';
    xhr.responseText = graphql({ data: { video: { id: '707070707', playable_url_quality_hd: HD } } });
    xhr.listeners.load();
    assert.equal(w.__pbHdUrlFor('707070707'), HD);
});
