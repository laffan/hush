/**
 * The Project Desktop board's model — what the rows are, and the data
 * the board keeps of its own.
 *
 * **Rows** are the project's text, in reading order: every document that
 * feeds the joined buffer (`collectDocumentIds`' rule — not a "Use as
 * note" doc), nested projects' documents included, each at the `depth`
 * of the project it sits in (0 for the board's own); and between them
 * the user's **placeholders**, documents not written yet. The rest — the
 * notes, notebooks, stacks and PDFs, nested projects' too — is the
 * project's **material**, listed apart.
 *
 * **Board data** rides the project's tree node as `board` (Rust
 * `TreeNode.board`, opaque there), so it syncs with the desk:
 *
 *   { placeholders: [{ id, afterId, parentId?, outline }],
 *     notes: { [fileId]: "plain text" } }
 *
 * A placeholder sits after the node `afterId` (a document, or a nested
 * project, in whatever container holds it); with no `afterId` it sits at
 * the head of the container `parentId` (absent: the board's project).
 * Several in one gap keep their array order; one whose node has gone
 * falls to the end. `outline` is outline markdown — a nested checklist,
 * what the outline module (outline/outline-canvas-element.js) edits; a
 * document's notes are plain text. A placeholder's **name** is
 * its outline's first item (placeholderName); without one it can't be
 * created.
 */
import { findNode, findParentOfNode, isRealProjectNode } from "../../state/tree-helpers.js";
import { parseOutlineLine, stripInlineMarkdown } from "../../outline/outline-model.ts";
import { findFrontmatterRange } from "../../editor/frontmatter.js";

export const WORDS_PER_PAGE = 500;
export const EMPTY_OUTLINE = "- [ ] ";

export const boardData = (project) => {
  const b = project?.board && typeof project.board === "object" ? project.board : {};
  return {
    placeholders: Array.isArray(b.placeholders) ? b.placeholders : [],
    notes: b.notes && typeof b.notes === "object" ? b.notes : {},
  };
};

const isTextDoc = (n) => n.type === "document" && n.fileId && !n.useAsNote;
const isNested = (n) => n.type === "project" && isRealProjectNode(n);

/** An outline's items with words in them. */
function outlineItems(outline) {
  return String(outline || "").split("\n").map((l, i) => parseOutlineLine(l, i))
    .filter((it) => it && stripInlineMarkdown(it.text || "").trim());
}

/** A placeholder's outline, reading an older placeholder's separate
 *  title as its first item. */
export function placeholderOutline(ph) {
  const title = String(ph?.title || "").trim();
  if (title && !outlineItems(ph.outline).length) return `- [ ] ${title}`;
  return ph?.outline || EMPTY_OUTLINE;
}

/** The name a placeholder's document will take: its outline's first
 *  item, or "" when it has none yet. */
export function placeholderName(ph) {
  const first = outlineItems(placeholderOutline(ph))[0];
  return first ? stripInlineMarkdown(first.text).replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 50) : "";
}

/** The project's other files — notes, notebooks, stacks, PDFs — its
 *  nested projects' included, as tree nodes in tree order. */
export function materials(project) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.cardsHome || n.pdfAlias) continue;
      if (n.type === "document" && n.useAsNote) out.push(n);
      else if (["notebook", "stack", "pdf"].includes(n.type) && !n.gutter) out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(project?.children);
  return out;
}

/** The board's rows, in order:
 *    `{ kind: "doc", node, depth, containerId, gap }`
 *    `{ kind: "placeholder", ph, depth, containerId, gap }`
 *    `{ kind: "group", node, depth }` — a nested project with nothing in it
 *  `depth` counts nested projects; `containerId` is the node a row lives
 *  in, and `gap` the `afterId` a placeholder put just before it takes.
 *  Every row also carries `groups`: the nested projects it is the first
 *  row of, outermost first, for the connector to name. */
