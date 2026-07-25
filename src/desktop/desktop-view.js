/**
 * Desktop view — a visual overview of everything inside a project,
 * presented as a full notebook canvas of live file thumbnails (see
 * README "Desktops"). Follows the PDF Shelf's takeover pattern: one
 * host mounted into #app, toggled via the `desktop-active` body class
 * so the surfaces underneath keep their layout.
 *
 * Every file renders as an ImageShape carrying a `fileRef` marker —
 * drag / group / undo come free from the notebook engine, while
 * `fileRef` withholds delete / rename / resize (the Desktop mirrors
 * the filesystem). Thumbnails generate on open for files whose cache
 * went stale (desktop-thumbs.js); the arrangement, camera, background
 * and per-Desktop options persist per container (desktop-store.js).
 * Stacking lives in desktop-stacks.js, options UI in desktop-options.js,
 * doc outlines in desktop-outline.js, and shape assembly + the shelf
 * search index in desktop-content.js.
 */

import { collectDesktopFiles, findDesktopContainer } from "./desktop-files.js";
import {
  ensureDesktopThumb, computeDesktopGrid,
  evictSessionThumb, DESKTOP_GRID_GAP,
} from "./desktop-thumbs.js";
import {
  refOf, keepRefFields, applyThumbRefFields, hydrateShape, shapeBottom,
  newThumbShape, buildShapes, fitCameraFor, buildSearchIndex,
} from "./desktop-content.js";
import { normalizeDesktopStacks } from "./desktop-stacks.js";
import { DESKTOP_OPTION_DEFAULTS, normalizeDesktopOptions } from "./desktop-options.js";
import { loadDesktopEnvelope, saveDesktopEnvelope } from "./desktop-store.js";
import { createDesktopOutline } from "./desktop-outline.js";
import { initDesktopConnections, applyDocConnections } from "./desktop-connections.js";
import { openFileRef, openFileRefWithGutter, openFileRefSecondary } from "./desktop-open.js";
import { canvasToScreen, screenToCanvas } from "../notebook/utils.ts";

let _host = null;
let _canvasHost = null;
let _state = null;
let _containerId = null;
let _canvas = null;
let _themeCtx = null;
let _openToken = 0;
let _saveTimer = null;
let _reconcileTimer = null;
let _optionsTimer = null;
let _hoverCleanup = null;
let _stackingCleanup = null;
let _canvasListenersCleanup = null;
let _outlineClickCleanup = null;
let _background = null; // per-desktop bg override cached from the popup event
let _options = { ...DESKTOP_OPTION_DEFAULTS };
let _refreshing = false;
let _hydrated = false; // true once the open-time thumbnail pass landed
let _focusKey = null; // fileRef key to select + centre after hydration
// fileRef key → deep search text, read by the shape shelf
// (window.__hushDesktopSearchText) so search reaches file contents.
const _searchText = new Map();
// Doc-outline controller — owns the per-doc outline row hit-geometry,
// the canvas click handler that opens a doc at a clicked heading, and
// the per-doc / bulk outline toggles (desktop-outline.js).
let _outline = null;

export function isDesktopOpen() {
  return !!_containerId;
}

export function currentDesktopContainerId() {
  return _containerId;
}

/** Desktops open on a 20% grid; the bg flyout overrides it per project. */
const DESKTOP_BG_DEFAULT = { backgroundPattern: "grid", gridSpacing: 25, gridOpacity: 0.2 };

function collectOpts() {
  return { includeGutters: _options.includeGutters };
}

/** Open a thumbnail in place. A nested project's Desktop replaces this
 *  one rather than opening the project's joined buffer — a project *is*
 *  a Desktop, so that's what opening it means. */
function openThumbnail(ref) {
  openFileRef(_state, ref, (nodeId) => openDesktop(_state, nodeId));
}

/** True when some file surface is genuinely active. The open events
 *  fire after the pointers are set, so this reads as "the open landed"
 *  — an open that bailed leaves every pointer null. */
function somethingIsOpen(state) {
  return !!(state.currentFileId || state.currentProjectId || state.currentNotebookFileId
    || state.currentPdfFileId || state.currentStackFileId || state.currentLocalSync);
}

