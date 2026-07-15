# Notebook Drawing — Technical Overview

The drawing layer adds freehand ink, erase, slice, and lasso-select tools on top of the notebook's shape-based canvas. Its toolbar (Undo, three brush slots, Slice, Erase, Lasso) is anchored to the right edge of the bottom toolbar with a 10 px gap, so the two pills read as one combined toolbar. There's no separate "drawing mode" to enter — clicking any drawing tool implicitly flips `state.tool = "pen"` and routes pointer events into the stroke engine. The layer lives in `src/notebook/drawing/` and is ported from a reference demo (`temp-drawing-hush-demo/`) that was a standalone [Perfect Freehand](https://github.com/steveruizok/perfect-freehand) + offscreen-bake stroke engine.

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
  tool-panel.ts          Drawing-tools controller: appends divider + brush slots + Slice / Erase / Lasso directly to the bottom toolbar (no separate pill), then mounts three gray-pill end-caps — drag + rotate on the left, Background settings on the right
  pocket-blit.ts         Pocket / done-canvas blit helpers extracted from drawing-layer.ts
  re-anchor.ts           Camera-following controller: shifts wrapper world-origin (and grows worldSize at low zoom) so the canvas backing always covers the visible viewport
  selection-drag.ts      Hush↔engine select-drag controller (pause-shim, hide-chrome, commit-on-release)
  mini-palette.ts        15-px-thick A/H/Red + size shortcut strip pinned to the active brush
  flyout-styles.ts       15-px squared-thumb stylesheet shared by every drawing flyout slider
  layers-panel.ts        Layers dropdown hung off the bottom toolbar — notebook-level, used by every shape type
  vite-assets.d.ts       `*.png?url` and `*.js` module declarations
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

src/notebook/pencil-bridge.js  Flips `setPencilOnly(true)` on iOS Tauri at startup so iPad finger contacts can't seed strokes
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
5. **Bulk loads pause per-stroke rebakes.** File-open inserts N strokes with rebakes suppressed (engine delta #22, `insertStrokeAt(..., { skipRebake: true })`) and calls `fullRebake()` once at the end.
6. **Large diffs go bulk.** When a single notify changes the identity of most DrawShapes at once (file load, pane mirror, undo/redo across a big action), the diff abandons per-stroke engine updates — each of which triggers its own tile rebake, O(N²) in aggregate — and rebuilds the engine stroke list wholesale with one `fullRebake()` plus a pocket-stash repaint. Threshold: ≥50 changed strokes AND ≥25% of the notebook's strokes. Steady-state pen-ups stay incremental.

World-coord translation is also at the shim boundary: `DrawShape.points` are stored in world coords; the engine's stage is a CSS-transformed wrapper and expects local coords. The shim applies `worldToLocal` on ingest and `localToWorld` on emit. The wrapper's world-space anchor (`originX`, `originY`) is mutable and shifts at runtime — see "Re-anchoring" below.

### Re-anchoring (infinite canvas)

The drawing engine renders into a fixed-pixel canvas wrapped in a CSS-transformed div. The wrapper is GPU-composited as the camera pans and zooms — fast — but the canvas backing covers a finite world rect `[origin, origin + worldSize]`. To make the surface effectively infinite without giving up the GPU pan, `re-anchor.ts` slides the origin (and grows `worldSize` at low zoom) so the visible viewport always lands inside the backing.

`ensureCoverage(camera)` runs on every `setCamera` call. The fast path is a cheap predicate: if the camera viewport sits well inside the canvas with `REANCHOR_MARGIN_FRAC × worldSize` (15%) of slack on every side, and `worldSize` is within `RESIZE_RATIO_THRESHOLD` (1.4×) of what the current zoom wants, return immediately — the existing wrapper transform handles the motion. Otherwise:

1. Pick a new `worldSize` from `wantWorldSize(zoom)` — `max(WORLD_SIZE_MIN, longest visible side / zoom × 1.25)`. At zoom=1 this stays at 2048 (DPR=2 against `MAX_BACKING_PIXELS = 4096²`); at zoom=0.25 it grows to ~9600 with DPR auto-degrading to ~0.4 — fine because zoomed-out strokes are subpixel anyway.
2. Pick a new `originX, originY` centered on the camera's current world viewport.
3. Call `engine.translateAllStrokePoints(oldOrigin - newOrigin)` (delta #20) so every stroke's local coords shift to keep its world position constant.
4. Resize the three stage canvases + pocket stash + wrapper + svg if `worldSize` changed.
5. `fullRebake()` (or the engine's own `resize()` rebake) repaints the done canvas at the new origin.
6. Walk pocketed strokes (hidden from done via delta #8) and re-render them into the pocket stash via `renderStrokeTo` (delta #20) — the stash bitmap was at old origin/dpr.
7. `selectionEngine.refreshBBox()` so any visible bbox lands at the new local coords.

Cost is O(N strokes) per re-anchor. The 15% margin keeps it amortized cheap — the user pans ~70% of the canvas before crossing the threshold. Steady-state pan/zoom is unchanged: same single CSS transform on the wrapper, no engine work.

`originX`, `originY`, and `worldSize` are held in a single mutable `AnchorState` record shared across `pointToLocal`, `applyWrapperTransform`, the pocket-blit getters, and the sync-shim's `localToWorld` / `worldToLocal` closures so a re-anchor's mutation propagates without re-binding callbacks.

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
13. **Pan-during-draw** — gesture-mode promotion fires on any small second contact landing while a stroke is in flight, rather than gating on the first finger being still. The active stroke is cancelled (`strokeEngine.cancelActiveStroke()`) on landing so the user can pan with two fingers mid-stroke; palm contacts are still rejected via `MAX_CONTACT_SIZE` so a brushing palm doesn't kill the stroke. A stale-entry sweep on every pointerdown drops any contact older than `STALE_ENTRY_MS` (5 s) as a backstop against missed pointerup / pointercancel events under iPad palm rejection. `SIMULTANEITY_MS` covers the evaluation window only (600 ms) — the pre-gate doesn't enforce it.
14. **Theme-tracking color flags** — `stroke.js` carries two boolean flags on every active stroke (`colorIsAuto`, `colorIsHeading`) plus a `setColorAutoSource(source)` method. Hush calls it from `applySlot` whenever a brush slot uses an `"auto"` or `"heading"` sentinel, so freshly-drawn strokes inherit the matching flag and `drawing-layer.setTheme` can retint them en masse on theme switches.
15. **Soft selection deactivate** — `selection.js` exposes `setEventActive(bool)` alongside the existing `activate / deactivate` pair. The hard `deactivate()` clears `selectedIds` (it has to, to keep the lasso-end semantics). `setEventActive(false)` only flips `state.active = false` and clears any in-flight lasso, so `drawing-layer.setTool` can disable engine event capture for non-select sub-tools without dropping the user's retroactive selection. Without this, brush-slot taps would wipe the engine selection right after the bridge re-populated it on the same tool change.
16. **Chrome interactivity toggle** — `selection.js` exposes `setChromeInteractive(bool)` which toggles `pointerEvents` on the entire bbox `<g>`. Used by the bridge during pen+draw/erase/slice with a live retroactive selection: the chrome stays painted (the user can see what's selected while the brush flyout retints it) but every pointerdown falls through to the stroke engine, so the user's next stroke isn't intercepted by an invisible-to-them resize handle.
17. **Finger hold-to-select (pencil-only mode)** — In pencil-only mode, finger contacts now arm the long-press timer at the touch position without seeding an active stroke (`state.fingerHoldPointer` tracks the candidate). Drift past `LONG_PRESS_MOVE_THRESHOLD` or release before the timer cancels the gesture quietly; on timeout the existing `onLongPress` handoff promotes the finger pointer into a lasso. A second finger landing during a hold cancels the candidate so the gesture recogniser can claim the burst.
18. **`translateAllStrokePoints` + `renderStrokeTo`** (source-side delta #20) — `stroke.js` exposes a bulk point-shift method and a single-stroke render helper so the host's re-anchor controller can slide the wrapper origin (and re-render pocketed strokes into the stash at new pixel positions) without poking the engine's internals. See "Re-anchoring" above for the full lifecycle.
19. **Per-point timestamps** (source-side delta #21) — `getPoint` stamps `t: e.timeStamp` onto every captured point (`commitTransform` carries it through move / resize). The field is optional everywhere (`DrawPoint.t?`), rides the sync shim into `DrawShape.points`, persists as whole ms in the notebook envelope, and feeds the ML Kit ink recognizer's pen-velocity model — only deltas *within* a stroke are meaningful since `timeStamp` is page-relative. The renderer ignores it.
20. **Skip-rebake inserts** (source-side delta #22) — `insertStrokeAt(stroke, index, opts)` accepts `opts.skipRebake` so bulk loads can insert N strokes without N per-insert tile rebakes (quadratic in N) and issue one `fullRebake()` at the end. Used by the sync shim's bulk-replace path.

### Apple Pencil gating (iOS)

On iOS Tauri builds, finger touches don't *draw* — only Apple Pencil and mouse can seed strokes. The gate lives at the engine level: `engine/stroke.js` carries a `setPencilOnly(bool)` flag (delta #18) that rejects every non-pen, non-mouse `pointerdown` for the stroke path. `src/notebook/pencil-bridge.js` flips that flag on once at startup if the runtime is iOS — no native code involved for the gate itself, since `PointerEvent.pointerType` reliably reports `"pen"` for Apple Pencil and `"touch"` for finger on this iPad WKWebView build.

Fingers can still trigger **hold-to-select** even with pencil-only on (delta #19). A finger contact in pencil-only mode arms the long-press timer at the touch position *without* seeding an active stroke; drift past `LONG_PRESS_MOVE_THRESHOLD` or release before the timer cancels the gesture. On timeout the existing `onLongPress` handoff promotes the finger pointer into a lasso pointer (the selection engine takes over capture from there). A second finger landing during a hold kills the candidate so the gesture recogniser can claim the burst (pan / pinch / 2-3 finger tap).

### Apple Pencil double-tap (iOS)

The Apple Pencil 2nd-gen / Pencil Pro squeeze gesture has no `PointerEvent` equivalent, so it goes through a native plugin: `src-tauri/tauri-plugin-pencil/` (Swift `PencilPlugin` + Rust shell). The plugin attaches a `UIPencilInteraction` directly to the WKWebView and triggers a `double-tap` plugin event each time the sensor fires; `pencil-bridge.js` registers a listener on that event and calls `toggleNotebookEraser()` from `notes-canvas.ts`, which flips the active notebook between the eraser and whatever non-erase sub-tool the user was last on (typically `draw`, which preserves their active brush slot).

An earlier iteration of the Swift plugin also attached a passive `UIGestureRecognizer` to the WKWebView's `scrollView` for finger-vs-pencil detection. That gesture chain interfered with how the page received touches and broke iPad drawing entirely, so it has been removed; the plugin's only responsibility now is the double-tap event. `UIPencilInteraction` is attached to the webview itself, not the scrollView, and does not affect touch delivery.

The plugin is registered unconditionally from `src-tauri/src/lib.rs` (`tauri_plugin_pencil::init()`); on every non-iOS target the plugin's iOS hook is gated behind `cfg(target_os = "ios")` so the macOS build stays a no-op. Listener registration is permitted via the `pencil:default` capability in `src-tauri/capabilities/default.json`.

### Drawing tools (the bottom pill)

Drawing is always on-deck: the drawing buttons live in the right half of the unified bar (past the divider that separates main canvas tools from drawing tools), and picking any of them flips `state.tool = "pen"` implicitly with the matching sub-tool. Leaving drawing happens when the user picks a non-drawing tool to the left of the divider (Select / Text / Drag Area / Brainstorm) — which flips `state.tool` back and the drawing buttons visually dim (opacity 0.6).

The bar is one DOM element so there's no inter-pill shadow seam, and three gray-pill end-caps anchor to the canvas container as siblings of the bar:
- **Drag** (leftmost) — press-and-drag updates `state.drawingToolbarOffset`, which `toolbar.ts` and `tool-panel.ts` both consume so the bar and every end-cap move as one unit.
- **Rotate** (next to drag) — flips `state.drawingToolbarVertical`. The handler captures the bar's pre-toggle screen center and queues a microtask that, after the orientation listeners apply new styles, sets a fresh offset preserving the saved center (clamped). Two microtasks land before paint, so the user sees the bar move from old position straight to preserved position with no intermediate flash.
- **Background settings** (right end-cap) — opens the canvas pattern / spacing / opacity popup. Like the brush + lasso flyouts, it follows the proximity rule (away from the nearest screen edge).

Each end-cap's perpendicular dimension matches the bar's: 38 px tall in horizontal mode, 52 px wide in vertical, so the assembly reads as one continuous strip. A `ResizeObserver` on the bottom toolbar drives a `relayout()` callback that re-anchors every end-cap whenever sidebar / theme / leftInset shifts change the bar's dimensions. `clampOffset` folds all three end-caps + the bar into one bbox so neither edge can be dragged off-screen.

| Sub-tool | Engine behavior |
|----------|-----------------|
| `draw` | New strokes are appended. Current brush slot feeds size / color / brushId / mode. |
| `erase` | Pixel-test erase on the done canvas; consumes strokes wholesale. |
| `slice` | Pixel-test slice at the cut; splits a stroke into two. |
| `select` | Polygon lasso; hits are bridged to `state.selectedIds` (see below). |

Draw has no dedicated button — the active brush slot indicates it. Clicking any brush returns the user to Draw (that's how they exit Erase/Slice). Lasso is the first button in the pill; clicking it activates select, clicking the already-active Lasso toggles a flyout with a single slider (500–2000 ms) for the hold-to-lasso duration.

`enterDrawingMode()` / `exitDrawingMode()` still exist on `DrawingState` as stable entry points for external callers, but the UI never surfaces them as a toggle.

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

### Double-click on a stroke

Double-clicking a `DrawShape` (including a stroke that lives inside a group) selects only that single stroke — the click reaches `DrawingState.handleDoubleClick`, which sets `selectedIds = { hit.id }` without changing the stroke's `groupId`. That's the only path for picking one member out of a group; single-click promotes to whole-group selection. The double-click path replaces Hush's default double-click behaviour (which would create a new text shape) for the drawing case specifically.

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
