/**
 * Splitting a doc at its heading structure and combining several docs
 * into one. Companion to state-convert.js (project <-> tabbed-doc).
 *
 * - splitDocAtHeadings: break a single document at a chosen heading
 *   level (h1..h6) into a new Project of child docs — one child per
 *   section. The project lands in the same container as the original.
 *   Optionally rewrite H1 lines to Hush tab markers, and optionally move
 *   the original to Trash.
 * - combineDocsIntoDoc: merge an ordered list of docs into one new
 *   document where each source becomes a Hush tab section, under a
 *   user-chosen H1 title. Optionally move the originals to Trash.
 *
 * The heading parser (`listHeadingLevels` / `splitSections`) is exported
 * so the split modal can preview the resulting filenames live without
 * duplicating the rules.
 */

import { findNode, findNodeByFileId, findParentOfNode, uniqueChildName } from "./tree-helpers.js";
import { joinTabs } from "../editor/tabs.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** A markdown heading line: 1-6 leading `#`, at least one space, then
 *  the title. Capture group 1 is the `#` run (its length is the level),
 *  group 2 is the trimmed title. */
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
/** A level-1 heading specifically (exactly one `#`). */
const H1_RE = /^#[ \t]+(.+?)[ \t]*$/;

/** Filenames map to Dropbox / disk paths, so slashes can't survive in a
 *  section name. Everything else (spaces, punctuation) is fine — match
 *  the directness of the project<->doc conversion. */
function sanitizeName(name) {
  return String(name || "").replace(/[\/\\]/g, "-").trim() || "Untitled";
}

/** Load a doc's content, preferring the live editor buffer when the doc
 *  is the one currently open (so unsaved edits are honoured). */
export async function getDocContent(state, fileId) {
  if (state.currentFileId === fileId && state.editor?.getContent) {
    return state.editor.getContent() || "";
  }
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      return file.content || "";
    } catch (e) {
      console.warn("Load file for split:", e);
      return "";
    }
  }
  const file = state.files.find((f) => f.id === fileId);
  return file?.content || "";
}

/** Distinct heading levels present in `content`, ascending (e.g. [1,2]).
 *  Drives the split modal's level dropdown — only levels that actually
 *  occur are offered. */
export function listHeadingLevels(content) {
  const levels = new Set();
  for (const line of String(content || "").split(/\n/)) {
    const m = HEADING_RE.exec(line);
    if (m) levels.add(m[1].length);
  }
  return [...levels].sort((a, b) => a - b);
}

function h1LinesToTabMarkers(content) {
  return String(content || "")
    .split(/\n/)
    .map((line) => {
      const m = H1_RE.exec(line);
      return m ? `---${sanitizeName(m[1])}---` : line;
    })
    .join("\n");
}

function trimBlankEdges(lines) {
  const b = lines.slice();
  while (b.length && b[0].trim() === "") b.shift();
  while (b.length && b[b.length - 1].trim() === "") b.pop();
  return b;
}

/**
 * Split `content` into sections at headings of the given `level`. Each
 * heading at that level starts a new section whose body INCLUDES the
 * heading line (so the resulting doc keeps its title). Content before
 * the first matching heading becomes a leading section named
 * `fallbackName`. Returns `[{ name, content }]`.
 *
 * When `convertH1sToTabs` is set, every `# H1` line in the output is
 * rewritten to a `---H1---` Hush tab marker.
 */
export function splitSections(content, level, opts = {}) {
  const { convertH1sToTabs = false, fallbackName = "Untitled" } = opts;
  const lines = String(content || "").split(/\n/);
  const sections = [];
  let cur = { name: null, buf: [] };
  const flush = () => {
    const body = trimBlankEdges(cur.buf);
    if (cur.name === null) {
      if (body.length) sections.push({ name: sanitizeName(fallbackName), content: body.join("\n") });
    } else {
      sections.push({ name: cur.name, content: body.join("\n") });
    }
  };
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m && m[1].length === level) {
      flush();
      cur = { name: sanitizeName(m[2]), buf: [line] };
    } else {
      cur.buf.push(line);
    }
  }
  flush();
  if (convertH1sToTabs) {
    for (const s of sections) s.content = h1LinesToTabMarkers(s.content);
  }
  return sections;
}

/** Create a backing file + content for a child doc, returning its
 *  fileId. Mirrors the create/save/rename dance used by state-convert. */
