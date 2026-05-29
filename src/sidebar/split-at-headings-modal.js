/**
 * "Split at Headings" modal.
 *
 * Lets the user break the open document at a chosen heading level into a
 * new Project of child docs. The level dropdown only offers heading
 * levels that actually occur in the doc; below it a live list previews
 * the filenames that will be created. A "Convert H1s to tabs" checkbox
 * rewrites `# H1` lines to Hush tab markers in the output, and a
 * "Delete original" checkbox moves the source doc to Trash afterwards.
 *
 * Reuses the notebook-export-modal (`nxm-*`) shell for visual
 * consistency; split-specific bits live under `sah-*` (split-combine.css).
 */

import { findNode, findNodeByFileId } from "../state/tree-helpers.js";
import {
  getDocContent, listHeadingLevels, splitSections,
} from "../state/state-split-combine.js";

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

const LEVEL_LABELS = {
  1: "Heading 1 (#)", 2: "Heading 2 (##)", 3: "Heading 3 (###)",
  4: "Heading 4 (####)", 5: "Heading 5 (#####)", 6: "Heading 6 (######)",
};

/** Resolve the modal's target node. Accepts an explicit tree-node id
 *  (sidebar row menu) or falls back to the currently-open doc (command
 *  palette). Returns the node or null. */
function resolveNode(state, nodeId) {
  if (nodeId) return findNode(state.fileTree, nodeId);
  if (state.currentFileId) return findNodeByFileId(state.fileTree, state.currentFileId);
  return null;
}

export async function openSplitAtHeadingsModal(state, nodeId = null) {
  const node = resolveNode(state, nodeId);
  if (!node || node.type !== "document" || !node.fileId) return () => {};

  const content = await getDocContent(state, node.fileId);
  const levels = listHeadingLevels(content);

  document.querySelectorAll(".sah-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "notebook-export-backdrop sah-backdrop";
  const modal = document.createElement("div");
  modal.className = "notebook-export-modal sah-modal";

  const choices = {
    level: levels[0] || 1,
    convertH1sToTabs: false,
    deleteOriginal: false,
  };

  if (levels.length === 0) {
    modal.innerHTML = `
      <div class="nxm-title">Split at Headings</div>
      <div class="sah-empty">This document has no headings to split on.</div>
      <div class="nxm-actions">
        <button class="nxm-cancel">Close</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    modal.querySelector(".nxm-cancel").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    return close;
  }

  modal.innerHTML = `
    <div class="nxm-title">Split at Headings</div>

    <div class="nxm-section">
      <div class="nxm-label">Split at</div>
      <select class="nxm-style-select sah-level-select">
        ${levels.map((l) => `<option value="${l}">${escHtml(LEVEL_LABELS[l] || ("Heading " + l))}</option>`).join("")}
      </select>
    </div>

    <div class="nxm-section">
      <label class="nxm-checkbox-label">
        <input type="checkbox" class="sah-h1-tabs" />
        Convert H1s to tabs
      </label>
      <label class="nxm-checkbox-label">
        <input type="checkbox" class="sah-delete-original" />
        Delete original
      </label>
    </div>

    <div class="nxm-section">
      <div class="nxm-label">Files to be created <span class="sah-count"></span></div>
      <ul class="sah-file-list"></ul>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-confirm">Split</button>
    </div>`;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const levelSelect = modal.querySelector(".sah-level-select");
  const h1Toggle = modal.querySelector(".sah-h1-tabs");
  const delToggle = modal.querySelector(".sah-delete-original");
  const list = modal.querySelector(".sah-file-list");
  const countEl = modal.querySelector(".sah-count");
  const confirmBtn = modal.querySelector(".nxm-confirm");

  function renderPreview() {
    const sections = splitSections(content, choices.level, {
      fallbackName: node.name || "Untitled",
    });
    list.innerHTML = sections.map((s) => `
      <li class="sah-file-row"><span class="sah-file-name">${escHtml(s.name)}</span></li>
    `).join("");
    countEl.textContent = `(${sections.length})`;
    confirmBtn.disabled = sections.length === 0;
  }

  levelSelect.addEventListener("change", () => {
    const v = parseInt(levelSelect.value, 10);
    choices.level = Number.isFinite(v) ? v : choices.level;
    renderPreview();
  });
  h1Toggle.addEventListener("change", () => { choices.convertH1sToTabs = h1Toggle.checked; });
  delToggle.addEventListener("change", () => { choices.deleteOriginal = delToggle.checked; });

  const cleanup = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cleanup(); }
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(); });
  modal.querySelector(".nxm-cancel").addEventListener("click", cleanup);

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Splitting…";
    try {
      await state.splitDocAtHeadings(node.id, {
        level: choices.level,
        convertH1sToTabs: choices.convertH1sToTabs,
        deleteOriginal: choices.deleteOriginal,
      });
      cleanup();
    } catch (err) {
      console.error("Split at headings failed:", err);
      confirmBtn.textContent = "Split failed";
      setTimeout(() => { confirmBtn.textContent = "Split"; confirmBtn.disabled = false; }, 2000);
    }
  });

  renderPreview();
  return cleanup;
}
