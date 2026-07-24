/**
 * Desktop view — a visual overview of everything inside a desk or a
 * project, presented as a full notebook canvas of live file thumbnails
 * (see README "Desktops"). Follows the PDF Shelf's takeover pattern:
 * one host mounted into #app, toggled via the `desktop-active` body
 * class so the surfaces underneath keep their layout.
 *
 * Every file renders as an ImageShape carrying a `fileRef` marker —
 * drag / group / scale / undo all come free from the notebook engine,
 * while `fileRef` withholds delete + rename (the Desktop mirrors the
 * filesystem; files change only through the files sidebar). Thumbnails
 * generate on open for files whose cache went stale (desktop-thumbs.js)
 * and the arrangement persists per container as a stripped notebook
 * envelope (desktop-store.js). Deleted files vanish from the canvas on
 * the next files-changed; brand-new files grid in beneath the existing
 * content.
 */

import { escHtml } from "../sidebar/files-panel-shared.js";
import {
  collectDesktopFiles, findDesktopContainer, desktopScopeName,
} from "./desktop-files.js";
import {
  ensureDesktopThumb, computeDesktopGrid, themeSigOf,
  evictSessionThumb, DESKTOP_GRID_GAP, loadFileContent,
} from "./desktop-thumbs.js";
import { loadDesktopEnvelope, saveDesktopEnvelope } from "./desktop-store.js";

let _host = null;
let _canvasHost = null;
let _state = null;
let _containerId = null;
let _canvas = null;
let _themeCtx = null;
let _openToken = 0;
let _saveTimer = null;
let _reconcileTimer = null;
let _hoverCleanup = null;
let _canvasListenersCleanup = null;
let _background = null; // per-desktop bg override cached from the popup event
let _refreshing = false;
let _hydrated = false; // true once the open-time thumbnail pass landed
// fileRef key → deep search text (doc body, notebook text, PDF metadata
// + annotations). Read by the shape shelf via window.__hushDesktopSearchText
// so its search box reaches file *contents*, not just filenames.
const _searchText = new Map();

export function isDesktopOpen() {
  return !!_containerId;
}

export function currentDesktopContainerId() {
  return _containerId;
}

function initDesktop(state) {
  if (_host) return;
  _state = state;
  // Deep-search hook for the shape shelf: while a Desktop is mounted,
  // shelf rows for file thumbnails search the file's content too.
  window.__hushDesktopSearchText = (key) => _searchText.get(key) || "";
  _host = document.createElement("div");
  _host.id = "desktop-view";
  _host.className = "desktop-view hidden";
  document.getElementById("app")?.appendChild(_host);

  // Any single-file open replaces the Desktop, exactly like the PDF
  // shelf (the hover Open buttons land here via these events too).
  const close = () => closeDesktop();
  state.on("file-opened", close);
  state.on("notebook-open", close);
  state.on("pdf-open", close);
  state.on("stack-open", close);
  state.on("multi-select-changed", () => {
    if ((state.selectedDocIds || []).length >= 2) closeDesktop();
  });
  // Filesystem is the source of truth: deleted files disappear from the
  // canvas, new files grid in, renames re-caption. Container gone → close.
  state.on("files-changed", () => {
    if (!_containerId) return;
    if (!findDesktopContainer(state, _containerId)) { closeDesktop(); return; }
    if (_reconcileTimer) clearTimeout(_reconcileTimer);
    _reconcileTimer = setTimeout(() => { _reconcileTimer = null; reconcileLive(); }, 300);
  });
  // A PDF cover landing from a background download swaps its
  // placeholder card in place.
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

  // A style / theme switch while the Desktop is open repaints the
  // canvas chrome; thumbnails re-render on the next open (or an
  // explicit Refresh) since their cache signature includes the theme.
  state.on("settings-changed", async () => {
    if (!_canvas || !_containerId) return;
    const { computeNotebookSettings } = await import("../notebook/notebook-style-settings.js");
    const nbSettings = computeNotebookSettings(state, null);
    const sig = themeSigOf(nbSettings);
    if (_themeCtx && _themeCtx.sig === sig) return;
    if (!_canvas) return;
    _canvas.applySettings({
      ...nbSettings,
      ...(_background
        ? { backgroundPattern: _background.pattern, gridSpacing: _background.spacing, gridOpacity: _background.opacity }
        : { backgroundPattern: "blank", gridOpacity: 0 }),
    });
    _themeCtx = {
      theme: _canvas.state.theme,
      fontFamily: _canvas.state.fontFamily,
      appearance: nbSettings.appearanceMode,
      canvasBackgroundOverride: nbSettings.canvasBackgroundOverride || "",
      sig,
    };
  });

  document.addEventListener("notebook-bg-changed", (e) => {
    const d = e.detail || {};
    if (!_canvas || !d.state || d.state !== _canvas.state) return;
    _background = { pattern: d.pattern, spacing: d.spacing, opacity: d.opacity };
    scheduleSave();
  });
}

