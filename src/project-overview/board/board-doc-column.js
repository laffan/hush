/**
 * The Overview Doc's column — fixed down the left of the Project
 * Overview, beside the scrolling list of the project's documents.
 *
 * It holds the project's Overview Doc (board-model.js `doc`) as a pane
 * (board-pane.js, made with `doc`), whose editor carries the section
 * links (section-links.js): select text, pick a section, and the words
 * link to it; a click on them scrolls the list to that section. Until
 * the project has an Overview Doc the column offers to start one.
 *
 * The column is built once per opening and kept across the board's
 * re-renders, which rebuild only the list beside it — so writing in the
 * Doc never waits for, or is disturbed by, the board redrawing.
 */
import { findNode } from "../../state/tree-helpers.js";
import { overviewDocNode, createOverviewDoc, sectionList, resolveSectionTarget } from "./board-model.js";
import { openRowPane, adoptSlot, docPaneView, closeRowPane } from "./board-pane.js";

/**
 * @param {object} o
 * @param {object} o.state      app state
 * @param {string} o.projectId  the board's project
 * @param {(target: {fileId?: string, phId?: string}) => void} o.onFollow
 *   scroll the list to a section
 */
export function createDocColumn({ state, projectId, onFollow }) {
  const el = document.createElement("aside");
  el.className = "po-doc-col";
  let shownFileId = null;
  let extensions = null;
  let starting = false;
  let opening = false;

  const project = () => findNode(state.fileTree || [], projectId);

  async function sectionExtensions() {
    if (extensions) return extensions;
    const { sectionLinks } = await import("../section-links.js");
    extensions = sectionLinks({
      resolve: (target) => resolveSectionTarget(project(), target),
      sections: () => (project() ? sectionList(project()) : []),
      onFollow: (target) => {
        const to = resolveSectionTarget(project(), target);
        if (to) onFollow(to);
      },
    });
    return extensions;
  }

  function showEmpty() {
    shownFileId = null;
    el.classList.remove("has-doc");
    el.innerHTML = `<div class="po-doc-empty">`
      + `<div class="board-section-label">Overview</div>`
      + `<p>Write about the project as a whole. Select any of it to link those words to one of the project's documents; a click on a link brings that document into view.</p>`
      + `<button type="button" class="board-open-pane po-doc-start">Start an Overview Doc</button>`
      + `</div>`;
    el.querySelector(".po-doc-start").addEventListener("click", start);
  }

  async function start() {
    if (starting) return;
    starting = true;
    try {
      const made = await createOverviewDoc(state, projectId);
      if (made) await showDoc({ fileId: made.fileId, name: made.name }, { focusEnd: true });
    } finally {
      starting = false;
    }
  }

  async function showDoc(node, { focusEnd = false } = {}) {
    if (shownFileId === node.fileId) return;
    shownFileId = node.fileId;
    el.classList.add("has-doc");
    el.innerHTML = "";
    const slot = document.createElement("div");
    slot.className = "board-pane-slot po-doc-slot";
    el.appendChild(slot);
    if (adoptSlot(node.fileId, slot)) return;
    opening = true;
    let pane = null;
    try {
      pane = await openRowPane(state, {
        fileId: node.fileId, name: node.name, slot, containerId: projectId,
        focus: false, doc: { extensions: await sectionExtensions() },
      });
    } finally {
      opening = false;
    }
    if (focusEnd && pane?.editor?.view) {
      const view = pane.editor.view;
      requestAnimationFrame(async () => {
        const { focusPane } = await import("../../pane/pane-manager.js");
        focusPane(pane.id);
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      });
    }
  }

  /** Bring the column up to date with the project: its Doc (made,
   *  moved out, deleted), and its links' names. */
  function update() {
    const p = project();
    if (!p) return;
    const node = overviewDocNode(p);
    if (!node) {
      // The Doc left the project (moved out, deleted): its pane goes.
      if (shownFileId) void closeRowPane(shownFileId);
      if (shownFileId !== null || !el.firstChild) showEmpty();
      return;
    }
    if (node.fileId !== shownFileId) { void showDoc(node); return; }
    const view = docPaneView(node.fileId);
    // Its pane was closed some other way (a palette command): put it back.
    if (!view && !opening) { shownFileId = null; void showDoc(node); return; }
    if (view) {
      import("../section-links.js").then(({ refreshSectionLinks }) => {
        view.dispatch({ effects: refreshSectionLinks.of(null) });
      }).catch(() => {});
    }
  }

  return { el, update };
}
