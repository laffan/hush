/**
 * Shared module-level state for the pane subsystem. Lives in its own
 * module so the sibling files (pane-content, pane-persistence, pane-drag,
 * pane-size-popover) can read and mutate the same state without circular
 * imports against pane-manager.js.
 *
 * Reads happen via the live ES module bindings (e.g. `import { panes }
 * from "./pane-state.js"` then iterate). Writes go through setters so the
 * mutation surface stays explicit.
 */

export const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export const panes = new Map();       // id → pane object — live binding (mutable Map)

// Debug hook: paste `window.__hushDumpGutter()` into the console to dump
// every gutter pane's live state (camera, offset, headers, scroller
// rect, …). Kept lightweight so it's safe to leave in the production
// bundle; only fires when the user explicitly calls it.
if (typeof window !== "undefined") {
  window.__hushDumpGutter = () => {
    const out = [];
    for (const [, p] of panes) {
      if (!p.gutter) continue;
      const st = p.notebook?.state;
      const scroller = st?.gutterScrollDOM;
      const canvas = p._content?.querySelector("canvas");
      out.push({
        paneId: p.id,
        fileName: p.fileName,
        gutter: p.gutter,
        gutterSide: p.gutterSide,
        ownerContext: p.ownerContext,
        pane_xy: { x: p.x, y: p.y, w: p.width, h: p.height },
        _gutterOffset: p._gutterOffset,
        _gutterPadTop: p._gutterPadTop,
        gutterHeaders_len: p._gutterHeaders?.length ?? null,
        gutterHeaders_first3: p._gutterHeaders?.slice(0, 3) ?? null,
        shadowHeaders_len: st?.shadowHeaders?.length ?? null,
        shadowHeaders_first3: st?.shadowHeaders?.slice(0, 3) ?? null,
        camera: st?.camera ? { ...st.camera } : null,
        gutterCameraOffset: st?.gutterCameraOffset ?? null,
        scrollDOM_present: !!scroller,
        scroller_scrollTop: scroller?.scrollTop ?? null,
        scrollerRect: scroller?.getBoundingClientRect()?.toJSON?.() ?? null,
        paneRect: p.el?.getBoundingClientRect()?.toJSON?.() ?? null,
        canvasRect: canvas?.getBoundingClientRect()?.toJSON?.() ?? null,
        canvasClient: canvas
          ? { w: canvas.clientWidth, h: canvas.clientHeight, bw: canvas.width, bh: canvas.height }
          : null,
        editor_doc_lines: window.__hushState__?.editor?.view?.state?.doc?.lines ?? null,
      });
    }
    console.log("[hush gutter dump]", out);
    return out;
  };
}

export let activePaneId = null;
export function setActivePaneId(id) { activePaneId = id; }

export let zCounter = 1000;
export function bumpZCounter() { return ++zCounter; }

// Pin keeps a pane visible across context switches but doesn't claim
// its own z-band — every pane (pinned or not, doc / notebook / zotero)
// stacks by focus order. Kept exported as 0 so any legacy importers
// still resolve.
export const PINNED_Z_OFFSET = 0;
// Gutter panes ride below every other pane — they're chrome attached
// to the doc, not free-floating reference content.
export const GUTTER_Z = 100;
export function zForPane(pane) {
  if (pane && pane.gutter) return GUTTER_Z;
  return bumpZCounter();
}

export let containerEl = null;
export function setContainerEl(el) { containerEl = el; }

export let appState = null;
export function setAppState(s) { appState = s; }

export let autosaveTimer = null;
export function setAutosaveTimer(t) { autosaveTimer = t; }

export let syncing = false;
export function setSyncing(v) { syncing = v; }

// ── Lazy notebook bridge handle ──────────────────────────────────────
export let notebookBridge = null;
export async function getNotebookBridge() {
  if (!notebookBridge) {
    notebookBridge = await import("../notebook/notebook-bridge.js");
  }
  return notebookBridge;
}

// ── Geometry constants ───────────────────────────────────────────────
export const DEFAULT_WIDTH = 420;
export const DEFAULT_HEIGHT = 340;
export const MIN_WIDTH = 240;
export const MIN_HEIGHT = 60;
export const TITLEBAR_HEIGHT = 35;

/** Clamp a pane axis (x or y) so the pane is fully on-screen at the
 *  given viewport size. Falls back to 0 when the viewport is smaller
 *  than the pane — the user can still drag it. */
export function clampPaneAxis(requested, paneSize, viewportSize) {
  const max = Math.max(0, viewportSize - paneSize);
  return Math.min(max, Math.max(0, requested));
}
