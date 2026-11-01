/**
 * The Project Desktop board's model — what the rows are, and the data
 * the board keeps of its own.
 *
 * **Rows** are the project's text, in reading order: every document that
 * feeds the joined buffer (`collectDocumentIds`' rule — not a "Use as
 * note" doc), and between them the user's **placeholders**, documents not
 * written yet. The rest of the project — notebooks, stacks, notes, PDFs —
 * is its **material**, listed apart.
 *
 * **Board data** rides the project's tree node as `board` (Rust
 * `TreeNode.board`, opaque there), so it syncs with the desk:
 *
 *   { placeholders: [{ id, afterId, title, outline }],
 *     notes: { [fileId]: "- [ ] …" } }
 *
 * A placeholder sits after the document whose node id is `afterId`
 * (null: before the first); several in one gap keep their array order;
 * one whose document has gone falls to the end. `outline` and the notes
 * are outline markdown — nested checklists, what the outline module
 * (outline/outline-canvas-element.js) edits.
 */
import { findNode } from "../../state/tree-helpers.js";
import { parseOutlineLine, stripInlineMarkdown } from "../../outline/outline-model.ts";
import { stripFrontmatter, findFrontmatterRange } from "../../editor/frontmatter.js";

export const WORDS_PER_PAGE = 500;
export const EMPTY_OUTLINE = "- [ ] ";

export const boardData = (project) => {
  const b = project?.board && typeof project.board === "object" ? project.board : {};
  return {
    placeholders: Array.isArray(b.placeholders) ? b.placeholders : [],
    notes: b.notes && typeof b.notes === "object" ? b.notes : {},
  };
};

/** The project's text documents, in order (tree nodes). */
export function textDocs(project) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === "document" && n.fileId && !n.useAsNote) out.push(n);
      if (n.children?.length && n.type !== "project") walk(n.children);
    }
  };
  walk(project?.children);
  return out;
}

/** Everything else in the project — notebooks, stacks, notes, PDFs, a
 *  nested project — as tree nodes, in tree order. */
export function materials(project) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.cardsHome || n.pdfAlias) continue;
      if (n.type === "document" && n.useAsNote) out.push(n);
      else if (["notebook", "stack", "pdf", "project"].includes(n.type) && !n.gutter) out.push(n);
      if (n.children?.length && n.type !== "project") walk(n.children);
    }
  };
  walk(project?.children);
  return out;
}

/** The board's rows: `{ kind: "doc", node }` and
 *  `{ kind: "placeholder", ph }`, in order. */
export function boardRows(project) {
  const docs = textDocs(project);
  const { placeholders } = boardData(project);
  const ids = new Set(docs.map((d) => d.id));
  const after = (key) => placeholders.filter((p) => (p.afterId || null) === key)
    .map((ph) => ({ kind: "placeholder", ph }));
  const rows = [...after(null)];
  for (const node of docs) {
    rows.push({ kind: "doc", node });
    rows.push(...after(node.id));
  }
  // Placeholders whose document is gone keep their place at the end.
  for (const ph of placeholders) {
    if (ph.afterId && !ids.has(ph.afterId)) rows.push({ kind: "placeholder", ph });
  }
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

/** The first words of the body, for a document with no headings. */
export function leadOf(content, words = 14) {
  const body = stripFrontmatter(String(content || "")).replace(/<<<[\s\S]*?>>>/g, " ");
  return body.split(/\s+/).filter(Boolean).slice(0, words).join(" ");
}

// ── Writing board data ─────────────────────────────────────────────

function writeBoard(project, data) {
  project.board = { placeholders: data.placeholders, notes: data.notes };
}

export async function addPlaceholder(state, projectId, afterId) {
  const project = findNode(state.fileTree, projectId);
  if (!project) return null;
  const data = boardData(project);
  const ph = { id: crypto.randomUUID(), afterId: afterId || null, title: "", outline: EMPTY_OUTLINE };
  // A new placeholder goes last among any already in that gap.
  const lastInGap = data.placeholders.map((p) => p.afterId || null).lastIndexOf(afterId || null);
  data.placeholders.splice(lastInGap + 1, 0, ph);
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
  if (!text || !text.replace(/^\s*-\s*\[[ xX]\]\s*$/gm, "").trim()) delete data.notes[fileId];
  else data.notes[fileId] = text;
  writeBoard(project, data);
}

/** A placeholder's document text: its title as the first line (a level
 *  1 heading) and each outline item as a heading one level deeper per
 *  step of nesting — so the document's own outline, where the
 *  placeholder's was, reads as the plan did. Empty when there is neither
 *  title nor outline: a blank document. */
export function placeholderContent(ph) {
  const title = String(ph.title || "").trim();
  const items = String(ph.outline || "").split("\n").map((l, i) => parseOutlineLine(l, i))
    .filter((it) => it && stripInlineMarkdown(it.text || "").trim());
  if (!title && !items.length) return "";
  const top = title ? 2 : 1;
  const lines = title ? [`# ${title}`, ""] : [];
  for (const it of items) {
    const level = Math.min(6, top + (it.depth || 0));
    lines.push(`${"#".repeat(level)} ${stripInlineMarkdown(it.text).trim()}`, "");
  }
  return lines.join("\n");
}

/** Turn a placeholder into a document in its place. */
export async function createFromPlaceholder(state, projectId, phId) {
  const project = findNode(state.fileTree, projectId);
  if (!project) return null;
  const data = boardData(project);
  const ph = data.placeholders.find((p) => p.id === phId);
  if (!ph) return null;
  const content = placeholderContent(ph);
  const title = String(ph.title || "").trim();
  const made = await state.newFile(projectId, {
    openImmediately: false,
    initialName: title || undefined,
    initialContent: content,
  });
  if (!made) return null;
  // newFile puts it last; move it to the placeholder's gap — after the
  // document it followed, ahead of anything after that.
  const kids = project.children || [];
  const idx = kids.findIndex((c) => c.fileId === made.fileId);
  if (idx >= 0) {
    const [node] = kids.splice(idx, 1);
    const anchor = ph.afterId ? kids.findIndex((c) => c.id === ph.afterId) : -1;
    const at = ph.afterId && anchor < 0 ? kids.length : anchor + 1;
    kids.splice(at, 0, node);
    // Placeholders that followed this one now follow the new document.
    for (const p of data.placeholders) {
      if (p !== ph && (p.afterId || null) === (ph.afterId || null)
        && data.placeholders.indexOf(p) > data.placeholders.indexOf(ph)) p.afterId = node.id;
    }
  }
  data.placeholders = data.placeholders.filter((p) => p.id !== phId);
  writeBoard(project, data);
  await state.saveFileTree();
  await state.syncProjectOrdering?.(projectId);
  state.emit("files-changed");
  return made;
}
