# Multi-Window on iPad with Tauri (a field guide)

How to open a **second native window** on iPadOS in a Tauri v2 app — a real
window running your full app with a working `invoke()` — starting from a
fresh project.

> **Use Tauri ≥ 2.11.** iOS/iPad multi-window is built in (PR
> [#14484](https://github.com/tauri-apps/tauri/pull/14484), shipped in
> **2.11.0**). On 2.11+ a second iPad window is *just a `WebviewWindow`* —
> the same API you already use on desktop. No custom Swift, no scene
> delegate, no IPC relay. If you're on **≤ 2.10**, none of this exists and
> you'd be forced into a painful custom plugin (see the appendix); the right
> move is to upgrade.

---

## TL;DR

1. **Upgrade** to Tauri ≥ 2.11 (Rust crates + `@tauri-apps/api` + `@tauri-apps/cli`).
2. **`Info.ios.plist`**: opt into multiple scenes.
3. **Capabilities**: allow `core:webview:allow-create-webview-window` and add a
   wildcard to the `windows` list for your dynamic labels.
4. **JS**: `new WebviewWindow(label, { url })` — works programmatically on iOS,
   carrying your URL (e.g. `index.html#file=…`) for seeding.
5. **Rust** (optional but recommended): handle `RunEvent::SceneRequested` so
   the OS "New Window" gesture (long-press the app icon) opens a window too.

That's it. The second window is a real wry-managed webview with full IPC, so
your entire app — editors, file tree, every `invoke` — works unchanged.

---

## 1. Upgrade

```toml
# src-tauri/Cargo.toml
tauri = { version = "2.11", features = [...] }
tauri-build = "2"
```
```jsonc
// package.json
"@tauri-apps/api": "^2.11.0",
"@tauri-apps/cli": "^2.11.0"
```
Then `cargo update -p tauri --precise 2.11.x` and `npm install`. (The CLI
version matters: it generates the iOS Xcode project with scene support.)

Requirements: **iOS 13+** (and Android 12L / API 32+ for Android activity
embedding, if you target that too).

## 2. Enable scenes in `Info.ios.plist`

```xml
<key>UIApplicationSceneManifest</key>
<dict>
  <key>UIApplicationSupportsMultipleScenes</key>
  <true/>
  <key>UISceneConfigurations</key>
  <dict/>
</dict>
```

Leave `UISceneConfigurations` an empty dict — Tauri manages the scenes; you
are only opting in.

## 3. Capabilities

Windows created at runtime get dynamic labels, so the capability's `windows`
list needs a wildcard that matches them, plus the create permission:

```jsonc
{
  "windows": ["main", "window-*", "window-scene-*"],
  "permissions": [
    "core:webview:allow-create-webview-window",
    // …your other permissions…
  ]
}
```

Match whatever label scheme you use (below): `window-*` for JS-created
windows, `window-scene-*` for the ones the `SceneRequested` handler builds.

## 4. Open a window programmatically (JS)

This is the same call as desktop — and it works on iOS 2.11+:

```js
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const label = `window-${crypto.randomUUID().slice(0, 12)}`;
const url = `index.html#file=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}`;

// iOS scenes are sized & decorated by the system, so the desktop chrome
// options (width/height, decorations, titleBarStyle, transparent, center)
// don't apply there — pass only { url } on iOS.
const opts = isIOS ? { url } : { url, width: 720, height: 720, decorations: true, /* … */ };
new WebviewWindow(label, opts);
```

**Key fact (from the Tauri source):**

> *"Scenes created by `Window::new` are not emitted with [`SceneRequested`].
> It is also not emitted for the main scene."*

So a programmatic `new WebviewWindow` creates the iOS scene **directly and
keeps your URL** — your hash (`#file=…`) survives, which is how the new window
knows what to open. (Read it on the other side with your existing
"secondary window" boot path, e.g. parse `location.hash` during init.)

## 5. Handle the OS "New Window" gesture (Rust)

When the user long-presses the app icon and taps "New Window", iOS asks the
app for a scene and Tauri emits `RunEvent::SceneRequested`. If you don't
handle it, nothing opens. Build a default window in the run loop:

```rust
tauri::Builder::default()
    .setup(|app| { /* build "main" */ Ok(()) })
    // …plugins, .manage(), .invoke_handler()…
    .build(tauri::generate_context!())
    .expect("error while running app")
    .run(move |_app, _event| {
        #[cfg(target_os = "ios")]
        {
            // counter declared above the builder: `#[cfg(target_os = "ios")] let mut n = 0;`
            if let tauri::RunEvent::SceneRequested { .. } = _event {
                n += 1;
                let _ = tauri::WebviewWindowBuilder::new(
                    _app, format!("window-scene-{n}"), tauri::WebviewUrl::default()
                ).build();
            }
        }
    });
```

Note the shape change: switch from the one-shot `.run(generate_context!())`
to `.build(generate_context!())?.run(|app, event| …)` so you get the event
callback. `RunEvent::SceneRequested { scene, options }` is `#[cfg(ios)]`-only;
keep the whole block behind `#[cfg(target_os = "ios")]` and underscore-prefix
the closure params so desktop builds stay warning-free.

`WebviewUrl::default()` opens your app's entry (it restores the last
file/session like a fresh launch). The two paths compose cleanly:

| Trigger | Mechanism | Result |
|---|---|---|
| Command / button in your UI | JS `new WebviewWindow(url)` | seeded window (your `#file=…`) |
| Long-press app icon → New Window | Rust `SceneRequested` handler | default window (restores session) |

## 6. Relating scenes (optional)

`WebviewWindow`/`WebviewWindowBuilder` accept iOS options for scene
relationships: `requestedBySceneIdentifier` sets which `UIScene` requested the
new one, and `sceneIdentifier()` reads a window's scene id to pass along. Use
these only if you need explicit parent/child scene grouping.

---

## Gotchas

- **Don't pass desktop window options on iOS.** `decorations`, `titleBarStyle`,
  `transparent`, `width/height`, `center` are desktop concepts; iOS scenes are
  system-managed. Passing them can make `build()` fail — send `{ url }` only.
- **Capabilities wildcard.** A new window whose label doesn't match any
  `windows` entry gets no permissions and your `invoke`s silently fail. Cover
  every label scheme you create.
- **CLI version.** The iOS project (Info.plist merge, scene wiring) is produced
  by `@tauri-apps/cli`; bump it alongside the Rust crate, not just `api`.
- **Full app, full backend.** The second window is a real instance sharing the
  same Rust backend, so any cross-window state (registries, file mutations,
  sync) is now in play on iPad exactly as on desktop — reuse your desktop
  multi-window machinery (window registry + broadcast/listen) rather than
  inventing a mobile-specific one.

---

## Appendix: the pre-2.11 custom approach (historical)

Before 2.11 there was **no** iOS multi-window in Tauri, and replicating it by
hand was the only option. For the record, that required a custom Swift plugin
that: observed `UIScene.willConnectNotification` (because Tauri builds the iOS
app on the legacy `UIWindow` lifecycle and never calls the scene-config
delegate), called `requestSceneSessionActivation` to spawn a scene, attached a
hand-made `WKWebView`, **proxied every asset** through the primary webview over
a private URL scheme (wry's own `tauri://` handler is webview-specific and
crashes if used from a foreign webview), and **relayed `invoke()`** through the
primary (the only webview with a real IPC bridge). It worked, but it was a lot
of fragile native code with no event delivery to the second window.

**All of that is obsolete on 2.11+.** If you find a project still doing it,
delete the plugin and switch to the five steps above.
