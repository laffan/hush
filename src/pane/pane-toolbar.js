/**
 * Pane title-bar DOM construction + the per-pane toggles wired to its
 * buttons (collapse, attach, pin). Extracted from pane-manager.js to
 * keep that file under the line limit.
 *
 * Lifecycle helpers (close/focus, onContextChange) are passed in via
 * the `deps` object so this module doesn't need to import pane-manager.js.
 */

import { isIOS } from "../settings/settings-ui.js";
import { applyTooltip } from "../tooltips.js";
import {
  appState,
  panes,
  zForPane,
  notebookBridge,
  getNotebookBridge,
  DEFAULT_WIDTH, DEFAULT_HEIGHT, TITLEBAR_HEIGHT,
} from "./pane-state.js";
import { setupPaneDrag, setupPaneResize } from "./pane-drag.js";
import { togglePaneSizePopover } from "./pane-size-popover.js";
import {
  screenToCanvas, startCanvasSync, startScrollSync, startPdfScrollSync, stopAttachSync, anchorPaneToPdf,
} from "./pane-attach-sync.js";
import { schedulePersist } from "./pane-persistence.js";

// ── SVG icons ─────────────────────────────────────────────────────────
const ICON_CLOSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;
const ICON_ATTACH = `<svg viewBox="0 0 10 10"><circle cx="5" cy="3.5" r="2"/><line x1="5" y1="5.5" x2="5" y2="9"/></svg>`;
const ICON_PIN = `<svg viewBox="0 0 10 10"><line x1="5" y1="1" x2="5" y2="7"/><line x1="2.5" y1="4" x2="7.5" y2="4"/><line x1="5" y1="7" x2="5" y2="9.5"/></svg>`;
const ICON_SIZE = `<svg viewBox="0 0 10 10"><polyline points="2,8 5,2 8,8"/><line x1="3.3" y1="6" x2="6.7" y2="6"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 10 10"><polyline points="2.5,4 5,6.5 7.5,4"/></svg>`;
// Header-bar glyph: a thick vertical bar (the gutter rule) next to three
// horizontal lines (the content below it). Read this as "header label
// territory" so the gutter affordance is recognisable at toolbar size.
const ICON_GUTTER = `<svg viewBox="0 0 10 10"><rect x="1" y="1" width="1.5" height="8" fill="currentColor" stroke="none"/><line x1="4.5" y1="2.5" x2="9" y2="2.5"/><line x1="4.5" y1="5" x2="9" y2="5"/><line x1="4.5" y1="7.5" x2="9" y2="7.5"/></svg>`;

function makeBtn(name, svg, ariaLabel) {
  const btn = document.createElement("button");
  btn.className = `floating-pane-btn fp-btn-${name}`;
  btn.innerHTML = svg;
  applyTooltip(btn, ariaLabel);
  btn.setAttribute("aria-label", ariaLabel);
  return btn;
}


/**
 * Build the pane root element + title bar + content area + resize
 * handles. Wires every button to its handler.
 *
 * @param {object} pane  Pane record (mutated — `el`, `_content`,
 *   `_titlebar`, `_wordCountEl` are set).
 * @param {object} deps  { closePane, focusPane, createPane, getCurrentContext }
 */
