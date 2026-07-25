/**
 * A project Desktop mounted inside a floating pane.
 *
 * The full-window Desktop (desktop-view.js) is a singleton takeover —
 * one host, one canvas, one container id — so a nested project can't
 * simply open a second copy of it. This is the pane-sized counterpart:
 * the same thumbnails, the same derived document-order connections, the
 * same stored layout, in a pane you can park beside the parent Desktop.
 * It's deliberately the *reading* half of a Desktop — no per-Desktop
 * options flyout, no doc-outline columns, no thumbnail stacking — with
 * the two things a reference view needs: pan / zoom, and double-click
 * to open.
 *
 * Layout edits (dragging a thumbnail) do write back to the shared
 * envelope so the pane and the full Desktop stay in agreement, but the
 * stored camera is left alone — a pane's viewport is nothing like a
 * full window's, and the full Desktop should reopen where the user left
 * *it*.
 *
 * Mounted through the pane system's custom-type hook, the same way the
 * Zotero highlight pane is (`pane-content.js#loadPaneContent`), with
 * `pane.fileId` holding the project's *node* id.
 */

import { collectDesktopFiles, findDesktopContainer } from "./desktop-files.js";
import { ensureDesktopThumb } from "./desktop-thumbs.js";
import { buildShapes, fitCameraFor } from "./desktop-content.js";
import { loadDesktopEnvelope, saveDesktopEnvelope } from "./desktop-store.js";
import { initDesktopConnections, applyDocConnections } from "./desktop-connections.js";
import { openFileRef } from "./desktop-open.js";
import { screenToCanvas } from "../notebook/utils.ts";
import { findShapeAtPoint } from "../notebook/state-helpers.ts";

/** Matches the takeover's default so a Desktop reads the same at either
 *  size (desktop-view.js's DESKTOP_BG_DEFAULT). */
const BG = { backgroundPattern: "grid", gridSpacing: 25, gridOpacity: 0.2 };

/** Thumbnails always bake in light mode — see desktop-view's makeThemeCtx. */
function makeThemeCtx(canvas, options) {
  const theme = canvas.state.themeForVariant("light");
  const fontFamily = canvas.state.fontFamily;
  return {
    theme, fontFamily, appearance: "light", canvasBackgroundOverride: "",
    docFontSize: options.docFontSize, longEdge: options.thumbLongEdge,
    sig: ["light", theme.canvasBackground, theme.foreground, theme.headingColor,
      fontFamily, `f${options.docFontSize}`, `L${options.thumbLongEdge}`].join("|"),
  };
}

/** (Re-)apply a Desktop pane's background — the project's saved override
 *  or the Desktop default. Called on mount and after any theme / style
 *  sync, which repaints every `pane.notebook` from the notebook settings
 *  and would otherwise leave this canvas on the notebook's own grid. */
export function applyDesktopPaneBackground(pane) {
  const bg = pane?._desktopBg;
  pane?.notebook?.applySettings(bg
    ? { backgroundPattern: bg.pattern, gridSpacing: bg.spacing, gridOpacity: bg.opacity }
    : { ...BG });
}

