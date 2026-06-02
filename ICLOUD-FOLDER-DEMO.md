# iCloud Folder on iOS — Local Folder support

Hush's **Add > Local Folder** mounts a folder on disk and reflects it
live in the sidebar with write-through autosave. On macOS this is plain
`std::fs`. On **iOS** the same feature now works against an arbitrary
iCloud Drive folder, via a small custom Swift plugin that supplies the
two things stock Tauri lacks on iOS: a **folder picker** and a
**persistent security-scoped bookmark** (so access survives relaunches).

The proof-of-concept that validated the mechanism on-device has been
folded into the real Local Sync flow; its harness now lives as a debug
panel under **Settings > Sync > iCloud**.

## Architecture

```
src-tauri/tauri-plugin-icloud-folder/        # custom iOS plugin
  ios/Sources/IcloudFolderPlugin.swift        #   picker, bookmark, coordinated I/O
  src/lib.rs                                   #   Rust command proxies (iOS-only)
```

Commands: `pick_folder`, `resolve_bookmark`, `stop_access`, `list_dir`,
`read_file`, `write_file`, `read_file_bytes`, `write_file_bytes`. The
file ops use `NSFileCoordinator` + `startDownloadingUbiquitousItem` so
dataless iCloud placeholders download on demand. Binary payloads cross
the bridge as base64.

### How it plugs into Local Sync

`LocalSyncFolder` (in `local_sync.rs`) gained an optional
`bookmark: Option<String>`. The platform fork lives entirely in
**`src/sync/local-sync.js`** — `isIOS()` routes the six I/O helpers
(`readDir` / `readFile` / `writeFile` / `readFileBytes` /
`writeFileBytes`, plus `addLocalSyncFolder`) through the plugin instead
of the desktop `local_sync_*` commands:

- **Add**: iOS calls `pick_folder`, then `local_sync_add` with the
  `bookmark`. Desktop still uses the `open({ directory: true })` dialog.
- **Resolve**: each mount's bookmark is resolved on first access (cached
  per `folderId`), re-acquiring security-scoped access and yielding the
  live absolute path. Relative paths are joined against that base.
- **Bytes**: images beside a `.md` round-trip as base64; dropped-image
  writes collision-suffix exactly like the macOS path.

Rust changes (`local_sync_add`, the startup watcher re-arm) skip the
`std::fs` `is_dir` check and the `notify` watcher when a bookmark is
present, since those are desktop-only.

## Known limitations

- **No live external-change watching on iOS.** The `notify` crate is
  `macos_fsevent`-only, so edits made to the folder by *other* apps
  won't auto-refresh Hush on iOS. Writes/autosave from Hush are
  unaffected. (A foreground-refresh or polling pass could close this
  later.)
- **Stale bookmarks.** If the folder is moved/renamed in Files.app, the
  resolve returns `stale: true` (logged); the mount must be re-added.
- **Open-scope limit.** iOS caps simultaneously-open security-scoped
  resources — fine for a handful of mounts; `stop_access` is called on
  unlink.

## Debugging — Settings > Sync > iCloud

A debug panel (`src/settings/settings-tabs-icloud.js`) drives the plugin
commands directly, independent of the sidebar mount bookkeeping, so a
failure points squarely at the bookmark layer. It keeps its own
bookmark in `localStorage`. The hard cross-launch test:

1. **Pick folder…** → choose an iCloud Drive folder.
2. Type in the test box → **Save**.
3. **Force-quit** the app, relaunch, open this panel.
4. **Reconnect** (resolves the saved bookmark — no picker), then
   **Read** — the text returns. Durable arbitrary-iCloud access proven.

iOS only — every action reports "iOS-only" on desktop.

## Build & run (Mac + Xcode required)

```sh
npm install
npm run ios:init          # first time only
npm run tauri ios dev     # or: npm run tauri ios build
```

Test on a **real device signed into iCloud** — the simulator's iCloud
Drive is unreliable.
