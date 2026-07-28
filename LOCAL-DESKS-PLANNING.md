# Local Desks — Planning (v2)

*Proposal, 2026-07, revised after review. Supersedes v1, which proposed a
per-desk mirror engine layered on the internal store while keeping Dropbox
sync. The revision adopts two directives: **Dropbox sync is removed
entirely**, and **desks become self-contained, portable units** that carry
their own databases — with full structural parity between internal and
local desks. Backwards compatibility is explicitly not required.*

## The model: a desk *is* a folder

Every desk — whether it lives in Hush's app data or in a folder the user
picked — is one directory with one layout:

```
<Desk root>/
├── .hushdesk                    desk identity + per-desk meta (style, last file)
├── .hush/
│   ├── index.json               fileId ↔ relative path (the identity map)
│   ├── tree.json                ordering + row decoration, keyed by fileId
│   ├── versions/                snapshot store — one file per snapshot
│   │   └── <fileId>/<ts>-<deviceId>.snap
│   ├── panes.json               pane layouts (per-desk now, not global)
│   └── pdf.json                 Zotero PDF registry (per-desk)
├── Inbox/                       real directories; structure IS the tree
├── Trash/
├── Images/
├── <Project>/                   project = directory (+ ordering in tree.json)
│   └── ...
├── Some Doc.md
├── Some Notebook.hushnote
└── Some Stack.hushstack
```

- An **internal desk** is this folder at `{data_dir}/desks/<deskId>/`.
- A **local desk** is this folder wherever the user pointed Hush —
  including an iCloud Drive or Dropbox folder, on both macOS and iPad.
- **Conversion between the two is a folder move plus a registry repoint.**
  Nothing is re-encoded, re-keyed, or re-imported. That is the parity
  requirement made literal.
- **Handoff** falls out for free: point a second Hush install (or a second
  device, via a synced folder) at an existing desk root and it adopts the
  desk wholesale — identity, ordering, version history and all.

Sync itself is delegated to the file provider (iCloud, Dropbox-the-folder,
Syncthing, a USB stick). Hush's job shrinks from *being* a sync engine to
being a **well-behaved citizen of a synced folder** — which is a much
smaller, much more testable job.

## Assessment: does this complicate or clarify?

**It clarifies — decisively — provided two design rules hold.** What it
removes is bigger than what it adds:

- The three-way storage split (VC store / Local Folder mounts / Dropbox
  mirror) collapses to one model. The `ls:` sentinel-id scheme, the
  mirror-map translation layer proposed in v1, and the entire Dropbox
  engine (op-log, cursor, rev-gating, initial sync, desk-sync wire format,
  reseed barriers) all go away. That is thousands of lines of the most
  delicate code in the app.
- "Local Desk" stops being a feature bolted onto the store and becomes a
  non-feature: every desk already operates from a folder; "local" only
  changes *which* folder.

The two rules that keep it from complicating instead:

1. **File identity must travel with the desk.** `fileId`s remain the join
   key for everything (versions, panes, wikilinks-by-rename, recent files,
   window badges) — but the `fileId ↔ path` map moves from a central
   SQLite table into the desk's own `.hush/index.json`. Hush performs its
   own renames, so the map stays exact in normal use; external renames
   (Finder) are re-paired by content hash, exactly the trick planned for
   v1's mirror. Frontmatter-embedded ids were considered and rejected:
   they pollute user-visible files and don't cover binaries.
2. **Nothing in a desk folder may be shared *mutable binary* state.** This
   is the crux of "multiple devices see the correct version." File-sync
   providers merge nothing — they detect conflicts at whole-file
   granularity and either last-writer-win or fork a "conflicted copy."
   A shared SQLite DB in a synced folder is therefore a corruption
   generator. So everything inside the desk is one of:
   - a **content file**, written atomically and whole (docs, notebooks);
   - an **append-only file**, never rewritten (snapshots — one file per
     snapshot, device-suffixed, so two devices can never contend);
   - a **small JSON** applied field-by-field on read (`.hushdesk`,
     `tree.json`, `panes.json`), where a lost race costs a preference,
     never content.

   Derived state that *wants* to be a database (the wikilink index, a
   versions listing cache) is rebuilt locally per device and never synced.

## What changes where

### Versions move into the desk

`snapshots.db` is replaced by `.hush/versions/<fileId>/<timestamp>-<deviceId>.snap`
(zstd-compressed content; notebooks store the same envelope they autosave).
Append-only and device-suffixed → sync-safe by construction, and history
rides along when a desk is handed off. The existing cadence (30 dirty
keystrokes / notebook autosave) and pruning policy carry over; the Versions
modal reads a per-device index cache rebuilt from the directory listing.
Snapshots of *both sides* of a detected conflict keep their role as the
safety net.

### The tree derives from the filesystem

Directories are the structure; `tree.json` holds only what a filesystem
can't: sibling ordering, flags, row tints, `useAsNote`, `showNumbers`,
gutter pairing, project-vs-folder type. Reconciliation rule: **disk wins on
existence, tree.json wins on decoration** — a file present on disk but
missing from the sidecar appears (sorted last), a sidecar entry with no
file is dropped. This is what makes another app (or another device) adding
files to the folder just *work*.

