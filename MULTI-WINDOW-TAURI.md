# Multi-Window on iPad with Tauri (a field guide)

How to open a **second native window** in a Tauri v2 app on iPadOS and run
your real web app inside it — including a working `invoke()` — starting from
a fresh project.

This is written generically; where it helps, it points at the concrete
implementation in this repo (`tauri-plugin-ipad-window`, `src/multi-window.js`,
`src/main.js` / `src/main-modes.js`). The companion design doc with Hush-
specific staging is `IPAD-MULTI-WINDOW-PLANNING.md`.

> **TL;DR.** On iPad you cannot use `WebviewWindow` (desktop-only) and you
> cannot adopt UIScene the normal way (Tauri builds the app on the legacy
> UIWindow lifecycle). The recipe: a tiny Swift plugin that (1) requests a
> second **UIScene** and attaches a hand-made `WKWebView`, (2) loads your
> bundle over a **private URL scheme that proxies every asset through the
> primary webview**, and (3) **relays `invoke()`** through the primary
> webview, which is the only one with a real Tauri IPC bridge.

---

## 1. Why the easy paths don't work

**`WebviewWindow.new()` is desktop-only.** On iOS/iPadOS, wry exposes a
single webview surface; there is no multi-`WebviewWindow` support. Calling it
no-ops or errors.

**You can't just adopt UIScene.** A normal iPad multi-window app declares a
`UISceneDelegate` and a scene manifest, and UIKit calls
`application(_:configurationForConnecting:)`. But Tauri's generated iOS app
(`gen/apple`) builds the app delegate and the primary window **in Rust on the
legacy, non-scene `UIWindow` lifecycle**. There is no Swift app/scene
delegate, and UIKit fixes the lifecycle inside `UIApplicationMain` before any
plugin loads — so:

- Swizzling `configurationForConnecting` from a plugin's `load()` runs too
  late; the method is never called anyway.
- Adding a full scene manifest to `Info.plist` makes UIKit ignore wry's
  legacy primary window.

**A second webview has no IPC.** Even once you get a second `WKWebView` on
screen, wry only wires its Tauri IPC bridge into the webview *it* created.
A hand-made webview has no `invoke()`. And your app — editors, canvases,
file trees — calls `invoke()` constantly, so "just pass the serialized
content over" is not viable for anything non-trivial. **You need a working
`invoke()` in the second window**, which means a relay.

---

## 2. Architecture

```
┌─ Scene 1: PRIMARY (Tauri-managed) ──────┐      ┌─ Scene 2: SATELLITE ───────────┐
│ wry WKWebView @ tauri://localhost       │      │ your WKWebView @ hushsat://…    │
│  • real Tauri IPC (invoke works)        │      │  • fresh config, own process    │
│  • can fetch() its own bundled assets   │      │  • __TAURI_INTERNALS__ = shim   │
│  • __hushSatelliteRequest(reqJSON)      │◀────▶│  • invoke → postMessage to Swift│
└─────────────────────────────────────────┘      └─────────────────────────────────┘
                 ▲   relay (req/resp)  +  asset proxy (fetch bytes)   ▲
                 └──────────────── Swift plugin owns both webviews ───┘
```

Two channels, both routed through the Swift plugin:

1. **Asset proxy** — the satellite loads your SPA from a *private scheme*
   (e.g. `hushsat://`). Its scheme handler asks the primary to `fetch()` the
   same path from `tauri://localhost` and returns the bytes. This works no
   matter where the bundle physically lives (loose files or compiled into the
   binary) and **avoids wry's own asset handler, which is webview-specific
   and crashes if used from a foreign webview**.
2. **Invoke relay** — the satellite's `invoke()` is a shim that posts to the
   plugin, which runs the command in the *primary* webview (real IPC) and
   posts the result back. One relay covers every command and every file type.

Tradeoff: the satellite routes everything through the primary, so **the
primary must stay alive** for the satellite to function. Acceptable for a
"secondary window of the same app" model.

---

## 3. The scene + seed path (getting a second window at all)

