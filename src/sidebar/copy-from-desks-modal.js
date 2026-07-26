/**
 * "Copy Files from other Desks" — a two-column planning modal.
 *
 * Left column: every Doc, Notebook, Stack, PDF, Project and Folder in
 * every desk *except* the active one, nested exactly as it appears in
 * that desk's file browser, with a search box above it and multi-select
 * (click / cmd-click / shift-click).
 *
 * Right column: the active desk's file browser, acting as the drop
 * surface. Dragging a batch across plans the copy — the files appear in
 * grey exactly where they'll land — and nothing touches the tree until
 * the **Move Files** button at the bottom runs the plan.
 *
 * Rendering + drag live in the sibling modules (`-tree.js`, `-dnd.js`);
 * the copy itself in `-copy.js`.
 */

import { escHtml } from "./files-panel-shared.js";
import { findNode } from "../state/tree-helpers.js";
import {
  buildSourceForest, filterCopyable, searchForest, renderRows, isContainerType,
} from "./copy-from-desks-tree.js";
import { installCopyDrag } from "./copy-from-desks-dnd.js";

let _openEl = null;

export function openCopyFromDesksModal(state) {
  const desks = (state.fileTree || []).filter((n) => n?.type === "desk");
  const active = state.getActiveDesk?.() || desks[0] || null;
  if (!active) return null;
  const sources = buildSourceForest(state);
  if (!sources.length) return null;   // nothing to copy from

  closeCopyFromDesksModal();

  const ui = {
    query: "",
    srcOpen: new Set(sources.map((d) => d.id)),
    dstOpen: new Set([active.id]),
    selection: [],
    anchor: null,
    plan: [],
    planSeq: 0,
    busy: false,
  };

  const backdrop = document.createElement("div");
  backdrop.className = "cfd-backdrop";
  backdrop.innerHTML = `
    <div class="cfd-modal" role="dialog" aria-label="Copy files from other desks">
      <div class="cfd-title">Copy Files from other Desks</div>
      <div class="cfd-columns">
        <div class="cfd-col cfd-col-src">
          <input type="search" class="cfd-search" placeholder="Search all desks…" />
          <div class="cfd-list cfd-src-list"></div>
        </div>
        <div class="cfd-col cfd-col-dst">
          <div class="cfd-col-head">This desk</div>
          <div class="cfd-list cfd-dst-list"></div>
        </div>
      </div>
      <div class="cfd-footer">
        <div class="cfd-status"></div>
        <div class="cfd-footer-actions">
          <button type="button" class="cfd-btn cfd-cancel">Cancel</button>
          <button type="button" class="cfd-btn cfd-confirm" disabled>Move Files</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  _openEl = backdrop;

  const srcList = backdrop.querySelector(".cfd-src-list");
  const dstList = backdrop.querySelector(".cfd-dst-list");
  const searchEl = backdrop.querySelector(".cfd-search");
  const statusEl = backdrop.querySelector(".cfd-status");
  const confirmBtn = backdrop.querySelector(".cfd-confirm");

  /** Flat list of the source rows currently on screen — the walk
   *  shift-click ranges over. */
  let visibleSrcIds = [];

  function renderSrc() {
    const { forest, expand } = searchForest(sources, ui.query);
    const expanded = expand
      ? new Set([...ui.srcOpen, ...expand])
      : ui.srcOpen;
    const selection = new Set(ui.selection);
    srcList.innerHTML = forest.map((desk) => {
      const open = expanded.has(desk.id);
      return `<div class="cfd-desk-head${open ? " open" : ""}" data-desk-id="${escHtml(desk.id)}">`
        + `<span class="cfd-arrow${open ? " open" : ""}">${open ? "▾" : "▸"}</span>`
        + `<span class="cfd-desk-name">${escHtml(desk.name)}</span></div>`
        + (open ? renderRows(desk.children, { side: "src", expanded, parentId: desk.id, selection, depth: 1 }) : "");
    }).join("") || `<div class="cfd-empty">No matches</div>`;
    visibleSrcIds = Array.from(srcList.querySelectorAll(".cfd-row")).map((r) => r.dataset.nodeId);
  }

  function renderDst() {
    const children = filterCopyable(active.children);
    dstList.innerHTML = `<div class="cfd-row cfd-desk-root" data-node-id="${escHtml(active.id)}"`
      + ` data-container="1" data-child-count="${children.length}" data-depth="-1" data-index="0" style="--cfd-depth:0">`
      + `<span class="cfd-arrow-spacer"></span><span class="cfd-name">${escHtml(active.name || "This desk")}</span></div>`
      + renderRows(children, { side: "dst", expanded: ui.dstOpen, parentId: active.id, plan: ui.plan, depth: 0 });
    const n = ui.plan.length;
    statusEl.textContent = n
      ? `${n} file${n === 1 ? "" : "s"} planned`
      : "Drag files from the left onto this desk.";
    confirmBtn.disabled = n === 0 || ui.busy;
  }

  function render() { renderSrc(); renderDst(); }

  // ----- source selection -------------------------------------------
  function selectFromRow(nodeId, event) {
    if (!nodeId) return;
    if (event?.metaKey || event?.ctrlKey) {
      const i = ui.selection.indexOf(nodeId);
      if (i >= 0) ui.selection.splice(i, 1); else ui.selection.push(nodeId);
      ui.anchor = nodeId;
    } else if (event?.shiftKey && ui.anchor) {
      const a = visibleSrcIds.indexOf(ui.anchor);
      const b = visibleSrcIds.indexOf(nodeId);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        ui.selection = visibleSrcIds.slice(lo, hi + 1);
      }
    } else {
      ui.selection = [nodeId];
      ui.anchor = nodeId;
    }
    renderSrc();
  }

  srcList.addEventListener("click", (e) => {
    const deskHead = e.target.closest(".cfd-desk-head");
    if (deskHead) { toggle(ui.srcOpen, deskHead.dataset.deskId); renderSrc(); return; }
    const arrowEl = e.target.closest(".cfd-arrow");
    if (!arrowEl) return;
    const row = arrowEl.closest(".cfd-row");
    if (row?.dataset.nodeId) { toggle(ui.srcOpen, row.dataset.nodeId); renderSrc(); }
  });

  dstList.addEventListener("click", (e) => {
    const remove = e.target.closest(".cfd-planned-remove");
    if (remove) {
      const planId = remove.closest(".cfd-planned")?.dataset.planId;
      ui.plan = ui.plan.filter((p) => p.planId !== planId);
      renderDst();
      return;
    }
    const row = e.target.closest(".cfd-row");
    if (row && !row.classList.contains("cfd-desk-root")
      && row.dataset.container === "1" && row.dataset.nodeId) {
      toggle(ui.dstOpen, row.dataset.nodeId);
      renderDst();
    }
  });

  searchEl.addEventListener("input", () => { ui.query = searchEl.value; renderSrc(); });

  // ----- drag → plan -------------------------------------------------
  let hoverExpandTimer = null;
  const detachDrag = installCopyDrag({
    srcEl: srcList,
    dstEl: dstList,
    rootId: active.id,
    getSelection: () => ui.selection,
    selectFromRow,
    onHoverContainer: (nodeId) => {
      clearTimeout(hoverExpandTimer);
      if (!nodeId || ui.dstOpen.has(nodeId)) return;
      hoverExpandTimer = setTimeout(() => { ui.dstOpen.add(nodeId); renderDst(); }, 500);
    },
    onDrop: (nodeIds, site) => {
      clearTimeout(hoverExpandTimer);
      addToPlan(nodeIds, site);
    },
  });

  function addToPlan(nodeIds, site) {
    // Dropping a container drops its contents with it, so a child that
    // rode along inside a selected ancestor is skipped.
    const ids = nodeIds.filter((id) => !nodeIds.some((other) => other !== id && isAncestorOf(other, id)));
    // The columns render a *filtered* tree (no Images / Trash), so the
    // slot the user saw has to be translated back to a real child index
    // before it can drive the copy.
    const displayIndex = site.index;
    const index = realIndexFor(site.parentId, displayIndex);
    for (const nodeId of ids) {
      const node = findNode(state.fileTree, nodeId);
      if (!node) continue;
      if (ui.plan.some((p) => p.srcNodeId === nodeId && p.parentId === site.parentId)) continue;
      ui.plan.push({
        planId: `plan-${++ui.planSeq}`,
        srcNodeId: nodeId,
        parentId: site.parentId,
        index,
        displayIndex,
        type: node.type,
        name: node.name || "Untitled",
        deskName: deskNameFor(nodeId),
      });
    }
    // Keep the drop target visible even if it was collapsed.
    if (isContainerType(findNode(state.fileTree, site.parentId)?.type)) ui.dstOpen.add(site.parentId);
    for (const id of ancestorsOf(site.parentId)) ui.dstOpen.add(id);
    ui.selection = [];
    render();
  }

  /** Translate a slot in the displayed (filtered) child list into the
   *  matching slot in the live tree's children. */
  function realIndexFor(parentId, displayIndex) {
    const parent = findNode(state.fileTree, parentId);
    const real = parent?.children || [];
    const display = filterCopyable(real);
    if (displayIndex < display.length) {
      const i = real.findIndex((n) => n?.id === display[displayIndex].id);
      if (i >= 0) return i;
    }
    const lastId = display[display.length - 1]?.id;
    const lastAt = lastId ? real.findIndex((n) => n?.id === lastId) : -1;
    return lastAt >= 0 ? lastAt + 1 : real.length;
  }

  function isAncestorOf(ancestorId, nodeId) {
    const node = findNode(state.fileTree, ancestorId);
    if (!node) return false;
    const walk = (nodes) => (nodes || []).some((n) => n.id === nodeId || walk(n.children));
    return walk(node.children);
  }

  function ancestorsOf(nodeId) {
    const out = [];
    const walk = (nodes, chain) => {
      for (const n of nodes || []) {
        if (n.id === nodeId) { out.push(...chain); return true; }
        if (walk(n.children, [...chain, n.id])) return true;
      }
      return false;
    };
    walk(state.fileTree, []);
    return out;
  }

  function deskNameFor(nodeId) {
    for (const desk of sources) {
      const walk = (nodes) => (nodes || []).some((n) => n.id === nodeId || walk(n.children));
      if (walk(desk.children)) return desk.name;
    }
    return "";
  }

  // ----- lifecycle ---------------------------------------------------
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  function close() {
    clearTimeout(hoverExpandTimer);
    detachDrag();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (_openEl === backdrop) _openEl = null;
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector(".cfd-cancel").addEventListener("click", close);

  confirmBtn.addEventListener("click", async () => {
    if (!ui.plan.length || ui.busy) return;
    ui.busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Copying…";
    try {
      const { runCopyPlan } = await import("./copy-from-desks-copy.js");
      const { copied, skipped } = await runCopyPlan(state, ui.plan);
      if (skipped) console.warn(`[copy-from-desks] ${skipped} item(s) skipped`);
      statusEl.textContent = `Copied ${copied} file${copied === 1 ? "" : "s"}`;
      close();
    } catch (err) {
      console.error("Copy from desks failed:", err);
      ui.busy = false;
      confirmBtn.textContent = "Copy failed";
      setTimeout(() => { confirmBtn.textContent = "Move Files"; confirmBtn.disabled = false; }, 2000);
    }
  });

  render();
  searchEl.focus();
  return close;
}

export function closeCopyFromDesksModal() {
  if (_openEl?.parentNode) _openEl.parentNode.removeChild(_openEl);
  _openEl = null;
}

function toggle(set, id) {
  if (!id) return;
  if (set.has(id)) set.delete(id); else set.add(id);
}
