# Sync & Desk Storage — Technical Overview

Extension of [README-TECHNICAL.md](README-TECHNICAL.md). Covers how Hush stores desks as folders, how those folders survive being mutated by third-party sync providers (iCloud Drive, Dropbox, Syncthing), and the invariants that keep a stale tree or a slow provider from destroying user content. This is the most dangerous subsystem in the app — most of the rules below were learned from real data-loss incidents, so read this before touching `desk_store.rs`, `desk_scan.rs`, or `sync/`.

**There is no sync engine.** Hush writes plain files into desk folders; the user's own file provider moves the bytes. Everything here is about making that safe.

## The model

- **Internal desk** — a folder at `{data_dir}/desks/<deskId>/`, fully owned by Hush. The tree is authoritative; the folder mirrors it.
- **Local desk** — the same layout written into a folder the user picked (`desks/roots.json` maps deskId → path). The *disk* is authoritative; the tree follows it via a disk-wins reconciler. The folder belongs to the user and to their sync provider.
- **Local Sync mount** — a different, older feature: a folder mounted read/write into the sidebar (`sync/local-sync.js`, Rust `local_sync.rs`) with *no* desk semantics, no fileIds, no version history. Hush simply reflects the filesystem. Don't confuse the two when reading code — "local desk" machinery lives in `desk_*.rs` / `sync/desk-roots.js`, mounts in `local_sync*` / `files-panel-local-sync*`.

### Desk folder layout

```
<desk root>/
├── .hushdesk                 desk identity + portable meta (style, last file,
│                             ratchet flag, desk stickies)
├── .hush/
│   ├── index.json            fileId ↔ relative path
│   ├── tree.json             structure + ordering + row decoration
│   ├── versions/<fileId>/<ms>-<deviceId>.snap
│   ├── hashes.json           fileId → content hash (rename pairing)
│   ├── gdoc-links.json       fileId → Google Doc link (rides handoffs)
│   └── orphans/              files whose node vanished — parked, never deleted
├── Inbox/  Trash/  Images/  Archive/
├── <Doc>.md   <Notebook>.hushnote   <Stack>.hushstack
└── <Project>/…
```

Supporting state in `{data_dir}`: `desks/order.json` (desk ordering + straggler nodes), `desks/.staging/<fileId>` (files created before they have a tree position), `desks/.deleted/<deskId>-<epoch>/` (retired desks — never wiped; the recovery source), `desk-archives/*.husharchive`, `desk-recovery/<deskId>/*.husharchive`, `device_id` (suffixes snapshot filenames so two devices never contend over one file). PDFs are deliberately absent from desk folders — metadata lives in a registry, binaries are a per-device cache re-downloaded from Zotero.

## The desk store (`desk_store.rs`, placement in `desk_place.rs`)

