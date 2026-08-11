# Hush — Technical Overview

This document is for people and coding agents working on the codebase. It covers architecture, conventions, cross-module contracts, and lessons learned — not feature behaviour (see [README.md](README.md)) and not line-by-line implementation, which the code itself documents heavily in comments. Deep dives: [README-NOTEBOOK.md](README-NOTEBOOK.md) (canvas notebooks), [README-DRAWING.md](README-DRAWING.md) (stroke engine), [README-SYNC.md](README-SYNC.md) (desk storage + folder sync — **read before touching `desk_*.rs` or `sync/`**).

## Architecture

Hush is a [Tauri v2](https://v2.tauri.app/) app (macOS + iOS/iPadOS) with a vanilla JavaScript frontend and Rust backend. The editor is [CodeMirror 6](https://codemirror.net/) — no framework anywhere. Communication: `invoke` IPC for commands, `emit`/`listen` for events. Two webview entry points, built as separate Vite inputs: `index.html` → `src/main.js` (the editor window) and `settings.html` → `src/settings/settings-window.js` (a separate WebviewWindow with its own CSS pipeline).

### Frontend map (`src/`)

| Area | Contents |
|---|---|
| `main.js`, `main-modes.js`, `main-listeners.js` | Orchestration only — `init()` wires everything; siblings hold surface-switching and listener installs |
| `state/` | `AppState` (single source of truth) + sibling modules: modes, snapshots, naming, tree CRUD, desks, project/doc conversion, per-editor mode contexts, tree helpers |
| `editor/` | CodeMirror setup (`editor.js`, `base-extensions.js`), plugins (`plugins/`), modes, formatting, sentence navigation, find, folding, ratchet, zen/selection-focus/shuffle overlays, frontmatter, tabs |
| `notebook/` | Canvas notebooks — see README-NOTEBOOK.md; `drawing/` (stroke engine) — see README-DRAWING.md |
| `pane/` | Floating panes: manager, editor factory, content I/O, drag/resize, edge docking, persistence, inline panes, text drag |
| `project/` | `.hushproject` envelope + Gutter mode (doc-aligned notebook sidebar) |
| `sidebar/` | The files panel and every modal it spawns (row menus, multi-select, find panel, style editor, versions, export modals, copy-from-desks planner), `sortable-list/` (drag-drop tree engine) |
| `stack/` | Column-layout stacks (`.hushstack`) |
| `desktop/` | Project Desktops — file-thumbnail canvases |
| `sticky/` | Sticky notes (scoped floating reminders; not files) |
| `links/` | Wikilink resolver/popup, citation popup, Zotero link menu, deep-link router |
| `sync/` | Provider-agnostic sync core + local desk roots + Local Sync mounts — see README-SYNC.md |
| `google-docs/`, `editor/google-docs/` | Phase 2 (OAuth, Drive/Docs API, link bar, incremental push, comments) / Phase 1 (pure paste/copy converters) |
| `pdf/`, `zotero*` | PDF.js viewer (+ shelf, bookmarks, covers, folds, suspend), Zotero API + caches |
| `settings/` | Settings window tabs |
| `themes/` | 16 editor themes, one file each (`_create-theme.js` wraps `EditorView.theme` + `HighlightStyle`) |
| `shader-layer/` | Optional per-style post-processing (dynamically imported only when enabled) |
| `background-layers/` | Composite per-style background stack (image / gradient / WebGL layers + caret effects), lazily imported like `shader-layer/` |
| `longview/` | Outline view |
| `styles/` | Per-module CSS, imported via `styles/main.css` |
| `recognition/` | On-device handwriting recognition entry points (outside `notebook/` so Docs can adopt it) |

### Backend map (`src-tauri/src/`)

| Area | Contents |
|---|---|
| `lib.rs` | App setup, managed state (`Mutex<AppSettings>` + managers), plugin registration, tray, window events, `invoke_handler!` list, `TreeNode`/`FileEntry` wire types |
| `atomic.rs` | `write_atomic` / `write_atomic_str` — tmp + fsync + rename. **Every long-lived JSON/binary store writes through this**; worst case on crash is always "the previous version" |
| `commands/` | Tauri command surface, grouped by domain (files, images, settings, snapshots, desks, local_sync, zotero, window, backup, grammar, spellcheck, pdf_export, multi_window, google_docs, diagnostics, handwriting) |
| `desk_*.rs` | The desk-folder store — see README-SYNC.md |
| `settings.rs` + `settings/defaults.rs` | `AppSettings` (camelCase serde) + default-value fns |
| `files.rs`, `images.rs`, `snapshots.rs` | fileId-keyed file CRUD, image storage, version snapshots |
| `zotero.rs`, `hushnote.rs`, `multi_window.rs`, `activity_log.rs`, `backup` | As named |
| `typst_export/` | In-process Typst PDF pipeline (preprocess → pulldown-cmark → Typst source → in-memory `World` → compile). No CLI, no network — same path serves desktop and iOS |
| `tauri-plugin-pencil/`, `tauri-plugin-icloud-folder/`, `tauri-plugin-scene-reuse/` | Custom iOS plugins: Apple Pencil double-tap, security-scoped folder bookmarks + coordinated I/O, scene reuse for incoming URLs |

## Development rules

- **No code file may exceed 700 lines.** Enforced by `scripts/check-line-limits.sh` (runs in `npm run build`). Split modules rather than growing them; the allowlist in `.line-limit-exceptions` requires a one-line justification per entry (currently `notebook/state.ts` and `notebook/drawing/engine/stroke.js`).
- **No framework dependencies.** Vanilla JS/TS, hand-rolled DOM.
- **Every JS-visible setting must have a field on the Rust `AppSettings` struct** (and every optional tree-node field on `TreeNode`). Serde silently drops unknown fields on the save/load round trip, so an undeclared setting resets to default every launch. Opaque/evolving shapes are stored as `serde_json::Value` (e.g. `persisted_panes`, `sticky_notes`, `desks_meta`) so Rust never has to learn their internals.
- **Heavy Rust work must be `async` + `spawn_blocking`.** A synchronous Tauri command runs on the webview's main thread and freezes the UI (harper's multi-second dictionary build, multi-MB `.hushnote` deflates). Similarly, multi-MB payloads cross IPC as raw byte bodies (`save_file_raw`), never JSON args — `JSON.stringify` of the payload on the JS thread stalls frames.
- **Rust→JS spans are converted to UTF-16 code units backend-side** (`char_to_utf16_range`) so CodeMirror positions apply directly.

