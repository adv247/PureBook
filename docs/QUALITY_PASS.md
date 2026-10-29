# Quality pass: privacy scripts, link handling, media

Status: finished, waiting for the repository owner's review (see the pull request for the report).

## How the scripts reach the page

`MainViewModel` concatenates the enabled `res/raw/*.js` files into one blob that
`MaterialbookWV` evaluates every time a page finishes loading. The blob starts with
`if(!window._mbBundleInjected){...}`, so it runs once per document. Two consequences:

- A syntax error in any file stops every file after it. `js-check.yml` syntax-checks each file.
- Code that must run **before** Facebook's own scripts (hooks on `WebSocket`, `fetch`,
  `addEventListener`) cannot rely on the bundle alone. `anti_reload.js` and `anti_seen.js` are
  also installed at document start by `installEarlyScripts()` in `WebViewHardening.kt`
  (`WebViewCompat.addDocumentStartJavaScript`, Facebook and Messenger origins only, when the
  WebView supports it). Every script guards against running twice (`window.__pb...`), so the
  bundle's later copy does nothing.

## Flows

### Feed auto-reload (`anti_reload.js`)
1. A window-level capture listener sees `visibilitychange` before any page handler.
2. `hidden`: Facebook's handlers run as usual (it pauses videos). The videos that were playing
   are remembered (at most 8, forgotten after one hide/show cycle).
3. `visible`: Facebook's handlers are stopped (this is what refreshes the feed). PureBook's own
   listeners (PiP, lock-screen audio, timer) are called by the gate, because
   `addEventListener` was wrapped to tell them apart from the page's by call stack: a stack with
   a URL (Facebook's CDN, or the page for inline scripts) is the page; an app-evaluated script
   has none.
4. The remembered videos are resumed, except in PiP or during the lock-screen handoff.
5. A page restored from the back/forward cache (`pageshow` with `persisted`) is gated the same
   way; a normal first-load `pageshow` is left alone so Facebook can initialise.

`document.visibilityState` is never faked, so code that reads it keeps working. Compared with the
J2TEAM extension, which pins the state to "visible" and discards the listeners, this keeps PiP,
the lock-screen handoff and Facebook's pause-on-leave working.

### Chat privacy (`anti_seen.js`)
Messenger sends read receipts and typing as MQTT `PUBLISH /ls_req` frames over a WebSocket,
plus a few HTTP/GraphQL calls. The script hooks `fetch`, `XMLHttpRequest`, `sendBeacon` and
`WebSocket.prototype.send`.

| Signal | Frame | What happens |
|---|---|---|
| Typing | outer `type` 4, task payload has `thread_key` | dropped: nothing waits for an answer |
| Seen | outer `type` 3, task label `21` | **not dropped**: the client waits for the reply. The marker is rewritten to point at the user's own id, so the request completes and no chat is marked read |
| Message send | any other task | untouched, even when it travels in the same frame as a seen task |
| Story view | GraphQL mutation `storiesUpdateSeenState...` | answered with a fake success |

Frames are edited as text when a JSON round trip would change a number (ids above 2^53). A frame
holding several MQTT packets, or a topic other than `/ls_req`, is never touched. Without a user id
(`c_user` cookie) a frame that only marks threads as read is dropped, and a mixed frame is passed,
so a message is never lost to hide a read marker.

### Links (`link_privacy.js`, `LinkResolver.kt`)
Pass 1 unwraps redirectors (`l.facebook.com`, `google.com/url`, store/affiliate redirectors).
Pass 2 strips tracking and affiliate parameters. Short links are expanded natively
(HEAD, no redirect following, `Dispatchers.IO`) and opened in the store's own app when installed.
While a short link is being expanded (up to ~40 s in the worst case) the calling Activity is held
only through a `WeakReference`; if it has finished by then the application context is used and the
Custom Tab gets `FLAG_ACTIVITY_NEW_TASK`.

### Memory and CPU (`download_content.js`)
- The per-video URL table is a `WeakMap`: Facebook swaps `<video>` nodes constantly, and a `Map`
  held every detached one (and its buffers) for the life of the page. A list of at most 8
  `WeakRef`s exists only so the debug hook can still list recent videos.
- The `MutationObserver` no longer does selector queries and layout reads for every batch of DOM
  changes: one pass per quiet 250 ms.
- Of the representations the player fetched, the sharpest (read from the `vencode_tag`, e.g.
  `720p`) is offered first; equally sharp ones keep newest first. The script does **not** fetch
  extra, higher-quality representations by itself.

## Known limits

- The message formats above are Facebook's, not a published API. If Meta changes them, "seen"
  can leak through; switch `window.__pbPrivacy.debug = true` to see what is blocked.
- Native code cannot see WebSocket frames or request bodies; the blocking lives in the page hooks.
- Everything here is on by default; there is no Settings switch yet.
- Highest-quality image/video download beyond what the player already fetched is not implemented:
  it needs Facebook's media manifest fields (for example an HD URL in the GraphQL response), and
  there was no sample to verify against.
- `MissingQuantity` lint is switched off (Arabic, Hebrew and Polish `share_files` plurals lack some
  quantities). Android falls back to "other", so text still shows; only the count's grammar is off.

## Tests

| Layer | Where | Runs in |
|---|---|---|
| Script syntax | `node --check` on every `res/raw/*.js` | `js-check.yml` |
| Script logic | `tests/js/*.test.js` (node:test, scripts loaded in a `vm` context) | `js-check.yml` |
| Kotlin units | `app/src/test` (includes `LinkCleanTest` for the two-pass link cleaner) | `ci.yml` (`./gradlew test`) |
| Build / lint | `assembleRelease`, `lintDebug` | `ci.yml` |
| On device | `app/src/androidTest` (app name in every locale, launcher icon, ...) | `ci.yml` (emulator) |

A red `ci.yml` job explains itself: lint errors, Gradle failures and the names of failing
instrumented tests are printed as annotations, readable without signing in to GitHub.

### Preventing the same breakage again
- **Rebrand leftovers**: `AppIdentityTest` and `LocaleAppNameTest` fail if any locale or the debug
  build still shows an old name. A rename must touch `values/brand_strings.xml`, every
  `values-xx/brand_strings.xml` and `src/debug/res/values/strings.xml`.
- **Launcher icon background**: a `<shape>` needs a `<size>` or `LauncherIconTest` sees an empty
  drawable (intrinsic size -1).
- **A bundled script with a syntax error**: caught by `js-check.yml` before it can silently disable
  the scripts after it.

Run the JS tests locally: `node --test tests/js/*.test.js` (Node 20+).

## Regression checklist (manual, on a device)

- Leave the app for a few minutes and return: the feed keeps its place.
- Play a reel, switch app and return: it plays again. Enter PiP and return: no double audio.
- Open a chat, read it, type: the other side sees neither "seen" nor "typing"; sending works.
- Open a story: the owner's viewer list does not show you.
- Long-press post text: native selection works, or the copy sheet opens.
- Tap a Shopee / TikTok / bit.ly link: opens clean, in the store app when installed. Tap a short
  link and leave the app before it opens: nothing crashes.
