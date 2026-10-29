'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

function boot() {
    const window = new EventTarget();
    const document = new EventTarget();
    document.visibilityState = 'visible';
    const video = { paused: false, ended: false, played: 0, hasAttribute: () => false, play() { this.played++; return Promise.resolve(); } };
    document.querySelectorAll = () => [video];
    document.body = { hasAttribute: () => false };
    const w = load('anti_reload.js', { window, document });
    return { window, document, video, api: window.__pbAntiReloadApi };
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
