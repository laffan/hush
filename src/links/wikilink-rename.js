/**
 * Rewrite every `[[OldName]]` reference in the user's docs and notebooks
 * to `[[NewName]]` after a tree-node rename.
 *
 * Called from `state-tree.js::renameTreeNode` after the rename itself has
 * landed on disk — which means it runs on the naming rule's 1.5 s
 * typing-idle debounce (README-TECHNICAL, "Naming rule"), so it is a hot
 * path.
 *
 * **The walk lives in Rust** (`src-tauri/src/wikilinks.rs`). It used to
 * run here, over `state.files`, which only worked because that cache held
 * every file's content — and holding it is what made boot read the whole
 * library. Notebooks no longer carry content in the listing, so the scan
 * moved to the side that can read a `.hushnote`'s `data.json` without
 * inflating its images. What stays here is the in-memory half: patch the
 * cached document bodies so the sidebar's tab and heading rows don't go
 * stale, and refresh whichever surface the user is looking at.
 *
 * Outside Tauri (browser dev) the cache does hold everything, so the
 * original in-memory rewrite is still the whole job.
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
 *  surprise edits to deliberately-cased prose like a quoted title.
 *  `wikilinks.rs#rewrite_doc` matches the same shape by scanning bracket
 *  pairs; keep the two in step. */
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
  // Cheap pretest on the raw JSON string before paying for a full parse.
  // A name containing `"` or `\` would be JSON-escaped in the raw text,
  // so only those rare names skip the shortcut and parse unconditionally.
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

/** Browser-dev path: `state.files` holds every file's content, so the
 *  rewrite and the write-back are the same operation. */
function rewriteCachedFiles(state, oldName, newName) {
  const touched = [];
  for (const file of state.files || []) {
    if (!file || typeof file.content !== "string") continue;
    const next = isNotebookContent(file.content)
      ? rewriteNotebookContent(file.content, oldName, newName)
      : rewriteDocContent(file.content, oldName, newName);
    if (next == null) continue;
    file.content = next;
    touched.push(file.id);
  }
  return touched;
}

/** Apply the same edit Rust just made on disk to whatever document
 *  bodies the listing still caches. Pure string work — no IO, and no
 *  re-listing, which would put the whole-library read back on the
 *  rename path. Entries with `content: null` (notebooks, stacks) have
 *  nothing to keep in step. */
function patchCachedDocs(state, touched, oldName, newName) {
  const ids = new Set(touched);
  for (const file of state.files || []) {
    if (!ids.has(file?.id) || typeof file.content !== "string") continue;
    const next = rewriteDocContent(file.content, oldName, newName);
    if (next != null) file.content = next;
  }
}

/** Rewrite wikilinks pointing to `oldName` across every doc and
 *  notebook. The `nodeType` argument scopes propagation — renaming a
 *  folder doesn't move any wikilink target, so we skip the walk
 *  entirely for non-leaf node types. */
export async function propagateWikilinkRename(state, oldName, newName, nodeType) {
  if (!oldName || !newName || oldName === newName) return;
  if (nodeType !== "document" && nodeType !== "notebook") return;

  let touched = [];
  if (IS_TAURI) {
    try {
      touched = await tauriInvoke("rename_wikilinks", { oldName, newName }) || [];
    } catch (e) {
      console.error("wikilink rename: rename_wikilinks failed", e);
      return;
    }
    patchCachedDocs(state, touched, oldName, newName);
  } else {
    touched = rewriteCachedFiles(state, oldName, newName);
  }

  if (!touched.length) return;

  // Refresh the live editor / canvas if the user is sitting on a file
  // whose content we just rewrote underneath them. Docs: re-seed the
  // CodeMirror buffer (bypasses ratchet + separator filters via the
  // existing `setContent` path). Notebooks: re-import the snapshot via
  // the notebook bridge.
  if (state.currentFileId && touched.includes(state.currentFileId) && state.editor) {
    const fresh = (state.files || []).find((f) => f.id === state.currentFileId);
    if (fresh && typeof fresh.content === "string") state.editor.setContent(fresh.content);
  }
  if (state.currentNotebookFileId && touched.includes(state.currentNotebookFileId)) {
    // The listing no longer caches notebook bytes, so read the one file
    // that matters back off disk rather than the whole library.
    let content = null;
    if (IS_TAURI) {
      try { content = (await tauriInvoke("load_file", { id: state.currentNotebookFileId }))?.content; }
      catch (e) { console.warn("wikilink rename: notebook reload failed", e); }
    } else {
      content = (state.files || []).find((f) => f.id === state.currentNotebookFileId)?.content;
    }
    if (typeof content === "string") {
      try {
        const m = await import("../notebook/notebook-bridge.js");
        if (typeof m.reloadNotebookShapes === "function") {
          await m.reloadNotebookShapes(content);
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
