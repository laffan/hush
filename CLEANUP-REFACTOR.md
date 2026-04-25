# Hush — Cleanup & Refactor Plan

A prioritized list of changes from the consultant code review. Items are grouped by effort/payoff, not by subsystem, so you can pick a tier and ship it as one focused pass.

---

## Tier 1 — small effort, high payoff

### 1. Replace silent catches with logged warnings

Every silent failure is a future debugging trap. One pass across the codebase replacing swallowed errors with `console.warn` / `tracing::warn!`. Keep the resilience, gain visibility.

**JS sites**
- `src/main.js:462–463` — `.catch(() => {})` after files-panel refresh on local-sync update
- `src/main.js:585, 613, 615` — `.catch(() => {})` around `set_always_on_top` and `set_activation_policy`
- `src/state/state.js:533` — `catch { return false; }` on notebook creation failure (highest priority — this can leave the UI inconsistent)

**Rust sites**
- `src-tauri/src/files.rs:138` — `Err(_) => continue` in `load_project_content`
- `src-tauri/src/local_sync.rs:143–147` — silent fallback to `modified = 0`
- `src-tauri/src/sync.rs:76–80` — silent empty-HashMap on malformed JSON

### 2. Wrap sync-guard flags in `try/finally`

A single thrown exception inside the pane↔editor sync path leaves `_syncing = true` forever, after which sync silently stops working until app restart.

**Sites**
- `src/pane/pane-manager.js` — every `_syncing = true` / `_syncing = false` pair
- The notebook shape sync's double-`queueMicrotask` reset path (also pane-manager.js)
- Equivalent guards in `src/notebook/drawing/sync-shim.ts` (`suppressDiff`, `pausedForDrag`, `batching`)

### 3. Atomic writes for persistent state

`fs::write()` is not atomic. A crash mid-save corrupts the file. The fix is `write to .tmp → rename` and costs ~30 lines.

**Sites in `src-tauri/src/`**
- `files.rs` — `save_file`, `save_file_tree`
- `settings.rs` — `AppSettings::save`
- `images.rs` — `save_from_data_url`, `rename_image`

### 4. Centralize z-index as CSS custom properties

Currently the z-index hierarchy is documented at 90/100/150 then jumps to 9,999 / 10,000 / 10,001 with one outlier at `2147483647`. New modals pick a fresh "high-enough" number with no shared reference.

**Action**: In `src/styles/base.css`, add:
```css
--z-pane: 90;
--z-sidebar: 200;
--z-shelf: 150;
--z-modal: 1000;
--z-modal-top: 2000;
--z-drag-ghost: 9999;
```
Replace literals across `styles-panel.css`, `ratchet.css`, `sync-conflict.css`, `zotero.css`, `footnotes.css`, `floating-pane.css`.

### 5. Bound `write_binary_file` destination

`src-tauri/src/lib.rs:225–228` writes binary files anywhere the app has permission. Restrict to a small set of allowed root directories (data dir, user-chosen export folders).

---

## Tier 2 — medium effort, structural payoff

### 6. Decompose `pane-manager.js`

At 1,342 lines this file is nearly 2× the stated limit and the least cohesive module in the codebase.

**Suggested split**
- `pane-lifecycle.js` — `createPane`, `closePane`, `focusPane`, the `panes` map, z-counter
- `pane-attach-sync.js` — `toggleAttach`, `startCanvasSync`, `startScrollSync`, `stopAttachSync`, RAF handles
- `pane-drag.js` — pointer-down/move/up drag and resize handlers
- `pane-popovers.js` — pane-size popover, confirmation dialogs

### 7. Split the oversized Rust modules

**`src-tauri/src/lib.rs` (753 LOC)** — split commands by domain:
- `commands/files.rs`
- `commands/window.rs`
- `commands/snapshots.rs`
- `commands/zotero.rs`

Keep app setup, AppState struct, and tray menu in `lib.rs`.

**`src-tauri/src/settings.rs` (835 LOC)** — extract default functions:
- `settings/defaults.rs` for the 75 default fns
- Keep the `AppSettings` struct and `save`/`load` in `settings.rs`

### 8. Promote underscore-prefixed AppState fields

The current implicit sub-API (`state._pendingScrollPosition`, `state._columnResizeHandler`, `state._hasVisibleDocPane`, `pane._scrollHandler`, `pane._syncFrame`, etc.) works but is undocumented and untyped.

**Action**: Either
- (a) Promote to formal `AppState.runtime` substructure with JSDoc types, or
- (b) Move them onto a clearly-named side-channel object (`appState.uiHooks`)

Either way, eliminate the convention of "any module can write a `_` field to AppState."

### 9. Inject DPR into `RenderState`