/** Open the Desktop for a desk id or project node id. */
export async function openDesktop(state, containerId) {
  if (!_host) initDesktop(state);
  _state = state;
  if (!findDesktopContainer(state, containerId)) return;
  if (_containerId === containerId) return;
  if (_containerId) {
    // Switching container (e.g. drilling into a project's Desktop from
    // the desk one): persist the outgoing layout first.
    persistNow();
    teardownCanvas();
  }
  if (state.selectedDocIds?.length) state.clearSelectedDocs();
  import("../pdf/pdf-shelf.js").then((m) => m.closePdfShelf()).catch(() => {});

  _containerId = containerId;
  _background = null;
  document.body.classList.add("desktop-active");
  _host.classList.remove("hidden");
  renderChrome();
  await mountCanvas();
}

export function closeDesktop() {
  if (!_containerId) return;
  persistNow();
  teardownCanvas();
  _containerId = null;
  _openToken++;
  document.body.classList.remove("desktop-active");
  if (_host) {
    _host.classList.add("hidden");
    _host.innerHTML = "";
  }
  _canvasHost = null;
}

// ── Chrome ──────────────────────────────────────────────────────────

function renderChrome() {
  _host.innerHTML = `
    <header class="desktop-header">
      <span class="desktop-scope">${escHtml(desktopScopeName(_state, _containerId))}</span>
      <span class="desktop-header-note">Desktop</span>
      <span class="desktop-header-actions">
        <button type="button" class="desktop-btn" data-desktop-refresh>Refresh Thumbnails</button>
        <button type="button" class="desktop-btn" data-desktop-close>Close</button>
      </span>
    </header>
    <div class="desktop-canvas-host"></div>
  `;
  _host.querySelector("[data-desktop-close]").addEventListener("click", () => closeDesktop());
  _host.querySelector("[data-desktop-refresh]").addEventListener("click", () => refreshDesktopThumbnails());
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

// ── Canvas lifecycle ────────────────────────────────────────────────

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
  // No flowchart on Desktops (for now): file thumbnails aren't chart
  // nodes, so drop-to-connect / ⌘→ edge creation stays off.
  _canvas.state.flowchartEnabled = false;
  // The toolbar starts parked at the bottom and minimized — a Desktop
  // leads with the thumbnails; the tools are one handle-click away.
  _canvas.state.setDrawingToolbarPosition("bottom");
  _canvas.state.setDrawingToolbarMinimized(true);
  const nbSettings = computeNotebookSettings(state, null);
  // Desktops default to the blank background; a per-desktop override
  // from the bg-settings popup is applied after the envelope loads.
  _canvas.applySettings({ ...nbSettings, backgroundPattern: "blank", gridOpacity: 0 });
  _themeCtx = {
    theme: _canvas.state.theme,
    fontFamily: _canvas.state.fontFamily,
    appearance: nbSettings.appearanceMode,
    canvasBackgroundOverride: nbSettings.canvasBackgroundOverride || "",
    sig: themeSigOf(nbSettings),
  };

  const collected = collectDesktopFiles(state, _containerId);
  const envelope = await loadDesktopEnvelope(_containerId);
  if (token !== _openToken) return;
  if (envelope?.background) {
    _background = envelope.background;
    _canvas.applySettings({
      backgroundPattern: _background.pattern,
      gridSpacing: _background.spacing,
      gridOpacity: _background.opacity,
    });
  }

  // Generate / refresh thumbnails for everything on this Desktop. Files
  // whose cache signature still matches come back instantly; stale and
  // new files render now — this is the "thumbnails update when the
  // Desktop opens" pass.
  const entries = collected?.entries || [];
  const thumbs = new Map();
  for (const entry of entries) {
    thumbs.set(entry.key, await ensureDesktopThumb(state, entry, _themeCtx));
    if (token !== _openToken) return;
  }

  const shapes = buildShapes(envelope, entries, thumbs);
  _canvas.loadShapes(shapes, envelope?.layers?.length ? envelope.layers : undefined);
  // Flowchart edges are intentionally not restored — the feature is
  // deactivated on Desktops (see flowchartEnabled above).

  requestAnimationFrame(() => {
    if (token !== _openToken || !_canvas) return;
    if (envelope?.camera && typeof envelope.camera.zoom === "number") {
      _canvas.state.camera = { ...envelope.camera };
    } else {
      _canvas.state.camera = fitCamera();
    }
    _canvas.state.notify("camera");
    _canvas.state.rebasePinAnchor?.();
  });

  attachCanvasListeners();
  setLoading(false);
  _hydrated = true;
  buildSearchIndex(state, entries, token);
}