/** Docked panes (a doc's gutter especially) reserve edge width through
 *  the pane-dock CSS vars. The Desktop hides every pane, so republish
 *  after the `desktop-active` flip — otherwise the Desktop's own shelf
 *  sits a gutter-width inboard. Restored on close by the same call. */
const syncDockVars = () =>
  import("../pane/pane-dock.js").then((m) => m.publishDockCssVars()).catch(() => {});

function initDesktop(state) {
  if (_host) return;
  _state = state;
  // Doc-outline controller (lazy getters over module state, so one
  // instance survives every open/close).
  _outline = createDesktopOutline({
    getCanvas: () => _canvas, getHost: () => _canvasHost,
    getState: () => _state, getContainerId: () => _containerId,
    getThemeCtx: () => _themeCtx, getToken: () => _openToken,
    collectOpts, screenToCanvas, scheduleSave,
    openRef: (ref) => openThumbnail(ref),
    ensureThumb: (st, entry, themeCtx) => ensureDesktopThumb(st, entry, themeCtx),
    collectFiles: (st, containerId, opts) => collectDesktopFiles(st, containerId, opts),
    applyThumb: (key, thumb) => applyThumbToShape(key, thumb),
  });
  // Deep-search hook for the shape shelf: while a Desktop is mounted,
  // shelf rows for file thumbnails search the file's content too.
  window.__hushDesktopSearchText = (key) => _searchText.get(key) || "";
  // Sticky-note hooks: desktop-pinned stickies map their world position
  // through the live camera and scale by the zoom returned alongside.
  window.__hushDesktopWorldToScreen = (pt) => {
    if (!_canvas || !_canvasHost) return null;
    const rect = _canvasHost.getBoundingClientRect();
    const s = canvasToScreen(pt, _canvas.state.camera);
    return { x: rect.left + s.x, y: rect.top + s.y, zoom: _canvas.state.camera.zoom };
  };
  window.__hushDesktopScreenToWorld = (pt) => {
    if (!_canvas || !_canvasHost) return null;
    const rect = _canvasHost.getBoundingClientRect();
    return screenToCanvas({ x: pt.x - rect.left, y: pt.y - rect.top }, _canvas.state.camera);
  };
  _host = document.createElement("div");
  _host.id = "desktop-view";
  _host.className = "desktop-view hidden";
  document.getElementById("app")?.appendChild(_host);

  // Any single-file open replaces the Desktop, exactly like the PDF
  // shelf (the hover Open buttons land here via these events too).
  // Guarded on something *actually* being open: an open that bailed
  // (missing file, failed load) still emits its event, and closing on
  // that would strand the user on the "No file selected" pane with the
  // Desktop gone. Better to stay put than to close into nothing.
  const close = () => { if (somethingIsOpen(state)) closeDesktop(); };
  state.on("file-opened", close);
  state.on("notebook-open", close);
  state.on("pdf-open", close);
  state.on("stack-open", close);
  state.on("multi-select-changed", () => {
    if ((state.selectedDocIds || []).length >= 2) closeDesktop();
  });
  // Filesystem is the source of truth: deleted files disappear from the
  // canvas, new files grid in, renames re-caption. A container that's
  // genuinely gone closes the Desktop — but that check lives inside the
  // debounced reconcile, so a transient miss while the tree reloads
  // can't yank the view out from under a pan.
  state.on("files-changed", () => {
    if (!_containerId) return;
    if (_reconcileTimer) clearTimeout(_reconcileTimer);
    _reconcileTimer = setTimeout(() => { _reconcileTimer = null; reconcileLive(); }, 300);
  });
  // A PDF cover landing from a background download swaps it in place.
  state.on("pdf-cover-ready", (fileId) => {
    if (_containerId && fileId) refreshEntryByFileId(fileId);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !_containerId) return;
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
    const st = _canvas?.state;
    // The canvas's own Esc semantics come first: exit reorder mode,
    // then drop an active selection; only a "cold" Esc closes.
    if (st && (st.reorderDragAreaId || st.editingText)) return;
    if (st && st.selectedIds.size > 0) {
      e.preventDefault(); e.stopPropagation();
      st.selectedIds = new Set();
      st.notify("selectedIds");
      return;
    }
    e.preventDefault(); e.stopPropagation();
    closeDesktop();
  }, true);

  // A style / theme switch repaints the canvas chrome; thumbnails
  // re-render on the next open since their cache signature holds the theme.
  state.on("settings-changed", async () => {
    if (!_canvas || !_containerId) return;
    const { computeNotebookSettings } = await import("../notebook/notebook-style-settings.js");
    const nbSettings = computeNotebookSettings(state, null);
    // Canvas follows the app theme; thumbnails stay light.
    _canvas.applySettings({
      ...nbSettings,
      ...(_background
        ? { backgroundPattern: _background.pattern, gridSpacing: _background.spacing, gridOpacity: _background.opacity }
        : { ...DESKTOP_BG_DEFAULT }),
    });
    const next = makeThemeCtx();
    if (!_themeCtx || _themeCtx.sig !== next.sig) _themeCtx = next;
  });

  document.addEventListener("notebook-bg-changed", (e) => {
    const d = e.detail || {};
    if (!_canvas || !d.state || d.state !== _canvas.state) return;
    _background = { pattern: d.pattern, spacing: d.spacing, opacity: d.opacity };
    scheduleSave();
  });
}