async function createDocFile(state, name, content) {
  if (IS_TAURI) {
    const file = await tauriInvoke("create_file");
    await tauriInvoke("save_file", { id: file.id, content });
    await tauriInvoke("rename_file", { id: file.id, name });
    return file.id;
  }
  const fileId = crypto.randomUUID();
  state.files.unshift({
    id: fileId, name, content,
    modified: Math.floor(Date.now() / 1000),
  });
  return fileId;
}

export async function splitDocAtHeadings(state, nodeId, opts = {}) {
  const { level, convertH1sToTabs = false, deleteOriginal = false } = opts;
  const node = findNode(state.fileTree, nodeId);
  if (!node || node.type !== "document" || !node.fileId) return;
  if (!Number.isInteger(level) || level < 1 || level > 6) return;

  // Honour unsaved edits in the open doc before reading its content.
  if (state.currentFileId === node.fileId && state.dirty) {
    await state.saveCurrentFile();
  }
  const content = await getDocContent(state, node.fileId);

  const sections = splitSections(content, level, {
    convertH1sToTabs,
    fallbackName: node.name || "Untitled",
  });
  if (sections.length === 0) return;

  // Build the child docs. `uniqueChildName` keeps sibling names distinct
  // within the new project (two sections sharing a heading get (2), (3)).
  const projectNode = {
    id: crypto.randomUUID(),
    type: "project",
    name: node.name,
    children: [],
    flagged: node.flagged,
    ...(node.bgColor ? { bgColor: node.bgColor } : {}),
  };
  const childContents = [];
  for (const section of sections) {
    const name = uniqueChildName(projectNode, section.name, "document");
    const childFileId = await createDocFile(state, name, section.content);
    projectNode.children.push({
      id: crypto.randomUUID(),
      type: "document",
      name,
      fileId: childFileId,
      children: [],
      flagged: false,
    });
    childContents.push(section.content);
  }

  // Drop the project into the same container as the original — right
  // after it, so it reads as "here's what this doc became".
  const parent = findParentOfNode(state.fileTree, nodeId);
  const siblings = parent ? parent.children : state.fileTree;
  const idx = siblings.findIndex((n) => n.id === nodeId);
  if (idx >= 0) siblings.splice(idx + 1, 0, projectNode);
  else siblings.push(projectNode);

  if (!IS_TAURI) state._saveFilesLocal();
  else state.files = await tauriInvoke("list_files");
  await state.saveFileTree();

  // Detach from the original before any delete so deleteTreeNode's
  // "current file got removed" fallback doesn't open an unrelated doc.
  state.currentFileId = null;

  // Move the original to Trash if requested (recoverable — matches the
  // app's normal Delete semantics rather than a hard purge).
  if (deleteOriginal) {
    try { await state.deleteTreeNode(nodeId); } catch (e) { console.warn("split: delete original failed", e); }
  }

  await state.openProject(projectNode.id);

  state.emit("files-changed");
  state.syncProjectOrdering(projectNode.id);
  projectNode.children.forEach((child, i) => {
    state.syncCreateFile(child.id, child.fileId, childContents[i] || "");
  });
}

export async function combineDocsIntoDoc(state, fileIds, opts = {}) {
  const { name, deleteOriginals = false } = opts;
  const ids = Array.isArray(fileIds) ? fileIds : [];
  if (ids.length === 0) return;

  const title = sanitizeName(name) || "Combined Document";

  // Resolve each id to a doc node + content, in the order given.
  const sources = [];
  for (const fileId of ids) {
    const docNode = findNodeByFileId(state.fileTree, fileId);
    if (!docNode || docNode.type !== "document") continue;
    const content = await getDocContent(state, fileId);
    sources.push({ node: docNode, content });
  }
  if (sources.length === 0) return;

  // Root section carries the H1 title; each file becomes a tab section.
  const sections = [{ path: [], content: `# ${title}` }];
  for (const s of sources) {
    sections.push({ path: [s.node.name || "Untitled"], content: s.content });
  }
  const combined = joinTabs(sections);

  const created = await state.newFile(null, {
    initialName: title,
    initialContent: combined,
    openImmediately: true,
  });

  if (deleteOriginals) {
    for (const s of sources) {
      try { await state.deleteTreeNode(s.node.id); } catch (e) { console.warn("combine: delete original failed", e); }
    }
  }

  state.emit("files-changed");
  return created;
}