### Conventions

- **Events** on `AppState` (`on`/`off`/`emit`, synchronous): the key ones are `settings-changed`, `theme-changed`, `style-changed`, `files-changed`, `file-opened`, `notebook-open`/`-unmount`, `pdf-open`/`-unmount`, `stack-open`/`-unmount`, `no-file-state`, `active-desk-changed`, `desks-changed`, `mode-changed`, `panes-changed`, `doc-content-changed`, `stickies-changed`, `you-are-here-changed`, `remote-settings-merged`. If a feature keys visibility off "what is open", it must handle **`no-file-state`** too (emitted by `clearActiveFile` — empty desk, deleted open file, archived desk), not just the open/unmount events.
- **`state.runtime`** holds cross-module side-channel data that is neither persisted settings nor evented state (`columnResizeHandler`, `visiblePaneCount`/`visiblePaneCentroid`, `docked*` footprints, `syncPulling`, `localSyncWriteFlag`, …). Never stamp ad-hoc `state._foo` fields.
- **Context ids**: every editing surface is addressed as `doc:`/`nb:`/`pdf:`/`st:` + fileId (panes' `ownerContext`, sticky targets, mode contexts); Desktops use `dt:` + containerId.
- **`window.__hush*` bridges**: the lazily-loaded notebook bundle never imports app modules. Cross-boundary hooks (`__hushOpenWikilink`, `__hushOpenPdfBookmark`, `__hushFileStickies`, `__hushCmdHeld`, …) are registered once from `main.js`/owning modules.
- **Transaction annotations**: programmatic doc rewrites (file loads, sync pulls, pane mirrors) carry `programmaticChange` so filters (ratchet, frontmatter protection) and dirty tracking can distinguish them from typing. `bypassRatchet` marks the one user edit a ratcheted selection may perform (strikethrough).
- **Command palette entries** are plain descriptors (`{ id, label, icon, ctx, action, hiddenIf?, keepOpen?, keywords? }`). The filter matches `label` plus the optional `keywords` string — the hidden half of a command's name, where a renamed command keeps its old wording searchable so muscle memory still lands.
- **Shortcuts** (`src/shortcuts.js`): stored bindings distinguish `Mod`/`CmdOrCtrl` (either primary modifier) from strict `Cmd` and `Ctrl` tokens — that's how `Cmd+N` (new doc) and `Ctrl+N` (new notebook) coexist. `⌘P` and `⌘,` are hardcoded. Shortcut definitions/categories live in `settings/settings-tabs-shortcuts.js` (single source for the Settings tab and the Show Shortcuts modal); notebook tools have their own `shortcutNb*` fields read at canvas mount.
- **CSS**: per-module files under `src/styles/`; design tokens + the documented z-index scale live in `base.css` (`--z-pane: 90`, `--z-shelf: 150`, `--z-sidebar: 200`, `--z-sticky: 250`, `--z-overlay: 300`, `--z-popover: 400`, `--z-modal: 500/510`, `--z-modal-top: 9999`, drag ghost `2147483647`). Anything modal or higher must use a token. iPad-only reserved bands ride `--ipad-safe-top/bottom` (30 px under `html.ios:not(.phone)`) because `env(safe-area-inset-*)` doesn't report them. The settings window duplicates the tokens it needs (separate webview, no `base.css`).
- **Platform detection**: `isIOS`-style helpers accept UA `iPad|iPhone|iPod` OR (`platform` matches `Mac` AND `maxTouchPoints > 0`) — iPadOS 13+ reports as Macintosh, and some WKWebViews expose only 1 touch point; real Macs report 0. `isPhone()` additionally requires a narrow viewport; `html.ios` / `html.phone` classes gate CSS.

## Core state

`state/state.js` is a thin coordinator: settings (mirroring `AppSettings`, defaults in `state-defaults.js`), the file list + tree, mode flags, the editor handle, and the event emitter. Behaviour lives in siblings (`state-modes.js`, `state-snapshots.js`, `state-naming.js`, `state-convert.js`, `state-split-combine.js`, `state-tree.js`, `state-desks*.js`, `mode-context.js`, …) that take `state` as their first argument; `AppState` methods are one-line delegations where external callers need them.

**File tree.** `AppState.fileTree` is a nested tree of typed nodes `{ id, type, name, fileId?, children[], …decorations }`. Top level is always `type: "desk"` nodes; each desk owns namespaced specials `__inbox__:<deskId>`, `__images__:…`, `__pdfs__:…`, `__archive__:…`, `__trash__:…` (canonical list: `SPECIAL_KINDS` in `state-desks.js`), pinned in tail order Images | PDFs | Archive | Trash by `pinSpecialsInList` / `enforceSpecialPositions`. Same-type siblings can't share a name (names map to on-disk paths) — every create/rename path routes through `uniqueChildName`. Projects normalize docs-first / supplementary-after via `normalizeProjectChildren`. Traversal helpers live in `state/tree-helpers.js`.

**Desks.** Structural, always-on (a legacy flat tree is wrapped by a boot migration). Per-desk state splits three ways: *portable* meta rides the desk folder itself (style choice, ratchet flag, last file, desk stickies — see README-SYNC.md), *per-device* state stays in settings (`activeDeskId`, recents, local-folder last file), and the desk list/registry is two-way reconciled with the tree at boot. Desks are archived (zip), never deleted; the last desk can't be removed.

**Naming rule.** A doc's filename follows its first line (`state-naming.js`), triggered on cursor-leaves-line-1, blur, autosave, and a 1.5 s typing-idle debounce. Because that debounce fires the full pipeline on every pause, **the rename path must stay cheap**: it patches the one cached `state.files` entry in place rather than re-fetching the library (`list_files` loads every file's *content* — never call it on a hot path), and the wikilink rewriter regex-pretests raw notebook JSON before parsing. Auto-rename is suppressed for Google-linked docs (the GDoc title owns the name), explicitly-named tabbed docs, and Local Sync files (disk is the source of truth).

