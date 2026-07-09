# Local Desks — Planning

*Proposal, 2026-07. Nothing here is implemented yet — this document is the
plan to review before work starts.*

## Goal

A desk should have the option of **operating from a local folder**: a plain
directory on disk (including an iCloud Drive folder on iPad) that holds the
desk's content in open formats, visible and editable from Finder or any
other app. Two hard requirements shape everything below:

1. **No features may be lost.** Versions, wikilinks, panes, projects,
   stacks, gutters, styles, stickies, find, multi-window — everything that
   works in a normal desk must keep working in a Local Desk.
2. **Moving back and forth must be painless.** Internal desk → Local Desk
   and back again, without data loss, re-setup, or broken references.

## The three candidate architectures

### A. Promote a Local Folder mount to desk level — rejected

Today's Local Folders live entirely on disk: no `fileId`s, no snapshot
history, `ls:` sentinel ids threaded through the notebook/stack bridges.
Making a whole desk work that way means re-keying every fileId-shaped
subsystem (snapshots.rs, wikilink index, panes.json, versions, multi-window
badges, Google links, Zotero PDF registry…) to a second id scheme — a
sprawling change that *still* loses features wherever we miss a spot. It
directly violates requirement 1.

### B. The desk keeps its internal store; a **local mirror** reflects it to the folder — recommended

This is the Dropbox sync architecture with `std::fs` as the backend, which
is why most of the work is already done:

- Files keep living in `{data_dir}/files/` with normal `fileId`s. Every
  feature keeps working *by construction* — a Local Desk is
  indistinguishable from a normal desk to the rest of the app.
- A per-desk mirror engine keeps the folder in step, using the **same wire
  format Dropbox sync writes**: docs as `.md` (first-line names, 50-char
  cap, collision suffixes), notebooks as `.hushnote` zips, stacks as
  `.hushstack`, images under `Images/`, project directories with their
  ordering meta, and the desk's `.hushdesk` identity file at the root.
- Inbound changes (user edits the folder from another app) arrive through
  the **existing** `notify` watcher (`LocalSyncManager`), flow through the
  **existing** `apply-external.js` shared apply layer, and are
  echo-suppressed by the **existing** content-hash ring (`echo-ring.js`) —
  exactly the machinery Local Folders and Dropbox already share.

### C. Move the whole library into a user-visible folder (Obsidian-style vault) — rejected for now

Solves the same need globally instead of per-desk, but it's a migration of
every install rather than an opt-in per-desk feature, and it forecloses the
"one desk local, one desk Dropbox-synced, one desk internal" mix that desks
exist to support.

## Design (Option B)

### Registration

- `settings.localDesks: [{ deskId, path, bookmark?, addedAt }]` — parallel
  to `localSyncFolders`, persisted by Rust the same way (`local_desk_add` /
  `local_desk_remove` write settings.json directly; JS mirrors the result).
  `bookmark` is the iOS security-scoped bookmark, `None` on desktop.
- The folder **is** the desk root (no `<DeskName>/` nesting — the user
  picked the folder; its name need not match the desk's).
- Phase 1 rule: a desk is *either* Dropbox-synced *or* local-mirrored,
  never both. Composing the two means three-way reconciliation; revisit
  only if there's real demand.

### Identity mapping

A mirror map — per-file `{ fileId, relativePath, lastSyncedHash }` — in the
existing SQLite `synced_files` table, namespaced by
`syncFolderId = "__local_desk__:<deskId>"` (the table and its commands
already take a `syncFolderId`). This is the local analog of Dropbox's
`remote_id`/`rev` slots, with content hashes standing in for revs (a plain
folder has no revs — same reasoning as the Local Folders echo ring).

### Outbound (Hush → folder)

Write-through on every mutation: save, rename, delete, create-folder,
image save, notebook autosave. Unlike Dropbox there's no network to
survive, so Phase 1 skips the durable op queue and writes directly,
marking every write in the per-desk echo ring before it lands (same
ordering rule as `saveCurrentLocalSync`). The three "don't push unchanged
content" gates carry over as one: compare `lastSyncedHash` before writing.
A failed write (unplugged drive, evicted iCloud file) flips the desk into
a visible "mirror stale" state and a reconcile repairs it later — that's
the moment to add the op queue if it proves insufficient.

### Inbound (folder → Hush)

The existing per-mount `notify` watcher, reused as-is:

- Content change on a mapped path → hash → echo ring check → map to
  `fileId` → `applyExternalDocContent` (`skipWhenDirty: true` — unsaved
  keystrokes always win, next autosave reasserts them; identical policy to
  Local Folders today).
- New file → import into the desk at the matching tree position (minting a
  fileId + mirror-map row).
- Removed file → move the internal copy to the desk's Trash (recoverable —
  never a hard delete on an event we inferred from the filesystem).