export function boardRows(project) {
  const { placeholders } = boardData(project);
  const rows = [];
  const placed = new Set();
  let entering = [];
  const push = (row) => { row.groups = entering; entering = []; rows.push(row); };
  const phRow = (ph, depth, containerId) => {
    placed.add(ph.id);
    push({ kind: "placeholder", ph, depth, containerId, gap: ph.afterId || null });
  };
  const walk = (container, depth, isTop) => {
    const start = rows.length;
    for (const ph of placeholders) {
      if (!ph.afterId && ((ph.parentId || project.id) === container.id || (isTop && !ph.parentId))) phRow(ph, depth, container.id);
    }
    let prev = null;
    for (const n of container.children || []) {
      if (isTextDoc(n)) {
        push({ kind: "doc", node: n, depth, containerId: container.id, gap: prev });
        prev = n.id;
      } else if (isNested(n)) {
        entering = [...entering, n];
        const before = rows.length;
        walk(n, depth + 1, false);
        if (rows.length === before) push({ kind: "group", node: n, depth: depth + 1 });
        prev = n.id;
      } else if (n.type === "folder" && n.children?.length) {
        walk(n, depth, false);
        continue;
      } else continue;
      for (const ph of placeholders) if (ph.afterId === n.id) phRow(ph, depth, container.id);
    }
    return rows.length > start;
  };
  walk(project, 0, true);
  // Placeholders whose place has gone keep it at the end.
  for (const ph of placeholders) if (!placed.has(ph.id)) phRow(ph, 0, project.id);
  return rows;
}

/** Where a page starts, every WORDS_PER_PAGE words of the body (the
 *  text after the frontmatter): `{ starts: [offset…], words }`, offsets
 *  into the whole content. */
export function paginate(content) {
  const text = String(content || "");
  const fm = findFrontmatterRange(text);
  const base = fm ? fm.to + 1 : 0;
  const starts = [base];
  let words = 0;
  const re = /\S+/g;
  re.lastIndex = base;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (words > 0 && words % WORDS_PER_PAGE === 0) starts.push(m.index);
    words++;
  }
  return { starts, words };
}

/** The page holding `offset`. */
export const pageOf = (starts, offset) => {
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= offset) i++;
  return i;
};

/** A document's headings: `{ text, level, from, to }` (from/to: the
 *  heading line), fenced code skipped. */
export function headingsOf(content) {
  const text = String(content || "");
  const fm = findFrontmatterRange(text);
  const out = [];
  let pos = 0;
  let fence = false;
  for (const line of text.split("\n")) {
    const from = pos;
    pos += line.length + 1;
    if (fm && from <= fm.to) continue;
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ text: stripInlineMarkdown(m[2]), level: m[1].length, from, to: from + line.length });
  }
  return out;
}

// ── Writing board data ─────────────────────────────────────────────

function writeBoard(project, data) {
  project.board = { placeholders: data.placeholders, notes: data.notes };
}

/** Add a placeholder in a gap: after node `afterId`, or at the head of
 *  `parentId` (null: the board's project). It goes before the
 *  placeholder `beforePhId` when given (adding just above one), else
 *  last in the gap. */
export async function addPlaceholder(state, projectId, { afterId = null, parentId = null, beforePhId = null } = {}) {
  const project = findNode(state.fileTree, projectId);
  if (!project) return null;
  const data = boardData(project);
  const ph = { id: crypto.randomUUID(), afterId: afterId || null, outline: EMPTY_OUTLINE };
  if (!afterId && parentId && parentId !== projectId) ph.parentId = parentId;
  const sameGap = (p) => (p.afterId || null) === ph.afterId && (ph.afterId || (p.parentId || null) === (ph.parentId || null));
  const before = beforePhId ? data.placeholders.findIndex((p) => p.id === beforePhId) : -1;
  let at = before;
  if (at < 0) {
    at = data.placeholders.length;
    for (let i = data.placeholders.length - 1; i >= 0; i--) if (sameGap(data.placeholders[i])) { at = i + 1; break; }
  }
  data.placeholders.splice(at, 0, ph);
  writeBoard(project, data);
  await state.saveFileTree();
  return ph;
}

