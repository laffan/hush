# Hush — Sync Architecture

> **Status**: Stable on the core primitives (identity, op-log, cursor); a
> 2026-05 audit pass added rev-gated uploads, an explicit conflict
> prompt, a unified write-gate predicate, and longpoll-driven change
> detection. The 2026-04 rewrite that introduced the cursor + op-log
> remains the architectural baseline.
> **Last Updated**: 2026-05-15

## Why This Document Exists

The original sync system used path-based identity, mixed clock domains
for conflict resolution, and fired Dropbox mutations directly from UI
handlers. Those choices produced two reproducible failure modes:

1. **Renames duplicated files.** A rename in Hush kicked off a Dropbox
   `move`. If that call raced with the polling diff (10 s cadence), the
   diff saw the old path as "new" and imported a fresh internal file
   with a different UUID. Now the same logical file existed twice
   locally.
2. **Content vanished.** "Most recent wins" compared Dropbox's
   `server_modified` (server clock) against `last_synced_at` (local
   clock). Even small clock skew flipped the comparison the wrong way,
   and the user's edits could be silently overwritten by a stale pull
   or vice versa.

Patching either symptom in isolation would not fix the other. The data
model couldn't *represent* the things it needed to do correctly: it
had no notion of a Dropbox file's stable identity (only its current
path), no operation log to survive offline, and no per-revision tokens
to recognise its own writes.

## What Changed (history)

The sync layer was rewritten in seven stages (2026-04), each landing
as a separate commit so any one can be reverted independently. Three
follow-on stages (2026-05) addressed multi-device activation races.
The 2026-05 audit pass added the rev gate, conflict prompt, and
longpoll.

| Stage | Commit | Change |
|------|------|--------|
| 1 | `5205e29` | Move sync map from `sync_map.json` into a SQLite `sync.db`. Add `dropbox_cursor`, `pending_ops`, `sync_orphans` tables. Migrate legacy JSON; resolve duplicate paths by keeping the most-recently-synced entry and recording orphans. |
| 2 | `de55cdd` | Replace fire-and-forget UI mutations with a durable op log + drain worker. Idempotent executors collapse retried partials. Ops survive offline. |
| 3+4 | `8557a28` | Replace `checkDropboxChanges` + `diffDropboxSync` (polling, path-set diff) with a single cursor consumer. Match by Dropbox `id` (stable across rename). Echo suppression via `rev` plumbed through every upload. |
| 5 | `32164a4` | `acquirePullLock` / `releasePullLock` held across the full async pull window. Blocks save and dirty-mark on the locked file so a keystroke during a pull can't ride out the network call and overwrite the just-arrived content. |
| 6 | `83e9097` | Local-folder watcher: stricter path-suffix match; skip identical-content reload events. |
| 7 | `1841edf` | Remove `checkDropboxChanges`, `diffDropboxSync`, `update_sync_hash`. Update READMEs. |
| 8 | `6e7d6ea` | Route content uploads through the op-log. `syncFileToExternal` now enqueues an `upload` op instead of calling `dbx.uploadFile` directly. `executeUpload` prefers `info.relativePath` over `op.path` so a content op draining behind a rename op uses the post-rename path. |
| 9 | `19024a7` | `setInitialSyncBarrier`. `runSyncCycle` and `drainOnce` are no-ops while set; main's `dropbox-sync-start` handler sets it before `await performInitialSync` and clears in `finally`. |
| 10 | `b27956d` | Replace blind meta pushes in `reconcileSync` with `pushMetaIfAbsent`. `applyDesksFile` re-publishes when `desks.length > incomingDesks.length` so simultaneous-activation races converge to the union. |
| 11 | `(prev)` | Two-part desk-content arrival fix (`looksLikeUnwrappedDeskSkeleton` no longer requires an `Inbox`; `ensureDesksTreeSpecials` skips name-matching stragglers). |
| 12 | this branch | **Audit pass (2026-05-15).** See "Audit pass" below for the full list of changes. |

## Audit pass (2026-05-15)

An expert-audit walk-through of the sync layer surfaced nine concrete
issues. All are addressed on this branch; what follows is the
authoritative description of the post-audit state.

### a. Rev-gated uploads (fixes silent overwrites)

