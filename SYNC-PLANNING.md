# Hush — Sync Architecture

> **Status**: Stable. Rewritten 2026-04 to fix the rename-duplication and content-loss bugs.
> **Last Updated**: 2026-04-29

## Why This Document Exists

The original sync system used path-based identity, mixed clock domains for conflict resolution, and fired Dropbox mutations directly from UI handlers. Those choices produced two reproducible failure modes:

1. **Renames duplicated files.** A rename in Hush kicked off a Dropbox `move`. If that call raced with the polling diff (10s cadence), the diff saw the old path as "new" and imported a fresh internal file with a different UUID. Now the same logical file existed twice locally.
2. **Content vanished.** "Most recent wins" compared Dropbox's `server_modified` (server clock) against `last_synced_at` (local clock). Even small clock skew flipped the comparison the wrong way, and the user's edits could be silently overwritten by a stale pull or vice versa.

Patching either symptom in isolation would not fix the other. The data model couldn't *represent* the things it needed to do correctly: it had no notion of a Dropbox file's stable identity (only its current path), no operation log to survive offline, and no per-revision tokens to recognise its own writes.

## What Changed

The sync layer was rewritten in seven stages, each landing as a separate commit so any one can be reverted independently.

| Stage | Commit | Change |
|------|------|--------|
| 1 | `5205e29` | Move sync map from `sync_map.json` into a SQLite `sync.db`. Add `dropbox_cursor`, `pending_ops`, `sync_orphans` tables. Migrate legacy JSON; resolve duplicate paths by keeping the most-recently-synced entry and recording orphans. |
| 2 | `de55cdd` | Replace fire-and-forget UI mutations with a durable op log + drain worker. Idempotent executors collapse retried partials. Ops survive offline. |
| 3+4 | `8557a28` | Replace `checkDropboxChanges` + `diffDropboxSync` (polling, path-set diff) with a single cursor consumer. Match by Dropbox `id` (stable across rename). Echo suppression via `rev` plumbed through every upload. |
| 5 | `32164a4` | `acquirePullLock` / `releasePullLock` held across the full async pull window. Blocks save and dirty-mark on the locked file so a keystroke during a pull can't ride out the network call and overwrite the just-arrived content. |
| 6 | `83e9097` | Local-folder watcher: stricter path-suffix match; skip identical-content reload events. The op-log + content-hash dedup pattern doesn't apply here (local sync is browse-in-place, not import-into-internal-store). |
| 7 | this commit | Remove `checkDropboxChanges`, `diffDropboxSync`, `update_sync_hash`. Update READMEs. |

## The Data Model

### `synced_files`

```sql
internal_id      TEXT PRIMARY KEY,   -- our UUID
sync_folder_id   TEXT NOT NULL,
relative_path    TEXT NOT NULL,      -- DISPLAY-only; never used for identity
last_synced_hash TEXT,               -- SHA256 of last-synced content
last_synced_at   INTEGER,            -- Dropbox clock, never mixed with local
remote_id        TEXT,               -- Dropbox "id:abc..." — STABLE across rename
last_known_rev   TEXT                -- Dropbox per-revision token
```

**Identity is `remote_id`.** `relative_path` is for upload/download URL building only. When Dropbox reports a rename, we receive the same `remote_id` with a new `path_display`; we update `relative_path` and move on. No new internal file is ever created.

`last_known_rev` is the load-bearing field for echo suppression. After every upload we record the response's rev. When the cursor's next delta reports the same file with the same rev, we recognise it as our own write and skip.

### `dropbox_cursor`

One row per sync folder, holding the `/2/files/list_folder/continue` cursor and the configured `root_path`. Cleared on disconnect or on cursor-reset (409 from Dropbox, e.g. after >90 days idle).

### `pending_ops`

Durable queue of outbound mutations. Each row is `(kind, internal_id, remote_id, path, new_path, payload, attempts, last_error)`. The drain worker peeks one at a time in insertion order, executes against Dropbox, and either drops the row on success or increments `attempts` on failure. A persistent network error stops the drain so subsequent ops don't reorder past it.

### `sync_orphans`

Set aside during the migration from `sync_map.json` when two `internal_id`s pointed at the same external path (the on-disk fingerprint of the rename-duplication bug). The most-recently-synced entry wins; the others land here and are surfaced in settings for manual review.

## Code Layout