/** Open the Desktop for a project node id. `opts.focusKey` selects and
 *  centres that file's thumbnail once the canvas lands (used by the
 *  "View in Desktop" palette entry). */
export async function openDesktop(state, containerId, opts = {}) {
  if (!_host) initDesktop(state);
  _state = state;
  if (!findDesktopContainer(state, containerId)) return;
  _focusKey = opts.focusKey || null;
  if (_containerId === containerId) {
    if (_focusKey && _hydrated) focusThumb(_focusKey);
    return;
  }
  if (_containerId) {
    // Switching container (e.g. drilling into a nested project's
    // Desktop): persist the outgoing layout first.
    persistNow();
    teardownCanvas();
    _state.emit("desktop-closed", _containerId);
  }
  if (state.selectedDocIds?.length) state.clearSelectedDocs();
  import("../pdf/pdf-shelf.js").then((m) => m.closePdfShelf()).catch(() => {});
  // The Desktop is the open thing now — tear down whatever file was open
  // so nothing interactive sits behind it (no doc margins, no panes).
  await state.clearActiveFile();

  _containerId = containerId;
  _background = null;
  _options = { ...DESKTOP_OPTION_DEFAULTS };
  window.__hushDesktopOpenId = containerId;
  document.body.classList.add("desktop-active");
  syncDockVars();
  _host.classList.remove("hidden");
  renderChrome();
  await mountCanvas();
}

export function closeDesktop() {
  if (!_containerId) return;
  const closed = _containerId;
  persistNow();
  teardownCanvas();
  _containerId = null;
  _openToken++;
  window.__hushDesktopOpenId = null;
  document.body.classList.remove("desktop-active");
  syncDockVars();
  if (_host) {
    _host.classList.add("hidden");
    _host.innerHTML = "";
  }
  _canvasHost = null;
  _state?.emit("desktop-closed", closed);
}

// ── Chrome ──────────────────────────────────────────────────────────

/** The Desktop has no header of its own — the canvas fills the takeover
 *  and its two view actions (Reset View / Refresh Thumbnails) live in
 *  the background-settings flyout's Desktop section, bottom right. */
function renderChrome() {
  _host.innerHTML = `<div class="desktop-canvas-host"></div>`;
  _canvasHost = _host.querySelector(".desktop-canvas-host");
}

function setLoading(on, label = "Building Desktop…") {
  if (!_canvasHost) return;
  let el = _canvasHost.querySelector(".desktop-loading");
  if (!on) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.className = "desktop-loading";
    _canvasHost.appendChild(el);
  }
  el.textContent = label;
}

/** Zoom out so every item on the Desktop is visible (header button). */
export function resetDesktopView() {
  if (!_canvas || !_canvasHost) return;
  const st = _canvas.state;
  st.camera = fitCameraFor(st.shapes, _canvasHost.clientWidth || 800, _canvasHost.clientHeight || 600);
  st.notify("camera");
  st.rebasePinAnchor?.();
}

// ── Canvas lifecycle ────────────────────────────────────────────────

/** Thumbnails always render in light mode — white page grounds, dark
 *  ink — whatever the app's appearance, so a doc reads as printed paper
 *  on the (still theme-coloured) Desktop canvas. Uses the active style's
 *  light-variant theme and drops any dark background override. */