export function buildPaneDOM(pane, deps) {
  const { closePane, focusPane, createPane, getCurrentContext } = deps;
  const el = document.createElement("div");
  el.className = "floating-pane";
  Object.assign(el.style, { left: pane.x + "px", top: pane.y + "px", width: pane.width + "px", height: pane.height + "px" });

  // Title bar
  const titlebar = document.createElement("div");
  titlebar.className = "floating-pane-titlebar";
  const title = document.createElement("span");
  title.className = "floating-pane-title";
  const titleLink = document.createElement("span");
  titleLink.className = "fp-title-link";
  titleLink.textContent = pane.fileName;
  titleLink.addEventListener("click", (e) => {
    if (pane.fileType === "zotero-highlights") return;
    e.stopPropagation();
    if (pane.fileType === "notebook") appState.openNotebook(pane.fileId);
    else if (pane.fileType === "pdf") appState.openPdf(pane.fileId);
    else appState.openFile(pane.fileId);
  });
  title.appendChild(titleLink);
  // Word-count chip (doc panes only) — populated by pane-content.js's
  // updatePaneWordCount on every doc change.
  if (pane.fileType !== "notebook" && pane.fileType !== "pdf") {
    const wc = document.createElement("span");
    wc.className = "fp-wordcount";
    wc.style.display = "none";
    title.appendChild(wc);
    pane._wordCountEl = wc;
  }
  titlebar.appendChild(title);

  const buttons = document.createElement("span");
  buttons.className = "floating-pane-buttons";

  // Font-size button (doc panes only — notebooks have no text size,
  // zotero-highlights pane is fileless).
  if (pane.fileType !== "notebook" && pane.fileType !== "pdf" && pane.fileType !== "zotero-highlights") {
    const sizeBtn = makeBtn("size", ICON_SIZE, "Pane font size");
    sizeBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePaneSizePopover(pane, sizeBtn, schedulePersist); });
    buttons.appendChild(sizeBtn);
  }

  const attachLabel = appState.currentPdfFileId ? "Attach to page" : appState.currentNotebookFileId ? "Attach to canvas" : "Attach to document";
  const attachBtn = makeBtn("attach", ICON_ATTACH, attachLabel);
  attachBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleAttach(pane); });
  buttons.appendChild(attachBtn);

  const pinBtn = makeBtn("pin", ICON_PIN, "Pin (keep across documents)");
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pinBtn.classList.contains("fp-btn-disabled")) return;
    togglePinned(pane, deps.onContextChange);
  });
  buttons.appendChild(pinBtn);

  // Gutter toggle on every pane — the click decides whether the pane
  // qualifies (notebook + doc context) and silently no-ops otherwise.
  // Mutually exclusive with pin: pin is disabled while the pane is a
  // gutter, see syncGutterButton.
  const gutterBtn = makeBtn("gutter", ICON_GUTTER, "Use as gutter");
  gutterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGutterFromButton(pane);
  });
  buttons.appendChild(gutterBtn);

  // Collapse button (iOS only — desktop's title-bar double-click is the
  // equivalent gesture).
  if (isIOS()) {
    const collapseBtn = makeBtn("collapse", ICON_COLLAPSE, "Collapse");
    collapseBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(pane); });
    buttons.appendChild(collapseBtn);
  }
  const closeBtn = makeBtn("close", ICON_CLOSE, "Close");
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closePane(pane.id); });
  buttons.appendChild(closeBtn);

  titlebar.appendChild(buttons);
  el.appendChild(titlebar);

  const content = document.createElement("div");
  content.className = "floating-pane-content";
  el.appendChild(content);

  // Resize handles (8 directions)
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = document.createElement("div");
    handle.className = `fp-resize fp-resize-${dir}`;
    handle.dataset.dir = dir;
    el.appendChild(handle);
  }
  // iOS / iPad: add larger corner touch targets nested inside the
  // border-radius so the corners are reachable by a fingertip without
  // lifting the pane out of place. The top-right corner is skipped —
  // it sits under the close button. They share the .fp-resize class so
  // `setupPaneResize` wires them automatically.
  if (isIOS()) {
    for (const dir of ["nw", "se", "sw"]) {
      const dot = document.createElement("div");
      dot.className = `fp-resize fp-resize-touch fp-resize-touch-${dir}`;
      dot.dataset.dir = dir;
      el.appendChild(dot);
    }
  }

  pane.el = el;
  pane._content = content;
  pane._titlebar = titlebar;

  setupPaneDrag(pane, { createPane, getCurrentContext, schedulePersist });
  setupPaneResize(pane, { schedulePersist });
  titlebar.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".floating-pane-btn, .fp-title-link")) toggleCollapse(pane);
  });
  el.addEventListener("pointerdown", () => focusPane(pane.id));
}

// ── Toggles wired into the title bar ─────────────────────────────────

export function toggleCollapse(pane) {
  pane.collapsed = !pane.collapsed;
  if (pane.collapsed) {
    pane._savedHeight = pane.height;
    pane.el.classList.add("collapsed");
    pane.el.style.height = TITLEBAR_HEIGHT + "px";
  } else {
    pane.el.classList.remove("collapsed");
    pane.height = pane._savedHeight || DEFAULT_HEIGHT;
    pane.el.style.height = pane.height + "px";
  }
  schedulePersist();
}

