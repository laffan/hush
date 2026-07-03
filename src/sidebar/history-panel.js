/**
 * History panel — UI over the session journal (state/history-journal.js).
 *
 * A slim floating panel pinned to the right edge listing the last 100
 * workspace states, newest first. Hovering a row paints the **blue
 * preview overlay**: a ghost of that recorded state — the open surface
 * labelled in the centre, plus an outlined rectangle for every pane at
 * its recorded position — signalling "this is a state you can return
 * to". Clicking a row restores it (surface + pane layout + scroll /
 * camera / focus). Esc or × closes.
 *
 * Deliberately NOT a modal: the workspace stays visible behind the
 * overlay so the ghost rectangles line up with real geometry.
 */

import { getJournalEntries, restoreJournalEntry } from "../state/history-journal.js";

let panelEl = null;
let overlayEl = null;
let keyHandler = null;
let journalListener = null;
let panelState = null;

export function toggleHistoryPanel(state) {
  if (panelEl) { closeHistoryPanel(); return; }
  openHistoryPanel(state);
}

export function openHistoryPanel(state) {
  if (panelEl) return;
  panelState = state;
  panelEl = document.createElement("div");
  panelEl.className = "history-panel";
  panelEl.innerHTML = `
    <div class="history-panel-header">
      <span class="history-panel-title">History</span>
      <button class="history-panel-close" title="Close">×</button>
    </div>
    <div class="history-panel-hint">Hover to preview · click to return</div>
    <div class="history-panel-list"></div>
  `;
  document.body.appendChild(panelEl);
  panelEl.querySelector(".history-panel-close").addEventListener("click", closeHistoryPanel);

  keyHandler = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeHistoryPanel(); }
  };
  document.addEventListener("keydown", keyHandler, true);

  journalListener = () => renderList();
  state.on("history-journal-changed", journalListener);

  renderList();
}

export function closeHistoryPanel() {
  removeOverlay();
  if (keyHandler) { document.removeEventListener("keydown", keyHandler, true); keyHandler = null; }
  if (journalListener && panelState) { panelState.off("history-journal-changed", journalListener); journalListener = null; }
  if (panelEl) { panelEl.remove(); panelEl = null; }
  panelState = null;
}

function renderList() {
  if (!panelEl) return;
  const listEl = panelEl.querySelector(".history-panel-list");
  const entries = getJournalEntries();
  listEl.innerHTML = "";
  if (!entries.length) {
    listEl.innerHTML = `<div class="history-panel-empty">Nothing recorded yet.</div>`;
    return;
  }
  // Newest first.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const row = document.createElement("div");
    row.className = `history-row history-row-${entry.type}`;
    if (i === entries.length - 1) row.classList.add("history-row-current");
    row.innerHTML = `
      <span class="history-row-time">${formatTime(entry.timestamp)}</span>
      <span class="history-row-label"></span>
    `;
    row.querySelector(".history-row-label").textContent = entry.label;
    row.addEventListener("mouseenter", () => showOverlay(entry));
    row.addEventListener("mouseleave", () => removeOverlay());
    row.addEventListener("click", () => {
      removeOverlay();
      const state = panelState;
      closeHistoryPanel();
      if (state) restoreJournalEntry(state, entry).catch((e) => console.error("History restore failed:", e));
    });
    listEl.appendChild(row);
  }
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

// ── Blue preview overlay ─────────────────────────────────────────────