function makeThemeCtx() {
  const theme = _canvas.state.themeForVariant("light");
  const fontFamily = _canvas.state.fontFamily;
  const sig = [
    "light", theme.canvasBackground, theme.foreground, theme.headingColor, fontFamily,
    `f${_options.docFontSize}`, `L${_options.thumbLongEdge}`,
  ].join("|");
  return {
    theme,
    fontFamily,
    appearance: "light",
    canvasBackgroundOverride: "",
    docFontSize: _options.docFontSize,
    longEdge: _options.thumbLongEdge,
    sig,
  };
}

async function mountCanvas() {
  const token = ++_openToken;
  const state = _state;
  setLoading(true);

  const { NotesCanvas, claimActiveNotebook } = await import("../notebook/notes-canvas.ts");
  const { computeNotebookSettings } = await import("../notebook/notebook-style-settings.js");
  if (token !== _openToken || !_canvasHost) return;

  const s = state.settings;
  const shortcuts = {
    shortcutNbSelect: s.shortcutNbSelect,
    shortcutNbText: s.shortcutNbText,
    shortcutNbDragArea: s.shortcutNbDragArea,
    shortcutNbBrainstorm: s.shortcutNbBrainstorm,
    shortcutNbDelete: s.shortcutNbDelete,
    shortcutNbUndo: s.shortcutNbUndo,
    shortcutNbRedo: s.shortcutNbRedo,
    shortcutNbGroup: s.shortcutNbGroup,
    shortcutNbUngroup: s.shortcutNbUngroup,
  };

  _canvas = new NotesCanvas(_canvasHost, shortcuts);
  // Route clipboard / undo to this canvas immediately — a hidden main
  // notebook underneath may still hold the active-canvas slot.
  claimActiveNotebook(_canvas);
  // No user-drawn flowchart, and no option-drag clones (dupes dedupe on
  // reopen). The flowchart *layer* stays live: the Desktop paints its
  // own derived document-order arrows through it (desktop-connections).
  _canvas.state.flowchartEnabled = false;
  _canvas.state.altDuplicateEnabled = false;
  _canvas.state.desktopMode = true;
  initDesktopConnections(_canvas);
  // Toolbar parks bottom + minimized — thumbnails lead, tools are a click away.
  _canvas.state.setDrawingToolbarPosition("bottom");
  _canvas.state.setDrawingToolbarMinimized(true);
  const nbSettings = computeNotebookSettings(state, null);
  // A saved per-desktop override lands after the envelope loads.
  _canvas.applySettings({ ...nbSettings, ...DESKTOP_BG_DEFAULT });

  const envelope = await loadDesktopEnvelope(_containerId);
  if (token !== _openToken) return;
  _options = normalizeDesktopOptions(envelope?.options);
  _themeCtx = makeThemeCtx();
  // Per-Desktop options ride the background-settings flyout.
  const { buildDesktopOptionsSection } = await import("./desktop-options.js");
  if (token !== _openToken || !_canvas) return;
  _canvas.state.extraBgSettingsSection = () =>
    buildDesktopOptionsSection(
      _canvas.state.theme, () => _options, setDesktopOption, (on) => _outline.setAll(on),
      { resetView: resetDesktopView, refreshThumbnails: refreshDesktopThumbnails },
    );
  if (envelope?.background) {
    _background = envelope.background;
    _canvas.applySettings({
      backgroundPattern: _background.pattern,
      gridSpacing: _background.spacing,
      gridOpacity: _background.opacity,
    });
  }

  // Docs whose outline column was open last time — generate up front.
  const outlineKeys = new Set(
    (envelope?.shapes || []).filter((s) => s?.fileRef?.outline).map((s) => s.fileRef.key));

  // Generate / refresh every thumbnail — unchanged files return
  // instantly (the "update when the Desktop opens" pass).
  const collected = collectDesktopFiles(state, _containerId, collectOpts());
  const entries = collected?.entries || [];
  const thumbs = new Map();
  _outline.clear();
  for (const entry of entries) {
    entry.outline = outlineKeys.has(entry.key);
    const thumb = await ensureDesktopThumb(state, entry, _themeCtx);
    thumbs.set(entry.key, thumb);
    _outline.setRows(entry.key, thumb.outlineRows);
    if (token !== _openToken) return;
  }

  _canvas.loadShapes(
    buildShapes(envelope, entries, thumbs),
    envelope?.layers?.length ? envelope.layers : undefined,
  );
  // Saved flowchart edges are intentionally not restored: the only edges
  // a Desktop carries are the derived document-order connections, which
  // are re-chained from the live file order every time.
  applyDocConnections(_canvas, entries, _options.showConnections);

  requestAnimationFrame(() => {
    if (token !== _openToken || !_canvas) return;
    if (envelope?.camera && typeof envelope.camera.zoom === "number") {
      _canvas.state.camera = { ...envelope.camera };
    } else {
      _canvas.state.camera = fitCameraFor(
        _canvas.state.shapes, _canvasHost.clientWidth || 800, _canvasHost.clientHeight || 600);
    }
    _canvas.state.notify("camera");
    _canvas.state.rebasePinAnchor?.();
    if (_focusKey) focusThumb(_focusKey);
  });

  attachCanvasListeners();
  // Warm the "Open as pane" path — a cold chunk fetch inside the click
  // handler is latency the user reads as a dead button.
  Promise.all([import("../pane/pane-manager.js"), import("./desktop-pane.js")]).catch(() => {});
  setLoading(false);
  _hydrated = true;
  _state.emit("desktop-opened", _containerId);
  buildSearchIndex(state, entries, _searchText, () => token === _openToken, collectOpts());
}