function teardownCanvas() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_reconcileTimer) { clearTimeout(_reconcileTimer); _reconcileTimer = null; }
  if (_hoverCleanup) { _hoverCleanup(); _hoverCleanup = null; }
  if (_canvasListenersCleanup) { _canvasListenersCleanup(); _canvasListenersCleanup = null; }
  if (_canvas) { _canvas.destroy(); _canvas = null; }
  _themeCtx = null;
  _refreshing = false;
  _hydrated = false;
  _searchText.clear();
}

function attachCanvasListeners() {
  const onChange = () => scheduleSave();
  _canvasHost.addEventListener("notebook-change", onChange);
  _canvasHost.addEventListener("notebook-camera-change", onChange);
  const host = _canvasHost;
  _canvasListenersCleanup = () => {
    host.removeEventListener("notebook-change", onChange);
    host.removeEventListener("notebook-camera-change", onChange);
  };
  import("./desktop-hover.js").then((m) => {
    if (!_canvas || !_canvasHost) return;
    _hoverCleanup = m.attachDesktopHover(_canvasHost, _canvas, {
      onOpen: openFileRef,
      onSecondary: openFileRefSecondary,
    });
  });
}

// ── Shelf deep-search index ─────────────────────────────────────────

/** Build the per-file search text the shape shelf reads through
 *  `window.__hushDesktopSearchText`: doc bodies, notebook text-shape
 *  contents, PDF metadata + bookmark names + cached Zotero annotation
 *  text. Fire-and-forget — the shelf reads the map live at query time,
 *  so entries land as they resolve. */
async function buildSearchIndex(state, entries, token) {
  for (const entry of entries) {
    if (token !== _openToken) return;
    let text = entry.name || "";
    try {
      if (entry.kind === "doc") {
        text += "\n" + (await loadFileContent(state, entry.fileId));
      } else if (entry.kind === "notebook") {
        const { extractSnapshotText } = await import("../sidebar/notebook-snapshot-preview.js");
        text += "\n" + extractSnapshotText(await loadFileContent(state, entry.fileId));
      } else if (entry.kind === "pdf") {
        const { getPdfMeta, getPdfBookmarks } = await import("../sync/pdf-sync.js");
        const meta = getPdfMeta(entry.fileId);
        const parts = [meta?.title, meta?.authors, meta?.year];
        for (const bm of getPdfBookmarks(entry.fileId)) parts.push(bm.name);
        if (meta?.zoteroAttKey) {
          const { getCachedAnnotations } = await import("../zotero-annotations.js");
          const annots = await getCachedAnnotations(meta.zoteroAttKey).catch(() => []);
          for (const a of annots) parts.push([a.text, a.comment].filter(Boolean).join(" "));
        }
        text += "\n" + parts.filter(Boolean).join("\n");
      } else if (entry.kind === "project") {
        const collected = collectDesktopFiles(state, entry.nodeId);
        text += "\n" + (collected?.entries || []).map((e) => e.name).join("\n");
      }
    } catch { /* best effort — the name alone still matches */ }
    if (token !== _openToken) return;
    _searchText.set(entry.key, text);
  }
}