Pre-audit: `uploadFile` / `uploadBinary` used `{ mode: "overwrite" }`
unconditionally. With desktop + iPad + iPhone editing concurrently,
device B could clobber device A's just-pushed rev inside the cursor
window. The "loser" device only learned about the clobber when its
cursor reported the winner's rev, at which point the lost content was
already gone from Dropbox (recoverable only via Versions, with no
prompt).

Post-audit: every upload carries the `last_known_rev` we're updating
against, so Dropbox returns 409 `conflict` if the remote has moved.
On conflict the executor pulls the cursor (so we now know the remote
rev + content), then routes to the conflict prompt (see (b)). If
there's no editor open on the file, the loser side auto-snapshots its
local content and accepts the remote — recovery from Versions is one
click. If the editor *is* open, the prompt fires.

Implementation: `dropbox.js#uploadFile` / `uploadBinary` accept an
optional `rev` param; `op-log.js#executeUpload` passes `info.lastKnownRev`
or "" (first upload). 409 handling lives in `executeUpload`.

### b. Conflict prompt for actively-edited files

User-story #2: "If newer files exist on Dropbox than what is being
pushed, the user should be asked to choose which file they would like
to keep." Pre-audit: no UI; remote silently won.

Post-audit: on a 409 from the rev-gated upload, when the file is open
in the editor or as a pane, `sync-conflict-modal.js` opens with three
choices (Keep mine / Keep remote / Open Versions). The local content
is snapshotted before either branch applies so the user can always
walk it back through Versions. The prompt is per-file; concurrent
conflicts queue.

### c. Notebook pull-lock gap

Pre-audit: `_isPullLockedForCurrent` matched against
`state.currentFileId` only. A remote pull for the open notebook fired
`notebook-sync-reload` without acquiring the lock, so the 2 s notebook
autosave could capture the post-reload state and overwrite the very
edit the user was making mid-stroke.

Post-audit: `_isPullLockedForCurrent` matches `currentNotebookFileId`
too; `applyContentChanged` acquires the lock before emitting
`notebook-sync-reload` and releases it after `reloadNotebookShapes`
finishes.

### d. Cross-folder remote moves now reparent the tree

Pre-audit: `applyRenamed` only updated the file's `relative_path` in
the sync map plus the leaf-name in the tree. A file moved between
folders on iPad arrived on Mac as a rename-in-place, but
`buildSyncManifest` later read the unmoved tree and `reconcileSync`
issued a Dropbox move back to the original parent — silently undoing
the user's iPad move.

Post-audit: `applyRenamed` compares old vs new parent path; when they
differ, the node is removed from its current parent and reinserted
under the new parent (creating intermediate folders if needed). The
reparenting walks the same desk-aware insertion logic as
`insertDocumentNode`.

### e. Doc images are now desk-aware

Pre-audit: `sync-images.js` hard-coded `Images/` at the sync root and
the legacy single-folder `__images__` id. On a desks-enabled install,
images created from the active desk landed under top-level `Images/`
on Dropbox instead of `<DeskName>/Images/`, and on receive the
top-level folder routed inconsistently.

Post-audit: `syncCreateImage` resolves the active desk and writes to
`<DeskName>/Images/<filename>`. `insertImageIntoTree` and
`sync-polling.js#insertImageNode` route to the matching desk's
`__images__:<deskId>` folder via `state.getImagesId()`. The bare-id
`__images__` fallback survives as legacy compat for installs that
haven't migrated to desks yet.

### f. Longpoll replaces the 10 s timer

Pre-audit: a fixed `setInterval` ran the cursor cycle every 10 s.
Latency on the receiving device was up to 10 s; idle devices burned
unnecessary `list_folder/continue` calls.

Post-audit: `dropbox-cursor.js#runLongPoll` wraps Dropbox's
`/2/files/list_folder/longpoll` (server-side wait up to 90 s, returns
immediately on changes). The polling driver awaits longpoll; on
`changes: true` it runs the cursor pull and loops. The original
`runSyncCycle` is retained for the startup reconcile path and as a
safety-net poll every 60 s when longpoll is unavailable. The drain
worker keeps its own retry cadence (`DRAIN_RETRY_INTERVAL_MS = 30000`).

### g. A unified write-gate predicate