function teardownCanvas() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_reconcileTimer) { clearTimeout(_reconcileTimer); _reconcileTimer = null; }
  if (_optionsTimer) { clearTimeout(_optionsTimer); _optionsTimer = null; }
  if (_hoverCleanup) { _hoverCleanup(); _hoverCleanup = null; }
  if (_stackingCleanup) { _stackingCleanup(); _stackingCleanup = null; }
  if (_canvasListenersCleanup) { _canvasListenersCleanup(); _canvasListenersCleanup = null; }
  if (_outlineClickCleanup) { _outlineClickCleanup(); _outlineClickCleanup = null; }
  if (_canvas) { _canvas.destroy(); _canvas = null; }
  _themeCtx = null;
  _refreshing = false;
  _hydrated = false;
  _focusKey = null;
  _searchText.clear();
  _outline?.clear();
}

function attachCanvasListeners() {
  const onChange = () => scheduleSave();
  const onCamera = () => {
    scheduleSave();
    // Desktop-pinned stickies re-anchor against the camera.
    document.dispatchEvent(new CustomEvent("desktop-camera-changed"));
  };
  _canvasHost.addEventListener("notebook-change", onChange);
  _canvasHost.addEventListener("notebook-camera-change", onCamera);
  const host = _canvasHost;
  _canvasListenersCleanup = () => {
    host.removeEventListener("notebook-change", onChange);
    host.removeEventListener("notebook-camera-change", onCamera);
  };
  import("./desktop-hover.js").then((m) => {
    if (!_canvas || !_canvasHost) return;
    _hoverCleanup = m.attachDesktopHover(_canvasHost, _canvas, {
      onOpen: (ref) => openThumbnail(ref),
      onSecondary: (ref, ev) => openFileRefSecondary(_state, ref, ev, _containerId),
      onOpenWithGutter: (ref) => openFileRefWithGutter(_state, ref),
      onToggleOutline: (ref) => _outline.toggle(ref),
      onStacksChanged: () => scheduleSave(),
    }, {
      showLabels: () => _options.showLabels,
      hasOutlineRows: (key) => _outline.has(key),
    });
  });
  import("./desktop-stacks.js").then((m) => {
    if (!_canvas || !_canvas.state.canvasEl) return;
    _stackingCleanup = m.attachDesktopStacking(_canvas.state.canvasEl, _canvas, {
      onStacksChanged: () => scheduleSave(),
    });
  });
  _outlineClickCleanup = _outline.attachClicks();
}

/** Select + centre a file's thumbnail (View in Desktop). */
function focusThumb(key) {
  _focusKey = null;
  const st = _canvas?.state;
  if (!st) return;
  const shape = st.shapes.find((sh) => sh.fileRef?.key === key);
  if (!shape) return;
  st.selectedIds = new Set([shape.id]);
  st.notify("selectedIds");
  st.focusShape(shape.id);
}

