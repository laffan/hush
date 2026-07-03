# Hush — Sync Test Plan

> A user-level test plan demonstrating that the sync rewrite fixes the failure modes that motivated it. These are the specific scenarios that previously produced duplicates, lost content, or stuck the queue.

## Setup

1. Two Hush installations connected to the same Dropbox account. Call them **Mac** and **iPad** (the second can be a second Mac if you don't have an iPad on hand — the Dropbox path is identical).
2. Both devices show the same sync folder under Settings → Sync.
3. Both devices have the same starting file: `Notes/Today.md` containing the text `hello`. Wait for both to sync this baseline.
4. (Optional but useful for inspection.) Open the data dir's `sync.db` with any SQLite viewer:
   - macOS: `~/Library/Application Support/com.hush.app/sync.db`
   - You can also tail console logs to see cursor and drain events.

## Automated tests (already passing)

```sh
cd src-tauri && cargo test --lib sync_db
```

Eleven tests covering: SQLite roundtrip, LIKE escape for paths with `_`, JSON migration with duplicate paths (orphan recording), legacy serde defaults, op-log FIFO + retry semantics, case-insensitive path lookup, `update_sync_state` writing rev + hash atomically, cursor get/set/clear/upsert.

---

## Manual scenarios

### 1. Rename round-trip — no duplicate

**Why:** This was the loudest failure mode. The path-set diff couldn't distinguish a remote rename from delete+create.

1. On **iPad**, rename `Today.md` to `Yesterday.md`.
2. Wait ≤10 seconds (one poll cycle).
3. On **Mac**, the file in the sidebar should rename in place to `Yesterday`. **There must be exactly one file**, not two.
4. Inspect `sync.db`: `SELECT internal_id, relative_path, remote_id FROM synced_files;` — the `relative_path` should reflect the new name, the `remote_id` should be unchanged from before the rename.
5. Now reverse: rename back to `Today` on Mac, observe iPad rename in place.

**Pass:** No duplicates appear in the sidebar at any point. The `internal_id` and `remote_id` are stable across both renames.

---

### 2. Rename of an open file — keystrokes during the rename window

1. On **Mac**, open `Today.md`. Type some content but don't save (or save once and then add more text).
2. On **iPad**, rename `Today.md` to `New Name.md`.
3. While the Mac is mid-poll, type more text into the open editor on the Mac.
4. After the cursor delta lands on Mac, the file should rename in the sidebar but the editor's content should **not** be reverted.

**Pass:** The Mac's edits persist. The remote rename only updates the sidebar name; it does not pull content (rename events don't carry content changes).

---

### 3. External edit while editing locally — content lock holds

**Why:** The original syncPulling boolean only covered the synchronous setContent call. Keystrokes during the long async download window slipped through and got overwritten.

1. On **Mac**, open `Today.md`. Type "MAC EDIT" but don't save.
2. On **iPad**, replace the content of `Today.md` with "IPAD EDIT" and save.
3. On **Mac**, while the Mac's autosave is running and the cursor poll is in flight, keep typing.
4. After the cursor pull lands, the Mac's editor shows the iPad's content. The Mac's keystrokes are not silently retained as dirty state and re-uploaded.

**Pass:** Either the Mac's edits ("MAC EDIT") or the iPad's edits ("IPAD EDIT") wins cleanly — no torn content like "MAC EDITIPAD EDIT". After the pull lands, `state.dirty` is `false` so the next autosave doesn't push anything. Whichever side's content was overwritten is recoverable from the Versions panel.

---

### 4. Offline rename → reconnect

**Why:** Mutations used to fire-and-forget; offline failures vanished.

1. On **Mac**, disable network (Wi-Fi off or just block dropbox.com via /etc/hosts).
2. Rename `Today.md` to `Renamed.md` in Hush.
3. Inspect `sync.db`: `SELECT * FROM pending_ops;` — there should be one row with `kind = 'rename'`, `path = 'Today.md'`, `new_path = 'Renamed.md'`.
4. Re-enable network. Wait ≤30 seconds (drain interval) or trigger any UI mutation to fire `triggerDrain`.
5. The rename now executes against Dropbox. The pending row is removed.
6. iPad observes the rename within one cursor cycle.

**Pass:** Pending row is created while offline; drained on reconnect; iPad sees the rename without duplicate creation.

---

### 5. Edit while offline → reconnect → conflict prompt fires

1. **Mac** offline. Edit `Today.md` with the file open in the editor. Save.
2. While Mac is still offline, on **iPad** edit `Today.md` differently and save.
3. Reconnect the Mac.
4. Mac's `syncFileToExternal` uploads with `mode: update` against its
   stale `last_known_rev`. Dropbox returns 409 conflict. The conflict
   handler downloads iPad's content and — because `Today.md` is open
   in the editor on Mac — fires the **Sync conflict** modal with both
   versions inline.
