/**
 * External-change apply for floating panes (the Gutter included — a
 * gutter is a docked notebook pane, so it rides this path with no
 * special case).
 *
 * A pane is a second window onto a file, and like every other secondary
 * surface it only ever read that file once: at create. When the bytes
 * change underneath — a sync provider delivering the far device's edit —
 * nothing told the pane, so a reference pane sat on content that had
 * moved on, and the Gutter's marginalia drifted out of step with the doc
 * beside it. The desk reconcile calls `refreshPanesFromDisk` on every
 * pass, exactly as it re-reads the open doc, notebook and stack.
 *
 * A pane whose file is *also* the open main surface has always been kept
 * in step by the `doc-content-changed` / `notebook-shapes-changed`
 * mirrors; this covers every other pane, which is most of them — a pane
 * exists to show something you are *not* looking at.
 *
 * The policy is the one shared by all four surfaces: our own content
 * back is a no-op, a pane with unsaved edits is strictly newer than disk
 * and keeps what it has (its autosave reasserts it), and nothing
 * per-device — caret, scroll, camera — is taken from the far side.
 *
 * Lives in its own module rather than pane-content.js because that file
 * is at the 700-line cap.
 */

import { panes, IS_TAURI, tauriInvoke } from "./pane-state.js";
import { updatePaneWordCount } from "./pane-content.js";

/** File types whose pane surface can take an external change. PDFs are
 *  a per-device binary cache, stacks/zotero/desktop panes hold no file
 *  buffer of their own. */
const RELOADABLE = new Set(["document", "notebook"]);

/** Apply externally-produced `content` to one pane. Returns true when
 *  the pane now matches it. */
export async function applyExternalToPane(pane, content) {
  if (!pane || typeof content !== "string") return false;
  if (!RELOADABLE.has(pane.fileType) || pane.dirty) return false;
  // Content we already applied is the common case — this runs on every
  // reconcile pass, and re-decoding a multi-MB notebook envelope to
  // discover it hasn't changed is not free. (The doc branch's own
  // equality check covers docs; this is what covers notebooks.)
  if (pane._extApplied === content) return false;
  pane._extApplied = content;

  if (pane.fileType === "document") {
    if (!pane.editor || pane.editor.getContent() === content) return false;
    // `setContent` is a minimal common-prefix/suffix diff carrying the
    // programmatic annotations, so the caret maps through the change
    // instead of collapsing to the top.
    pane.editor.setContent(content);
    // Clear on the same tick: the mirror dispatch reaches the pane's own
    // change handler, and a dirty flag left up would autosave the
    // just-loaded content straight back over the wire.
    pane.dirty = false;
    updatePaneWordCount(pane);
    return true;
  }

  if (!pane.notebook || typeof pane.notebook.mirrorContent !== "function") return false;
  const { decodeNotebookContent } = await import("../notebook/notebook-content.ts");
  const snap = decodeNotebookContent(content);
  if (!snap) return false;
  // Mirror rather than load, so the pane's own undo history survives and
  // the remote edit lands as one checkpoint. The incoming camera is
  // deliberately dropped — a viewport is per-device.
  pane.notebook.mirrorContent({
    shapes: snap.shapes,
    layers: snap.layers,
    flowEdges: snap.flowEdges,
    bookmarks: Array.isArray(snap.bookmarks) ? snap.bookmarks : undefined,
  });
  pane.dirty = false;
  return true;
}

/** Re-read every open pane's file and apply it.
 *
 * Reads are de-duplicated by fileId: the same doc can legitimately be
 * open in several panes at once (different contexts, an inline pane plus
 * a floating one), and one IPC round trip serves all of them. Local
 * Folder panes are skipped — those mounts have their own watcher and
 * address files by path, not fileId. */
let _inFlight = null;

export function refreshPanesFromDisk() {
  if (!IS_TAURI || panes.size === 0) return Promise.resolve();
  // Coalesce: every local desk reconciles separately, so one burst of
  // provider activity can call this several times over. Panes aren't
  // scoped to a desk (a pane onto another desk's file is the normal
  // case), so each of those calls would otherwise re-read every pane.
  // Sharing the in-flight pass collapses them without ever skipping one.
  if (!_inFlight) _inFlight = _refresh().finally(() => { _inFlight = null; });
  return _inFlight;
}

async function _refresh() {
  const targets = new Map(); // fileId → panes wanting it
  for (const [, pane] of panes) {
    if (!pane?.fileId || pane.localSync) continue;
    if (!RELOADABLE.has(pane.fileType) || pane.dirty) continue;
    if (!targets.has(pane.fileId)) targets.set(pane.fileId, []);
    targets.get(pane.fileId).push(pane);
  }
  // One batched `stat` before any reading: most passes find nothing has
  // moved, and a pane onto a big notebook is not cheap to re-read.
  const { movedSince } = await import("../sync/file-freshness.js");
  const moved = await movedSince([...targets.keys()]);
  for (const [fileId, group] of targets) {
    if (!moved.has(fileId)) continue;
    let content = null;
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      content = file?.content ?? null;
    } catch (_) { continue; } // removed or unreadable — leave the panes as they are
    if (typeof content !== "string") continue;
    for (const pane of group) {
      // The read is async, so the pane may have been closed across it —
      // its editor is destroyed by then, and touching one throws.
      if (!panes.has(pane.id)) continue;
      try { await applyExternalToPane(pane, content); }
      catch (e) { console.warn("pane external reload failed:", e); }
    }
  }
}
