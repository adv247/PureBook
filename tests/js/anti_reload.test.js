'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { load } = require('./helpers');

function boot() {
    const window = new EventTarget();
    const document = new EventTarget();
    document.visibilityState = 'visible';
    const video = { paused: false, ended: false, played: 0, hasAttribute: () => false, play() { this.played++; return Promise.resolve(); } };
    document.querySelectorAll = () => [video];
    document.body = { hasAttribute: () => false };
    const w = load('anti_reload.js', { window, document });
    return { window, document, video, api: window.__pbAntiReloadApi, w };
}

test("blocks Facebook's handlers on 'visible' but keeps PureBook's own and resumes playing videos", () => {
    const { window, document, video, api } = boot();
    const log = [];
    api.opts.fromPage = () => true;                       // registered by Facebook's code
    window.addEventListener('visibilitychange', () => log.push('facebook'));
    api.opts.fromPage = () => false;                      // registered by a PureBook script
    document.addEventListener('visibilitychange', () => log.push('purebook'), true);
    assert.equal(api.ours.length, 1, "PureBook's listener goes through the gate");

    document.visibilityState = 'hidden';
    window.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(log.sort(), ['facebook', 'purebook'], "'hidden' reaches everyone, so Facebook still pauses videos");
    log.length = 0;

    video.paused = true;                                   // Facebook paused it on hide
    document.visibilityState = 'visible';
    window.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(log, ['purebook'], "'visible' is hidden from Facebook only");
    assert.equal(video.played, 1, 'the video that was playing resumes');
});

test('does not resume videos while in picture-in-picture', () => {
    const { window, document, video } = boot();
    document.visibilityState = 'hidden';
    window.dispatchEvent(new Event('visibilitychange'));
    video.paused = true;
    document.body = { hasAttribute: name => name === 'data-astryx-pip-active' };
    document.visibilityState = 'visible';
    window.dispatchEvent(new Event('visibilitychange'));
    assert.equal(video.played, 0);
});

test('removeEventListener drops a PureBook listener from the gate', () => {
    const { document, api } = boot();
    api.opts.fromPage = () => false;
    const fn = () => {};
    document.addEventListener('visibilitychange', fn, true);
    assert.equal(api.ours.length, 1);
    document.removeEventListener('visibilitychange', fn, true);
    assert.equal(api.ours.length, 0);
});

test('a page restored from the back/forward cache is blocked, a normal pageshow is not', () => {
    const { window, document, api } = boot();
    const log = [];
    api.opts.fromPage = () => true;
    window.addEventListener('pageshow', () => log.push('facebook'));
    const normal = new Event('pageshow');
    normal.persisted = false;
    window.dispatchEvent(normal);
    assert.deepEqual(log, ['facebook'], 'first load: Facebook must still initialise');
    log.length = 0;
    const restored = new Event('pageshow');
    restored.persisted = true;
    document.visibilityState = 'visible';
    window.dispatchEvent(restored);
    assert.deepEqual(log, [], 'bfcache restore is where it would refresh');
});

test('classifies callers by their stack: a script with a URL is the page, an app script is not', () => {
    const { w, api } = boot();
    vm.runInContext("window.addEventListener('visibilitychange', function () {})", w, { filename: 'https://static.xx.fbcdn.net/rsrc.php/v4/app.js' });
    vm.runInContext("window.addEventListener('visibilitychange', function () {})", w, { filename: 'https://m.facebook.com/' });
    assert.equal(api.ours.length, 0, 'CDN script and inline page script both count as Facebook');
    vm.runInContext("window.addEventListener('visibilitychange', function () {})", w, { filename: 'evaluateJavascript.js' });
    assert.equal(api.ours.length, 1, 'an app-evaluated script is PureBook');
});

test('forgets the remembered videos after one hide/show cycle', () => {
    const { window, document, video } = boot();
    document.visibilityState = 'hidden';
    window.dispatchEvent(new Event('visibilitychange'));
    document.visibilityState = 'visible';
    window.dispatchEvent(new Event('visibilitychange'));
    assert.equal(video.played, 1);
    video.paused = true;
    window.dispatchEvent(new Event('visibilitychange'));   // a second 'visible' without a 'hidden' in between
    assert.equal(video.played, 1, 'nothing left to resume');
});
