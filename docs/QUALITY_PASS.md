# Quality pass: privacy scripts, link handling, media

Status: in progress (see the pull request for the final report).

## How the scripts reach the page

`MainViewModel` concatenates the enabled `res/raw/*.js` files into one blob that
`MaterialbookWV` evaluates every time a page finishes loading. The blob starts with
`if(!window._mbBundleInjected){...}`, so it runs once per document. Two consequences:

- A syntax error in any file stops every file after it. `js-check.yml` syntax-checks each file.
- Code that must run **before** Facebook's own scripts (hooks on `WebSocket`, `fetch`,
  `addEventListener`) cannot rely on the bundle alone. It is also installed at document start
  (see `WebViewHardening.kt`); every script guards against running twice (`window.__pb...`).

## Flows

### Feed auto-reload (`anti_reload.js`)
1. A window-level capture listener sees `visibilitychange` before any page handler.
2. `hidden`: Facebook's handlers run as usual (it pauses videos). The videos that were playing
   are remembered.
3. `visible`: Facebook's handlers are stopped (this is what refreshes the feed). PureBook's own
   listeners (PiP, lock-screen audio, timer) are called by the gate, because
   `addEventListener` was wrapped to tell them apart from the page's by call stack.
4. The remembered videos are resumed, except in PiP or during the lock-screen handoff.

`document.visibilityState` is never faked, so code that reads it keeps working.

### Chat privacy (`anti_seen.js`)
Messenger sends read receipts and typing as MQTT `PUBLISH /ls_req` frames over a WebSocket,
plus a few HTTP/GraphQL calls. The script hooks `fetch`, `XMLHttpRequest`, `sendBeacon` and
`WebSocket.prototype.send`.

### Links (`link_privacy.js`, `LinkResolver.kt`)
Pass 1 unwraps redirectors (`l.facebook.com`, `google.com/url`, store/affiliate redirectors).
Pass 2 strips tracking and affiliate parameters. Short links are expanded natively
(HEAD, no redirect following, `Dispatchers.IO`) and opened in the store's own app when installed.

## Tests

| Layer | Where | Runs in |
|---|---|---|
| Script syntax | `node --check` on every `res/raw/*.js` | `js-check.yml` |
| Script logic | `tests/js/*.test.js` (node:test, scripts loaded in a `vm` context) | `js-check.yml` |
| Kotlin units | `app/src/test` | `ci.yml` (`./gradlew test`) |
| Build / lint | `assembleRelease`, `lintDebug` | `ci.yml` |

Run the JS tests locally: `node --test tests/js/*.test.js` (Node 20+).

## Regression checklist (manual, on a device)

- Leave the app for a few minutes and return: the feed keeps its place.
- Play a reel, switch app and return: it plays again. Enter PiP and return: no double audio.
- Open a chat, read it, type: the other side sees neither "seen" nor "typing"; sending works.
- Long-press post text: native selection works, or the copy sheet opens.
- Tap a Shopee / TikTok / bit.ly link: opens clean, in the store app when installed.
