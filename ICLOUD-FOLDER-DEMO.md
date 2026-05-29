# iCloud Folder on iOS — proof-of-concept demo

This is a **throwaway demo** that tests whether Hush can get durable
read/write access to an arbitrary iCloud Drive folder on iOS — the
prerequisite for shipping **Add > Local Folder + autosave on iOS** the
way macOS Local Sync works today.

It answers the open question from the research pass: stock Tauri can't
do this (no folder picker on iOS, no persistent security-scoped
bookmark), so we built a small custom Swift plugin to close both gaps
and prove the mechanism end-to-end.

## What it proves

1. **Folder picker on iOS** — `UIDocumentPickerViewController` opened for
   `UTType.folder` with `asCopy: false` (stock `@tauri-apps/plugin-dialog`
   only opens *file* pickers on iOS).
2. **Persistent security-scoped bookmark** — on pick we mint
   `url.bookmarkData()` and persist the blob; on a later launch we
   `URL(resolvingBookmarkData:)` + `startAccessingSecurityScopedResource()`
   to regain access **without** re-prompting.
3. **Read / write inside the folder** — coordinated (`NSFileCoordinator`)
   I/O against iCloud, including a `startDownloadingUbiquitousItem` nudge
   for dataless placeholders.
4. **macOS-style 2s autosave** — a textarea writes to
   `hush-icloud-demo.md` in the picked folder 2s after you stop typing.

The hard test is **#2**: pick a folder, type, **force-quit**, relaunch,
tap **Reconnect**, then **Read note** — your text comes back. That's
durable access to an arbitrary iCloud location across launches.

## What's in this branch

New custom plugin (mirrors the existing `tauri-plugin-pencil`):

```
src-tauri/tauri-plugin-icloud-folder/
  Cargo.toml
  build.rs                         # command list for permission codegen
  permissions/default.toml
  ios/Package.swift
  ios/Sources/IcloudFolderPlugin.swift   # the actual iOS implementation
  src/lib.rs                       # Rust command proxies (iOS-only; Err elsewhere)
```

Wiring:

- `src-tauri/Cargo.toml` — path dependency on the plugin.
- `src-tauri/src/lib.rs` — `.plugin(tauri_plugin_icloud_folder::init())`.
- `src-tauri/capabilities/default.json` — `"icloud-folder:default"`.
- `icloud-demo.html` + `src/icloud-demo/icloud-demo.js` — the harness.
- `vite.config.js` — registers `icloud-demo.html` as a build input.
- `src-tauri/tauri.conf.json` — **main window `url` points at
  `icloud-demo.html`** so the app boots straight into the harness.

## Build & run (must be on a Mac with Xcode)

> ⚠️ This cannot be built or run on Linux/CI — it needs Xcode, and the
> bookmark/iCloud behavior is only trustworthy on a **real device signed
> into iCloud** (the simulator's iCloud Drive is unreliable).

```sh
npm install
npm run ios:init          # first time only
npm run tauri ios dev     # or: npm run tauri ios build  (then deploy the .ipa)
```

On device:

1. **Pick folder…** → choose an iCloud Drive folder (make one in the
   Files app first if needed). The checklist lights up "picked" +
   "persisted".
2. Type into the **autosave** box; wait for "saved ✓ (autosave)".
3. **Force-quit** the app (swipe up from the app switcher).
4. Relaunch → tap **Reconnect from saved bookmark** (no picker appears).
5. **Read note** → your text returns; "autosave round-trip" check passes.
6. Open the same file in the **Files app / Finder on a Mac** to confirm
   it's a real file at the iCloud location, not a sandbox copy.

The on-screen **Checklist** and **Log** report PASS/FAIL for each step.
Running on desktop or a simulator-without-iCloud is expected to report
"iOS-only" — that's the honest result, not a bug.

## Known limitations (decide before productionizing)

- **No live external-change watching.** Hush's Local Sync uses the
  `notify` crate (`macos_fsevent`, macOS-only). On iOS the "edits from
  other apps appear instantly" half won't carry over — you'd poll on
  foreground or accept write-through + manual refresh. Autosave (writes)
  is unaffected.
- **Stale bookmarks.** If the folder is moved/renamed in Files.app, the
  resolve returns `stale = true` (surfaced in the log) and you must
  re-pick. Production code should auto-re-mint and re-persist.
- **Open-scope limit.** iOS caps simultaneously-open security-scoped
  resources; fine for a handful of mounts, balance start/stop carefully.
- **Concurrency.** The Swift `accessing` map isn't locked — fine for the
  demo, add a lock for production.

## How to fold this into real Local Sync (next step, not done here)

The Swift side already reads/writes by absolute path — the same shape
`src-tauri/src/local_sync.rs` uses with `std::fs`. To productionize:

1. Add `bookmark: Option<String>` to `LocalSyncFolder`.
2. On iOS, replace `open({ directory: true })` in
   `src/sync/local-sync.js` with `pick_folder`, and store the bookmark.
3. In the startup hook that re-arms watchers (`lib.rs`, the
   `persisted_local_sync` loop), resolve each iOS mount's bookmark to
   re-acquire access **before** any list/read/write.
4. Lift the desktop-only gate on the Local Folder button
   (`src/sidebar/add-popup.js`).

Once access is held, the existing `list_dir` / `read_file` /
`write_file` paths work unchanged — autosave behaves like macOS.

## Reverting the demo

The only invasive change is the boot redirect. To get the normal app
back, remove this line from `src-tauri/tauri.conf.json`'s main window:

```json
"url": "icloud-demo.html",
```

Everything else (the plugin, the demo page) is additive and inert when
not invoked.
