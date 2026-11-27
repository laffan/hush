/**
 * A section link (`hush-section://<target>`, editor/plugins/
 * section-link-syntax.js) followed from anywhere but the Overview Doc —
 * the Doc opened in the main editor or a pane, or a link copied into
 * another document. It opens the Project Overview the link belongs to,
 * scrolled to the section.
 *
 * Which Overview: the project whose Overview Doc is the document on the
 * main surface, when it holds that section (the link is being read in
 * its own Doc); otherwise the nearest project above the section.
 */
import { findNode, findNodeByFileId, nearestAncestorProjectId } from "../state/tree-helpers.js";
import { parseSectionTarget, SECTION_URL_PREFIX } from "../editor/plugins/section-link-syntax.js";
import { boardData, resolveSectionTarget } from "./board/board-model.js";

/** Every project in the tree, outermost first. */
function projects(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === "project") out.push(n);
    if (n.children?.length) projects(n.children, out);
  }
  return out;
}

export async function openSectionLinkUrl(url) {
  const state = typeof window !== "undefined" ? window.__hushState__ : null;
  if (!state || !String(url).startsWith(SECTION_URL_PREFIX)) return;
  const target = String(url).slice(SECTION_URL_PREFIX.length);
  const tree = state.fileTree || [];

  // The Overview whose Doc is open on the main surface, if this section
  // is one of its own.
  const home = state.currentFileId
    ? projects(tree).find((p) => boardData(p).doc === state.currentFileId && resolveSectionTarget(p, target))
    : null;
  let projectId = home?.id || null;
  let focus = home ? resolveSectionTarget(home, target) : null;

  if (!projectId) {
    const { fileId, phId } = parseSectionTarget(target);
    if (phId) {
      // A placeholder lives on its project's board.
      const owner = projects(tree).find((p) => resolveSectionTarget(p, target));
      if (owner) { projectId = owner.id; focus = resolveSectionTarget(owner, target); }
    } else {
      const node = findNodeByFileId(tree, fileId);
      if (node) { projectId = nearestAncestorProjectId(tree, node.id); focus = { fileId }; }
    }
  }
  if (!projectId || !findNode(tree, projectId)) return;
  const { openProjectOverview } = await import("./project-overview.js");
  await openProjectOverview(state, projectId, { focusKey: focus?.fileId, focusPlaceholder: focus?.phId });
}
