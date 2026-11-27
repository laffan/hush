/**
 * The Project Overview board's model — what the rows are, and the data
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
 *   { doc: fileId,
 *     placeholders: [{ id, afterId, parentId?, outline }],
 *     notes: { [fileId]: "plain text" },
 *     created: { [placeholderId]: fileId } }
 *
 * `doc` is the **Overview Doc** — the column down the board's left: a
 * real document called Overview, kept in the project as a note ("Use as
 * note") and pinned first among its children (tree-helpers.js
 * normalizeProjectChildren), whose section links
 * (editor/plugins/section-link-syntax.js) point at the rows. It counts
 * only while it is one of the project's own children. `created`
 * remembers which document each created placeholder became, so a
 * section link made to the placeholder follows it.
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
import {
  findNode, findNodeByFileId, findParentOfNode, isRealProjectNode, normalizeProjectChildren, overviewDocFileIdOf,
} from "../../state/tree-helpers.js";
import { parseSectionTarget } from "../../editor/plugins/section-link-syntax.js";
import { parseOutlineLine, stripInlineMarkdown } from "../../outline/outline-model.ts";
import { findFrontmatterRange } from "../../editor/frontmatter.js";

export const WORDS_PER_PAGE = 500;
export const EMPTY_OUTLINE = "- [ ] ";

export const boardData = (project) => {
  const b = project?.board && typeof project.board === "object" ? project.board : {};
  return {
    doc: typeof b.doc === "string" && b.doc ? b.doc : null,
    placeholders: Array.isArray(b.placeholders) ? b.placeholders : [],
    notes: b.notes && typeof b.notes === "object" ? b.notes : {},
    created: b.created && typeof b.created === "object" ? b.created : {},
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
 *  nested projects' included, as tree nodes in tree order. Overview Docs
 *  (the board's own, and nested projects') are the board's, not
 *  material. */
export function materials(project) {
  const out = [];
  const walk = (nodes, owner) => {
    const own = boardData(owner).doc;
    for (const n of nodes || []) {
      if (n.cardsHome || n.pdfAlias) continue;
      if (n.type === "document" && n.useAsNote) { if (!own || n.fileId !== own) out.push(n); }
      else if (["notebook", "stack", "pdf"].includes(n.type) && !n.gutter) out.push(n);
      if (n.children?.length) walk(n.children, n.type === "project" ? n : owner);
    }
  };
  walk(project?.children, project);
  return out;
}

/** The project's Overview Doc's tree node, or null — none made yet, or
 *  the one it had is no longer among the project's own children (moved
 *  out, or into a folder; deleted). */
export function overviewDocNode(project) {
  const fileId = overviewDocFileIdOf(project);
  if (!fileId) return null;
  return (project.children || []).find((n) => n.type === "document" && n.fileId === fileId) || null;
}

/** The sections a piece of the Overview Doc can link to — the board's
 *  rows that are documents or placeholders, in reading order:
 *  `{ target: { fileId } | { phId }, name, depth, groups }`, `groups`
 *  being the nested projects the row is the first of, outermost first
 *  (for headings over it). An empty nested project is an entry with no
 *  target. */
export function sectionList(project) {
  const out = [];
  for (const row of boardRows(project)) {
    if (row.kind === "doc") {
      out.push({ target: { fileId: row.node.fileId }, name: row.node.name || "Untitled", depth: row.depth, groups: row.groups });
    } else if (row.kind === "placeholder") {
      out.push({ target: { phId: row.ph.id }, name: placeholderName(row.ph), depth: row.depth, groups: row.groups, placeholder: true });
    } else if (row.groups?.length) {
      // A nested project with nothing in it yet: only its name.
      out.push({ target: null, name: "", depth: row.depth, groups: row.groups });
    }
  }
  return out;
}

/** What a section link's target (a string — section-link-syntax.js)
 *  points at on this board: `{ fileId, name }` for a document row,
 *  `{ phId, name }` for a placeholder, null when it is on neither (the
 *  document left the project's text, the placeholder was removed). A
 *  placeholder that has been created points at the document it became. */
export function resolveSectionTarget(project, target) {
  if (!project) return null;
  const { fileId, phId } = parseSectionTarget(target);
  const rows = boardRows(project);
  if (phId) {
    const ph = rows.find((r) => r.kind === "placeholder" && r.ph.id === phId);
    if (ph) return { phId, name: placeholderName(ph.ph) || "Untitled placeholder" };
    const made = boardData(project).created[phId];
    return made ? resolveSectionTarget(project, made) : null;
  }
  const doc = rows.find((r) => r.kind === "doc" && r.node.fileId === fileId);
  return doc ? { fileId, name: doc.node.name || "Untitled" } : null;
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
  const board = { placeholders: data.placeholders, notes: data.notes };
  if (data.doc) board.doc = data.doc;
  if (Object.keys(data.created || {}).length) board.created = data.created;
  project.board = board;
}

/** Make the project's Overview Doc: a document called Overview in the
 *  project, kept out of its text as a note, pinned first. Its name stays
 *  (state-naming.js leaves it alone), so it needs no title line.
 *  `content` is what it starts with — the board makes it at the first
 *  keystroke in its column. Returns `{ fileId, name }`, or null. */
export async function createOverviewDoc(state, projectId, content = "") {
  const project = findNode(state.fileTree, projectId);
  if (!project) return null;
  const made = await state.newFile(project.id, {
    openImmediately: false,
    initialName: "Overview",
    initialContent: content,
  });
  if (!made) return null;
  const node = findNodeByFileId(project.children || [], made.fileId);
  if (node) node.useAsNote = true;
  const data = boardData(project);
  data.doc = made.fileId;
  writeBoard(project, data);
  normalizeProjectChildren(state.fileTree); // pins it first
  await state.saveFileTree();
  state.emit("files-changed");
  return made;
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
  // A section link made to the placeholder follows its document.
  data.created = { ...data.created, [phId]: made.fileId };
  writeBoard(project, data);
  await state.saveFileTree();
  await state.syncProjectOrdering?.(projectId);
  state.emit("files-changed");
  return made;
}