**Projects.** `openProject()` concatenates child docs with `---hush-separator---` markers into one buffer; `saveProjectContent()` splits and writes each part back. Only docs join the buffer (`state.projectDocIds`); notebooks/stacks/PDF aliases ride along as supplementary sidebar children.

## Editor

`editor/editor.js` builds the main CodeMirror instance; **`createBaseExtensions(state, onChange, opts)`** builds the shared extension set (theme, markdown + custom inline parsers for `%%comments%%` / `==highlights==` / GFM tables / strikethrough, shortcuts, and nearly every plugin) used identically by floating panes, stack columns, and the Zen/Selection-Focus overlays — a feature added only to `editor.js`'s own list (e.g. proofread, spellcheck) is deliberately main-editor-only. Compartments expose theme / highlight / shortcut / editable reconfiguration.

**Per-editor mode contexts** (`state/mode-context.js`): focus, typewriter, and D.R.Y. are scoped per surface via a prototype-inheriting proxy over `AppState` (`Object.create(appState)` with own-property flags). Shortcut handlers resolve the active context (`getActiveModeContext`) and fall back to the global toggles for the main editor, which does *not* use a context.

**Overlay editors** (Zen Focus, Selection Focus, Shuffle Editor) use a **shadow editor model**: a fresh `EditorView` (or plain-DOM node model, for Shuffle) seeded from the source, written back as a single replacement transaction on exit so undo collapses to one step. Reparenting the live editor DOM was tried and abandoned — stale geometry, focus fights. Selection Focus passes `{ fragment: true }` so ratchet treats the buffer as a slice (no title-line exception, no append-at-end).