### Change detection

The existing `notify` watcher — today armed per Local Folder mount — arms
per desk root instead, internal desks included (cheap, and it makes
multi-install-on-one-Mac coherent). Inbound changes flow through the
existing `apply-external.js` layer with the existing content-hash echo
ring; the dirty-buffer-wins rule is unchanged. On iPad there is no
watcher: foreground reconcile (today's behaviour) is the baseline, and an
`NSMetadataQuery` listener in the icloud-folder plugin is the stretch that
makes iCloud changes land live.

### Conflicted copies

We don't control the transport, so we handle its one failure mode
explicitly: a reconcile pass recognizes provider conflict siblings
(`Doc (conflicted copy).md`, `Doc (Nate's iPad).md`) next to a mapped
file, snapshots both sides to Versions, keeps the newer as the file, and
surfaces a toast linking to the Versions modal. That plus append-only
snapshots is the whole "correct version" story — honest and inspectable,
rather than a bespoke protocol pretending the transport is reliable.

### Dropbox sync is removed

Deleted: `sync/dropbox.js`, `dropbox-browser.js`, `dropbox-cursor.js`,
`op-log.js`, `initial-sync.js`, `desks-migration.js`, the desk/project/
style/pane *wire* modules, `sync_db.rs`'s Dropbox tables, the Settings >
Sync > Dropbox tab, OAuth plumbing, and the sync-gate/reseed machinery.
Kept and repurposed: `echo-ring.js`, `apply-external.js`, the conflict
modal (now fed by conflicted-copy detection), the sync log UI (now the
desk-reconcile log), and `meta-sync.js`'s hash-dedup idea (now the
don't-rewrite-unchanged-files gate). The Sync settings tab becomes a
**Desks** tab: each desk's location, Make Local / Make Internal, Reveal,
Reconcile now, last-reconcile status.

### App-wide vs desk-scoped

| Stays app-wide (`{data_dir}`)                 | Moves into the desk           |
| --------------------------------------------- | ----------------------------- |
| settings.json (options, shortcuts, window)    | content files + Images        |
| styles (list is shared across desks today)    | `.hush/index.json`, `tree.json` |
| Zotero credentials + reference/annotation cache | `.hush/versions/`           |
| PDF binary cache (re-downloadable)            | `.hush/pdf.json` registry     |
| per-device caches (wikilink index, versions index) | `.hushdesk` (style choice, last file) |
| global/file/project sticky notes*             | `panes.json` (desk-scoped now) |

\* Desk stickies ride in `.hushdesk`'s `meta` object (shipped with the
Phase 4 follow-ups), alongside the per-desk style choice and last-open
file; global/file/project stickies stay app-wide.

Cross-desk features keep working because the app still mounts every
registered desk at boot: `settings.deskRoots: [{ deskId, path | "internal",
bookmark? }]` is the only global registry left.

### Local Folder mounts

Unchanged and still useful for ad-hoc folders that shouldn't become desks.
"Convert Local Folder to Desk" becomes trivial: write `.hushdesk` +
`.hush/` into the folder (or decline if it's someone else's directory and
copy instead), register it as a desk root, drop the mount.

*Update (Phase 5):* the mechanism now exists — `open_folder_as_desk` does
exactly that write-and-register for any folder. A **Convert Local Folder
to Desk** entry on a mount's row would be a thin wrapper over it plus
dropping the mount; it hasn't been wired up, since **Open Folder as
Desk…** already reaches the same folder from the picker.

## Phasing

0. **Delete Dropbox sync.** ✅ *Shipped 2026-07.* Engine, Rust backend,
   settings tab, OAuth deep-link path all removed; echo-ring /
   apply-external / Local Sync / notebook-sync kept and repurposed.
1. **Desk-folder storage for internal desks.** ✅ *Shipped 2026-07.*
   `{data_dir}/desks/<deskId>/` with `.hushdesk` + `.hush/index.json` +
   `.hush/tree.json`; content as real files (`.md` / `.hushnote` zips
   packed in Rust / `.hushstack` / `Images/`); path reconciliation on
   every tree save (staging → placement, moves, orphan parking, desk
   retirement to `.deleted/`); images resolve across desks with the
   active desk as save target; one-shot boot migration leaves the flat
   store as an inert backup. Command surface unchanged — zero frontend
   changes. Notes: desk dirs are keyed by desk *id* (renames move
   nothing); tree.json stays authoritative for structure until the
   fs-wins reconciler lands with local desks; snapshots stay central
   until Phase 2.
2. **Versions into desk data.** ✅ *Shipped 2026-07.* File-per-snapshot
   store at `.hush/versions/<fileId>/<createdAtMs>-<deviceId>.snap`
   (plain bytes for inspectability; compression can layer on later if
   size warrants), device id persisted at `{data_dir}/device_id`,
   identical decay policy, unplaced-file fallback area, version history
   rides along on cross-desk file moves, one-shot migration renames
   snapshots.db to `.pre-desks.bak`. Command surface unchanged — zero
   frontend changes. Backups exclude version history and retired desks.
