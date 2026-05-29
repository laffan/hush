/**
 * Multi-select view — overlays the editor area with a list of the
 * currently-selected doc filenames, plus batch actions (Delete, Flag).
 * Mounts a single `#multi-select-view` container into the app root and
 * toggles it via the `multi-select-active` body class so the editor /
 * notebook stay laid out underneath without flicker.
 *
 * Lifecycle: appears whenever `state.selectedDocIds` has at least two
 * entries; hides otherwise. Single-doc selections fall through to the
 * normal open path (`onClick` in the files panel opens that doc and
 * leaves the editor as-is) so there's no in-between state to manage.
 *
 * Click on a row → opens that doc and clears the selection (matches
 * the single-click semantics elsewhere in the app).
 */
import { typeIcons, escHtml, showDeleteConfirmModal, showPromptModal } from "./sidebar/files-panel-shared.js";
import { findNodeByFileId, findAncestorIds, findNode } from "./state/tree-helpers.js";
import { deleteTreeNode } from "./state/state-tree.js";
import { createColorPalette } from "./sidebar/files-panel-row-menu.js";

let _hostEl = null;
let _state = null;

export function initMultiSelectView(state) {
  _state = state;
  _hostEl = document.createElement("div");
  _hostEl.id = "multi-select-view";
  _hostEl.className = "multi-select-view hidden";
  // Sits inside #app so the existing layout (sidebar / panel-overlay /
  // editor-container) flows around it via CSS rather than this module
  // having to compute offsets.
  const app = document.getElementById("app");
  if (app) app.appendChild(_hostEl);

  state.on("multi-select-changed", refresh);
  // Any single-doc open path implicitly exits multi-select mode. We
  // listen to the same events the sidebar does so the view doesn't
  // linger after the user opens a doc from the command palette, file
  // picker, etc.
  state.on("file-opened", () => state.clearSelectedDocs());
  state.on("notebook-open", () => state.clearSelectedDocs());
  // Tree changes (delete, rename, move) can invalidate fileIds in the
  // selection — drop any that no longer resolve to a doc node, then
  // repaint. Comparing against `state.files` rather than walking the
  // tree avoids missing freshly-trashed entries (trashed docs stay in
  // `files` but lose their node).
  state.on("files-changed", () => {
    if (state.selectedDocIds.length === 0) return;
    const valid = state.selectedDocIds.filter((id) =>
      !!findNodeByFileId(state.fileTree, id),
    );
    if (valid.length !== state.selectedDocIds.length) {
      state.setSelectedDocs(valid);
      return; // setSelectedDocs emits multi-select-changed → refresh()
    }
    refresh();
  });

  // Esc clears the selection. Capture-phase so it beats CodeMirror's
  // own keymap (which wouldn't see Esc anyway since the editor is
  // hidden, but the keydown still reaches it).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.selectedDocIds.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    state.clearSelectedDocs();
  }, true);

  refresh();
}

function refresh() {
  if (!_hostEl || !_state) return;
  const ids = _state.selectedDocIds || [];
  // Single-selection sticks with the normal open path — only show the
  // listing view when there's actually a multi-doc batch in play.
  const active = ids.length >= 2;
  document.body.classList.toggle("multi-select-active", active);
  _hostEl.classList.toggle("hidden", !active);
  if (!active) { _hostEl.innerHTML = ""; return; }
  render(ids);
}

/** Walk the node's ancestor chain into a readable "Desk / Folder /
 *  Project" breadcrumb. Skips the Inbox / Trash specials (they read as
 *  noise alongside user-named containers), and starts from the active
 *  desk's children rather than the bare desk-wrapper id so the path
 *  matches what the sidebar actually shows. Returns "" when the file
 *  lives at the desk root (no container ancestors). */
function ancestorBreadcrumb(state, nodeId) {
  const chain = findAncestorIds(state.fileTree, nodeId) || [];
  // findAncestorIds returns the ancestors INCLUDING the node's own
  // siblings' parent path; the final entry is the immediate parent.
  // For our purposes we want all containers from the desk root down
  // to the immediate parent, named in order.
  const parts = [];
  function findNodeAnywhere(nodes, id) {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const r = findNodeAnywhere(n.children, id);
        if (r) return r;
      }
    }
    return null;
  }
  for (const ancestorId of chain) {
    const node = findNodeAnywhere(state.fileTree, ancestorId);
    if (!node) continue;
    // Skip the desk wrapper itself + the Inbox / Trash / Images specials;
    // they don't add information for the user.
    if (node.type === "desk") continue;
    if (node.id === "__inbox__" || node.id?.startsWith("__inbox__:")) continue;
    if (node.id === "__trash__" || node.id?.startsWith("__trash__:")) continue;
    if (node.id === "__images__" || node.id?.startsWith("__images__:")) continue;
    parts.push(node.name || "Untitled");
  }
  return parts.join(" / ");
}

