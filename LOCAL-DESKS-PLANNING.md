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

\* Desk stickies could move into `.hushdesk` so they ride along — cheap,
decide during implementation.

Cross-desk features keep working because the app still mounts every
registered desk at boot: `settings.deskRoots: [{ deskId, path | "internal",
bookmark? }]` is the only global registry left.

### Local Folder mounts

Unchanged and still useful for ad-hoc folders that shouldn't become desks.
"Convert Local Folder to Desk" becomes trivial: write `.hushdesk` +
`.hush/` into the folder (or decline if it's someone else's directory and
copy instead), register it as a desk root, drop the mount.

## Phasing

0. **Delete Dropbox sync.** First, not last — no compatibility burden, and
   every subsequent refactor gets simpler when the op-log/cursor/reseed
   invariants stop needing to be preserved. (Code stays in git history as
   reference.)
1. **Desk-folder storage for internal desks.** Move `{data_dir}/files/` +
   `file_tree.json` into per-desk folders with `.hush/index.json` +
   `tree.json`; loaders/savers go path-through-index; one-shot migration
   (the Dropbox manifest/export code is the serializer, one last time).
   No user-visible change when this phase lands — that's the test.
2. **Versions into desk data.** File-per-snapshot store, migration from
   snapshots.db, prune policy, Versions modal on the new store.
3. **Local desks.** Desk root = user-picked folder (bookmark on iOS);
   watcher per desk root; Make Local / Make Internal (= move folder,
   repoint registry); adopt-existing-desk-folder flow; New Local Desk in
   the Add menu.
4. **Multi-device hardening.** Conflicted-copy detection + adoption,
   eviction-tolerant reads (NSFileCoordinator already in the plugin),
   foreground reconcile on iPad, `NSMetadataQuery` live updates, then real
   two-device soak tests over iCloud Drive and a Dropbox folder.

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
