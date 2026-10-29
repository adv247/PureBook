'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, element, makeDocument } = require('./helpers');

test('long press on post text opens a sheet; copy selection and copy all use the bridge', async () => {
    const sent = [];
    const body = element('div');
    body.innerText = 'Dòng 1\n\nDòng 2';
    body.textContent = body.innerText;
    const post = element('div');
    post.querySelectorAll = sel => (sel === '.native-text' ? [body] : []);
    const target = element('span');
    target.closest = sel => (sel.includes('role="article"') ? post : null);

    const document = makeDocument();
    load('text_select.js', { document, getSelection: () => '', FaceboostPage: { postMessage: m => sent.push(JSON.parse(m)) } });

    document.fire('touchstart', { touches: [{ clientX: 1, clientY: 1 }], target });
    await new Promise(resolve => setTimeout(resolve, 700));

    const sheet = document.getElementById('pb-copy-sheet');
    assert.ok(sheet, 'the sheet opens after the hold');
    const parts = sheet.children[0].children;
    const box = parts[2];
    assert.equal(box.value, 'Dòng 1\n\nDòng 2');
    const buttons = parts[3].children;
    box.selectionStart = 0;
    box.selectionEnd = 6;
    buttons[1].click();   // copy selection
    buttons[2].click();   // copy all
    assert.deepEqual(sent.map(m => m.text), ['Dòng 1', 'Dòng 1\n\nDòng 2']);
});

test('the sheet stays closed when the page already has a text selection', async () => {
    const post = element('div');
    const target = element('span');
    target.closest = sel => (sel.includes('role="article"') ? post : null);
    const document = makeDocument();
    load('text_select.js', { document, getSelection: () => 'đã chọn', FaceboostPage: { postMessage() {} } });
    document.fire('touchstart', { touches: [{ clientX: 1, clientY: 1 }], target });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(document.getElementById('pb-copy-sheet'), null);
});
