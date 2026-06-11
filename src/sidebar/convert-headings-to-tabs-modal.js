/**
 * "Convert Headings to Tabs" modal.
 *
 * Companion to the Split at Headings modal, but instead of breaking the
 * document into multiple files it rewrites the open document in place so
 * its headings at a chosen level become Hush `---Tab name---` markers.
 * The level dropdown only offers heading levels that actually occur in
 * the doc; below it a live list previews the tabs that will be created.
 * A "Keep headings at the top of each tab" checkbox keeps the heading
 * line inside each tab's content rather than replacing it with the
 * marker.
 *
 * Reuses the notebook-export-modal (`nxm-*`) shell + the split modal's
 * `sah-*` styling for visual consistency.
 */

import { findNode, findNodeByFileId } from "../state/tree-helpers.js";
import {
  getDocContent, listHeadingLevels, headingsToTabs,
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

export async function openConvertHeadingsToTabsModal(state, nodeId = null) {
  const node = resolveNode(state, nodeId);
  if (!node || node.type !== "document" || !node.fileId) return () => {};

  const content = await getDocContent(state, node.fileId);
  const levels = listHeadingLevels(content);

  document.querySelectorAll(".cht-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "notebook-export-backdrop sah-backdrop cht-backdrop";
  const modal = document.createElement("div");
  modal.className = "notebook-export-modal sah-modal";

  const choices = {
    level: levels[0] || 1,
    keepHeadings: false,
  };

  if (levels.length === 0) {
    modal.innerHTML = `
      <div class="nxm-title">Convert Headings to Tabs</div>
      <div class="sah-empty">This document has no headings to convert.</div>
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
    <div class="nxm-title">Convert Headings to Tabs</div>

    <div class="nxm-section">
      <div class="nxm-label">Convert at</div>
      <select class="nxm-style-select sah-level-select">
        ${levels.map((l) => `<option value="${l}">${escHtml(LEVEL_LABELS[l] || ("Heading " + l))}</option>`).join("")}
      </select>
    </div>

    <div class="nxm-section">
      <label class="nxm-checkbox-label">
        <input type="checkbox" class="cht-keep-headings" />
        Keep headings at the top of each tab
      </label>
    </div>

    <div class="nxm-section">
      <div class="nxm-label">Tabs to be created <span class="sah-count"></span></div>
      <ul class="sah-file-list"></ul>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-confirm">Convert</button>
    </div>`;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const levelSelect = modal.querySelector(".sah-level-select");
  const keepToggle = modal.querySelector(".cht-keep-headings");
  const list = modal.querySelector(".sah-file-list");
  const countEl = modal.querySelector(".sah-count");
  const confirmBtn = modal.querySelector(".nxm-confirm");

  function renderPreview() {
    const { tabs } = headingsToTabs(content, choices.level, { keepHeadings: choices.keepHeadings });
    list.innerHTML = tabs.map((name) => `
      <li class="sah-file-row"><span class="sah-file-name">${escHtml(name)}</span></li>
    `).join("");
    countEl.textContent = `(${tabs.length})`;
    confirmBtn.disabled = tabs.length === 0;
  }

  levelSelect.addEventListener("change", () => {
    const v = parseInt(levelSelect.value, 10);
    choices.level = Number.isFinite(v) ? v : choices.level;
    renderPreview();
  });
  keepToggle.addEventListener("change", () => { choices.keepHeadings = keepToggle.checked; });

  const cleanup = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cleanup(); }
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(); });
  modal.querySelector(".nxm-cancel").addEventListener("click", cleanup);

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Converting…";
    try {
      await state.convertHeadingsToTabs(node.id, {
        level: choices.level,
        keepHeadings: choices.keepHeadings,
      });
      cleanup();
    } catch (err) {
      console.error("Convert headings to tabs failed:", err);
      confirmBtn.textContent = "Convert failed";
      setTimeout(() => { confirmBtn.textContent = "Convert"; confirmBtn.disabled = false; }, 2000);
    }
  });

  renderPreview();
  return cleanup;
}
