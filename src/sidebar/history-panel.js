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
  const card = document.createElement("div");
  card.className = "history-preview-card";
  const inlineCount = (entry.state.panes || []).filter((p) => p && p.inline).length;
  card.innerHTML = `
    <div class="history-preview-kind">${kindLabel(surface.kind)}</div>
    <div class="history-preview-name"></div>
    <div class="history-preview-meta"></div>
  `;
  card.querySelector(".history-preview-name").textContent = surface.name || "No file";
  card.querySelector(".history-preview-meta").textContent =
    `${formatTime(entry.timestamp)}${inlineCount ? ` · ${inlineCount} inline pane${inlineCount === 1 ? "" : "s"}` : ""}`;
  overlayEl.appendChild(card);

  // Ghost rectangles for every recorded pane, positioned against the
  // live pane container so they land where the panes actually sat.
  const container = document.getElementById("pane-container");
  const base = container ? container.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  for (const p of entry.state.panes || []) {
    if (!p || p.inline) continue;
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