Pre-audit: nine separate guard sites checked
`state.runtime.reseedActive` (and a parallel barrier flag for
initial sync). Adding a new sync writer meant remembering to check
both flags in the right order, or quietly racing.

Post-audit: a single `isSyncWriteGated(state)` predicate in
`sync-gate.js` covers reseed + initial-sync barrier + sync-not-
configured. Every push path calls it; the barrier setters are
unchanged but now have one consumer to remember.

### h. Versioned source-of-truth for `.hushproject`

The dead-write code for per-folder `.hushproject` files
(`sync_commands.rs#write_project_json`, `sync.rs#write_project_json`,
the JS-side classification helpers, and skip-on-receive branches in
five files) has been removed. Project ordering lives in
`.hush/projects.json` exclusively; old `.hushproject` files left on
Dropbox by pre-rewrite peers are still tolerated on receive but not
processed.

### i. Pending-ops surfacing

The Sync log now shows the pending-ops queue inline: each `pending_ops`
row with `attempts > 0` or `last_error != null` appears beneath the
recent-activity list with kind, target path, attempt count, and the
last error. A "Retry now" button kicks the drain.

### j. Project ordering propagates on sidebar reorder

Pre-audit: dragging a doc to reorder it inside a project saved the
tree locally and ran `reconcileSync`, but `reconcileSync`'s
`pushMetaIfAbsent` only republishes `.hush/projects.json` when Dropbox
*doesn't already have a copy* — true on first activation, false ever
after. Subsequent reorders never reached other devices.

Post-audit: `files-panel.js#onChange` calls
`state.syncProjectOrdering(state.currentProjectId || null)` after
every drag-reorder, which always re-serialises and pushes the full
projects registry through the op-log.

### k. Late-arriving folders pick up their project status

Pre-audit: `applyProjectsFile` looks up each entry's folder by
`{deskId, innerPath}` and silently skips entries whose folder hasn't
synced down yet. Once skipped, the entry stays skipped — the cursor
only re-fires `.hush/projects.json` when *that file* changes, not
when a folder it references arrives.

Post-audit: `syncDropboxCursor` calls
`reapplyProjectsAfterCreates(state, dbx)` whenever a cycle imported
any new docs/folders. It re-downloads `projects.json` and re-runs
`applyProjectsFile` against the now-complete tree. Idempotent — a
folder that's already a project is a no-op.

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

**Identity is `remote_id`.** `relative_path` is for upload/download URL
building only. When Dropbox reports a rename, we receive the same
`remote_id` with a new `path_display`; we update `relative_path` and
move on. No new internal file is ever created.

`last_known_rev` is the load-bearing field for echo suppression AND
for the rev-gated upload's `update` mode. After every upload we record
the response's rev. The next upload passes that rev to Dropbox as the
update precondition; if the remote has moved, Dropbox returns 409 and
the conflict path runs.

### `dropbox_cursor`

One row per sync folder, holding the `/2/files/list_folder/continue`
cursor and the configured `root_path`. Cleared on disconnect or on
cursor-reset (409 from Dropbox, e.g. after >90 days idle).

### `pending_ops`

Durable queue of outbound mutations. Each row is `(kind, internal_id,
remote_id, path, new_path, payload, attempts, last_error)`. The drain
worker peeks one at a time in insertion order, executes against
Dropbox, and either drops the row on success or increments `attempts`
on failure. A persistent network error stops the drain so subsequent
ops don't reorder past it.

### `sync_orphans`

Set aside during the migration from `sync_map.json` when two
`internal_id`s pointed at the same external path (the on-disk
fingerprint of the rename-duplication bug). The most-recently-synced
entry wins; the others land here and are surfaced in settings for
manual review.

## Code Layout