// ── Per-Desktop options ─────────────────────────────────────────────

function setDesktopOption(key, value) {
  _options = normalizeDesktopOptions({ ..._options, [key]: value });
  if (key === "showLabels") {
    // Labels are hover-only DOM now — the option just gates them; the
    // hover module reads it live, so nothing to repaint here.
  } else if (key === "showConnections") {
    const collected = collectDesktopFiles(_state, _containerId, collectOpts());
    applyDocConnections(_canvas, collected?.entries || [], _options.showConnections);
  } else if (key === "includeGutters") {
    reconcileLive();
  } else {
    // Size-affecting options — regenerate thumbnails (debounced; the
    // sliders fire per step).
    if (_optionsTimer) clearTimeout(_optionsTimer);
    _optionsTimer = setTimeout(async () => {
      _optionsTimer = null;
      if (!_canvas || !_containerId) return;
      _themeCtx = makeThemeCtx();
      const collected = collectDesktopFiles(_state, _containerId, collectOpts());
      const token = _openToken;
      for (const entry of collected?.entries || []) {
        const thumb = await ensureDesktopThumb(_state, entry, _themeCtx);
        if (token !== _openToken || !_canvas) return;
        applyThumbToShape(entry.key, thumb);
      }
    }, 350);
  }
  scheduleSave();
}

// ── Persistence ─────────────────────────────────────────────────────

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; persistNow(); }, 800);
}

/** Serialize the canvas synchronously; the IDB write is fire-and-forget
 *  so close / switch never blocks on storage. fileRef dataUrls are
 *  stripped — the thumbnail cache rehydrates them on the next open. */
function persistNow() {
  if (!_canvas || !_containerId) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const st = _canvas.state;
  const shapes = st.shapes.map((s) => {
    if (s.type === "image" && s.fileRef) {
      const copy = { ...s, dataUrl: "" };
      delete copy.dataUrlDark;
      return copy;
    }
    return s;
  });
  const envelope = {
    version: 1,
    shapes,
    layers: st.layers,
    // The Desktop's only edges are the derived document-order arrows —
    // never persisted, always re-chained from the live file order.
    flowEdges: [],
    camera: { ...st.camera },
    options: { ..._options },
    ...(_background ? { background: _background } : {}),
    savedAt: Date.now(),
  };
  saveDesktopEnvelope(_containerId, envelope);
}

// ── Live reconcile + thumbnail refresh ──────────────────────────────

/** files-changed while open: drop thumbnails whose file vanished,
 *  refresh captions, grid in files that appeared. Thumbnail *content*
 *  refresh stays an open-time (or explicit Refresh) concern. */