In `Info.plist`, opt into multiple scenes **without** declaring a scene
delegate/manifest (so wry's legacy primary window is untouched):

```xml
<key>UIApplicationSceneManifest</key>
<dict>
  <key>UIApplicationSupportsMultipleScenes</key><true/>
</dict>
```

In the plugin's `load(webview:)`, capture the primary webview and observe
scene connections instead of swizzling:

```swift
HushWindowBridge.shared.primaryWebview = webview
NotificationCenter.default.addObserver(
  self, selector: #selector(sceneWillConnect(_:)),
  name: UIScene.willConnectNotification, object: nil)
```

A Tauri command requests a new scene, carrying a seed (which file to open):

```swift
@objc public func openWindow(_ invoke: Invoke) throws {
  // parse fileId/fileType/title from args …
  bridge.pendingSeed = seed
  bridge.expectingNewScene = true            // gate: only claim scenes WE asked for
  DispatchQueue.main.async {
    let activity = NSUserActivity(activityType: "com.you.app.fileWindow")
    activity.userInfo = ["fileId": id, "fileType": type]
    UIApplication.shared.requestSceneSessionActivation(nil, userActivity: activity,
                                                        options: nil, errorHandler: nil)
  }
  invoke.resolve()
}
```

In the observer, attach your own `UIWindow` + webview to the requested scene,
and **destroy unrequested scenes** (iPadOS restores "zombie" sessions from
prior runs; if you don't kill them they flash open/closed and can be reused
in place of a fresh seeded scene):

```swift
@objc func sceneWillConnect(_ note: Notification) {
  guard let scene = note.object as? UIWindowScene,
        scene.session.role == .windowApplication else { return }
  guard bridge.expectingNewScene else {
    // iOS-restored leftover — destroy so it can't be reused.
    UIApplication.shared.requestSceneSessionDestruction(scene.session, options: nil, errorHandler: nil)
    return
  }
  bridge.expectingNewScene = false
  let win = UIWindow(windowScene: scene)
  win.rootViewController = makeSatelliteVC(seed: bridge.pendingSeed)
  win.makeKeyAndVisible()
  bridge.sceneWindows.append(win)   // strong ref — no scene delegate owns it
}
```

Also purge leftover secondary scenes ~2s after launch (everything except the
primary and your own attached windows) so a backlog can't accumulate.

> **Gotcha:** the primary window is a *legacy* `UIWindow`, not a scene, and it
> connects before your observer is installed — so it never trips the observer.
> That's what makes this safe.

---

## 4. Loading your bundle in the satellite (the asset proxy)

**Do NOT** reuse wry's configuration or its `tauri://` scheme handler.
`WKWebViewConfiguration.copy()` *does* carry the handler, but wry's handler is
**webview-specific**: invoked for a webview it doesn't own, it crashes the
shared web-content process. (Symptom: blank window, then the whole app dies.)

Instead, give the satellite a **fresh config + a private scheme + your own
handler**, and proxy every request through the primary:

```swift
let cfg = WKWebViewConfiguration()
cfg.processPool = WKProcessPool()                 // isolate: a satellite crash
                                                   // must not kill the primary.
                                                   // (Only safe on a FRESH config —
                                                   //  swapping the pool on a copied
                                                   //  config crashes WebKit.)
cfg.setURLSchemeHandler(SatelliteSchemeHandler(), forURLScheme: "hushsat")

let ucc = WKUserContentController()
ucc.add(self, name: "hushInvoke")                  // satellite → native (invoke)
ucc.addUserScript(WKUserScript(source: shimJS,     // defines __TAURI_INTERNALS__
                  injectionTime: .atDocumentStart, forMainFrameOnly: true))
cfg.userContentController = ucc

let web = WKWebView(frame: .zero, configuration: cfg)
web.load(URLRequest(url: URL(string: "hushsat://localhost/#file=\(id)&type=\(type)")!))
```

The scheme handler fetches each asset from the primary (same origin as the
real bundle) and returns the bytes. Use `callAsyncJavaScript` (iOS 14+) so the
`fetch().arrayBuffer()` promise is awaited:

```swift
func webView(_ wv: WKWebView, start task: WKURLSchemeTask) {
  let path = task.request.url!.path.isEmpty ? "/" : task.request.url!.path
  let body = """
    const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer());
    let s = ""; for (let i=0;i<b.length;i+=0x8000) s += String.fromCharCode.apply(null,b.subarray(i,i+0x8000));
    return { b64: btoa(s), type: r.headers.get('Content-Type')||'application/octet-stream', status: r.status };
  """
  primaryWebview.callAsyncJavaScript(body, arguments: ["u": "tauri://localhost\(path)"],
                                     in: nil, in: .page) { result in
    // decode b64 → Data, build HTTPURLResponse with Content-Type, then
    // task.didReceive(response); task.didReceive(data); task.didFinish()
  }
}
```

Notes:
- **Content-Type matters.** ES modules won't execute without a JS MIME type —
  propagate the primary's response `Content-Type` header verbatim.
- **Guard cancelled tasks.** Track tasks; if `stop` was called, drop the late
  async delivery (messaging a stopped `WKURLSchemeTask` crashes).
- **Root-relative URLs** (`/assets/x.js`) resolve against `hushsat://localhost`
  and route back through your handler — so the whole bundle comes through.

---

## 5. The invoke relay

The shim (injected at document-start, before your bundle) replaces
`window.__TAURI_INTERNALS__`. `@tauri-apps/api`'s `invoke` just calls
`__TAURI_INTERNALS__.invoke(cmd, args, opts)`, so a faithful shim is enough:

```js
// SATELLITE shim
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "satellite" },
              currentWebview: { label: "satellite", windowLabel: "satellite" } },
  invoke(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++; pending[id] = { resolve, reject };
      webkit.messageHandlers.hushInvoke.postMessage({ id, cmd, args: args || {} });
    });
  },
  transformCallback(cb) { /* store locally, return an id */ },
  convertFileSrc(p) { return p; },
};
window.__HUSH_RESOLVE_B64__ = (b64) => { /* decode, resolve/reject pending[id] */ };
```

```js
// PRIMARY (injected once): run the real invoke, post the result back
window.__hushSatelliteRequest = (b64) => {
  const { id, cmd, args } = decode(b64);
  Promise.resolve(window.__TAURI_INTERNALS__.invoke(cmd, args)).then(
    res => webkit.messageHandlers.hushRelayResult.postMessage(encode({ id, ok: true,  payload: res })),
    err => webkit.messageHandlers.hushRelayResult.postMessage(encode({ id, ok: false, payload: String(err) })));
};
```

The Swift plugin wires the two message handlers:

- `hushInvoke` (from satellite) → `primaryWebview.evaluateJavaScript("__hushSatelliteRequest('<b64>')")`
- `hushRelayResult` (from primary) → `satelliteWebview.evaluateJavaScript("__HUSH_RESOLVE_B64__('<b64>')")`

> **Base64 everything across the JS↔Swift boundary.** Encode the JSON payload
> as base64 in JS, pass it as a single string argument, decode in Swift (and
> vice-versa). Base64 is `[A-Za-z0-9+/=]` only, so it embeds safely inside a
> JS string literal with zero escaping — no quoting/newline/UTF-8 bugs. Use
> `decodeURIComponent(escape(atob(b64)))` / `btoa(unescape(encodeURIComponent(s)))`
> for correct UTF-8.

Register the primary's relay function as a persistent `WKUserScript` on the
primary's `userContentController` (so it survives reloads) **and**
`evaluateJavaScript` it once for the already-loaded page.

---

## 6. Single-file / trimmed boot mode (don't run two full apps)

By default the satellite boots your **entire** SPA — sidebar, sync, registry,
autosave — i.e. a second full instance racing the primary on the same backend
state. Gate that. Have the shim set a flag (`window.__HUSH_SATELLITE__ = true`)
and, in your app's bootstrap, skip everything that isn't the one surface you
want:

```js
state.isSatellite = !!window.__HUSH_SATELLITE__;
if (state.isSatellite) document.documentElement.classList.add("satellite");
// …then guard: if (!state.isSatellite) setupSidebar()/sync()/registry()/…
```

Hide remaining chrome with a `html.satellite { … display:none }` stylesheet.
See `src/main.js` (the `isSatellite` gates) and the `html.satellite` rules in
`src/styles/main.css`.

---

## 7. Known limitations / gotchas

- **Events don't reach the satellite (yet).** `listen()` registers a callback
  via the relay, but the callback id lives in the *satellite* while the event
  fires in the *primary* → `[TAURI] Couldn't find callback id N` spam in the
  primary console, and the satellite never gets the event. Request-response
  `invoke` is unaffected (load/save/etc. all work). Routing events back to the
  satellite (match the callback id → `evaluateJavaScript` into the right
  webview) is a separate piece of work.
- **The satellite can't outlive the primary** — the relay routes through it.
- **`requestSceneSessionActivation` is best-effort** — iPadOS can decline it
  (unsupported multitasking state). Surface failures quietly.
- **You can't build/test this in CI on Linux** — it needs a Mac + a device or
  simulator. `tauri ios dev` may fail in some setups; `tauri ios build` +
  Safari **Web Inspector** is a reliable loop.

---

## 8. Debugging without a terminal

On-device you have no stdout. Two tactics that paid off:

1. **Mirror native breadcrumbs into the primary's JS console** via a plugin
   event (`trigger("diag", …)` → an `addPluginListener` in JS), readable in
   Safari Web Inspector. Dispatch `trigger()` on the main thread.
2. **Mirror the satellite's console into the primary's** — add a `hushDiag`
   message handler and, in the shim, post `window.onerror` /
   `unhandledrejection` / a "shim installed @ <href>" breadcrumb to it. When
   the satellite boots blank or dies before its own inspector can attach, this
   is the only way to see *why* (did the page even load? what threw?).

Make `web.isInspectable = true` (iOS 16.4+) on the satellite so it shows up as
a second page in Safari's Develop menu when it survives long enough to attach.
