# Notebook Drawing — Technical Overview

The drawing layer adds freehand ink, erase, slice, and lasso-select tools on top of the notebook's shape-based canvas. Its top toolbar (Lasso, Erase, Slice, three brush slots) is always visible alongside the other notebook tools — there's no separate "drawing mode" to enter; clicking any drawing tool implicitly flips `state.tool = "pen"` and routes pointer events into the stroke engine. The layer lives in `src/notebook/drawing/` and is ported from a reference demo (`temp-drawing-hush-demo/`) that was a standalone [Perfect Freehand](https://github.com/steveruizok/perfect-freehand) + offscreen-bake stroke engine.

The port's core goal is keeping the engine fast (bake-to-canvas with tile indexing, GPU-composited preview transforms) while making every stroke a first-class Hush shape (undo, groups, layers, shelf, pocket, floating panes).

```
src/notebook/drawing/
  drawing-layer.ts       Factory + public API (camera sync, tool switch, brush slot apply, selection-drag hooks, style patches, lasso hold-ms, touch pan)
  drawing-layer-types.ts DrawingLayer interface + EngineTool / SelectionStyleEntry / SelectionStylePatch types
  drawing-layer-dom.ts   DOM scaffolding (transform wrapper, three stacked canvases, pocket-stash canvas, SVG overlay, eraser cursor, "Selecting" hint pill)
  selection-style.ts     Retroactive selection styling session (snapshot → apply → commit one undo entry)
  selection-bridge.ts    Mirrors Hush's state.selectedIds into the engine selection so resize / rotate handles also appear under the regular Select tool, not only the pen-mode lasso
  sync-shim.ts           state.shapes[] ↔ engine.strokes bridge (identity diff, no-op fast path)
  brush-urls.ts          Resolves brush-N PNG atlases via Vite asset imports
  brush-runtime.ts       Helpers used by drawing-layer (slot colour resolution, applySlot, renderSwatch, theme retint) — extracted to keep drawing-layer.ts under the 700-line cap
  brush-slots.ts         Toolbar slot row + the brush-edit flyout (size / stream / spacing / brush / color / mode)
  tool-panel.ts          Top pill (Lasso, Erase, Slice, brush slots, lasso hold-time flyout) plus a sibling meta-tools pill (drag handle + minimize) and the restore pencil pill mounted next to the bottom toolbar
  layers-panel.ts        Layers dropdown hung off the bottom toolbar — notebook-level, used by every shape type
  vite-assets.d.ts       `*.png?url` and `*.js` module declarations
  pencil-bridge.js (sibling, in src/notebook/) — wires `tauri-plugin-pencil` (iOS) to the engine's `setPencilOnly` flag and routes Apple Pencil double-tap into a draw ↔ erase toggle on the active canvas
  engine/
    stroke.js            Stroke engine entry: pointerdown/move/up → active stroke → done canvas; configurable long-press-ms
    stroke-render.js     Draws stamps into the done canvas via the brush atlas
    stroke-geometry.js   Perfect-freehand integration, bbox, tile hashing, culling
    stroke-atlas.js      PNG atlas loader, per-brush tint cache
    stroke-erase.js      Pixel-test erase (full) + slice (split at cut)
    selection.js         Polygon lasso, move / delete, proportional resize handles, rotation handle, previewTransform
    gestures.js          Multi-touch recogniser: 2-/3-finger tap → undo/redo (routed through Hush's snapshot stack), 2-finger drag → pan (engages even mid-stroke), pinch → zoom
    history.js           Legacy engine command stack — no longer wired; left in place pending removal
    layers.js            Engine-local layer record (id, locked, hidden). Mirrored from notebook state.
    brushes/             brush-1.png ... brush-5.png — the atlases the renderer samples from
```

## Architecture

```
  Hush DrawingState ──┐                                       ┌── Hush UI (toolbar, shelf, pocket)
       state.shapes[] │                                       │
                      ▼                                       ▲
               ┌────────────┐   identity diff   ┌────────────┐
               │ sync-shim  │ ───────────────▶ │  engine    │
               │  (O(N))    │ ◀─────────────── │ strokes[]  │
               └────────────┘   engine-origin  └────────────┘
                      ▲            push-back          │
                      │                               ▼
                      │                       done canvas (baked)
                      │                       + active stroke overlay
                      │                       + preview transform
                      │
                 renderer.ts (notebook) blits grouped-drawing thumbs via blitWorldRegion
```

### The sync shim

`state.shapes[]` is canonical. The engine holds a parallel `state.strokes[]` array, and the shim makes the two look like one data source without duplicating storage or rebaking on every unrelated mutation.

Invariants (documented in the file header and required on every change):

1. **Identity diff only.** A single O(N) ref-compare pass per `"shapes"` notify. Same reference → skipped. The shim never deep-compares points.
2. **Zero engine work on unrelated mutations.** Editing a TextShape fires a shapes notify; the diff finds no DrawShape deltas and returns. This must stay under a millisecond on multi-thousand-shape notebooks.
3. **Engine-originated mutations bypass the diff.** When the engine commits a stroke, it pushes into `state.shapes` *and* refreshes the shim's last-seen snapshot in one go, so the resulting notify sees no deltas.
4. **Mutations route through engine methods.** Style patches go through `setStrokesStyleMap`; point edits through `setStrokePoints`; inserts/removes through `insertStrokeAt` / `removeStrokes`. Never poke `strokes[]` directly — the engine maintains bbox + tile indexes that need to stay in sync.
5. **Bulk loads pause per-stroke rebakes.** File-open inserts N strokes with rebakes suppressed and calls `fullRebake()` once at the end.

World-coord translation is also at the shim boundary: `DrawShape.points` are stored in world coords; the engine's stage is a CSS-transformed wrapper and expects local coords. The shim applies `worldToLocal` on ingest and `localToWorld` on emit.

### The engine (deltas from the reference demo)

Targeted deltas have been applied to `engine/` so the port stays as close as possible to the upstream code. Each is documented at the call site (`grep -rn "Hush delta #" src/notebook/drawing/engine/` finds every modification) and listed here so a diff-check against the reference demo has a known shape:

1. **`pointToLocal`** — engine receives Hush's screen→local transform instead of computing its own; keeps pointer events aligned with the CSS wrapper transform we drive the engine inside.
2. **`getDpr`** — DPR is read from a Hush-owned callback (we cap at 2 and factor in `MAX_BACKING_PIXELS`).
3. **`brushUrl`** — atlas URLs come from `brush-urls.ts` (Vite `?url` import) rather than a hard-coded relative path.
4. **selection `pointToLocal`** — mirror of #1 for the lasso engine.
5. **gestures `pointToLocal`** — mirror of #1 for the pinch/pan gesture engine.
6. **public `fullRebake`** — exposed on the engine adapter so the shim can trigger it after bulk loads and layer mutations.
7. **Square handles** — `selection.js` renders 10 px `<rect>` resize handles in place of the reference demo's circles, matching Hush's TextShape / ImageShape selection UI.
8. **Pocketed → hidden** — `isStrokeHidden` treats `pocketed` as a reason to skip the done-canvas render; the pocket tray shows those strokes via the separate pocket stash canvas (see "Pocket stash" below).
9. **Delete badge hidden** — the red-X bbox badge from the reference demo is created but never appended to the DOM. Delete for strokes flows through Hush's shared selection toolbar trash icon, so an engine-owned badge was redundant.
10. **Two-finger pan** — `gestures.js` watches for two-finger drift past `PAN_START_2` and promotes the burst from tap-candidate to pan. Midpoint deltas (client space) are forwarded via `onPanStart / onPanMove / onPanEnd` so the notebook camera can track. Without this, iPad users couldn't pan while any drawing tool was active (the SVG overlay swallowed the touches).
11. **Configurable long-press** — `stroke.js` reads its lasso hold duration from `state.longPressMs` instead of a module constant, and exposes `setLongPressMs()`. Hush drives this from the Lasso flyout's 500–2000 ms slider (`state.lassoHoldMs`).
12. **Pinch-zoom** — `gestures.js` also fires `onPinchStart / onPinchMove / onPinchEnd` with client-space midpoint + finger-spread distance once the spread has drifted past `PINCH_START`. Runs alongside pan in the same burst — typical iPad zoom is "spread + drift" simultaneously.
13. **Pan-during-draw** — gesture-mode promotion fires on any second contact landing while a stroke is in flight, rather than gating on the first finger being still. The active stroke is cancelled (`strokeEngine.cancelActiveStroke()`) on landing so the user can pan with two fingers mid-stroke; palm contacts (`width|height > MAX_CONTACT_SIZE`) are filtered out before the active map sees them so a brushing palm never inflates `active.size` or strands a phantom entry when iPad palm rejection drops its pointerup. A stale-entry sweep on every pointerdown drops any contact older than `STALE_ENTRY_MS` (5 s) as a backstop against missed lifts. `SIMULTANEITY_MS` covers the evaluation window only (600 ms) — the pre-gate doesn't enforce it.
14. **Theme-tracking color flags** — `stroke.js` carries two boolean flags on every active stroke (`colorIsAuto`, `colorIsHeading`) plus a `setColorAutoSource(source)` method. Hush calls it from `applySlot` whenever a brush slot uses an `"auto"` or `"heading"` sentinel, so freshly-drawn strokes inherit the matching flag and `drawing-layer.setTheme` can retint them en masse on theme switches.
15. **Soft selection deactivate** — `selection.js` exposes `setEventActive(bool)` alongside the existing `activate / deactivate` pair. The hard `deactivate()` clears `selectedIds` (it has to, to keep the lasso-end semantics). `setEventActive(false)` only flips `state.active = false` and clears any in-flight lasso, so `drawing-layer.setTool` can disable engine event capture for non-select sub-tools without dropping the user's retroactive selection. Without this, brush-slot taps would wipe the engine selection right after the bridge re-populated it on the same tool change.
16. **Chrome interactivity toggle** — `selection.js` exposes `setChromeInteractive(bool)` which toggles `pointerEvents` on the entire bbox `<g>`. Used by the bridge during pen+draw/erase/slice with a live retroactive selection: the chrome stays painted (the user can see what's selected while the brush flyout retints it) but every pointerdown falls through to the stroke engine, so the user's next stroke isn't intercepted by an invisible-to-them resize handle.

### Apple Pencil bridge (iOS only)

A small native plugin (`src-tauri/tauri-plugin-pencil/`) augments the in-WebView pointer events with two iPadOS-specific signals that PointerEvent doesn't surface:

- **Touch type** (`UITouch.type`) — every `touchesBegan` is observed by a passive `UIGestureRecognizer` that fails immediately so the WebView keeps owning the touch. The plugin reports `"pencil"` or `"finger"` as a `touch` event and the JS bridge stashes the most recent value on `window.__hushLastTouchKind`. It's a confirmed signal independent of `PointerEvent.pointerType`, which the current Tauri WKWebView build sometimes mis-classifies on Apple Pencil contacts.
- **Pencil double-tap** (`UIPencilInteractionDelegate`) — the hardware double-tap on Pencil 2nd gen / Pencil Pro has no PointerEvent equivalent, so the plugin forwards it as a `double-tap` event. Hush flips `state.drawingSubTool` between `"draw"` and `"erase"` (and ensures `state.tool === "pen"`) when this fires, giving the user a hardware shortcut to swap the active brush for the eraser.

The bridge is loaded asynchronously from `src/notebook/pencil-bridge.js`. The engine carries a `setPencilOnly(bool)` hook (delta #18) that drops every non-pen contact from `onPointerDown`, but the bridge does **not** auto-enable it — locking finger contacts out unconditionally also locked Pencil contacts out on builds where pointerType mis-reports, so the hook is left in place for a future settings toggle or correlated touch-kind gate to flip on deliberately. The bridge is a no-op on macOS / Windows / Linux and on iOS builds where the native plugin failed to register.

### Drawing tools (the top pill)

Drawing is always on-deck: the top pill is rendered at all times and picking any of its buttons flips `state.tool = "pen"` implicitly with the matching sub-tool. Leaving drawing happens when the user picks a non-drawing tool from the bottom toolbar (Select / Text / Drag Area / Brainstorm) — which flips `state.tool` back and the pill visually dims (buttons at 0.6 opacity).

A second **meta-tools pill** sits to the right of the main pill carrying the **drag handle** (a 4-direction arrow icon — press and drag to reposition both pills as a unit, persisting the offset on `state.drawingToolbarOffset`) and a **minimize** button. Clicking minimize flips `state.drawingToolbarMinimized = true`, which hides both pills (`display: none`) and shows a separate one-item pencil pill positioned 10 px to the right of the bottom toolbar. Clicking the pencil flips the flag back. Minimize also reverts `state.tool` to `"select"` if the user was mid-pen, so they aren't trapped with an active draw / erase / slice tool they can no longer see. The flag is session-only (not persisted) and defaults to `true` — fresh notebooks open with only the pencil pill visible, so users who don't draw aren't met with a full toolbar they have to dismiss. The restore pill's left edge tracks the bottom toolbar's right edge via a `ResizeObserver` + state-change hook in `notes-canvas.ts` so it stays glued in place as theme / sidebar / brainstorm width changes shift the bottom toolbar around.

| Sub-tool | Engine behavior |
|----------|-----------------|
| `draw` | New strokes are appended. Current brush slot feeds size / color / brushId / mode. |
| `erase` | Pixel-test erase on the done canvas; consumes strokes wholesale. |
| `slice` | Pixel-test slice at the cut; splits a stroke into two. |
| `select` | Polygon lasso; hits are bridged to `state.selectedIds` (see below). |

Draw has no dedicated button — the active brush slot indicates it. Clicking any brush returns the user to Draw (that's how they exit Erase/Slice). Lasso is the first button in the pill; clicking it activates select, clicking the already-active Lasso toggles a flyout with a single slider (500–2000 ms) for the hold-to-lasso duration.

`enterDrawingMode()` / `exitDrawingMode()` still exist on `DrawingState` for the double-click-on-stroke path and for external callers, but the UI never surfaces them as a toggle.

**Long-press → lasso handoff.** While the user is drawing, a 0.5-s hold (or whatever `state.lassoHoldMs` currently is) without drift cancels the in-flight stroke and promotes the gesture into a lasso. The drawing layer saves the previous sub-tool, flips to `select` for the duration of the selection (so the stroke engine stops accepting new draws), and flashes a small "Selecting" pill to the left of the anchor for acknowledgement. Tapping empty canvas while a selection exists (a `onLassoComplete({ selected: false })` from the engine) restores the previous sub-tool so the user drops straight back into drawing.

### Brush slots

Three user-owned presets (`state.brushSlots[0..2]`, `SLOT_COUNT = 3`). Each slot carries `{ brushId, color, size, mode, streamline, spacing }`. The factory defaults are `auto` (theme text colour, brush-1, 3 px), `heading` (theme heading colour, brush-2, 6 px), and `#3b82f6` (blue, brush-3, 25 px). Two of the slot colours are theme sentinels: `"auto"` resolves to `theme.foreground` at paint time (tagged `colorIsAuto` on the stroke) and `"heading"` resolves to `theme.headingColor` (tagged `colorIsHeading`) — the same hue markdown headings paint in the editor. Both flags ride through the engine's stroke metadata so theme changes retint matching strokes; the engine's `setColorAutoSource(source)` carries the choice forward to freshly-drawn strokes. Picking a `heading` swatch lets users mark up text-shape annotations in the same accent the editor uses for headers, which is handy for sketchy diagrammatic emphasis on top of typed notes.

**Flyout behavior.** Clicking the already-active slot toggles a flyout that edits that slot in place. Clicking a different slot just switches — it does **not** open the flyout. Inside the flyout, edits also retroactively restyle any live selection; slider drags are wrapped in one style-session-per-drag so a single undo reverts the whole gesture.

The slot buttons match the main toolbar icon size (36×36, transparent) and use opacity — not a tint background — to indicate which slot is active. Active state is only shown when the sub-tool is `draw`.

### Layers

Layers are notebook-level — not drawing-specific — because shape membership applies to every shape type (text, image, drag-area, draw). `state.layers` is an ordered array (top-first). Every shape carries an optional `layerId`; legacy shapes default to the bottom layer on load. The notebook renderer iterates bottom-to-top and skips hidden layers, producing the expected paint order.

The dropdown is mounted on the bottom notebook toolbar and exposes per-row: radio (make active), rename (double-click), reorder arrows, visibility eye, lock, trash. The drawing engine mirrors the layer list via its own `layers.js` module; the shim keeps the two in sync.

### Selection bridge

The engine owns drawing-mode selection via `selection.js`. When it commits a lasso pick, `bridgeEngineSelectionToState` writes the hit stroke ids back to `state.selectedIds` so downstream hush UI (selection toolbar, Cmd+G, shelf highlight) treats the strokes like any other shape selection.

The reverse direction is also bridged via `selection-bridge.ts`: every `selectedIds` / `tool` / `drawingSubTool` change resolves matching engine stroke ids and pushes them into `selectionEngine.setSelectedIds(...)` so the bbox + handles appear when strokes are selected via Hush's regular Select tool, not just the pen-mode lasso. Three orthogonal toggles control how the chrome is exposed in each mode:

- **`setBboxClickable(bool)`** — pen+lasso turns it on so the dashed body acts as a grab-to-move target; everywhere else it's off so click-on-stroke routes through Hush's drag handler.
- **`setChromeHidden(bool)`** — only flipped to `true` for transient cases (none currently in active use); `false` keeps the bbox visible whenever `selectedIds.size > 0`.
- **`setChromeInteractive(bool)`** (delta #16) — pen+draw/erase/slice with a live selection sets this to `false`, leaving the bbox painted as a passive visual cue but pinning `pointer-events: none` on the `<g>` so the user's next stroke isn't intercepted by a handle.

Drawing-layer's `setTool` calls `setEventActive(false)` (delta #15) for non-select sub-tools, which disables the engine's pointer-event listeners without touching the selection set — that's what keeps the user's selection alive across brush-slot taps so the flyout can keep retinting it.

### Drag performance

Naive drag: update N `DrawShape.points` per frame, fire a shapes notify, diff, call `setStrokePoints(...)` N times, rebake N tiles. Unusable above ~20 strokes.

Instead, hush's select-drag routes DrawShape moves through `engine.previewTransform`:

1. `beginSelectionDrag(hushIds)` — strokes with those ids are excluded from the done canvas and drawn on the preview overlay. The shim pauses so per-frame state.shapes point mutations don't re-enter the engine.
2. `updateSelectionDrag(totalDx, totalDy)` — a CSS/matrix shift on the preview overlay. One GPU-composited frame, independent of N.
3. `endSelectionDrag()` — mutate engine points by the final total offset, rebridge, resume the shim.

A drag of 500 strokes runs at the same frame rate as a single-stroke drag.

### Double-click into drawing

Double-clicking a `DrawShape` (or any stroke in a group) selects it group-aware and calls `enterDrawingMode()`. This replaces hush's default double-click behavior (which creates a new text shape) for the drawing case specifically. The user can then pick a brush / eraser / etc. from the top pill; exiting drawing is a matter of clicking another top-level tool.

### Pocket stash

Pocketed strokes are hidden from the done canvas (engine delta #8). To still render them inside the pocket tray, the layer keeps a separate offscreen canvas called the pocket stash. On pocket, the drawing layer blits the stroke's world-region into the stash. On unpocket, it restores. The notebook's pocket tray renderer reads from the stash via `blitWorldRegion` with a pocket-space destination ctx.

### Retroactive styling

When the drawing selection is live, flyout edits restyle the selection in place rather than just updating the slot config. The lifecycle:

1. `snapshotSelectedStyle()` — capture the pre-edit styles.
2. `applyStyleToSelection(patch)` — live preview. No history entry yet.
3. `commitStyleHistory(before)` — record one snapshot via `state.recordHistory()` if anything actually changed. No-op otherwise.

Slider inputs open a session on their first `input` event of a drag and commit on `change` (fired on pointer release) so a slider sweep produces one undo entry, not one per frame.

### Selection bbox: resize, rotate, undo

`selection.js` paints a dashed bbox with **eight square resize handles** (corners + edge mid-points) and a **rotation handle** as a small circle on a tether above the top edge. Resize is always **proportional** — corner handles project the cursor onto the diagonal anchor→handle vector; edge mid-handles propagate their single-axis scale to the locked axis. The engine's `commitTransform(ids, fn, sizeScale)` accepts an optional uniform size scale so the brush stamp itself widens or narrows with the bbox, not just the underlying point positions. Rotation rotates the chrome via an SVG `transform="rotate(angle, cx, cy)"` for live feedback and bakes the rotated points on commit; the bbox is then recomputed axis-aligned from the new points.

The bbox + handles also appear when strokes are selected via Hush's regular Select tool — `selection-bridge.ts` listens for `selectedIds` / `tool` / `drawingSubTool` change events and pushes the matching engine stroke ids into `selectionEngine.setSelectedIds()`. CSS pins `pointer-events: auto` on `.bbox` and `.handle` so the handles stay interactive even when the SVG root has `pointer-events: none` outside pen mode (which lets empty-canvas clicks fall through to Hush's input layer). The pen-mode lasso path skips the bridge so it owns its own selection set.

### Undo / redo

Drawing-mode actions (add stroke, erase, slice, transform, restyle) flow into Hush's snapshot-based `UndoManager` — the same stack that backs `⌘Z` for every other notebook action. Engine callbacks bridge their mutations into `state.shapes` via the sync shim and then call `state.recordHistory()` to capture a checkpoint. The shim exposes `isDiffing()` so engine callbacks fired as a consequence of a state→engine reflection (e.g. an undo restoring `state.shapes` triggers `engine.removeStrokes` which fires `onStrokesRemoved`) skip recording; otherwise an undo would clobber the redo stack. The 2- and 3-finger touch taps in `engine/gestures.js` call `state.undo()` / `state.redo()` directly. The legacy engine-local command stack (`engine/history.js`) is no longer wired.

## Development rules

Same as the notebook and main Hush codebase:

- No file may exceed 700 lines.
- No framework dependencies.
- State mutations go through `DrawingState` (notebook-level state) or the engine's public methods (never poke `strokes[]`).
- The sync shim's invariants are load-bearing — don't add work inside the diff loop. If a shape mutation needs extra processing, do it in the caller.

## Adding a new sub-tool

1. Add the tool to the `DrawingSubTool` union in `types.ts`.
2. Implement the pointer handling in `engine/stroke.js` (or a new `engine/*.js` if it's distinct enough).
3. Add the button to `SUB_TOOLS` in `drawing/tool-panel.ts`, or mount it alongside Lasso if it needs custom click behavior (e.g. its own flyout).
4. Route the sub-tool through `DrawingLayer.setTool()` so the engine gets the update.
5. Have the button's click handler call `activateDrawingSubTool()` from `tool-panel.ts` — that's what flips `state.tool = "pen"`, clears an active pan, and sets the sub-tool in one shot.

## Adding a new brush

1. Drop a `brush-N.png` atlas into `engine/brushes/`.
2. Register it in `brush-urls.ts` and the `BRUSH_IDS` list in `brush-slots.ts`.
3. The engine's atlas loader and tint cache pick it up automatically.
