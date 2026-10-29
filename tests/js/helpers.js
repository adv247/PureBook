'use strict';
// Runs the WebView scripts under test the way the app does: as a plain script, in a fresh global.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAW = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'res', 'raw');

function load(name, globals = {}) {
    const sandbox = Object.assign({
        console, URL, URLSearchParams, Event, EventTarget, TextDecoder, TextEncoder,
        setTimeout, clearTimeout, Date, Promise,
    }, globals);
    if (!sandbox.window) sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(RAW, name), 'utf8'), sandbox, { filename: name });
    return sandbox;
}

// Minimal DOM element: enough for the scripts' own UI code.
function element(tag) {
    return {
        nodeType: 1, tag, style: {}, children: [], textContent: '', value: '', isConnected: false,
        listeners: {},
        appendChild(child) { this.children.push(child); child.parent = this; child.isConnected = true; this.lastChild = child; return child; },
        remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
        setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; },
        querySelectorAll() { return []; }, closest() { return null; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); },
    };
}

function makeDocument() {
    const doc = element('document');
    doc.body = element('body');
    doc.body.tagName = 'BODY';
    doc.head = element('head');
    doc.documentElement = element('html');
    doc.scripts = [];
    doc.visibilityState = 'visible';
    doc.createElement = element;
    doc.getElementById = id => doc.body.children.find(c => c.id === id) || null;
    doc.fire = (type, event) => (doc.listeners[type] || []).forEach(fn => fn(event));
    doc.dispatchEvent = event => doc.fire(event.type, event);
    return doc;
}

module.exports = { load, element, makeDocument, RAW };