export function updatePlaceholder(state, projectId, phId, patch) {
  const project = findNode(state.fileTree, projectId);
  const data = boardData(project);
  const ph = data.placeholders.find((p) => p.id === phId);
  if (!ph) return false;
  Object.assign(ph, patch);
  writeBoard(project, data);
  return true;
}

export async function removePlaceholder(state, projectId, phId) {
  const project = findNode(state.fileTree, projectId);
  if (!project) return;
  const data = boardData(project);
  data.placeholders = data.placeholders.filter((p) => p.id !== phId);
  writeBoard(project, data);
  await state.saveFileTree();
}

export function setNotes(state, projectId, fileId, text) {
  const project = findNode(state.fileTree, projectId);
  if (!project) return;
  const data = boardData(project);
  if (!String(text || "").trim()) delete data.notes[fileId];
  else data.notes[fileId] = text;
  writeBoard(project, data);
}

/** A placeholder's document text: its first outline item as the
 *  title line (a level 1 heading) and every other item as a heading, one
 *  level deeper per step of nesting (never above level 2) — so the
 *  document's own outline, where the placeholder's was, reads as the
 *  plan did. */
export function placeholderContent(ph) {
  const items = outlineItems(placeholderOutline(ph));
  if (!items.length) return "";
  const lines = [`# ${stripInlineMarkdown(items[0].text).trim()}`, ""];
  for (const it of items.slice(1)) {
    const level = Math.min(6, Math.max(2, (it.depth || 0) + 1));
    lines.push(`${"#".repeat(level)} ${stripInlineMarkdown(it.text).trim()}`, "");
  }
  return lines.join("\n");
}

/** The container a placeholder will be created in. */
function placeholderContainer(state, project, ph) {
  if (ph.afterId) {
    const after = findNode(state.fileTree, ph.afterId);
    if (after) return findParentOfNode(state.fileTree, ph.afterId) || project;
  }
  return (ph.parentId && findNode(state.fileTree, ph.parentId)) || project;
}

/** Turn a placeholder into a document in its place, named by its
 *  outline's first item. Refused (null) while it has none. */
export async function createFromPlaceholder(state, projectId, phId) {
  const project = findNode(state.fileTree, projectId);
  if (!project) return null;
  const data = boardData(project);
  const ph = data.placeholders.find((p) => p.id === phId);
  if (!ph) return null;
  const name = placeholderName(ph);
  if (!name) return null;
  const container = placeholderContainer(state, project, ph);
  const made = await state.newFile(container.id, {
    openImmediately: false,
    initialName: name,
    initialContent: placeholderContent(ph),
  });
  if (!made) return null;
  // newFile puts it last; move it to the placeholder's gap — after the
  // node it followed (or first), ahead of anything after that.
  const kids = container.children || [];
  const idx = kids.findIndex((c) => c.fileId === made.fileId);
  if (idx >= 0) {
    const [node] = kids.splice(idx, 1);
    const anchor = ph.afterId ? kids.findIndex((c) => c.id === ph.afterId) : -1;
    const at = ph.afterId && anchor < 0 ? kids.length : anchor + 1;
    kids.splice(at, 0, node);
    // Placeholders that followed this one in its gap now follow the new
    // document.
    const gap = (p) => `${p.afterId || ""}|${p.afterId ? "" : p.parentId || ""}`;
    const mine = data.placeholders.indexOf(ph);
    for (const p of data.placeholders) {
      if (p !== ph && gap(p) === gap(ph) && data.placeholders.indexOf(p) > mine) { p.afterId = node.id; delete p.parentId; }
    }
  }
  data.placeholders = data.placeholders.filter((p) => p.id !== phId);
  writeBoard(project, data);
  await state.saveFileTree();
  await state.syncProjectOrdering?.(projectId);
  state.emit("files-changed");
  return made;
}