| File | Role |
|------|------|
| `src-tauri/src/sync_db.rs` | All SQLite access. Schema, queries, JSON migration. ~470 lines incl. tests. |
| `src-tauri/src/sync.rs` | `SyncManager` — high-level operations. Filesystem helpers for desktop sync. Public API stable across the rewrite. |
| `src-tauri/src/sync_commands.rs` | Tauri command surface. |
| `src/sync/dropbox-cursor.js` | Cursor consumer + longpoll driver. Converts Dropbox deltas into typed events. |
| `src/sync/op-log.js` | Drain worker + idempotent executors (incl. 409-conflict handling). |
| `src/sync/sync-mutations.js` | Thin wrappers from UI events to op-log enqueues. |
| `src/sync/sync-polling.js` | Longpoll loop driver. Dispatches handlers, drives op-log drain. |
| `src/sync/sync-state.js` | Initial sync, reconcile, push helpers. |
| `src/sync/sync-gate.js` | Single `isSyncWriteGated(state)` predicate. Every push path consults it. |
| `src/sync/sync-conflict-modal.js` | Per-file conflict prompt. |
| `src/sync/sync-images.js` | Image upload/download. Routes to active desk's `Images/`. |

## How Each User-Visible Scenario Resolves

### Rename a file in Hush
UI handler calls `enqueueRename(internalId, fromPath, toPath)`. Drain
worker calls `dbx.moveEntry`. On success, `rename_sync_file` updates
`relative_path`. If the move fails because the destination already
exists from a previous attempt, `getMetadata(toPath) && !getMetadata(fromPath)`
collapses to success — no duplicate. The cursor's next delta reports
our move, sees rev unchanged, skips.

### Rename a file on iPad while Mac is offline
Mac comes back online. Cursor pulls and gets one event: same
`remote_id`, new `path_display`. Handler calls `rename_sync_file` and
updates the local tree node's name. If the new path's parent differs
from the old one, the node is reparented (see audit (d)). No
duplicate, no content download.

### Edit a file on Dropbox via another app
External app uploads a new revision. Cursor delta reports the file
with a different `rev`. Handler downloads content, calls
`accept_external_change` (takes a snapshot of the previous local
content), then `update_sync_state` to record the new rev. If the file
is open in the editor or notebook canvas, the pull lock is held
across the entire download so a keystroke can't race the apply.

### Edit on Mac while offline
`saveCurrentFile` runs `syncFileToExternal` which enqueues an upload
op. The op-log drain attempts to execute it and fails on the network
call; the op stays at the head of the queue. When connectivity
returns, the next drain succeeds, records the response rev, and the
cursor delta sees its own write (rev match) and skips.

### Edit on Mac and iPad simultaneously while both offline
Each writes locally. When the first reconnects, its upload succeeds
with `mode: update` against an empty rev (first upload after the
network gap) — accepted, rev = R1. When the second reconnects, its
upload tries `mode: update` against R0 (its last known rev) — 409.
The conflict handler pulls the cursor (so the second device now has
R1's content), and depending on whether the file is currently open in
the editor:
  * **Open** → the conflict modal opens with both contents. The user
    picks; the chosen content uploads with `mode: update` against R1,
    becoming R2. The losing content is preserved as a snapshot.
  * **Closed** → auto-accept the remote (R1), snapshot the local
    pre-pull content. The user can recover it from Versions.

### Cursor expires after 90 days idle
`/list_folder/continue` returns 409 with `error.tag = "reset"`. Cursor
consumer clears the stored cursor and reseeds via
`list_folder(recursive=true)` on the next call. The seed reports every
existing entry; legacy entries with no `remote_id` get backfilled by
case-insensitive path lookup.

### Three devices, all active
With longpoll, each device hears about changes within ~1 s of the
upload completing on the writer. The rev gate ensures any device
that's been offline longer than the others gets a clean 409 instead
of overwriting. Conflict prompts queue per-file. The per-file rev
ring (`PER_FILE_REVS_MAX = 64` post-audit, up from 16) covers the
case where the cursor reports an older rev that we've already
superseded with a newer push.

## Known Gaps and Future Work

These are deliberate omissions, not bugs.

- **Cross-folder moves on remote, edge cases.** Reparenting in
  `applyRenamed` handles the common case but doesn't yet move the
  node into a still-empty target folder that hasn't synced down. The
  retry hits on the next cycle once the folder is present.
- **Project / desk demotion.** Promotions (folder → project, folder →
  desk) propagate via push paths. Demotions don't — apply paths are
  union-only. The user has to demote on each device manually.
- **Conflict modal styling.** The current modal reuses the
  source-of-truth modal's CSS rather than its own.

## Testing

See `SYNC-TESTS.md` for the manual test plan. Unit tests for the
SQLite layer live in `src-tauri/src/sync_db.rs::tests`.