3. **Local desks.** ✅ *Shipped 2026-07 (desktop).* `desks/roots.json`
   maps deskId → external folder and `DeskStore::desk_dir` consults it —
   the single redirect seam that makes files, images, snapshots, and the
   tree all resolve identically for local desks. **Make Desk Local…**
   moves the folder out (cross-volume-safe), **Make Desk Internal**
   moves it back, **Open Folder as Desk…** adopts a desk another install
   produced (the handoff flow), **Reveal Desk Folder** opens Finder —
   all in the command palette + the desk row menu, with an
   outline-square badge in the desk switcher. A `notify` watcher per
   local root feeds a debounced **disk-wins reconcile**
   (`desk_reconcile`): files added to the folder become tree nodes
   (directories mirrored as containers), files deleted on disk drop
   their nodes (Versions is the recovery path), and the open doc reloads
   through the guarded external-apply. Deleting a local desk only
   unregisters — the user's folder is never moved or modified. Deferred
   to Phase 4: iPad (security-scoped bookmarks), external-rename pairing
   by content hash (today a rename arrives as remove + add with a fresh
   fileId).
4. **Multi-device hardening.** ✅ *Shipped 2026-07.* External renames
   pair by content hash (`.hush/hashes.json` — FNV-1a over disk bytes,
   refreshed on save and on a reconcile pre-pass), so a Finder/provider
   rename keeps its fileId: version history, panes, recents all survive;
   changed-content renames fall back to remove + add. Conflicted copies
   (Dropbox `… (conflicted copy …)`, Syncthing `….sync-conflict-…`;
   iCloud's ambiguous `Name 2` pattern deliberately unmatched) are
   adopted: both sides snapshot to Versions under the same fileId, the
   newer bytes keep the real path, and the sidebar toasts + logs the
   resolution. iPad local desks work through security-scoped bookmarks
   (`roots.json` v2 entries optionally carry one; boot re-resolves it —
   re-acquiring folder access for Rust's std::fs — and repoints stale
   container paths via `desk_update_root_path`); with no watcher on iOS,
   every local desk reconciles at boot and on each return to foreground.
   A two-install soak test drives adopt / edit / add / rename / conflict
   / delete through two data dirs sharing one desk folder.
   *Follow-up niceties, shipped 2026-07:* per-desk meta — style choice,
   last-open file, desk stickies — mirrors into `.hushdesk`'s `meta`
   object (JS write-through on change, disk-wins pull at boot / adopt /
   reconcile), the Google-Docs link map moves into each desk's
   `.hush/gdoc-links.json` (settings keeps the merged read cache, and
   an install without Google credentials degrades to the disabled link
   bar), and `NSMetadataQuery` live updates land on iPad (an
   icloud-folder plugin watch per local desk root emits `watch-changed`
   while the app is frontmost; foreground reconcile stays the fallback
   for non-iCloud providers). Still on the user: real two-device runs
   over iCloud Drive and a Dropbox folder.
5. **Any folder is a desk.** ✅ *Shipped 2026-07.* Closes the loop on the
   model at the top of this document: "a desk *is* a folder" now runs in
   both directions. `DeskStore::open_folder_as_desk` initialises **any**
   directory in place — `.hushdesk` + `.hush/` written into the folder
   the user picked, the four specials pre-seeded under their
   `<kind>:<deskId>` ids so an existing `Inbox/` folds into the special
   rather than doubling it, then the Phase-3 reconciler absorbs whatever
   was already there. A folder that already carries the sidecar still
   falls through to Phase 3's adopt, so handoff is unchanged. Creating a
   local desk and opening a folder as a desk are now literally the same
   call — the picked folder becomes the root; nothing is moved or
   nested. Two consequences worth recording: a local desk takes its
   folder's name and refuses in-app renames (the directory is the source
   of truth, and Hush doesn't rename a user's directories), and
   `save_forest` gained `preserve_doc_extensions` — absorbed `.txt` /
   `.markdown` files keep their extension instead of being rewritten to
   `.md` on the next tree save, which only mattered once desks could
   contain files Hush didn't create.

Phases 1–2 are the overhaul's risk concentrated where it's cheapest: still
single-device, still internal, fully testable before any folder is shared.

## Resolved questions (2026-07)

1. **Snapshot format** → one file per snapshot.
2. **Styles** → stay app-wide; nothing style-related is embedded in the
   desk beyond the per-desk *choice* already in `.hushdesk`.
3. **PDF binaries** → registry-only (`.hush/pdf.json`); devices
   re-download from Zotero, binary cache stays per-device app data.
4. **Google Docs links** → link map lives in the desk (`.hush/`), and an
   install without Google credentials shows the link bar in a disabled
   "connect Google to use" state rather than dropping the links.
5. **Desk stickies** → move into `.hushdesk` so they ride along.