async function toggleAttach(pane) {
  if (pane.gutter) {
    const { stopActivePaneAsGutter } = await import("./pane-gutter.js");
    stopActivePaneAsGutter();
  }
  if (pane.pinned) {
    if (!confirm("This pane is pinned globally. Attaching will remove the pin. Continue?")) return;
    setPinned(pane, false);
  }

  pane.attached = !pane.attached;
  const btn = pane.el.querySelector(".fp-btn-attach");
  if (btn) btn.classList.toggle("attach-active", pane.attached);

  if (pane.attached) {
    if (appState.currentPdfFileId) {
      anchorPaneToPdf(pane);
      startPdfScrollSync(pane);
    } else if (appState.currentNotebookFileId) {
      await getNotebookBridge();
      const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
      const zoom = canvas ? (canvas.state.camera.zoom || 1) : 1;
      const canvasPos = screenToCanvas(pane.x, pane.y);
      if (canvasPos) { pane._canvasX = canvasPos.x; pane._canvasY = canvasPos.y; }
      pane.width = pane.width / zoom;
      pane.height = pane.height / zoom;
      pane.el.style.width = pane.width + "px";
      pane.el.style.height = pane.height + "px";
      startCanvasSync(pane);
    } else {
      const scrollTop = appState.editor?.view.scrollDOM.scrollTop || 0;
      pane._scrollRelY = pane.y + scrollTop;
      startScrollSync(pane);
    }
  } else {
    // Mirror the attach path: panes detaching from canvas convert their
    // layout-px size back to screen px so the visible size carries
    // across the transition.
    const wasCanvasAttached = appState && appState.currentNotebookFileId;
    if (wasCanvasAttached) {
      const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
      const zoom = canvas ? (canvas.state.camera.zoom || 1) : 1;
      pane.width = pane.width * zoom;
      pane.height = pane.height * zoom;
      pane.el.style.width = pane.width + "px";
      pane.el.style.height = pane.height + "px";
    }
    stopAttachSync(pane);
  }
  schedulePersist();
}

async function toggleGutterFromButton(pane) {
  // The pane has to be focused for the gutter helpers to act on it —
  // they read `activePaneId` to decide which pane to mutate. The
  // button click already focuses via the pane's pointerdown handler,
  // but a programmatic call wouldn't, so be explicit.
  const { useActivePaneAsGutter, stopActivePaneAsGutter, isActivePaneAGutter } = await import("./pane-gutter.js");
  if (isActivePaneAGutter()) stopActivePaneAsGutter();
  else useActivePaneAsGutter();
  syncGutterButton(pane);
}

/** Reflect pane.gutter on the toolbar: the Gutter button picks up the
 *  active red tint, and the Pin button is disabled (gutter and pin are
 *  mutually exclusive). Exposed so the gutter module can call back
 *  after enter/exit/restore so command-palette / persistence-driven
 *  toggles update the toolbar too. */
export function syncGutterButton(pane) {
  if (!pane || !pane.el) return;
  const gBtn = pane.el.querySelector(".fp-btn-gutter");
  if (gBtn) gBtn.classList.toggle("gutter-active", !!pane.gutter);
  const pBtn = pane.el.querySelector(".fp-btn-pin");
  if (pBtn) pBtn.classList.toggle("fp-btn-disabled", !!pane.gutter);
}

async function togglePinned(pane, onContextChange) {
  if (pane.gutter) {
    const { stopActivePaneAsGutter } = await import("./pane-gutter.js");
    stopActivePaneAsGutter();
  }
  if (pane.attached) {
    if (!confirm("This pane is attached. Pinning will remove the attachment. Continue?")) return;
    pane.attached = false;
    stopAttachSync(pane);
    const aBtn = pane.el.querySelector(".fp-btn-attach");
    if (aBtn) aBtn.classList.remove("attach-active");
  }

  setPinned(pane, !pane.pinned, onContextChange);
}

function setPinned(pane, value, onContextChange) {
  pane.pinned = value;
  const btn = pane.el.querySelector(".fp-btn-pin");
  if (btn) btn.classList.toggle("pin-active", pane.pinned);
  pane.el.classList.toggle("pinned", pane.pinned);
  // Re-stamp z-index so the pane lifts into (or drops out of) the
  // pinned z-band immediately on toggle.
  pane.el.style.zIndex = zForPane(pane);
  // When unpinning, pane returns to its original context — hide if not current.
  if (!value && typeof onContextChange === "function") onContextChange();
  schedulePersist();
}