function render(ids) {
  const rows = ids
    .map((fileId) => {
      const node = findNodeByFileId(_state.fileTree, fileId);
      if (!node) return null;
      return {
        fileId,
        nodeId: node.id,
        name: node.name || "Untitled",
        path: ancestorBreadcrumb(_state, node.id),
        type: node.type,
        flagged: !!node.flagged,
      };
    })
    .filter((r) => r && (r.type === "document" || r.type === "notebook" || r.type === "pdf"));

  const flagBtnLabel = rows.every((r) => r.flagged) ? "Unflag" : "Flag";
  // "Combine Files" only makes sense when every selected item is a Doc —
  // the result is a single document with one tab section per source.
  const allDocs = rows.length >= 2 && rows.every((r) => r.type === "document");

  _hostEl.innerHTML = `
    <div class="ms-view-inner">
      <header class="ms-view-header">
        <div class="ms-view-title">${rows.length} file${rows.length === 1 ? "" : "s"} selected</div>
        <div class="ms-view-actions">
          <button type="button" class="ms-view-btn ms-view-btn-danger" data-ms-action="delete">Delete</button>
          <button type="button" class="ms-view-btn" data-ms-action="clear">Clear selection</button>
        </div>
      </header>
      <ul class="ms-view-list">
        ${rows.map((r) => `
          <li class="ms-view-row" data-file-id="${escHtml(r.fileId)}" data-type="${escHtml(r.type)}">
            <span class="ms-view-icon">${typeIcons[r.type] || typeIcons.document}</span>
            <span class="ms-view-text">
              ${r.path ? `<span class="ms-view-path">${escHtml(r.path)} / </span>` : ""}<span class="ms-view-name">${escHtml(r.name)}</span>
            </span>
            ${r.flagged ? `<span class="ms-view-flag">flagged</span>` : ""}
          </li>`).join("")}
      </ul>
      <div class="ms-view-colors-row"></div>
      <div class="ms-view-actions ms-view-actions-bottom">
        <button type="button" class="ms-view-btn" data-ms-action="flag">${escHtml(flagBtnLabel)}</button>
        <button type="button" class="ms-view-btn" data-ms-action="stack">Create Stack from selected</button>
        ${allDocs ? `<button type="button" class="ms-view-btn" data-ms-action="combine">Combine Files into Doc</button>` : ""}
      </div>
    </div>
  `;

  // Mount the color palette below the list. If every selected row has
  // the same bgColor we highlight that swatch; mixed selections show no
  // active swatch (clicking any swatch still applies it to all).
  const colorsRow = _hostEl.querySelector(".ms-view-colors-row");
  if (colorsRow) {
    const keys = rows.map((r) => {
      const n = findNode(_state.fileTree, r.nodeId);
      return n?.bgColor || null;
    });
    const allSame = keys.every((k) => k === keys[0]);
    const currentKey = allSame ? keys[0] : undefined;
    colorsRow.appendChild(createColorPalette(currentKey, (colorKey) => {
      applyColorToSelected(rows, colorKey);
    }));
  }

  // Row click → open that file via the type-appropriate path. The open
  // call emits `file-opened` (or `notebook-open`), our listener clears
  // the selection, refresh() hides the view. No explicit clear here so
  // the visual transition is single-shot.
  _hostEl.querySelectorAll(".ms-view-row").forEach((row) => {
    row.addEventListener("click", () => {
      const fileId = row.dataset.fileId;
      if (!fileId) return;
      if (row.dataset.type === "notebook") _state.openNotebook(fileId);
      else if (row.dataset.type === "pdf") _state.openPdf(fileId);
      else _state.openFile(fileId);
    });
  });

  // Batch-action buttons.
  _hostEl.querySelectorAll("[data-ms-action]").forEach((btn) => {
    btn.addEventListener("click", () => runBatchAction(btn.dataset.msAction, rows));
  });
}

function applyColorToSelected(rows, colorKey) {
  for (const r of rows) {
    const node = findNode(_state.fileTree, r.nodeId);
    if (!node) continue;
    if (colorKey) node.bgColor = colorKey;
    else delete node.bgColor;
  }
  _state.saveFileTree();
  _state.emit("files-changed");
}

async function runBatchAction(action, rows) {
  if (action === "clear") {
    _state.clearSelectedDocs();
    return;
  }
  if (action === "stack") {
    const items = rows.map((r) => ({ fileId: r.fileId, type: r.type, name: r.name }));
    showPromptModal({
      title: "New stack",
      label: "Name",
      placeholder: "New Stack",
      initialValue: "New Stack",
      confirmLabel: "Create",
      onConfirm: async (name) => {
        _state.clearSelectedDocs();
        const result = await _state.createStack(name, null, { openImmediately: true });
        if (!result) return;
        await new Promise((r) => setTimeout(r, 100));
        const { getStackInstance } = await import("./stack/stack-bridge.js");
        const inst = getStackInstance();
        if (!inst) return;
        for (const it of items) inst.addItem(it.fileId, it.type, it.name);
      },
    });
    return;
  }
  if (action === "combine") {
    // Pass the selected docs in their current selection order so the
    // modal can preview / re-order them before they become tab sections.
    const docs = rows
      .filter((r) => r.type === "document")
      .map((r) => ({ fileId: r.fileId, name: r.name }));
    if (docs.length < 2) return;
    const { openCombineFilesModal } = await import("./sidebar/combine-files-modal.js");
    openCombineFilesModal(_state, docs);
    return;
  }
  if (action === "flag") {
    // If every selected doc is already flagged, the action becomes
    // "unflag all"; otherwise "flag all". Mirrors what the button
    // label said when the user clicked it.
    const target = !rows.every((r) => r.flagged);
    for (const r of rows) {
      if (!!r.flagged === target) continue;
      try { await _state.toggleFlagged(r.nodeId); } catch (e) { console.warn("flag toggle failed", e); }
    }
    return;
  }
  if (action === "delete") {
    const list = rows.map((r) => `  • ${r.name}`).join("\n");
    showDeleteConfirmModal(
      `Delete ${rows.length} document${rows.length === 1 ? "" : "s"}?`,
      `The following will be moved to Trash:\n\n${list}`,
      async () => {
        // Delete in sequence so the tree mutation stays consistent —
        // each call awaits the previous so we don't fire concurrent
        // saveFileTree() races.
        for (const r of rows) {
          try { await deleteTreeNode(_state, r.nodeId); } catch (e) { console.warn("delete failed", e); }
        }
        _state.clearSelectedDocs();
      },
    );
  }
}
