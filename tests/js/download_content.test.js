'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, element, makeDocument } = require('./helpers');

class FakeMedia {
    constructor() { this.currentSrc = 'blob:video'; this._src = ''; }
    play() { return Promise.resolve(); }
    get src() { return this._src; }
    set src(v) { this._src = v; }
}

function boot() {
    const document = makeDocument();
    document.readyState = 'complete';
    document.createElement = tag => Object.assign(element(tag), { classList: { add() {}, remove() {} } });
    let lookups = 0;
    const getById = document.getElementById;
    document.getElementById = id => { lookups++; return getById(id); };
    const observers = [];
    class FakeObserver { constructor(cb) { observers.push(cb); } observe() {} }
    const w = load('download_content.js', {
        document, atob, HTMLMediaElement: FakeMedia, MutationObserver: FakeObserver,
        XMLHttpRequest: class { open() {} }, fetch: () => Promise.resolve(),
        location: { href: 'https://m.facebook.com/' }, isFeed: () => true,
    });
    w.location = { href: 'https://m.facebook.com/' };
    return { w, observers, lookups: () => lookups };
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const videoUrl = (tag, name) => 'https://video.xx.fbcdn.net/v/' + name + '.mp4?efg=' + b64({ vencode_tag: tag });

test('DOM mutation bursts are handled once per quiet quarter second, not once per batch', async () => {
    const { observers, lookups } = boot();
    assert.equal(observers.length, 1);
    const afterInit = lookups();
    for (let i = 0; i < 200; i++) observers[0]([{ type: 'childList', addedNodes: [{}] }]);
    assert.equal(lookups(), afterInit, 'nothing runs synchronously inside the burst');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(lookups() - afterInit, 1, 'one pass for the whole burst');
    observers[0]([{ type: 'attributes', target: { tagName: 'DIV' } }]);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(lookups() - afterInit, 1, 'irrelevant attribute changes cost nothing');
});

test('the sharpest representation the player fetched is offered first', () => {
    const { w } = boot();
    const video = new FakeMedia();
    FakeMedia.prototype.play.call(video);
    ['dash_h264-basic-gen2_360p', 'dash_h264-basic-gen2_720p', 'dash_h264-basic-gen2_480p'].forEach((tag, i) => w.fetch(videoUrl(tag, 'v' + i)));
    w.fetch(videoUrl('dash_ln_heaacv2_vbr3_audio', 'audio'));
    w.fetch(videoUrl('progressive_h264-basic-gen2_720p', 'muxed'));
    const c = w.__materialbookCandidates(video);
    assert.deepEqual([...c.video.map(u => /\/(v\d)\.mp4/.exec(u)[1])], ['v1', 'v2', 'v0'], '720p, 480p, 360p');
    assert.equal(c.progressive.length, 1);
    assert.equal(c.audio.length, 1);
});

test('equally sharp candidates keep the newest first', async () => {
    const { w } = boot();
    const video = new FakeMedia();
    FakeMedia.prototype.play.call(video);
    w.fetch(videoUrl('dash_h264-basic-gen2_720p', 'old'));
    await new Promise(resolve => setTimeout(resolve, 5));
    w.fetch(videoUrl('dash_h264-basic-gen2_720p', 'new'));
    const names = [...w.__materialbookCandidates(video).video.map(u => /\/(\w+)\.mp4/.exec(u)[1])];
    assert.deepEqual(names, ['new', 'old']);
});

test('the per-element URL table does not pin elements: only the last few are tracked for the debug hook', () => {
    const { w } = boot();
    for (let i = 0; i < 20; i++) {
        const video = new FakeMedia();
        FakeMedia.prototype.play.call(video);
        w.fetch(videoUrl('dash_h264-basic-gen2_360p', 'x' + i));
    }
    const snapshot = w.__materialbookCaptured();
    assert.ok(snapshot.byElement.length <= 8, 'bounded');
    assert.ok(snapshot.byElement.length > 0, 'and still useful');
    assert.ok(snapshot.global.length > 0);
});

test('the HD video the page announced goes first among the muxed candidates', () => {
    const { w } = boot();
    const hd = 'https://video.xx.fbcdn.net/v/hd.mp4?x=1';
    const video = new FakeMedia();
    FakeMedia.prototype.play.call(video);
    w.fetch(videoUrl('progressive_h264-basic-gen2_360p', 'low'));
    w.__pbHdUrlFor = () => hd;
    const payload = w.__materialbookPayload(video);
    assert.equal(payload.progressive[0], hd);
    assert.equal(payload.progressive.length, 2, 'the player\'s own muxed file stays as a fallback');
    w.__pbHdUrlFor = () => null;
    assert.ok(![...w.__materialbookPayload(video).progressive].includes(hd), 'nothing announced: nothing added');
    delete w.__pbHdUrlFor;
    assert.equal(w.__materialbookPayload(video).progressive.length, 1, 'media_quality.js absent: unchanged behaviour');
});