- Renames arrive as remove+create pairs (fs events carry no stable id, the
  one thing Dropbox has that a folder hasn't) — pair them by content hash
  before falling back to trash+import so history survives a Finder rename.
- iPad has no watcher → reconcile on app-foreground, exactly like
  `refreshOpenLocalSyncFile` today.

### Reconcile

One pass — on attach, on boot, and on demand ("Reconcile now" in the desk
menu): walk tree and disk, diff by mirror map + hashes, emit
imports/exports/trashes for the differences. This is `reconcileSync` +
`initial-sync.js` shrunk to a filesystem backend, and it doubles as the
attach-time initial sync (below). Newest wins on both-changed conflicts,
with the losing side snapshotted to Versions first (Dropbox's policy).

### Conversion flows (the "painless back and forth")

- **Make Desk Local** (desk row menu + command palette): pick a folder.
  Empty folder → export walk seeds it. Non-empty folder → merge: matching
  names link up (content diff → newest wins, loser snapshotted),
  disk-only entries import, Hush-only entries export. Collisions suffix
  `Foo (2)` — the initial-sync rules verbatim.
- **Make Desk Internal** (detach): drop the watcher + mirror map. The
  internal copies *are* the desk — nothing to import. The folder stays on
  disk untouched (the Local Folders unlink invariant). Optional "…and
  delete folder" checkbox, default off.
- **Convert a Local Folder mount into a Local Desk**: create the desk,
  attach it to the mount's path (the non-empty-folder flow imports
  everything, minting fileIds), remove the plain mount. The reverse —
  desk → plain mount — is Make Desk Internal plus adding the folder as a
  Local Folder, and can ship as a one-click convenience later.

Because attach/detach only adds/removes the mirror — never relocates the
authoritative store — round-tripping any number of times is lossless.

### What stays internal (and why that's fine)

Snapshots/Versions, the sync DBs, panes.json, stickies, styles: session and
history state, not content. The folder holds everything needed to *read and
edit* the work from outside; Hush-specific machinery stays in the app dir.
(A future `.hush/` subfolder inside the desk could carry per-desk meta so a
second machine pointing at the same folder — via iCloud/Syncthing — adopts
the desk wholesale. That's the Phase 3 stretch, not the core feature.)

### UI

- **Add (+)** popover: **New Local Desk…** (pick folder → new desk attached
  to it). Desk row menu / switcher: **Make Desk Local… / Make Desk
  Internal**, plus **Reveal in Finder** and **Reconcile now** when local.
- The desk switcher and all-desks rows badge local desks with the
  outline-square Local glyph.
- Settings > Sync gains a **Local Desks** block: path per desk, last
  reconcile, stale-mirror warnings.

## Phasing

1. **Core mirror (desktop, docs + folders):** registry + attach/detach
   commands, export walk, write-through outbound, watcher inbound, mirror
   map, Make Local / Make Internal UI. Docs and folder structure only.
2. **Full type coverage + reconcile:** notebooks, images, stacks, project
   directories + ordering, `.hushdesk`, boot/foreground reconcile, rename
   pairing, conflict snapshots, mount→desk conversion.
3. **iPad + shared-folder stretch:** bookmarks via the icloud-folder
   plugin, foreground reconcile, optional `.hush/` per-desk meta for
   multi-device use over a synced folder.

## Open questions

1. Dropbox + Local on the same desk: keep mutually exclusive (recommended)
   or allow both?
2. On inbound *deletes* from disk: trash the internal copy (recommended) or
   mirror the hard delete?
3. Should PDFs mirror as binaries in the folder, or stay registry-only like
   Dropbox sync (recommended: registry-only, folder stays light)?
4. Naming: "Local Desk" vs "Folder-backed desk" in UI copy?
5. From the improvements list: is "pin the Inbox while dragging" still
   wanted now that drag auto-scroll exists, or should the desk's Inbox row
   stick to the top of the panel during any drag?
