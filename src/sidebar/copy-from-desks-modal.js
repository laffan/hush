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
 * the **Copy Files** button at the bottom runs the plan.
 *
 * Rendering + drag live in the sibling modules (`-tree.js`, `-dnd.js`);
 * the copy itself in `-copy.js`.
 */

import { escHtml } from "./files-panel-shared.js";
import { findNode, isRealProjectNode, normalizeProjectChildren } from "../state/tree-helpers.js";
import { isProjectPdfFolder } from "../state/state-pdf-aliases.js";
import {
  buildSourceForest, filterCopyable, searchForest, renderRows, isContainerType, arrow,
} from "./copy-from-desks-tree.js";
import { installCopyDrag } from "./copy-from-desks-dnd.js";

const isPdfsSpecialId = (id) =>
  id === "__pdfs__" || String(id || "").startsWith("__pdfs__:");

/** The desk's one real (non-alias) node for a PDF, if it has one. */
function findRealPdfInDesk(nodes, fileId) {
  for (const n of nodes || []) {
    if (n?.type === "pdf" && !n.pdfAlias && n.fileId === fileId) return n;
    const deeper = findRealPdfInDesk(n?.children, fileId);
    if (deeper) return deeper;
  }
  return null;
}

function projectHasPdf(project, fileId) {
  const folder = (project.children || []).find(isProjectPdfFolder);
  return !!folder?.children?.some((c) => c?.type === "pdf" && c.fileId === fileId);
}

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
    ghosts: [],   // containers the plan will create (PDFs folders)
    planOpen: new Set(),   // expanded planned containers / preview rows
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
          <button type="button" class="cfd-btn cfd-confirm" disabled>Copy Files</button>
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
        + arrow(open)
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
      + renderRows(children, { side: "dst", expanded: ui.dstOpen, parentId: active.id, plan: ui.plan, ghosts: ui.ghosts, planOpen: ui.planOpen, depth: 0 });
    const n = ui.plan.length;
    statusEl.textContent = n
      // "item", not "file" — a planned project carries a whole subtree.
      ? `${n} item${n === 1 ? "" : "s"} planned`
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
      pruneGhosts();
      renderDst();
      return;
    }
    const row = e.target.closest(".cfd-row");
    // Planned rows twirl open over their snapshotted contents rather
    // than over the live tree, so they key off the plan / preview id.
    if (row?.classList.contains("cfd-planned") && e.target.closest(".cfd-arrow")) {
      const key = row.dataset.previewKey || row.dataset.planId;
      if (key) { toggle(ui.planOpen, key); renderDst(); }
      return;
    }
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
      // A PDF never lands where it was dropped — see planPdfDrop.
      if (node.type === "pdf") { planPdfDrop(node, site); continue; }
      if (ui.plan.some((p) => p.srcNodeId === nodeId && p.parentId === site.parentId)) continue;
      pushPlan({
        srcNodeId: nodeId,
        parentId: site.parentId,
        index,
        displayIndex,
        type: node.type,
        name: node.name || "Untitled",
        fileId: node.fileId || null,
        deskName: deskNameFor(nodeId),
        // Snapshot of what rides along, for the row's disclosure arrow.
        preview: previewOf(node),
      });
    }
    // Keep the drop target visible even if it was collapsed.
    if (isContainerType(findNode(state.fileTree, site.parentId)?.type)) ui.dstOpen.add(site.parentId);
    for (const id of ancestorsOf(site.parentId)) ui.dstOpen.add(id);
    ui.selection = [];
    render();
  }

  /** What a planned container will actually contain: its copyable
   *  subtree, run through the same project ordering the copy applies (so
   *  the preview doesn't show notebooks above docs when the result won't).
   *  `filterCopyable` clones, so normalizing here can't touch the tree. */
  function previewOf(node) {
    if (!isContainerType(node.type)) return [];
    const wrapper = { ...node, children: filterCopyable(node.children) };
    normalizeProjectChildren([wrapper]);
    return wrapper.children;
  }

  function pushPlan(entry) {
    ui.plan.push({ planId: `plan-${++ui.planSeq}`, ...entry });
  }

  /**
   * PDFs are registry entries with a per-device binary cache, so a copy
   * doesn't go where it's dropped: the desk's PDFs folder holds the one
   * real node, and dropping onto a project files a *reference* in that
   * project's own PDFs folder. Either folder may not exist yet — then
   * the plan grows a ghost folder so the user sees it appear.
   */
  function planPdfDrop(node, site) {
    if (!node.fileId) return;
    const already = findRealPdfInDesk(active.children, node.fileId);
    const planned = (pred) => ui.plan.some(pred);
    if (!already && !planned((p) => p.fileId === node.fileId && !p.alias)) {
      const dest = deskPdfsSite();
      pushPlan({ ...dest, srcNodeId: node.id, type: "pdf", name: node.name || "Untitled",
        fileId: node.fileId, deskName: deskNameFor(node.id) });
      expandTo(dest.parentId);
    }
    const project = nearestProjectFor(site.parentId);
    if (!project) return;
    if (projectHasPdf(project, node.fileId)) return;
    if (planned((p) => p.fileId === node.fileId && p.alias && p.projectId === project.id)) return;
    const dest = projectPdfsSite(project);
    pushPlan({ ...dest, srcNodeId: node.id, type: "pdf", alias: true, projectId: project.id,
      name: node.name || "Untitled", fileId: node.fileId, deskName: deskNameFor(node.id) });
    expandTo(dest.parentId);
  }

  /** Slot for the desk's own PDFs folder, minting a ghost if it has none. */
  function deskPdfsSite() {
    const folder = (active.children || []).find((c) => isPdfsSpecialId(c.id));
    if (folder) return endOfContainer(folder);
    return ghostSite(active.id, "deskPdfs");
  }

  function projectPdfsSite(project) {
    const folder = (project.children || []).find(isProjectPdfFolder);
    if (folder) return endOfContainer(folder);
    return ghostSite(project.id, "projectPdfs");
  }

  function endOfContainer(node) {
    const real = node.children || [];
    const planned = ui.plan.filter((p) => p.parentId === node.id).length;
    return { parentId: node.id, index: real.length, displayIndex: filterCopyable(real).length + planned };
  }

  /** Find-or-create the planned "PDFs" folder for `parentId`. Planned
   *  containers aren't real slots, so index/displayIndex just order the
   *  ghost's own contents. */
  function ghostSite(parentId, kind) {
    let ghost = ui.ghosts.find((g) => g.parentId === parentId && g.kind === kind);
    if (!ghost) {
      ghost = { id: `ghost-${++ui.planSeq}`, parentId, kind, name: "PDFs" };
      ui.ghosts.push(ghost);
    }
    const n = ui.plan.filter((p) => p.parentId === ghost.id).length;
    return { parentId: ghost.id, index: n, displayIndex: n };
  }

  /** Open the destination (and everything above it) so a planned row
   *  can't land inside a collapsed container the user never sees. */
  function expandTo(parentId) {
    const ghost = ui.ghosts.find((g) => g.id === parentId);
    const realId = ghost ? ghost.parentId : parentId;
    ui.dstOpen.add(realId);
    for (const id of ancestorsOf(realId)) ui.dstOpen.add(id);
  }

  /** Drop the ghost folders whose planned contents have all been removed. */
  function pruneGhosts() {
    let changed = true;
    while (changed) {
      changed = false;
      ui.ghosts = ui.ghosts.filter((g) => {
        const used = ui.plan.some((p) => p.parentId === g.id) || ui.ghosts.some((o) => o.parentId === g.id);
        if (!used) changed = true;
        return used;
      });
    }
  }

  /** Nearest real project at or above `nodeId` — the thing a dropped PDF
   *  would become a reference in. */
  function nearestProjectFor(nodeId) {
    const self = findNode(state.fileTree, nodeId);
    if (isRealProjectNode(self)) return self;
    for (const id of [...ancestorsOf(nodeId)].reverse()) {
      const n = findNode(state.fileTree, id);
      if (isRealProjectNode(n)) return n;
    }
    return null;
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
      statusEl.textContent = `Copied ${copied} item${copied === 1 ? "" : "s"}`;
      close();
    } catch (err) {
      console.error("Copy from desks failed:", err);
      ui.busy = false;
      confirmBtn.textContent = "Copy failed";
      setTimeout(() => { confirmBtn.textContent = "Copy Files"; confirmBtn.disabled = false; }, 2000);
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