`save_forest` reconciles paths on every tree save: each file-backed node's expected path is computed from the tree (names sanitised to single path segments, sibling collisions suffixed ` (2)`), compared against the index, and files are moved / created / adopted to match. `load_forest` assembles the tree from `order.json` + per-desk `tree.json`, adopting any desk folder on disk the order file doesn't know about (the handoff seam). `FileManager` keeps its fileId-keyed command surface (`load_file` / `save_file` / …) and resolves ids through the per-desk indexes, so the frontend is layout-agnostic. **Per-desk IO errors are contained**: a desk whose folder is unreachable mid-save (a local desk's provider not mounted — routinely ENOENT) is skipped wholesale — its index and tree.json keep their previous generation *together* — and the failure is reported after the other desks have written. Aborting the whole pass at the first error left the on-disk forest mixed-generation, and the next `load_forest` stitched the halves together; that tearing is how a node moved between desks ended up recorded under both.

**Deletion is never inferred.** A desk missing from a saved forest is indistinguishable from a *stale* tree (a second window that never saw it, an iPad scene resumed with an old snapshot, a boot that read before iOS re-granted folder access). Removal is explicit only: `desk_retire` moves the folder to `.deleted/`, archiving calls `desk_archive` + `desk_discard_archived`, and a local desk detaches via `desk_unregister_root`. `save_forest` never retires or unregisters anything on its own.

**Local desks are exempt from every destructive half of the reconcile.** No orphan-parking (an unindexed file stays put and is re-absorbed), pruning restricted to directories Hush itself emptied, no blank-filling for untraceable fileIds (that's the signature of a stale tree — the dangling node is dropped instead; on any desk, `place_file` checks retired folders for real bytes before it would ever write a blank doc, because an empty doc reads as healthy and the first keystroke makes the loss permanent), and a desk node whose folder is missing is skipped wholesale rather than fabricated as blanks.

**One desk per file (`desk_dedupe.rs`).** A fileId belongs to exactly one desk — `locate` returns the first index hit, so a doubly-claimed id has no single answer and the damage compounds (both indexes claim it, `place_file` moves the bytes to whichever desk was walked last, deleting either desk kills the only copy). `repair_forest` runs inside `save_forest` before anything is computed: a contested fileId resolves to the desk that already holds the bytes (pure bookkeeping, no file moves); a foreign special (an `__inbox__:<otherDesk>` node inside the wrong desk) has its contents lifted into the right special and the shell dropped. Real (non-alias) `pdf` nodes participate in the invariant too — their binaries live in the app-global cache, never in `old_global`, so a contested PDF resolves to the desk claiming it *outside* its Trash (project `pdfAlias` nodes legitimately share the original's fileId and never count as claims). PDFs were once exempt entirely, which is why a PDF duplicated across desks never healed: the sidebar rendered one copy while `isInTrash(id)` matched the twin, producing an undeletable row wearing trash menu entries. Returns `None` on a sound forest so the common path pays nothing. The JS-side seams that used to produce broken forests are closed too — see `absorbMatchingFolder`, `ensureDesksTreeSpecials` (folds stragglers into the *first* desk, the same answer in every window — the active desk is per-window), and `migrateLegacyTreeIfNeeded` (asks `desk_store_diagnostics` before treating a desk-less read as a legacy install; on iOS a short read is routine).

**Rescue (`desk_rescue.rs`).** Retired folders keep their `.hush/index.json`, which is what makes id-keyed recovery possible. `recover_desk_files` (Settings > Debug > Repair desk files) copies bytes back for any live node whose fileId resolves to nothing; it only ever adds. `store_diagnostics` powers the Debug tab's per-desk counts.

## Local desk roots (`desk_roots.rs`, `desk_scan.rs`, JS `sync/desk-roots.js`)

`roots.json` entries are either a bare path string (desktop) or `{path, bookmark}` (iOS — untagged serde so v1 files parse). `DeskStore::desk_dir` consults the map (mtime-cached); that one redirection carries files, images, snapshots, and tree IO.

- **Make Desk Local…** moves the desk folder out of app data (per-entry rename, recursive copy+delete fallback for cross-volume; target must be empty and outside app data). **Make Desk Internal** reverses.
- **Open Folder as Desk… / create Local desk** (`desk_open_folder_as_desk`): a folder already carrying `.hushdesk` + `.hush/tree.json` is *adopted* (identity, ordering, history intact); any other folder is initialised **in place** — fresh desk id, then `absorb_disk_files` builds the desk node *and* the index from the folder's existing files **before anything is written**, so the first sidecars on disk are already complete and the folder never has a moment where it looks like an empty desk (a concurrent tree save once mistook that moment for "this desk has no files" and wiped a populated folder to a skeleton). An existing `Inbox/` / `Trash/` / etc. (any case) folds into the desk's special of that kind. Mid-initialise failure removes the partial sidecars. Refused: non-folders, paths inside app data, already-registered folders, half-initialised ones (`.hushdesk` xor `.hush`).
- **Local desks are named by their folder** — `renameDesk` throws `desk-rename-local`; `adoptFolderName` (the only writer, via make-local/adopt) copies the folder's basename in. Desk folders are keyed by desk *id*, so a rename is metadata only.
- **Absorbed docs keep their extension** — `preserve_doc_extensions` lets an adopted `.txt` / `.markdown` stay itself instead of being renamed to `.md` on the next tree save.

### Disk-wins reconcile (`desk_reconcile` → `desk_scan.rs`)

Triggered per desk by a `notify` watcher (desktop), an `NSMetadataQuery` via the icloud-folder plugin (iPad, iCloud folders), foreground `visibilitychange` (iPad fallback), and **at boot on every platform** (the watcher only covers the running session; changes that synced in while Hush was closed used to stay invisible until an unrelated event). The command runs through the `FileManager` mutex — the reconciler rewrites the desk's `tree.json`, and unsynchronized it could load a desk's tree, have a concurrent `save_forest` rewrite it, then write its stale copy back, resurrecting nodes the save had just moved to another desk. Recognised files with no index entry become tree nodes (directory chains mirrored as containers); the open doc re-reads through `applyExternalDocContent` (no-op on identical content or a dirty buffer).

**Absent is not deleted.** Inside a provider-synced folder, "missing from the listing" routinely means *not delivered yet*. Two guards in `desk_scan.rs`:

1. A `.Name.icloud` placeholder counts as **present, just not local**. Its path rides out in `ScanReport.pending_downloads`; on iOS the JS side walks them through the plugin's coordinated `read_file` (which triggers `startDownloadingUbiquitousItem` — plain `std::fs` never does), capped 25/pass.
2. Any other absence starts a **10-minute grace clock** (process-wide `MISSING_SINCE` ledger keyed by root+fileId). An entry drops only when a scan ≥10 min after the first miss still can't see the file — a single scan can never remove anything, and the post-adopt reconcile is additions-only by construction. Reappearance resets the clock; a restart merely restarts it. Held-back absences surface in `ScanReport.pending` → sync log.

**Renames pair by content hash (`desk_hashes.rs`).** `.hush/hashes.json` holds FNV-1a of each file's bytes (+ the mtime it was taken at), refreshed on every content save and by a reconcile pre-pass for moved mtimes. Vanished entries are held back until additions have had a chance to pair — an added file hashing to a vanished entry's cache keeps that entry's fileId, so version history, panes, and recents survive a Finder or provider rename. Same-directory renames update the node in place; relocations lift it (decoration and all) into the new container chain. The cache is best-effort derived state — losing it costs one pairing, never content.

**Conflicted copies (`desk_conflicts.rs`).** Provider conflict siblings (Dropbox `… (conflicted copy …)`, Syncthing `.sync-conflict-…`; iCloud's ambiguous `Doc 2.md` is deliberately unmatched) are resolved automatically: both sides snapshot into Versions under the same fileId, the newer bytes keep the real path, the sibling is removed, and a toast + sync-log line reports it. If the original vanished in the same race the sibling is adopted as the file.

A two-install soak test (`desk_soak_tests.rs`) drives adopt / edit / add / rename / conflict / delete through two data dirs sharing one desk folder.

### iOS specifics

iOS sandboxing means an arbitrary iCloud Drive folder is only reachable through a security-scoped URL from the system picker, and access dies on relaunch unless a **security-scoped bookmark** is persisted and re-resolved. The custom Swift plugin `src-tauri/tauri-plugin-icloud-folder/` provides `pick_folder` / `resolve_bookmark` / `stop_access` plus `NSFileCoordinator`-coordinated file I/O (binary payloads as base64) and the `start_watch` / `stop_watch` NSMetadataQuery pair. Boot re-resolves every bookmarked root (so plain `std::fs` works for the rest of the run) and repoints stale container paths via `desk_update_root_path`. `main.js` runs `acquireLocalDeskAccess(state)` **before** `state.init()` so the boot tree read can actually see local desks. Bookmarked roots get no `notify` watcher — there are no filesystem events on iOS.

## The provider-agnostic core (`sync/`)

- **`apply-external.js`** — the single implementation of "apply externally-produced content to the open buffer": pull-locked, applied as a minimal common-prefix/suffix diff (cursor maps through the edit), clears `dirty` (an applied external change is not a user edit), skips on identical content, and — with `skipWhenDirty: true`, the standard policy — never clobbers unsaved keystrokes (the buffer is strictly newer than anything disk can offer; the next autosave reasserts it). Callers: local-desk reconcile, Local Sync watcher/foreground reload, multi-window broadcasts.
- **`echo-ring.js`** — bounded "recently seen" rings + `sha256Hex`. **Echo suppression is by content identity, never by timestamp** — iCloud's bird daemon replays events seconds late, which is exactly what killed the old 500 ms write-origin window: late events landed outside it while the buffer had moved past the last autosave, so the reload wiped keystrokes and threw the cursor to the top, every few seconds while typing. Every write path marks a hash into its ring; on-disk content matching any recent own-write hash is skipped as an echo no matter how late it arrives.
- **`pdf-sync.js`** — PDF metadata registry + background Zotero downloads (progress ring, startup resume). Metadata only; binaries are per-device cache.
- **`sync-feedback.js`** — corner toast + persistent `settings.syncLog` (Settings > Sync > Log; `[!]`-prefixed rows paint red).
- **`notebook-sync.js`** — `.hushnote` zip pack/unpack, the sole wire format for notebook envelopes.
- **`desk-meta.js`** — portable desk meta, below.
- **`desk-roots.js`** — the JS lifecycle for local desk roots (watcher subscription, debounced reconcile, boot/foreground passes).

The external-store hooks on `AppState` (`syncFileToExternal`, `syncCreateNode`, …) are the choke points every mutation path already reports through — the desk-folder write-through attaches there, and features like YOU ARE HERE detection piggyback on them.

**Never write a file the user didn't edit.** Any programmatic `setContent` dispatches through CodeMirror's updateListener, which can't distinguish it from a keystroke — so every load/reload path resets `dirty` on the same tick (`openLocalSyncFile`, `applyExternalDocContent`). Without that, the 2 s autosave writes the just-loaded buffer back, bumping mtimes with no real edit and clobbering the other device's changes on shared files.

## Portable desk meta (`desk_meta.rs`, `sync/desk-meta.js`)

Desk-scoped preferences ride inside the desk so a handed-off folder feels like the one you left: `.hushdesk` carries `{ styleId, ratchet, lastFileId, lastFileType, stickies }` (field-merged via `desk_meta_get` / `desk_meta_set`; values stored verbatim, `null` included — "no last file" is an explicit choice). `settings.desksMeta` / `settings.stickyNotes` remain the runtime store: JS pushes after each desk-scoped mutation (de-duped per desk) and pulls **disk-wins** at boot, after adopt, and after every reconcile; pushes are gated until the first pull so a boot re-persist can't clobber another device's newer meta. A pull that changes stickies emits `desk-meta-pulled`; one that flips `ratchet` emits `mode-changed` (the open buffer must re-lock immediately). Google-Doc links follow the same pattern via `.hush/gdoc-links.json` — the per-desk sidecar is durable, `settings.googleDocLinks` is the merged read cache (`refresh_gdoc_link_cache` at boot/adopt/reconcile), and an install without Google credentials keeps the links in a disabled state. `settings.activeDeskId` is deliberately local-only — each device picks its own.

## Versions (`snapshots.rs`)

One file per snapshot, stored inside the desk: `.hush/versions/<fileId>/<createdAtMs>-<deviceId>.snap`, plain bytes, append-only. The device-id suffix means two devices writing into a shared folder never contend over one filename. Staged files snapshot under `desks/.versions-unplaced/`; reads aggregate across every desk plus that fallback; cross-desk moves carry the version directory along. Decay policy (applied on create + a startup sweep): keep all for 30 min, then 1/min to 2 h, 1/10 min to 24 h, 1/hour to 7 days, 1/day beyond.

## Archives & recovery snapshots

**Archiving replaces deleting** (`desk_archive.rs`). `archive_desk` zips the desk's whole folder — dotfiles included, they *are* the desk — into `desk-archives/<slug>-<epoch>.husharchive` with a manifest at the zip root, built in memory and written once. It deliberately does **not** remove the desk: the frontend zips, verifies, then unhooks and calls `desk_discard_archived`, so a failed archive can never cost a desk. A local desk's folder is copied, never moved. `restore_archive` unpacks into a **new** internal desk and re-identifies everything — fresh desk id, specials, tree-node ids, and fileIds (images excepted: their fileId is their filename) — which is what makes restoring twice, or restoring beside the source desk, safe under the one-desk-per-file invariant. `state/desk-teardown.js` closes the departing desk's panes/takeover views (views only, never data) and flushes the editor + open notebook *before* the zip reads the folder.

**Recovery snapshots (`desk_recovery.rs`)** are defense-in-depth for local desks, whose folders a provider can mutate underneath Hush. Every content mutation through the desk store stamps its desk; a background thread wakes each minute and zips any local desk edited since its newest snapshot, provided that snapshot is ≥30 min old (a desk with none is due immediately, so short sessions are covered; boot seeds stamps from mtimes). External changes deliberately do **not** stamp — a synced-in wipe can't burn rotation slots on empty states. Newest 16 kept per desk; >1 GiB folders are refused rather than built in memory. **Settings > Sync > Recovery** lists them; Recover restores through the shared re-identify pass into a fresh *internal* desk named `<Desk> Recovery - <time>` — the user's folder is never written to.

## How multi-window and sync interact

Cross-window propagation (see README-TECHNICAL § Multiple Windows) rides the same guards: receivers apply content under the pull lock with `state.runtime.syncPulling` set (suppressing `markDirty` so a pull can't re-trigger a broadcast), and secondary windows write shared settings key-scoped — fresh disk values plus only the touched keys — because a full-copy write from a window with stale memory silently reverts keys it wasn't touching (the vanishing YOUAREHERE registry was this). Conflict policy everywhere is last-write-wins; OT/CRDT is out of scope.

## Rules of thumb when changing this code

1. **Never infer deletion** from a listing, a tree save, or a single scan. Deletion is an explicit user action or a grace-expired absence.
2. **Prefer keeping bytes**: park in `orphans/`, retire to `.deleted/`, adopt rather than overwrite. When a choice risks writing a blank file over real content, check staging and retired folders first.
3. **Identity over timing**: dedupe echoes by content hash, pair renames by content hash. Time-window heuristics have repeatedly failed against iCloud's delayed events.
4. **Disk wins for local desks, tree wins for internal desks.** Don't let one regime's code path run under the other.
5. **All durable writes are atomic** (`atomic.rs`: tmp + fsync + rename). Worst case is always "the previous version".
6. Add tests beside the existing ones — `desk_store_tests.rs`, `desk_roots_tests.rs`, `desk_dedupe_tests.rs`, `desk_archive_tests.rs`, `desk_recovery_tests.rs`, `desk_soak_tests.rs` — they encode the incidents above.