`src/notebook/renderer.ts:123` reads `window.devicePixelRatio` directly, breaking the README's "pure renderer" claim. Pass DPR as a field on `RenderState` and have `notes-canvas.ts` populate it. The export pipeline already sets DPR explicitly — this just makes the live path symmetric.

### 10. Inline engine-delta markers

The drawing engine's deltas from the upstream demo are documented in file headers but not always at the call site. Add `// Hush delta #N` comments inline at each modification site so future port-syncs can `grep` for them.

**Files to update**: `src/notebook/drawing/engine/{stroke,selection,gestures,stroke-atlas}.js`

---

## Tier 3 — larger investments

### 11. Accessibility pass on CSS

Currently missing across 5,367 lines of CSS:
- `:focus-visible` outlines for keyboard users
- `@media (prefers-reduced-motion: reduce)` for `notebook.css` and `typewriter.css` animations
- `@media (prefers-color-scheme)` fallback (theme is JS-driven only)
- `::selection` styling (currently browser default)
- WCAG AA contrast review on the theme tokens

Worth doing before any wider public release.

### 12. Lock-ordering audit (Rust)

Define a canonical lock order:
```
settings → file_manager → snapshot_manager → sync_manager → local_sync_manager
```
Audit every command path that takes more than one lock and verify it acquires in that order. `sync_commands.rs:259–278` (`check_sync_changes`) and `:295–315` (`accept_external_change`) are the obvious starting points. Document the order at the top of `lib.rs` near the AppState definition.

### 13. Replace `unwrap()`/`expect()` in command handlers

Specific sites:
- `src-tauri/src/lib.rs:73` — `get_settings` lock unwrap
- `src-tauri/src/snapshots.rs:22` — `expect()` in `new()` constructor

Both crash the app on poison/init failure rather than degrading. Convert to proper error returns.

### 14. Sync-image support

The README itself flags this gap: image refs in Dropbox-synced docs don't resolve on other devices. Currently the sync scanner walks only `.md` / `.hushnote` files and the manifest filter excludes `type: "image"`.

This is more product than architecture, but it's the most user-visible incoherence in the shipped app today. Estimate: 2–3 days of work in `src/sync/` + `src-tauri/src/sync.rs` + sync_commands.

### 15. ✅ Decided: enforce the 700-line rule with a small exception allowlist

**Done.** All eleven violators were split. Two files remain on a documented exception list (`.line-limit-exceptions`):

- `src/notebook/drawing/engine/stroke.js` — port hygiene against the upstream demo
- `src/notebook/state.ts` — pointer-interaction state machine; extraction was evaluated as adding a conceptual seam without proportional gain

A new check script (`scripts/check-line-limits.sh`) runs as part of `npm run build` (`npm run check:line-limits` to invoke directly). It honors the exception file and exits 1 with a violator list otherwise.

**Files split** (see `README-TECHNICAL.md` for the full module map):

- `src-tauri/src/settings.rs` (835 → 561) + `settings/defaults.rs` (279)
- `src-tauri/src/lib.rs` (753 → 374) + `commands/{settings,files,images,snapshots,local_sync,zotero,window}.rs` (412 total)
- `src/state/state.js` (750 → 584) + `state/state-defaults.js` (173)
- `src/sidebar/sidebar.js` (725 → 529) + `sidebar/{sidebar-export,ratchet-dropdown,panel-resizer}.js` (~210 total)
- `src/notebook/renderer.ts` (768 → 632) + `renderer-selection.ts` (112) + `renderer-background.ts` (31)
- `src/main.js` (880 → 637) + `font-imports.js` + `style-application.js` + `window-shortcuts.js` (~280 total)
- `src/sidebar/files-panel.js` (973 → 652) + `files-panel-shared.js` (62) + `files-panel-local-sync.js` (289)
- `src/sidebar/styles-panel.js` (964 → 240) + `styles-panel-shared.js` (52) + `style-modal.js` (625)
- `src/notebook/drawing/drawing-layer.ts` (984 → 686) + `drawing-layer-types.ts` (89) + `drawing-layer-dom.ts` (148) + `selection-style.ts` (146)
- `src/editor/editor.js` (782 → 625) + `heading-indent.js` (96) + `comment-plugins.js` (73)
- `src/pane/pane-manager.js` (1342 → 657) + `pane-state.js` (53) + `pane-content.js` (311) + `pane-attach-sync.js` (93) + `pane-drag.js` (126) + `pane-size-popover.js` (110) + `pane-persistence.js` (138)

---

## Suggested ordering

A two-week consolidation sprint covering Tiers 1 and 2 would meaningfully shrink the bug surface without changing the shape of the app:

- **Week 1**: items 1, 2, 3, 5 (defensive cleanup) + item 4 (z-index tokens)
- **Week 2**: items 6, 7 (file decomposition) + item 8 (state hygiene) + items 9, 10 (notebook polish)

Tier 3 items can be scheduled individually as product priorities allow.