**Ratchet** (`editor/ratchet.js`) owns both forward-only modes with a per-surface anchor `StateField`, a transaction filter, and — for desk-only ratchet — the *rearrangement rule*: a transaction whose removed and inserted "material" (non-whitespace, non-`~`/`%` characters, sorted) is equal and non-empty is a move, not an edit, and is allowed. That one rule powers sentence-shift, Shuffle write-back, and Selection Focus without per-tool exemptions.

**CodeMirror gotchas** (all learned the hard way):

- **Never put vertical `margin` on a CM block or block widget** — the heightmap measures `getBoundingClientRect` (excludes margin) and stores the margin as a `WidgetBefore` pseudo-block, which breaks ArrowUp motion past it. Use `padding` or fixed `height` (see `project-view.js`, `tab-marker.js`).
- **Block decorations cannot come from a ViewPlugin** — provide them via `EditorView.decorations.from(stateField)` (table renderer, inline panes, properties).
- **Overlapping replace/fold decorations crash the view layer** — filter candidates before applying (`applyFolds`).
- A caret inside a folded range auto-unfolds it — park the cursor at the fold start when folding would strand it.
- **No layout reads or dispatches inside `ViewPlugin.update`** — defer via `queueMicrotask` with a re-entry guard (wikilink decorator).
- Replace-decoration **widgets render outside surrounding mark spans**, so focus-mode dimming must be baked onto widget DOM (links, citation pills) and rebuilt on toggle.
- `EditorView.scrollIntoView` via `coordsAtPos` silently no-ops for offsets outside the rendered viewport — dispatch the scroll **state effect** instead (outline jumps).
- Widget teardown races taps on iOS — see Platform gotchas.
- A `getBoundingClientRect` read flushes CM's pending measure pass — some scroll-sync code (gutter) depends on that side effect; "optimizing" the read away breaks fresh-line measurements.

**Editor geometry**: column width is `paddingLeft/Right` on `.cm-scroller`, managed by `editor/modes.js#applyColumnLayout`, which also subtracts docked-pane footprints and reacts to sidebar/pane changes via `state.runtime.columnResizeHandler`. The bottom typing runway is `padding-bottom` on `.cm-content` — WebKit doesn't count a scroll container's own bottom padding as scrollable overflow.

## Styling / theme pipeline