5. Pick "Keep my version" → Mac's content uploads with iPad's rev as
   the new base; iPad's prior content is in Versions on Mac.
   Pick "Keep the other version" → Mac's editor swaps to iPad's
   content; Mac's prior content is in Versions.

**Pass:** No duplicate file is created. The chosen side wins on
Dropbox; the losing side's content is reachable from the Versions
panel for that file on the chosen device.

### 5b. Conflict on a file that's not open — auto-accept remote

1. Repeat scenario 5 but leave `Today.md` **closed** on Mac (have
   some other doc open in the editor when you reconnect).
2. Reconnect Mac. The 409 fires the same conflict path, but since the
   file isn't open in any editor or pane, the handler skips the modal
   and accepts the remote content silently.

**Pass:** Mac's local content for the closed file becomes iPad's
content; Mac's prior content is preserved in the Versions panel for
that file. No modal interrupts the user.

---

### 6. Echo suppression — uploading doesn't pull our own write back

**Why:** Cross-clock comparisons used to mistake our own writes for remote changes and pull them back, sometimes overwriting in-flight edits.

1. On **Mac**, edit `Today.md` to `revision A`. Save (autosave or Cmd+S).
2. Within seconds, edit again to `revision B`. Save.
3. Watch console / `sync.db`. Expectation: each save records a new `last_known_rev`. The cursor poll reports our writes back, sees `rev == last_known_rev`, skips. No "Synced ↓" indicator should fire as a result of our own uploads.

**Pass:** No spurious "Synced ↓" notifications follow your own saves. `SELECT last_known_rev FROM synced_files WHERE internal_id = ...;` advances on every upload.

---

### 7. External app edits a markdown file in the Dropbox folder

**Why:** Validates the third party use case the user mentioned.

1. Open the Dropbox folder in any other markdown editor (iA Writer, Obsidian, BBEdit, plain TextEdit). Modify `Today.md`. Save.
2. Within ~1–2 s the longpoll loop should wake and pull the change.
3. Hush should pull the change automatically — sidebar unchanged (no duplicate, no rename), open editor (if this file is open) updates with a "Synced ↓" toast.

**Pass:** Content updates in Hush within seconds, without rename or duplicate. The Versions panel for that file gains an entry containing the previous content.

### 7b. Cross-folder move on another device reparents locally

**Why:** Pre-audit, a remote move between folders updated only the
name; the file stayed under its old parent locally, and the next
`reconcileSync` pushed it back to the old path on Dropbox.

1. On **iPad**, move `Today.md` from `Personal/Inbox/` to
   `Personal/Archive/` (drag in the sidebar).
2. Wait for one longpoll cycle on Mac (~1–2 s).
3. Mac's sidebar should show `Today.md` now under
   `Personal/Archive/`, not `Personal/Inbox/`.
4. Open `sync.db`: `SELECT relative_path FROM synced_files WHERE …;`
   reflects the new path.
5. Wait through a force-sync. Inspect Dropbox: file stays at
   `Personal/Archive/Today.md`. No move back to `Personal/Inbox/` fires.

**Pass:** Tree reparents; Dropbox layout is stable across the next
reconcile.

### 7c. Notebook pull mid-stroke doesn't clobber

**Why:** Pre-audit, `notebook-sync-reload` fired without the pull
lock; the 2 s notebook autosave could capture the post-reload buffer
and upload it, erasing the user's in-progress shape from both sides.

1. On **iPad**, open a notebook and start drawing a stroke.
2. On **Mac**, open the same notebook, add a distinct shape, save.
3. While iPad is mid-stroke, the cursor pull from Mac's save lands.

**Pass:** iPad's stroke completes and is preserved. After the next
iPad autosave, both Mac's shape and iPad's stroke are on the canvas
on both devices.

---

### 8. Migration from legacy `sync_map.json`

**Why:** Pre-existing installations have entries that were created before `remote_id` existed.

1. Take a snapshot of `sync_map.json` from a pre-rewrite install (or generate one — see the unit test `migration_keeps_most_recent_duplicate_orphans_the_rest`).
2. Place it in the data dir.
3. Launch Hush.
4. After startup, `sync_map.json` should be renamed to `sync_map.json.bak`. `sync.db` should contain rows for every legacy entry, with `remote_id` and `last_known_rev` empty.
5. After the first cursor poll completes, those empty fields should be backfilled (`SELECT remote_id FROM synced_files;` shows real Dropbox `id:...` values).
6. If the legacy JSON had two entries pointing at the same path (the rename-duplication bug at rest), only the most-recently-synced wins; the other appears in `sync_orphans`.

**Pass:** No legacy data is silently lost. Duplicate-path entries are surfaced, not merged.

---

### 9. Cursor expiry / reset

