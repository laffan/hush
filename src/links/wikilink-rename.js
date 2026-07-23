/**
 * Rewrite every `[[OldName]]` reference in the user's docs and notebooks
 * to `[[NewName]]` after a tree-node rename. Both file types are
 * supported: docs are plain markdown so a regex replace is sufficient,
 * notebooks store a JSON envelope so we decode it, rewrite TextShape
 * bodies in place, and re-encode.
 *
 * Called from `state-tree.js::renameTreeNode` after the rename itself
 * has landed on disk. Side-effects are kept narrow: the in-memory
 * `state.files` cache is updated, each touched file is written through
 * `save_file`, and — if one of them happens to be the currently-open
 * doc / notebook — the live editor / canvas content is refreshed too.
 */

import { escapeForRegex } from "./wikilink-index.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const NOTEBOOK_ENVELOPE_RE = /^\s*\{[^]*"format"\s*:\s*"hushnote"/;

function isNotebookContent(content) {
  if (!content || typeof content !== "string") return false;
  return NOTEBOOK_ENVELOPE_RE.test(content);
}

/** Build a regex that matches `[[OldName]]` ignoring leading/trailing
 *  whitespace inside the brackets (Obsidian-style trim). Case-sensitive
 *  match — the user-facing title comparison is case-insensitive when
 *  resolving, but rewriting only the exact-case occurrences avoids
 *  surprise edits to deliberately-cased prose like a quoted title. */
function buildWikilinkRegex(oldName) {
  const escaped = escapeForRegex(oldName);
  return new RegExp("\\[\\[\\s*" + escaped + "\\s*\\]\\]", "g");
}

function rewriteDocContent(content, oldName, newName) {
  if (!content) return null;
  const re = buildWikilinkRegex(oldName);
  if (!re.test(content)) return null;
  re.lastIndex = 0;
  return content.replace(re, "[[" + newName + "]]");
}

function rewriteNotebookContent(content, oldName, newName) {
  if (!content) return null;
  // Cheap pretest on the raw JSON string before paying for a full parse —
  // stroke-heavy notebook envelopes can be megabytes, and this runs for
  // every notebook in the library on every rename (including the 1.5 s
  // idle-debounce title renames while a first line is typed). A name
  // containing `"` or `\` would be JSON-escaped in the raw text, so only
  // those rare names skip the shortcut and parse unconditionally.
  if (!/["\\]/.test(oldName)) {
    const pre = buildWikilinkRegex(oldName);
    if (!pre.test(content)) return null;
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.shapes)) return null;
  const re = buildWikilinkRegex(oldName);
  let changed = false;
  for (const shape of parsed.shapes) {
    if (shape && shape.type === "text" && typeof shape.text === "string") {
      re.lastIndex = 0;
      if (re.test(shape.text)) {
        re.lastIndex = 0;
        shape.text = shape.text.replace(re, "[[" + newName + "]]");
        changed = true;
      }
    }
  }
  if (!changed) return null;
  return JSON.stringify(parsed);
}

/** Rewrite wikilinks pointing to `oldName` across every doc and
 *  notebook. The `nodeType` argument scopes propagation — renaming a
 *  folder doesn't move any wikilink target, so we skip the walk
 *  entirely for non-leaf node types. */
export async function propagateWikilinkRename(state, oldName, newName, nodeType) {
  if (!oldName || !newName || oldName === newName) return;
  if (nodeType !== "document" && nodeType !== "notebook") return;
  if (!Array.isArray(state.files)) return;

  const touched = [];
  for (const file of state.files) {
    if (!file || typeof file.content !== "string") continue;
    const next = isNotebookContent(file.content)
      ? rewriteNotebookContent(file.content, oldName, newName)
      : rewriteDocContent(file.content, oldName, newName);
    if (next == null) continue;
    file.content = next;
    touched.push(file.id);
    if (IS_TAURI) {
      try { await tauriInvoke("save_file", { id: file.id, content: next }); }
      catch (e) { console.error("wikilink rename: save_file failed", file.id, e); }
    }
  }

  if (!touched.length) return;

  // Refresh the live editor / canvas if the user is sitting on a file
  // whose content we just rewrote underneath them. Docs: re-seed the
  // CodeMirror buffer (bypasses ratchet + separator filters via the
  // existing `setContent` path). Notebooks: re-import the snapshot via
  // the notebook bridge.
  if (state.currentFileId && touched.includes(state.currentFileId) && state.editor) {
    const fresh = state.files.find((f) => f.id === state.currentFileId);
    if (fresh) state.editor.setContent(fresh.content);
  }
  if (state.currentNotebookFileId && touched.includes(state.currentNotebookFileId)) {
    const fresh = state.files.find((f) => f.id === state.currentNotebookFileId);
    if (fresh && typeof fresh.content === "string") {
      try {
        const m = await import("../notebook/notebook-bridge.js");
        if (typeof m.reloadNotebookShapes === "function") {
          await m.reloadNotebookShapes(fresh.content);
        }
      } catch (_) {
        // Notebook bridge isn't loaded yet (web fallback / pre-mount).
      }
    }
  }

  // Persist + sync. We deliberately don't fire `files-changed` here:
  // the rename caller already does, and the file contents (not the
  // tree) are what changed.
  if (!IS_TAURI) state._saveFilesLocal?.();
}