export async function mountDesktopPane(pane, state) {
  const containerId = pane.fileId;
  if (!findDesktopContainer(state, containerId)) return;
  // Mount straight into the pane body, exactly like a notebook pane —
  // floating-pane.css already sizes a bare canvas child.
  const host = pane._content;

  const { NotesCanvas } = await import("../notebook/notes-canvas.ts");
  const { computeNotebookSettings } = await import("../notebook/notebook-style-settings.js");
  if (!host.isConnected) return;

  const canvas = new NotesCanvas(host, {});
  // Every async step below re-checks this: a pane closed (or had its
  // content swapped) mid-hydration must not keep writing to the canvas.
  const alive = () => pane.notebook === canvas && host.isConnected;
  // Same per-canvas switches the takeover sets: no chart authoring, no
  // option-drag clones, derived + locked connections.
  canvas.state.flowchartEnabled = false;
  canvas.state.altDuplicateEnabled = false;
  canvas.state.desktopMode = true;
  initDesktopConnections(canvas);
  canvas.state.setDrawingToolbarMinimized(true);
  canvas.applySettings({ ...computeNotebookSettings(state, null), ...BG });
  // Held on `pane.notebook` so the pane system's generic teardown and
  // theme sync pick it up for free; every notebook-*specific* save /
  // mirror path is gated on `fileType === "notebook"`, which this isn't.
  pane.notebook = canvas;

  const envelope = await loadDesktopEnvelope(containerId);
  if (!alive()) return;
  const options = {
    docFontSize: envelope?.options?.docFontSize ?? 8,
    thumbLongEdge: envelope?.options?.thumbLongEdge ?? 400,
    showConnections: envelope?.options?.showConnections !== false,
  };
  const themeCtx = makeThemeCtx(canvas, options);
  // Parked on the pane so a later theme sync can put it back: that pass
  // re-applies the *notebook* settings to every `pane.notebook`, which
  // would otherwise reset this canvas to the notebook default grid.
  pane._desktopBg = envelope?.background || null;
  applyDesktopPaneBackground(pane);

  const entries = collectDesktopFiles(state, containerId)?.entries || [];
  const thumbs = new Map();
  for (const entry of entries) {
    // Outline columns are a takeover affordance — a pane is too small to
    // read one, and it would double the thumbnail's width.
    entry.outline = false;
    thumbs.set(entry.key, await ensureDesktopThumb(state, entry, themeCtx));
    if (!alive()) return;
  }

  canvas.loadShapes(
    buildShapes(envelope, entries, thumbs),
    envelope?.layers?.length ? envelope.layers : undefined,
  );
  applyDocConnections(canvas, entries, options.showConnections);
  requestAnimationFrame(() => {
    if (!alive()) return;
    canvas.state.camera = fitCameraFor(
      canvas.state.shapes, host.clientWidth || 400, host.clientHeight || 300);
    canvas.state.notify("camera");
    canvas.state.rebasePinAnchor?.();
  });

  attachOpenGesture(host, canvas, state);
  attachPersist(host, canvas, containerId, alive);
}

/** Persist shape / layer moves back into the shared envelope, keeping
 *  the stored camera (and everything else the takeover owns) intact —
 *  a pane's viewport is not the Desktop's viewport. */
function attachPersist(host, canvas, containerId, alive) {
  let timer = null;
  const flush = async () => {
    timer = null;
    if (!alive()) return;
    const prev = (await loadDesktopEnvelope(containerId)) || { version: 1 };
    const shapes = canvas.state.shapes.map((s) => {
      if (s.type !== "image" || !s.fileRef) return s;
      const copy = { ...s, dataUrl: "" };
      delete copy.dataUrlDark;
      return copy;
    });
    saveDesktopEnvelope(containerId, {
      ...prev, shapes, layers: canvas.state.layers, flowEdges: [], savedAt: Date.now(),
    });
  };
  host.addEventListener("notebook-change", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 800);
  });
}

/** Double-click (mouse) / double-tap (touch) a thumbnail to open it —
 *  the same gesture the takeover uses, including the multi-touch guard
 *  that keeps a two-finger pan from reading as a tap pair. */
function attachOpenGesture(host, canvas, state) {
  const st = canvas.state;
  const thumbAt = (clientX, clientY) => {
    if (st.tool !== "select") return null;
    const rect = host.getBoundingClientRect();
    const world = screenToCanvas({ x: clientX - rect.left, y: clientY - rect.top }, st.camera);
    const hit = findShapeAtPoint(world, st.shapes, st.fontFamily);
    return hit && hit.type === "image" && hit.fileRef && !hit.pocketed ? hit : null;
  };
  let lastOpenAt = 0;
  const openAt = (clientX, clientY) => {
    if (Date.now() - lastOpenAt < 600) return;
    const shape = thumbAt(clientX, clientY);
    if (!shape) return;
    lastOpenAt = Date.now();
    // A nested project inside the pane drills the *takeover* into it —
    // panes within panes are more confusion than they're worth.
    openFileRef(state, shape.fileRef, (nodeId) => {
      import("./desktop-view.js").then((m) => m.openDesktop(state, nodeId));
    });
  };
  host.addEventListener("dblclick", (e) => openAt(e.clientX, e.clientY));

  const live = new Set();
  let multi = false;
  let lastTap = 0, lastX = 0, lastY = 0;
  host.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    if (!live.size) multi = false;
    live.add(e.pointerId);
    if (live.size > 1) { multi = true; lastTap = 0; }
  });
  host.addEventListener("pointercancel", (e) => live.delete(e.pointerId));
  host.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    const wasMulti = multi || live.size > 1;
    live.delete(e.pointerId);
    if (wasMulti) return;
    const now = Date.now();
    if (now - lastTap < 400 && Math.abs(e.clientX - lastX) < 24 && Math.abs(e.clientY - lastY) < 24) {
      lastTap = 0;
      openAt(e.clientX, e.clientY);
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
  });
}
