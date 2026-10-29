'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeDocument } = require('./helpers');

function boot() {
    return load('link_privacy.js', {
        document: makeDocument(),
        location: { href: 'https://m.facebook.com/' },
        MutationObserver: class { observe() {} },
        requestAnimationFrame: fn => fn(),
    });
}

const CASES = [
    ['https://l.facebook.com/l.php?u=https%3A%2F%2Fshopee.vn%2Fproduct%2F123%2F456%3Futm_source%3Dan_1%26smtt%3D0.0.9%26sp_atk%3Dabc%26xptdk%3Dxyz%26spm%3Da.b%26id%3D7&h=AT0&__tn__=x',
        'https://shopee.vn/product/123/456?id=7'],
    ['https://www.tiktok.com/@a/video/123?_t=8abc&_r=1&is_from_webapp=1&sender_device=pc&lang=vi',
        'https://www.tiktok.com/@a/video/123?lang=vi'],
    ['https://www.amazon.com/dp/B000?tag=foo-20&linkCode=ll1&th=1&psc=1&pd_rd_r=x',
        'https://www.amazon.com/dp/B000?th=1&psc=1'],
    ['https://example.com/page?id=5&fbclid=IwAR&utm_medium=x&ref=home', 'https://example.com/page?id=5&ref=home'],
    ['https://www.lazada.vn/products/x.html?laz_trackid=1&mkttid=2&exlaz=3&sub_id1=a&q=giay',
        'https://www.lazada.vn/products/x.html?q=giay'],
    ['https://www.google.com/url?q=https://example.com/a?aff_id=9&sa=t', 'https://example.com/a'],
    ['https://l.facebook.com/l.php?u=https%3A%2F%2Fl.facebook.com%2Fl.php%3Fu%3Dhttps%253A%252F%252Fexample.org%252F%253Futm_x%253D1',
        'https://example.org/'],
];

test('removes tracking and affiliate parameters in two passes', () => {
    const w = boot();
    for (const [input, expected] of CASES) assert.equal(w.__pbCleanUrl(input), expected, input);
});

test('keeps functional parameters of non-shopping sites', () => {
    const w = boot();
    const url = 'https://example.com/search?q=a&spm=1&ref=home&tag=x';
    assert.equal(w.__pbCleanUrl(url), url, 'spm / tag are only tracking on shopping hosts');
});

test('recognises short links', () => {
    const w = boot();
    for (const u of ['https://shope.ee/abc', 'https://vt.tiktok.com/ZS1/', 'https://bit.ly/x', 'https://www.tiktok.com/t/ZT1/']) {
        assert.equal(w.__pbIsShortUrl(u), true, u);
    }
    for (const u of ['https://example.com/', 'https://shopee.vn/product/1']) assert.equal(w.__pbIsShortUrl(u), false, u);
});