| File | Role |
|------|------|
| `src-tauri/src/sync_db.rs` | All SQLite access. Schema, queries, JSON migration. ~470 lines incl. tests. |
| `src-tauri/src/sync.rs` | `SyncManager` — high-level operations. Filesystem helpers for desktop sync. Public API stable across the rewrite. |
| `src-tauri/src/sync_commands.rs` | Tauri command surface. |
| `src/sync/dropbox-cursor.js` | Cursor consumer. One responsibility: convert Dropbox deltas into typed events. |
| `src/sync/op-log.js` | Drain worker + idempotent executors. |
| `src/sync/sync-mutations.js` | Thin wrappers from UI events to op-log enqueues. |
| `src/sync/sync-polling.js` | 10s tick: invoke cursor pull, dispatch handlers, drive op-log drain. |
| `src/sync/sync-state.js` | Initial sync, reconcile, push helpers. (Some legacy bulk operations live here.) |

## How Each User-Visible Scenario Resolves

### Rename a file in Hush
UI handler calls `enqueueRename(internalId, fromPath, toPath)`. Drain worker calls `dbx.moveEntry`. On success, `rename_sync_file` updates `relative_path`. If the move fails because the destination already exists from a previous attempt, `getMetadata(toPath) && !getMetadata(fromPath)` collapses to success — no duplicate. The cursor's next delta reports our move, sees rev unchanged, skips.

### Rename a file on iPad while Mac is offline
Mac comes back online. Cursor pulls `/2/files/list_folder/continue` and gets one event: same `remote_id`, new `path_display`. Handler calls `rename_sync_file` and updates the local tree node's name. No duplicate, no content download.

### Edit a file on Dropbox via another app
External app uploads a new revision. Cursor delta reports the file with a different `rev`. Handler downloads content, calls `accept_external_change` (which takes a snapshot of the previous local content via `snapshots.rs`), then `update_sync_state` to record the new rev. If the file is open in the editor, the pull lock is held across the entire download so a keystroke can't race the apply.

### Edit on Mac while offline
`saveCurrentFile` runs `syncFileToExternal` which fails (no network). Local content is preserved (FileManager wrote it). Cursor doesn't run. When connectivity returns, the next `saveCurrentFile` succeeds, records the response rev, and the cursor delta sees its own write (rev match) and skips.

### Edit on Mac and iPad simultaneously while both offline
Each writes locally. When the first reconnects, its upload succeeds and records `last_known_rev = R1`. When the second reconnects, it tries `uploadFile` in `mode: overwrite` — succeeds, replacing R1 with R2. The first device's cursor delta sees R2 (different rev) and pulls, overwriting its local content — the user can recover the lost edits from Versions. This is "most recent wins" by intent. Three-way merge is out of scope.

### Cursor expires after 90 days idle
`/list_folder/continue` returns 409 with `error.tag = "reset"`. Cursor consumer clears the stored cursor and reseeds via `list_folder(recursive=true)` on the next call. The seed reports every existing entry; legacy entries with no `remote_id` get backfilled by case-insensitive path lookup. No files are duplicated because every match-by-path that would create a duplicate falls through to the existing internal id.

## Known Gaps and Future Work

These are deliberate omissions, not bugs.

- **Rev-locked uploads.** `syncFileToExternal` uses `mode: overwrite`, which can clobber a remote edit that hasn't reached us via cursor yet. The fix is `mode: { ".tag": "update", "update": last_known_rev }` plus a conflict handler that pulls before retrying. Adds one cycle of complexity and isn't load-bearing for the bugs the user reported.
- **Cross-folder moves on remote.** When Dropbox reports a rename whose path crosses folder boundaries, we update the name in the tree but don't reparent. Dropbox iPad / Mac users renaming inside the same folder works perfectly; moving between folders updates the name only.
- **Project ordering uploads.** `.hushproject` files are uploaded via `enqueueUploadPayload` but not tracked in `synced_files` (no `internal_id`). They're regenerated locally on every project change, so a missed sync just means the next change re-uploads.
- **Op-log surfacing.** Failed ops accumulate `last_error` and `attempts` but there's no UI yet that shows them. A future stage can add a "sync queue" view in settings.

## Testing

See `SYNC-TESTS.md` for the manual test plan that demonstrates each user-visible failure mode is fixed. Unit tests for the SQLite layer live in `src-tauri/src/sync_db.rs::tests` and cover roundtrip, LIKE-escape edge cases, op-log FIFO + retry semantics, the case-insensitive path lookup used for `deleted` events, cursor get/set/clear, and the duplicate-resolution behavior of the JSON migration.