**Why:** Dropbox invalidates cursors after >90 days idle or on certain server-side events. The system must reseed cleanly.

This is hard to trigger manually. Two options:

- **Manual:** `UPDATE dropbox_cursor SET cursor = 'invalid' WHERE sync_folder_id = '__dropbox_sync__';` then trigger a poll. The cursor consumer should detect the 409 with `reset`, call `clear_dropbox_cursor`, and reseed on the next call.
- **Code review:** Inspect `continueAndProcess` in `dropbox-cursor.js`: a 409 with `tag === "reset"` clears the cursor and returns null; the next pull seeds fresh.

**Pass:** A manual cursor corruption recovers within two poll cycles with no duplicates.

---

### 10. iPad-only test (if you have a device)

Replicate scenarios 1, 3, 4, 7 with the iPad as the actor.

The iPad uses the same JS code path; correctness should be identical. Differences to look for:
- Network behavior on cellular (latency, intermittent connectivity).
- Background app suspension by iOS — when Hush returns to foreground, the drain worker should resume from `pending_ops` automatically. (Drain runs on `startSyncPolling`, called from `main.js`.)

---

### 11. Second-device first activation — no duplicates, desks survive

**Why:** Activation fires `settings-changed` (which arms the polling timer) before `dropbox-sync-start` (which runs `performInitialSync`). Without the initial-sync barrier, the cursor cycle wakes during the upload phase, hits Mac's entries before their downloads register, and dispatches `applyCreated` for each — producing duplicate `synced_files` rows + tree nodes.

1. On **Mac**, fresh install. Create files in Personal/Inbox plus a second desk (`The Second Desk`) with a file inside.
2. Activate sync. Wait for upload to complete.
3. On **iPad**, fresh install. Create one local file in Personal/Inbox.
4. Activate sync to the same Dropbox folder.
5. After the cursor seed completes, inspect `sync.db`:
   ```sql
   SELECT internal_id, remote_id, relative_path FROM synced_files;
   SELECT remote_id, COUNT(*) FROM synced_files GROUP BY remote_id HAVING COUNT(*) > 1;
   ```

**Pass:** No `remote_id` group has >1 row. The iPad's tree has Personal desk + The Second Desk (as a desk, not a folder), each with the right files inside. Mac's `pending_ops` shows no leftover ops.

---

### 12. Second-device collision rename — no overwrite

**Why:** Both devices independently create a file named "New Notebook" before activating sync. `performInitialSync`'s collision detector renames the local copy to `New Notebook (2)` mid-iteration. A racy autosave between activation and that rename used to enqueue an upload op against the pre-rename path; routing content uploads through the op-log + gating drain on the barrier closes that race.

1. **Mac**: create `New Notebook` in Personal/Inbox. Add unique content. Activate sync.
2. **iPad**: create another `New Notebook` in Personal/Inbox. Add different unique content. Activate sync.
3. After sync settles on both devices, open both notebooks on each device.

**Pass:** Both devices show two notebooks, one named "New Notebook" with Mac's content and one named "New Notebook (2)" with iPad's content. Neither side's content is gone.

---

### 13. Two devices, two extra desks each — merge-back converges

**Why:** Both devices have a local-only desk Mac/iPad doesn't know about. The `pushMetaIfAbsent` guard in `reconcileSync` prevents the second-activated device from overwriting the first's `desks.json`, but the second device's local-only desk also has to land on Dropbox. `applyDesksFile` re-publishes the merged list when `desks.length > incomingDesks.length`.

1. **Mac**: Personal + `Mac's Desk` (each with at least one doc). Activate sync.
2. **iPad**: Personal + `iPad's Desk` (each with at least one doc). Activate sync.
3. Wait through one cursor cycle on each device (~10 s).

**Pass:** Both devices show three desks in the desk switcher (Personal, Mac's Desk, iPad's Desk). Files are in their original desks. Dropbox has `/Personal/`, `/Mac's Desk/`, `/iPad's Desk/` directories, no `/Personal/Mac's Desk/` or `/Personal/iPad's Desk/` shadows.

---

### 14. Second-device receives a desk whose content has no Inbox child

**Why:** The earlier `looksLikeUnwrappedDeskSkeleton` gate required an `Inbox` sub-child to recognize a top-level orphan as an absorbable desk skeleton. A Mac-organized desk that holds a project (or any folder) at its root, with no Inbox folder, would arrive on iPad as an orphan that the gate refused to absorb — the new desk landed empty next to the orphan. On a subsequent reboot, `ensureDesksTreeSpecials` would fold the orphan into the active desk and `reconcileSync` would push physical Dropbox moves to make `/Personal/<DeskName>/...`. Both halves have to be tested.