Themes are plain data files under `src/themes/` (`themeList`, `getActiveTheme()` resolves style + appearance). Styles (named presets: theme, font, sizes, per-appearance color overrides, cursor mode, line indicator, background layers, shader layer) apply through **`style-application.js#applyActiveStyle`**, which writes CSS custom properties on `<html>` and emits `theme-changed` last. **All colour resolution goes through `theme-colors.js#resolveEffectiveColors`** — one chain (style override → style's resolved theme → global appearance theme, with the Default style's `defaultLight/DarkColors` standing in when no style is active) shared by the editor writes and the sidebar/chrome writes (`updatePrivateBoxColor` → `--theme-bg`, `--fg`, `--panel-bg`, …). Do not add a parallel resolution path: the sidebar-desync bug existed because the sidebar, editor, and panes each hand-copied this chain and drifted. The style hover-preview is the only caller that passes explicit override colours.

The **shader layer** (`shader-layer/`) is zero-cost when off — the entire runtime is `import()`ed only when a style with an enabled effect applies. Blend modes live on the host element, not the canvas (a child canvas isolates `mix-blend-mode` against the host's transparent backdrop), and `window.__hushShaderPanicCleanup()` tears down every artifact regardless of internal state. It hosts the CSS-family overlays only; WebGL2 effects render as background layers.

**Background layers** (`background-layers/`) follow the same lazy-import discipline. A style's `backgroundLayers` array (index 0 = back; types `image` / `gradient` / `webgl` / `caret`) mounts as a `#background-layers-host` div inserted as the editor element's first child, with the host's `z-index: 0` making it the isolation boundary for the layers' `mix-blend-mode` (the scroller sits above at `z-index: 1`). **The backdrop colour is passed in explicitly** (`backdropColor`, the same value just written to `--bg`) rather than picked up via `background: inherit` — `.cm-editor` is transparent under plenty of theme/style combinations, and blending against a transparent backdrop silently turns every blend mode into a no-op or a black wash. `backgroundLayersEnabled === false` switches the stack off without discarding it.

Legacy shapes never rewrite themselves at apply time: `styles-panel-shared.js#resolveBackgroundLayersList` derives layers from the old single `backgroundImage`, from a WebGL2 `shaderLayer`, and from the first-cut caret-knobs-on-a-WebGL-layer shape on the fly; `migrateStyle` bakes each conversion onto the style only when it's opened for editing.

Caret layers sample `EditorView.coordsAtPos` through an event-driven, rAF-coalesced tracker (`caret-tracker.js`, refcounted singleton) and hand shaders a short trail of `(position, birth, seed)` uniforms so particles are pure functions of age. Presets that need more than the trail also get the live caret (`u_caret` / `u_caretH`) and two JS-accumulated dynamics: `u_activity`, a bump-and-decay of trail pushes that stands in for typing speed, and `u_angle`, rotation integrated at an activity-scaled rate (integrated rather than derived from time so a speed change never snaps the rings). Idle behaviour is per-preset (`PARK_MODES`): trail presets clear and park once everything has faded, `freeze` presets (HUD) park on their last drawn frame, and `run` presets (flicker bar) animate whenever a caret exists. Parked loops wake on a 4 Hz caret poll, so an idle editor pays no per-frame cost either way. In a scoped preview there is no editor caret, so the runtime substitutes a pointer-following source that idles into a slow orbit.

The caret canvases draw with **blending disabled**. Each preset writes one quad over a freshly cleared transparent buffer, so straight `(colour, alpha)` output is exact; the `SRC_ALPHA` blend they originally used squared alpha against a non-premultiplied canvas, which double-darkened faint output and turned every designed fade into its own square (an `exp(-0.85t)` tail displaying as `exp(-1.7t)`).

The style modal previews layers scoped to its preview pane under a `setScopedPreviewLock` that makes editor-context applies no-ops until the modal closes (the modal's own live saves emit `style-changed`, which would otherwise steal the layers back to fullscreen mid-edit). Layer rows reorder by dragging their grip; the drag listeners sit on `document` rather than on the grip under a `setPointerCapture`, because relocating the row mid-drag counts as a remove-and-reinsert and drops the capture, so the `pointerup` that commits the reorder never arrives.

## Panes

`pane/` is split around **`pane-state.js`** (the shared `panes` Map + accessors) so siblings avoid circular imports; `pane-manager.js` owns lifecycle and public API. Pane editors come from `createBaseExtensions`, so they behave identically to the main editor; inactive panes are locked non-editable and `pointer-events: none` to prevent input leaks. Content sync with the main editor is bidirectional under a pull-lock flag with try/finally guards; `pane-external.js` is the other direction — externally-changed bytes arriving from a synced desk folder, applied per pane under its own dirty flag (see README-SYNC).

**Docking** (`pane-dock.js`) is a contract between panes and every host surface: docked footprints publish as CSS vars (`--pane-dock-{left,right}-width`, `--pane-dock-{top,bottom}-height`, `--pane-dock-*-edge`) plus a synchronous `pane-dock-changed` document event; containers consume the vars in pure CSS, and `editor/modes.js` copies the event payload onto `state.runtime.docked*` in the same frame (the lazy-import path could resolve after paint, flashing the editor under a fresh dock). The four edges carve mutually exclusive territory; `publishDockCssVars` skips `display:none` panes so an inactive context's dock can't leak its footprint.

**Gutter** (`project/gutter.js`) is a docked notebook pane scroll-locked to a doc: the dock module owns geometry, and the canvas camera is slaved to the editor scroll (`camera.y = offset − scrollTop`, `zoom` locked at 1, so world-y ≡ doc-content-y). The doc↔gutter pairing is a **naming convention** (`<docName>-gutter` inside the doc's project), re-derived from names on every render — it survives round trips, restarts, and the `.hushproject` envelope with no metadata field. When serializing a gutter pane's notebook, the *pre-gutter* camera snapshot is written, never the live scroll-tied one (a scroll-position camera persisted into the file would seed the main canvas at a bogus viewport later).

**Persistence**: the open pane set (geometry, anchoring, per-pane view state — editor scroll, PDF zoom, notebook camera) rides `.hush/panes.json` with a 300 ms debounce; position stays per-device. Inline panes anchor as `{ anchorTitle, occurrence, height }` under the Nth `[[wikilink]]` occurrence.

## Notebooks, Desktops, Drawing

See [README-NOTEBOOK.md](README-NOTEBOOK.md) and [README-DRAWING.md](README-DRAWING.md). The contracts that matter from outside:

- The canvas is mounted/unmounted by `notebook-bridge.js` with **serialized lifecycle** and multiple guards against saving an empty canvas over a real file — don't bypass `saveNotebook`.
- **Shapes are immutable once in `state.shapes`** — mutations replace objects. The sync shim's identity diff and the undo manager's structurally-shared checkpoints both depend on it.
- Notebook files are a versioned JSON envelope (`notebook-content.ts`); `.hushnote` zip packing (`sync/notebook-sync.js` / Rust `hushnote.rs`) is the only wire format.
- Desktops (`desktop/`) reuse the whole notebook engine with per-canvas capability switches on `DrawingState` (`flowchartEnabled`, `flowEdgesLocked`, `desktopMode`, …) and store per-device layout/thumbnail caches in IndexedDB — a pattern to follow for future canvas-based takeover views.

## Multi-window

Desktop and iPad (native scenes, Tauri ≥ 2.11). A Rust `WindowRegistry` tracks `{ label, fileId, fileType }` per window; windows register at boot, push their open file, heartbeat every 4 s (mobile entries expire after 10 s of silence — iPad scene teardown can be completely silent, and closed vs switcher-parked scenes are indistinguishable), and are pruned belt-and-braces (destroy events, JS `beforeunload` + `pagehide`, reconciliation against live webviews). Native titles (`[Desk]-[File]`) go through `set_window_display_title`, which on iOS walks to `UIWindowScene.title` for the app switcher.

Cross-window sync: `broadcast_state_change` (settings / files — receivers re-fetch from disk and merge), `broadcast_doc_changed` (live buffer, debounced 250 ms), `broadcast_notebook_changed` (**id only** — the envelope is multi-MB and marshalling it froze the saving window). Receivers apply under the pull lock so echoes can't loop. Two hard-won rules:

- **Per-window settings writes are key-scoped.** A secondary window writes fresh-disk-settings + only the keys it touched, re-pinning per-window keys (`lastFileId`, `scrollPosition`, `activeDeskId`, mode flags). A full-copy write from a window holding stale memory for an untouched key silently reverts that key on disk (the vanishing YOUAREHERE registry bug).
- Subscribe to cross-window events **before** registering, so the registration's own broadcasts arrive through the same pipe.

`activeDeskId` is per-window: each window operates its own desk; only main's choice persists as the launch desk.

## Backend notes

- `AppSettings` uses `#[serde(rename_all = "camelCase")]` and `#[serde(default)]` on every field; defaults live in `settings/defaults.rs`.
- Images: binaries live in each desk's `Images/` under the original filename (auto-suffixed); **the filename is the fileId**; reads search every desk (markdown refs are bare filenames); saves land in the active desk.
- Zotero caches (`zotero_references.json`, `zotero_pdfs/`, `zotero_annotations/`) are local-only, never synced; PDF fetches happen server-side (`reqwest`) because Zotero's `/file` 302s to a presigned S3 URL whose CORS rejects the webview's `null` origin. Annotation fetches use the `/children` endpoint — `/items?parentItem=` does not actually scope and returns the whole library.
- `typst_export/`: citations are folded to control-char sentinels before pulldown-cmark (split-text events would lose bracket framing) and expanded per `CitationMode`; emphasis/cites emit Typst's *function* forms (`#emph[…]`, `#cite(...)`) because the markup forms are whitespace-sensitive (`*shape*attention` breaks). The in-memory `World` carries fonts from `typst-assets` + bundled Karla; no package resolution — iOS can't reach the network at render time.
- Grammar (`harper-core`) and spellcheck (`spellbook`) both run `async` + `spawn_blocking`; dictionaries embed via `include_str!` behind `OnceLock`.
- The activity log (`activity_log.rs` + `src/activity-log.js`) is the cross-window console: JSONL ring at `{data_dir}/activity.log`, JS batches on a 1.5 s timer with eager flush on error/`pagehide`/`visibilitychange: hidden` (iPad swipe-away never runs `beforeunload`). Rust logs fire-and-forget — diagnostics must never fail the operation they describe.
- Build stamps: `scripts/gen-build-info.mjs` (web) + `src-tauri/build.rs` (native) surface in Settings > Debug; a mismatch (stale bundle + fresh binary, common on iPad) explains many "impossible" bugs.

## Data storage

```
{data_dir}/com.hush.app/
├── settings.json
├── device_id
├── desks/                    (the desk-folder store — layout in README-SYNC.md)
├── desk-archives/            (archived desks, one zip each)
├── desk-recovery/            (automatic local-desk snapshots)
├── activity.log
├── files/                    (legacy flat store — inert backup after migration)
│   └── pdfs/                 (PDF binaries + _registry.json — per-device cache)
├── zotero_references.json  zotero_pdfs/  zotero_annotations/
└── *.pre-desks.bak           (pre-migration backups)
```

macOS: `~/Library/Application Support/com.hush.app/`; Linux: `$XDG_DATA_HOME/com.hush.app/`.

## Platform gotchas (lessons learned)

### WebKit / iOS

- **`visibility: hidden` on a container + `visible` on a child is valid CSS that WebKit may simply never paint** — the element computes visible, composites, and isn't drawn until an unrelated invalidation. Hide siblings individually instead (Desktop panes).
- **The Canvas2D cost model on iPad** is upload-dominated: WebKit rasterizes CPU-side and uploads the canvas's *dirty region* at ~280 MB/s, so fully dirtying a visible 4096² canvas costs ~235 ms regardless of JS cost; a ~1 %-opacity canvas skips the upload; using a canvas as its own `drawImage` source forces a ~230 ms GPU→CPU readback; a *mutable* canvas as a draw source re-uploads per draw (promote to `ImageBitmap`); and assigning `canvas.width` reallocates the IOSurface (0.8–1.5 s) even for the same size — guard no-op resizes. The full story is engine deltas #25–#31 in README-DRAWING.md.
- **Production WKWebView leaves `var(--theme-bg)` chrome stale** after focus/visibility transitions — `updatePrivateBoxColor` force-writes inline backgrounds on the themed surfaces under `html.ios`, once synchronously and once next frame (the restore can clobber a synchronous write).
- **Tap → caret placement re-renders CM and tears down the tapped widget before `click` fires.** Open-from-widget handlers attach `pointerdown` directly to the widget element and capture anchor rects synchronously (an awaited import later, the element rect reads as zeros). Dismiss-on-outside listeners use `pointerdown`, not `mousedown` — iOS delivers the synthetic `mousedown` hundreds of ms after `touchend`, past any rAF that armed the listener, so a `mousedown` dismiss self-closes on the opening tap.
- **iOS fires `pointercancel` (not `pointerup`) when it claims a near-stationary touch for scrolling** — recover an in-slop cancel as a click or files need two taps to open. Multi-touch gestures end with paired `pointerup`s milliseconds apart — a pinch reads as a double-tap unless the detector tracks concurrent contacts and poisons the whole gesture (`pointercancel` must feed the same bookkeeping or the set leaks and locks the detector).
- **`beforeunload` never runs on iOS** — also flush on `pagehide` and `visibilitychange: hidden`.
- External-app drops on iPadOS often arrive via `dataTransfer.items` with `files` empty — union both sources and dedupe.
- iPadOS deep links are delivered **more than once** (every window, replayed `getCurrent()`, webview reloads) — dedupe by nonce in a shared ring; and without `tauri-plugin-scene-reuse` the OS spawns a fresh empty scene per incoming URL.
- WKWebView's native scrollbar is a non-grabbable overlay on iPad — surfaces that need a draggable thumb build their own (stacks).
- `toDataURL("image/webp")` yields PNG on WebKit, WebP on Chromium — sniff magic bytes when reading caches back.
- Linking Google's ML Kit static archives with a global `-ObjC` flag detonates on Tauri's `libapp.a` (Swift objects embedded once per plugin) — the pod-install script rewrites to per-archive `-force_load` (`scripts/ios-add-mlkit-pod.mjs`).

### Tauri / OAuth / integration

- Tauri's built-in drag-drop is disabled (`dragDropEnabled: false`) so DOM drop events reach the webview.
- The macOS `#drag-region` strip (z 80, `-webkit-app-region: drag`) steals clicks from anything beneath it — chrome that must sit at the top edge either mounts at body level above z 80 (the Google link bar) or the region is display-noned for that surface (notebook/PDF/stack/Desktop takeovers). A child of a lower stacking context can never outrank it, no matter its local z-index.
- Google OAuth for desktop apps requires a **loopback HTTP redirect** (`http://127.0.0.1`, port wildcarded) — custom URI schemes are rejected for generic desktop clients. The Rust listener binds an ephemeral port per flow.
- Webview windows don't navigate custom-scheme anchors — route through `plugin-opener`.

### General

- Emit order matters around teardown: `clearActiveFile`/`openFile` emit unmount events *before* nulling the matching `current*` pointer, so listeners of those events read the *outgoing* surface; the fully-cleared state is only visible on the trailing `no-file-state` / `file-opened`.
- `window.confirm` doesn't reliably block in the WebView — use the in-app confirm modals.
- Keep per-keystroke and per-frame paths allocation-free and IPC-free: the naming-rule pipeline, notebook autosave gates (quiet-moment + backpressure), rAF-coalesced drag/scroll handlers, and dirty-driven render loops all exist because a single stall drops pointer samples (visible as straight-line gaps in ink).

## Companion deep links (`hushwriter://`)

Inbound channel for companion apps, routed by `src/links/deep-link-router.js` → per-feature handlers (`zotero-helper-import.js`). Current action: `hushwriter://zotero-import?desk=…&project=…&items=<json>&nonce=…` registers placeholder PDFs and background-downloads via Hush's own Zotero credentials (links never carry secrets); desk/project match by id then case-insensitive name; `project=__active__` targets the open project. Only a request with **no** `desk` parameter targets the active desk: a named desk that doesn't resolve is waited for (a local desk's folder routinely loads seconds after a cold launch) and, failing that, the import is refused with an error toast — the old silent active-desk fallback is how a cold-launch send (or a sender holding a renamed desk's old name) filed PDFs into the wrong desk. Registry writes happen before any tree access and the tree is then resolved and mutated in one synchronous pass, so a cross-window tree reload mid-import can't strand placeholders. New actions: parse in a sibling module, return `true` when recognized, remember the window boots hidden (`show()` before long work). Known gap: no `tauri-plugin-single-instance`, so Windows/Linux deep links may spawn a second instance.