// ── Shape reconstruction ────────────────────────────────────────────

/** Merge the saved envelope with the live file list: saved thumbnails
 *  keep their position / size / grouping, dead ones drop out, new files
 *  grid in below the existing content, user-added shapes (text, drag
 *  areas, strokes) pass through untouched. */
function buildShapes(envelope, entries, thumbs) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const seen = new Set();
  const shapes = [];
  let maxY = 0;
  let hasSaved = false;

  for (const s of envelope?.shapes || []) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "image" && s.fileRef) {
      const entry = byKey.get(s.fileRef.key);
      if (!entry || seen.has(entry.key)) continue; // deleted file / duplicate
      seen.add(entry.key);
      shapes.push(hydrateShape(s, entry, thumbs.get(entry.key)));
    } else {
      shapes.push(s);
    }
    hasSaved = true;
    const b = shapeBottom(s);
    if (b > maxY) maxY = b;
  }

  const missing = entries.filter((e) => !seen.has(e.key));
  if (missing.length) {
    const startY = hasSaved ? maxY + DESKTOP_GRID_GAP : 0;
    const rects = computeDesktopGrid(missing, thumbs, startY);
    for (const entry of missing) {
      const rect = rects.get(entry.key);
      const t = thumbs.get(entry.key) || { w: 220, h: 280 };
      shapes.push({
        id: crypto.randomUUID(),
        type: "image",
        position: { x: rect?.x ?? 0, y: rect?.y ?? startY },
        width: rect?.w ?? t.w,
        height: rect?.h ?? t.h,
        dataUrl: t.dataUrl || t.url || "",
        name: entry.name,
        color: "#000000",
        fileRef: refOf(entry),
      });
    }
  }
  return shapes;
}

function refOf(entry) {
  return { key: entry.key, kind: entry.kind, fileId: entry.fileId, nodeId: entry.nodeId, name: entry.name };
}

/** Re-arm a persisted fileRef shape with its (possibly regenerated)
 *  thumbnail. Keeps the user's width; height follows the thumbnail's
 *  current aspect so a grown notebook doesn't render squashed. */
function hydrateShape(s, entry, thumb) {
  const out = { ...s, name: entry.name, fileRef: refOf(entry) };
  if (thumb) {
    out.dataUrl = thumb.dataUrl || thumb.url || "";
    if (thumb.w > 0 && thumb.h > 0 && out.width > 0) {
      const newH = out.width * (thumb.h / thumb.w);
      if (Math.abs(newH - out.height) > 1) out.height = newH;
    }
  }
  return out;
}

function shapeBottom(s) {
  if (s.type === "draw" && Array.isArray(s.points)) {
    let m = 0;
    for (const p of s.points) if (p.y > m) m = p.y;
    return m;
  }
  const h = s.height || 0;
  return (s.position?.y || 0) + h + (s.fileRef ? 24 : 0);
}

function fitCamera() {
  const st = _canvas.state;
  const w = _canvasHost.clientWidth || 800;
  const h = _canvasHost.clientHeight || 600;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of st.shapes) {
    if (s.pocketed) continue;
    const x = s.position?.x ?? 0, y = s.position?.y ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (s.width || 0));
    maxY = Math.max(maxY, y + (s.height || 0) + 24);
  }
  if (!Number.isFinite(minX)) return { x: 60, y: 60, zoom: 1 };
  const pad = 60;
  const zoom = Math.max(0.25, Math.min(1,
    (w - pad * 2) / Math.max(1, maxX - minX),
    (h - pad * 2) / Math.max(1, maxY - minY)));
  return {
    x: (w - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: Math.max(20, (h - (maxY - minY) * zoom) / 2) - minY * zoom,
    zoom,
  };
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
    flowEdges: st.flowchart.serialize(),
    camera: { ...st.camera },
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
  const collected = collectDesktopFiles(_state, _containerId);
  if (!collected) { closeDesktop(); return; }
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
      if (entry.name !== s.fileRef.name) {
        next.push({ ...s, name: entry.name, fileRef: refOf(entry) });
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
      const rect = rects.get(entry.key);
      const t = thumbs.get(entry.key);
      next.push({
        id: crypto.randomUUID(), type: "image",
        position: { x: rect?.x ?? 0, y: rect?.y ?? maxY + DESKTOP_GRID_GAP },
        width: rect?.w ?? t.w, height: rect?.h ?? t.h,
        dataUrl: t.dataUrl || t.url || "", name: entry.name,
        color: "#000000", fileRef: refOf(entry),
      });
    }
    changed = true;
  }

  if (!changed) return;
  const surviving = new Set(next.map((s) => s.id));
  st.shapes = next;
  st.selectedIds = new Set([...st.selectedIds].filter((id) => surviving.has(id)));
  st.recordHistory();
  st.notify("shapes");
  st.notify("selectedIds");
  scheduleSave();
  // Entry set changed — refresh the shelf's deep-search index too.
  for (const key of [..._searchText.keys()]) if (!byKey.has(key)) _searchText.delete(key);
  buildSearchIndex(_state, collected.entries, token);
}

