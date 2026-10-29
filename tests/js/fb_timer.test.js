'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeDocument } = require('./helpers');

function boot() {
    const store = {};
    const document = makeDocument();
    document.scripts = [{ textContent: 'x;["CurrentUserInitialData",[],{"ACCOUNT_ID":"1","USER_ID":"1000","NAME":"Nguy\\u1ec5n V\\u0103n A","SHORT_NAME":"A"}]' }];
    const w = load('fb_timer.js', {
        document, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        addEventListener() {}, setInterval: () => 0,
    });
    return { w, document };
}
const pillOf = d => d.body.children.find(c => c.textContent.startsWith('\u23F1'));
const dialogOf = d => d.body.children.find(c => c.children[0] && c.children[0].children[0]);

test('stays invisible, shows a countdown only in the last 2 minutes, then the break dialog with the account name', () => {
    const { w, document } = boot();
    const api = w.__pbTimerApi;
    for (let s = 1; s <= 1679; s++) api.tick(true);
    assert.equal(pillOf(document), undefined, 'nothing before the warning window');
    api.tick(true);
    assert.equal(pillOf(document).textContent, '\u23F1 02:00');
    for (let s = 1681; s <= 1799; s++) api.tick(true);
    assert.equal(pillOf(document).textContent, '\u23F1 00:01');
    api.tick(true);
    assert.equal(pillOf(document), undefined, 'the pill hides when the dialog appears');
    const dialog = dialogOf(document);
    const card = dialog.children[0];
    assert.equal(card.children[0].textContent, 'Nghỉ ngơi mắt nhé, Nguyễn Văn A!');
    assert.equal(card.children[1].textContent, 'Bạn đã lướt Facebook liên tục 30 phút.');
});

test('a dismissed dialog does not block the next warning and break', () => {
    const { w, document } = boot();
    const api = w.__pbTimerApi;
    for (let s = 1; s <= 1800; s++) api.tick(true);
    dialogOf(document).children[0].children[2].children[0].click(); // "Tiếp tục"
    for (let s = 1801; s <= 3480; s++) api.tick(true);
    assert.equal(pillOf(document).textContent, '\u23F1 02:00');
    for (let s = 3481; s <= 3600; s++) api.tick(true);
    assert.equal(dialogOf(document).children[0].children[1].textContent, 'Bạn đã lướt Facebook liên tục 60 phút.');
});

test('does not count time while the page is hidden', () => {
    const { w } = boot();
    const api = w.__pbTimerApi;
    for (let s = 0; s < 100; s++) api.tick(false);
    assert.equal(api.state.active, 0);
});
