/**
 * Project headings in the files sidebar.
 *
 * When Settings > `showProjectHeadings` is on (toggled by the command
 * palette's **Show / Hide Project Headings**), every document row grows
 * small synthetic child rows — one per markdown heading in the doc —
 * indented by heading level, so a project reads like a table of
 * contents straight from the file browser. Clicking a heading opens the
 * doc scrolled to that section.
 *
 * A heading on the doc's first content line is skipped: the filename
 * already derives from the first line, so the row would just repeat the
 * name directly above it.
 *
 * Mirrors files-panel-tabs.js: the rows are *not* persisted — injected
 * just before SortableList builds the DOM, stripped before any tree
 * write, and opted out of every drag-and-drop path.
 */
import { parseHeadings, sanitizeLine } from "../longview/longview-parser.js";
import { readDocContent, openDocAtTab } from "./files-panel-tabs.js";

/** True for the synthetic rows this module injects. */
export function isHeadingItem(item) {
  return item?.type === "doc-heading";
}

/** Offset of the first content line — past a `---` frontmatter block
 *  and any blank lines — matching how first-line filename derivation
 *  decides which line *is* the name. */
function firstContentLineOffset(text) {
  const lines = text.split("\n");
  let offset = 0;
  let i = 0;
  if (lines[0]?.trim() === "---") {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== "---") j++;
    if (j < lines.length) {
      for (let k = 0; k <= j; k++) offset += lines[k].length + 1;
      i = j + 1;
    }
  }
  while (i < lines.length && lines[i].trim() === "") {
    offset += lines[i].length + 1;
    i++;
  }
  return offset;
}

/** `[{ text, level, offset }, …]` for a document's headings, in source
 *  order, minus a heading sitting on the first content line (that one
 *  is the filename). */
export function getHeadingsForDoc(state, fileId) {
  const text = readDocContent(state, fileId);
  if (!text) return [];
  const nameOffset = firstContentLineOffset(text);
  const out = [];
  for (const h of parseHeadings(text, 0)) {
    if (h.startOffset === nameOffset) continue;
    const clean = sanitizeLine(h.text);
    if (!clean) continue;
    out.push({ text: clean, level: h.level, offset: h.startOffset });
  }
  return out;
}

/** Walk the tree and append synthetic heading children under every
 *  `type: "document"` node. Runs *after* augmentTreeWithTabs, so tab
 *  markers keep their slot and headings land beneath them. Pure —
 *  never mutates the input. No-op while the setting is off. */
export function augmentTreeWithHeadings(state, tree) {
  if (!state?.settings?.showProjectHeadings) return tree;
  if (!Array.isArray(tree)) return tree;
  return tree.map((node) => augmentNode(state, node));
}

function augmentNode(state, node) {
  if (!node || typeof node !== "object") return node;
  let nextChildren = node.children;
  if (Array.isArray(node.children) && node.children.length) {
    nextChildren = node.children.map((child) => augmentNode(state, child));
  }
  if (node.type === "document" && node.fileId && !node.gutter) {
    const headings = getHeadingsForDoc(state, node.fileId);
    if (headings.length) {
      const rows = headings.map((h) => ({
        id: `heading:${node.id}:${h.offset}`,
        type: "doc-heading",
        name: h.text,
        fileId: node.fileId,
        headingOffset: h.offset,
        headingLevel: h.level,
        children: [],
      }));
      const baseChildren = Array.isArray(nextChildren) ? nextChildren : [];
      return { ...node, children: [...baseChildren, ...rows] };
    }
  }
  if (nextChildren !== node.children) return { ...node, children: nextChildren };
  return node;
}

/** Inverse of `augmentTreeWithHeadings` — drops every synthetic node so
 *  the saved file tree never inherits one. */
export function stripHeadingsFromTree(tree) {
  if (!Array.isArray(tree)) return tree;
  const out = [];
  for (const node of tree) {
    if (isHeadingItem(node)) continue;
    if (Array.isArray(node?.children) && node.children.length) {
      out.push({ ...node, children: stripHeadingsFromTree(node.children) });
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Inline DOM for a heading row — a `#`-count glyph plus the heading
 *  text, indented one step per level past H1. Click handler attached
 *  directly (SortableList suppresses clicks on non-draggable rows —
 *  same reasoning as renderTabMarkerRow). */
export function renderHeadingRow(item, onJump) {
  const row = document.createElement("span");
  row.className = "tree-item-row tree-heading-row";
  const level = Math.max(1, Math.min(6, item.headingLevel || 1));
  row.style.paddingLeft = `${(level - 1) * 10}px`;
  const glyph = document.createElement("span");
  glyph.className = "tree-heading-glyph";
  glyph.textContent = "#".repeat(level);
  row.appendChild(glyph);
  const nameEl = document.createElement("span");
  nameEl.className = "tree-item-name tree-heading-name" + (level === 1 ? " tree-heading-h1" : "");
  nameEl.textContent = item.name || "";
  row.appendChild(nameEl);
  if (typeof onJump === "function") {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onJump(item);
    });
  }
  return row;
}

/** Open the doc scrolled to the heading — same mechanics as a tab
 *  marker jump, so reuse it. */
export function openDocAtHeading(state, fileId, offset) {
  return openDocAtTab(state, fileId, offset);
}
