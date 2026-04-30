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

### 5. Edit while offline → reconnect → no duplicate, no overwrite

1. **Mac** offline. Edit `Today.md`. Save.
2. While Mac is still offline, on **iPad** edit `Today.md` differently and save.
3. Reconnect the Mac.
4. Mac's `syncFileToExternal` uploads its content. iPad's cursor delta arrives, sees a different rev, pulls Mac's content. Or vice versa depending on order.

**Pass:** No duplicate file is created (single `remote_id` and `internal_id`). The losing side's prior content is in the Versions panel.

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
2. Wait ≤10 seconds.
3. Hush should pull the change automatically — sidebar unchanged (no duplicate, no rename), open editor (if this file is open) updates with a "Synced ↓" toast.

**Pass:** Content updates in Hush without rename or duplicate. The Versions panel for that file gains an entry containing the previous content.

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

## What success looks like, in one sentence per area

- **Renames**: one event in, one event out, same `remote_id` throughout, exactly one file on each device.
- **Offline mutations**: queued in `pending_ops`, drained on reconnect, no data loss.
- **External edits**: pulled via cursor with a Versions snapshot, editor lock prevents keystroke races.
- **Migration**: legacy `sync_map.json` becomes `sync.db` rows; duplicate paths land in `sync_orphans` for review.
- **Echo suppression**: own writes are recognized by `rev` match and skipped — no pull-back loops.