1. **Mac**: Personal + a second desk `School` containing a project `Loss Paper` with one or more docs/notebooks inside. The desk's Inbox stays empty. Activate sync; wait for upload.
2. **iPad**: fresh install. Activate sync. Wait through `performInitialSync` + the first cursor cycle (~15 s).
3. Inspect iPad's tree: the School desk should now contain `Loss Paper` (and its docs), no orphan top-level "School" folder.
4. Restart iPad. Inspect the tree again — still correct.
5. Inspect Dropbox: still `/Personal/...` and `/School/Loss Paper/...`. **No `/Personal/School/...`.**

**Pass:** No empty desks; no orphan top-level folders; the per-desk last-file slot resolves and switching desks lands the editor on the right file. Across a restart, no Dropbox moves fire.

---

### 15. Folder→project + reorder propagates

**Why:** Sidebar drag-reorders inside a project used to save locally
but never push `.hush/projects.json`; the rev-on-promotion path also
silently skipped entries whose folder hadn't synced down yet.

1. On **Mac**, create a folder `Story`, add three docs (`a`, `b`, `c`).
   Convert the folder to a project (hover-revealed arrow icon).
2. Wait one cursor cycle on **iPad**. `Story` should appear as a
   project there, with the three docs in the same order.
3. On Mac, drag the docs into a new order (`c`, `a`, `b`).
4. Wait one cursor cycle on iPad. The order should match.

**Pass:** Both promotion and subsequent reorders propagate within
one cycle.

### 15b. Late folder arrival still promotes to project

1. On **Mac**, take iPad offline (cellular off).
2. Create `Story` folder, add docs, promote to project. Wait for
   the upload + cursor pull on Mac to complete.
3. Bring iPad back online. `Story` should arrive and immediately
   show as a project, not as a plain folder.

**Pass:** The post-create reapply of projects.json catches the
folder up to its project status without requiring a manual
re-promote on iPad.

### 16. Pending queue UI surfaces stuck ops

1. Disable the network on **Mac** and rename a file — the rename
   queues but can't drain.
2. Open Settings → Sync → Dropbox. The **Pending sync queue** section
   should show one row: kind = `rename`, target path = the rename
   target, attempts incrementing if the drain has retried since
   enqueue.
3. Click **Retry now**. Without network, it stays queued; restore
   network and click again — the row disappears within a couple of
   seconds.

**Pass:** Stuck ops are visible without opening sync.db; restoring
connectivity + clicking Retry drains the queue.

### 17. Local Folder inside iCloud Drive — typing is never interrupted

**Why:** iCloud's bird daemon re-touches a file (upload + xattr
bookkeeping) *seconds* after every Hush autosave. The old 500 ms
write-origin window read those late events as external edits and
reloaded the last-autosaved content over the buffer — wiping the
keystrokes typed since the save and throwing the cursor to the top,
every few seconds while typing. Echo detection is now by content
identity (SHA-256 ring, `echo-ring.js`), the reload is dirty-guarded,
and genuine external changes apply as a cursor-preserving diff
(`apply-external.js`).

1. On **Mac**, mount a folder that lives inside iCloud Drive via
   Add (+) → Local Folder. Open a `.md` in it.
2. Type continuously for 60+ seconds (past many 2 s autosaves and
   iCloud upload cycles — the file's Finder badge should cycle
   through "uploading").
3. The cursor must never move on its own and no typed characters may
   disappear.
4. Now edit the same file in another app (e.g. TextEdit) and save.
   With Hush's buffer clean (pause typing ~3 s), the change should
   appear in Hush without the cursor jumping to the top.
5. Repeat step 4 while Hush has unsaved keystrokes (type, then within
   2 s save from the other app): Hush must not lose the in-buffer
   keystrokes; its next autosave wins (last-write-wins, as with
   Dropbox).

**Pass:** Zero cursor jumps and zero lost characters while typing;
external edits still land when the buffer is clean.

---

## What success looks like, in one sentence per area

- **Renames**: one event in, one event out, same `remote_id` throughout, exactly one file on each device.
- **Offline mutations**: queued in `pending_ops`, drained on reconnect, no data loss.
- **External edits**: pulled via cursor with a Versions snapshot, editor / notebook lock prevents keystroke races.
- **Migration**: legacy `sync_map.json` becomes `sync.db` rows; duplicate paths land in `sync_orphans` for review.
- **Echo suppression**: own writes are recognized by `rev` match and skipped — no pull-back loops.
- **First activation on a second device**: no duplicate rows, desks arrive as desks, name collisions auto-suffix without losing either side's content.
- **Concurrent edits across three devices**: rev-gated uploads catch conflicts; the conflict modal surfaces them when the file is open; auto-snapshot-and-accept-remote when it's not.
- **Cross-folder moves**: tree reparents on receive; reconcile never undoes a move.
- **Longpoll change detection**: typical receiving latency is 1–2 s; safety-net poll at 60 s catches stuck longpolls.