async function reconcileLive() {
  // The open-time hydration owns the canvas until it lands; a
  // files-changed racing it would double-build the shape list.
  if (!_canvas || !_containerId || !_hydrated) return;
  const token = _openToken;
  const collected = collectDesktopFiles(_state, _containerId, collectOpts());
  // A container that can't be resolved right now is only fatal if the
  // tree is actually loaded — a mid-reload `files-changed` (multi-window
  // broadcast, background PDF sync) would otherwise drop the user onto
  // the "No file selected" pane with no warning.
  if (!collected) {
    if ((_state.fileTree || []).length) closeDesktop();
    return;
  }
  const st = _canvas.state;
  const byKey = new Map(collected.entries.map((e) => [e.key, e]));

  let changed = false;
  const present = new Set();
  let maxY = 0;
  let next = [];
  for (const s of st.shapes) {
    if (s.type === "image" && s.fileRef) {
      const entry = byKey.get(s.fileRef.key);
      if (!entry || present.has(s.fileRef.key)) { changed = true; continue; }
      present.add(s.fileRef.key);
      if (entry.name !== s.fileRef.name || !!entry.hasGutter !== !!s.fileRef.hasGutter
          || (entry.tint || "") !== (s.fileRef.tint || "")) {
        next.push({ ...s, name: entry.name, fileRef: { ...refOf(entry), ...keepRefFields(s.fileRef) } });
        changed = true;
      } else {
        next.push(s);
      }
    } else {
      next.push(s);
    }
    maxY = Math.max(maxY, shapeBottom(s));
  }

  const missing = collected.entries.filter((e) => !present.has(e.key));
  if (missing.length) {
    const thumbs = new Map();
    for (const entry of missing) {
      thumbs.set(entry.key, await ensureDesktopThumb(_state, entry, _themeCtx));
      if (token !== _openToken || !_canvas) return;
    }
    const rects = computeDesktopGrid(missing, thumbs, next.length ? maxY + DESKTOP_GRID_GAP : 0);
    for (const entry of missing) {
      next.push(newThumbShape(entry, rects.get(entry.key), thumbs.get(entry.key)));
    }
    changed = true;
  }

  // Order can change without the shape set changing at all (a sidebar
  // drag reorders the project's docs), so re-chain the connections
  // before the early-out.
  applyDocConnections(_canvas, collected.entries, _options.showConnections);

  if (!changed) return;
  next = normalizeDesktopStacks(next);
  const surviving = new Set(next.map((s) => s.id));
  st.shapes = next;
  st.selectedIds = new Set([...st.selectedIds].filter((id) => surviving.has(id)));
  st.recordHistory();
  st.notify("shapes");
  st.notify("selectedIds");
  // Shape ids changed (new files gridded in, dead ones dropped) — the
  // edges reference ids, so re-derive against the new array.
  applyDocConnections(_canvas, collected.entries, _options.showConnections);
  scheduleSave();
  // Entry set changed — refresh the shelf's deep-search index too.
  for (const key of [..._searchText.keys()]) if (!byKey.has(key)) _searchText.delete(key);
  buildSearchIndex(_state, collected.entries, _searchText, () => token === _openToken, collectOpts());
}

/** Swap one entry's thumbnail in place (PDF cover arriving, refresh,
 *  option changes). Display dims mirror the thumbnail's natural size. */
function applyThumbToShape(key, thumb) {
  if (!_canvas || !thumb) return;
  const st = _canvas.state;
  const cache = _canvas.getImageCache?.();
  let changed = false;
  st.shapes = st.shapes.map((s) => {
    if (s.type !== "image" || s.fileRef?.key !== key) return s;
    changed = true;
    const out = { ...s, dataUrl: thumb.dataUrl || thumb.url || "" };
    delete out.dataUrlDark;
    // Same shape id, new bytes — reload the decoded image in place (the
    // cache only auto-reloads on an appearance swap, so a content change
    // would otherwise keep showing the stale thumbnail).
    const cached = cache?.get(s.id);
    if (cached) cached.src = out.dataUrl;
    const fileRef = { ...s.fileRef };
    applyThumbRefFields(fileRef, thumb);
    out.fileRef = fileRef;
    if (thumb.w > 0 && thumb.h > 0) {
      out.width = thumb.w;
      out.height = thumb.h;
    }
    return out;
  });
  _outline?.setRows(key, thumb.outlineRows);
  if (changed) st.notify("shapes");
}

async function refreshEntryByFileId(fileId) {
  if (!_canvas || !_themeCtx || !_hydrated) return;
  const collected = collectDesktopFiles(_state, _containerId, collectOpts());
  const entry = collected?.entries.find((e) => e.fileId === fileId);
  if (!entry) return;
  applyThumbToShape(entry.key, await ensureDesktopThumb(_state, entry, _themeCtx));
}

/** Force-regenerate every thumbnail on the open Desktop — the command
 *  palette's "Refresh Desktop Thumbnails" and the Desktop settings
 *  button. */
export async function refreshDesktopThumbnails() {
  if (!_canvas || !_containerId || _refreshing || !_hydrated) return;
  const token = _openToken;
  _refreshing = true;
  try {
    const collected = collectDesktopFiles(_state, _containerId, collectOpts());
    for (const entry of collected?.entries || []) {
      evictSessionThumb(entry.key);
      const thumb = await ensureDesktopThumb(_state, entry, _themeCtx, { force: true });
      if (token !== _openToken) return;
      applyThumbToShape(entry.key, thumb);
    }
    applyDocConnections(_canvas, collected?.entries || [], _options.showConnections);
    scheduleSave();
  } finally {
    _refreshing = false;
  }
}