/** Swap one entry's thumbnail in place (PDF cover arriving, refresh). */
function applyThumbToShape(key, thumb) {
  if (!_canvas || !thumb) return;
  const st = _canvas.state;
  let changed = false;
  st.shapes = st.shapes.map((s) => {
    if (s.type !== "image" || s.fileRef?.key !== key) return s;
    changed = true;
    const out = { ...s, dataUrl: thumb.dataUrl || thumb.url || "" };
    delete out.dataUrlDark;
    if (thumb.w > 0 && thumb.h > 0 && out.width > 0) {
      const newH = out.width * (thumb.h / thumb.w);
      if (Math.abs(newH - out.height) > 1) out.height = newH;
    }
    return out;
  });
  if (changed) st.notify("shapes");
}

async function refreshEntryByFileId(fileId) {
  if (!_canvas || !_themeCtx || !_hydrated) return;
  const collected = collectDesktopFiles(_state, _containerId);
  const entry = collected?.entries.find((e) => e.fileId === fileId);
  if (!entry) return;
  applyThumbToShape(entry.key, await ensureDesktopThumb(_state, entry, _themeCtx));
}

/** Force-regenerate every thumbnail on the open Desktop — the command
 *  palette's "Refresh Desktop Thumbnails" and the header button. */
export async function refreshDesktopThumbnails() {
  if (!_canvas || !_containerId || _refreshing || !_hydrated) return;
  const token = _openToken;
  const btn = _host?.querySelector("[data-desktop-refresh]");
  _refreshing = true;
  if (btn) { btn.textContent = "Refreshing…"; btn.disabled = true; }
  try {
    const collected = collectDesktopFiles(_state, _containerId);
    for (const entry of collected?.entries || []) {
      evictSessionThumb(entry.key);
      const thumb = await ensureDesktopThumb(_state, entry, _themeCtx, { force: true });
      if (token !== _openToken) return;
      applyThumbToShape(entry.key, thumb);
    }
    scheduleSave();
  } finally {
    _refreshing = false;
    if (btn && token === _openToken) { btn.textContent = "Refresh Thumbnails"; btn.disabled = false; }
  }
}

// ── Hover actions ───────────────────────────────────────────────────

function openFileRef(ref) {
  const state = _state;
  if (!ref) return;
  if (ref.kind === "project") { state.openProject(ref.nodeId); return; }
  if (ref.kind === "doc") { state.openFile(ref.fileId); return; }
  if (ref.kind === "notebook") { state.openNotebook(ref.fileId); return; }
  if (ref.kind === "stack") { state.openStack(ref.fileId); return; }
  if (ref.kind === "pdf") {
    import("../sync/pdf-sync.js").then(({ isPdfDownloaded }) => {
      if (isPdfDownloaded(ref.fileId)) state.openPdf(ref.fileId);
    });
  }
}

async function openFileRefSecondary(ref, ev) {
  if (!ref) return;
  if (ref.kind === "project") {
    // Drill into the project's own Desktop.
    await openDesktop(_state, ref.nodeId);
    return;
  }
  const typeMap = { doc: "document", notebook: "notebook", pdf: "pdf", stack: "stack" };
  const { createPane } = await import("../pane/pane-manager.js");
  createPane(ref.fileId, ref.name, typeMap[ref.kind] || "document", ev?.clientX ?? 200, ev?.clientY ?? 120);
}