function showOverlay(entry) {
  removeOverlay();
  if (!entry?.state) return;
  overlayEl = document.createElement("div");
  overlayEl.className = "history-preview-overlay";

  const surface = entry.state.surface || { kind: "empty" };
  const container = document.getElementById("pane-container");
  const base = container ? container.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  // Base-document ghost FIRST so the pane rectangles stack over it the
  // way real panes stacked over the real document — the preview is a
  // picture of the whole recorded workspace, not just the panes.
  renderBaseGhost(entry, surface, base);

  // Only panes that were actually on screen in this snapshot — the
  // journal records the full pane set (other documents' panes ride
  // along hidden, and restore needs them all), but the ghost must show
  // exactly what the user saw. Entries recorded before the `visible`
  // stamp existed have no flag; treat those as visible.
  const visiblePanes = (entry.state.panes || []).filter((p) => p && p.visible !== false);

  const card = document.createElement("div");
  card.className = "history-preview-card";
  const inlineCount = visiblePanes.filter((p) => p.inline).length;
  card.innerHTML = `
    <span class="history-preview-kind">${kindLabel(surface.kind)}</span>
    <span class="history-preview-name"></span>
    <span class="history-preview-meta"></span>
  `;
  card.querySelector(".history-preview-name").textContent = surface.name || "No file";
  card.querySelector(".history-preview-meta").textContent =
    `${formatTime(entry.timestamp)}${inlineCount ? ` · ${inlineCount} inline pane${inlineCount === 1 ? "" : "s"}` : ""}`;
  overlayEl.appendChild(card);

  // Ghost rectangles for every pane visible in the snapshot, positioned
  // against the live pane container so they land where they actually sat.
  for (const p of visiblePanes) {
    if (p.inline) continue;
    const rect = paneGhostRect(p, base);
    if (!rect) continue;
    const ghost = document.createElement("div");
    ghost.className = "history-preview-pane" + (p.docked ? " docked" : "");
    Object.assign(ghost.style, {
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`,
    });
    const label = document.createElement("div");
    label.className = "history-preview-pane-label";
    label.textContent = p.fileName || "Untitled";
    ghost.appendChild(label);
    overlayEl.appendChild(ghost);
  }
  document.body.appendChild(overlayEl);
}

function kindLabel(kind) {
  switch (kind) {
    case "doc": case "localsync-doc": return "Document";
    case "project": return "Project";
    case "notebook": return "Notebook";
    case "stack": return "Stack";
    case "pdf": return "PDF";
    default: return "Empty";
  }
}

/** Paint the recorded base document into the overlay: doc surfaces get
 *  their captured buffer text laid out as a blue editor column (scrolled
 *  to the recorded offset); notebooks get their captured shapes rendered
 *  to a canvas at the recorded camera, under a blue wash. Both fill the
 *  workspace area so pane ghosts stack over them like the real thing. */
function renderBaseGhost(entry, surface, base) {
  const rectStyle = {
    left: `${Math.round(base.left)}px`,
    top: `${Math.round(base.top)}px`,
    width: `${Math.round(base.width)}px`,
    height: `${Math.round(base.height)}px`,
  };

  const isDocKind = surface.kind === "doc" || surface.kind === "localsync-doc" || surface.kind === "project";
  if (isDocKind && typeof entry.state.docText === "string") {
    const layer = document.createElement("div");
    layer.className = "history-preview-doc";
    Object.assign(layer.style, rectStyle);
    const column = document.createElement("div");
    column.className = "history-preview-doc-column";
    // Match the live editor's column width so the ghost's line measure
    // reads like the page the user remembers.
    const liveContent = document.querySelector("#editor-container .cm-content");
    if (liveContent && liveContent.clientWidth) column.style.maxWidth = `${liveContent.clientWidth}px`;
    // Project buffers join docs with a machine separator line — swap it
    // for the dashed rule the editor renders in its place.
    column.textContent = entry.state.docText.replace(/---hush-separator---/g, "— — — — —");
    if (typeof entry.state.scrollTop === "number" && entry.state.scrollTop > 0) {
      column.style.transform = `translateY(-${Math.round(entry.state.scrollTop)}px)`;
    }
    layer.appendChild(column);
    overlayEl.appendChild(layer);
    return;
  }

  if (surface.kind === "notebook" && entry.state.notebook) {
    const canvas = document.createElement("canvas");
    canvas.className = "history-preview-canvas";
    Object.assign(canvas.style, rectStyle);
    overlayEl.appendChild(canvas);
    const wash = document.createElement("div");
    wash.className = "history-preview-wash";
    Object.assign(wash.style, rectStyle);
    overlayEl.appendChild(wash);
    // Async render (the notebook renderer lives in its own chunk); the
    // overlay may have been dismissed by the time it resolves.
    const myOverlay = overlayEl;
    Promise.all([
      import("./notebook-snapshot-preview.js"),
      import("../notebook/notebook-bridge.js"),
    ]).then(([{ renderShapesPreview }, { getCanvasInstance }]) => {
      if (overlayEl !== myOverlay || !canvas.isConnected) return;
      renderShapesPreview(canvas, entry.state.notebook, getCanvasInstance(), entry.state.camera);
    }).catch(() => {});
  }
}

const GHOST_TITLEBAR = 32;

/** Window-space rect for a recorded pane. Docked panes reconstruct from
 *  their edge + user size; floating ones use the recorded x/y/w/h
 *  (container-relative). Best-effort — this is a ghost, not a layout. */
function paneGhostRect(p, base) {
  const W = base.width || window.innerWidth;
  const H = base.height || window.innerHeight;
  if (p.docked && p.dockEdge) {
    const size = typeof p.dockUserSize === "number" && p.dockUserSize > 0
      ? p.dockUserSize
      : (p.dockEdge === "left" || p.dockEdge === "right" ? W / 2 : H / 2);
    switch (p.dockEdge) {
      case "left": return { left: base.left, top: base.top, width: Math.min(size, W), height: H };
      case "right": return { left: base.left + W - Math.min(size, W), top: base.top, width: Math.min(size, W), height: H };
      case "top": return { left: base.left, top: base.top, width: W, height: Math.min(size, H) };
      case "bottom": return { left: base.left, top: base.top + H - Math.min(size, H), width: W, height: Math.min(size, H) };
    }
  }
  const width = Math.max(60, p.width || 300);
  const height = p.collapsed ? GHOST_TITLEBAR : Math.max(GHOST_TITLEBAR, p.height || 200);
  return { left: base.left + (p.x || 0), top: base.top + (p.y || 0), width, height };
}

function removeOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
}
