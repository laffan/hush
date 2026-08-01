/**
 * YOU ARE HERE — a single "resume reading here" marker per desk.
 *
 * Typing the literal characters `YOUAREHERE` (caps, no spaces) into a
 * Doc or a Notebook text shape plants the marker: the token renders as
 * a bright red rounded tag in place, and the sidebar surfaces a red
 * `YOU ARE HERE : <filename>` row above the Flagged list. Clicking the
 * row opens the file *and* scrolls (docs) or pans (notebooks) to the
 * marker itself.
 *
 * Only one marker is permitted per desk. Planting a new one anywhere in
 * the desk automatically deletes the previous token — from the live
 * editor surface when the old holder is open (an ordinary, undoable
 * transaction), or by rewriting the file on disk when it isn't.
 *
 * Detection rides the save pipeline: every content write path already
 * reports through `state.syncFileToExternal(fileId, content)` (main
 * editor autosave, floating panes, stack tiles, project split-saves,
 * notebook autosaves), so `initYouAreHere` wraps that hook once and the
 * registry — `settings.youAreHere[deskId] = { fileId, fileType,
 * shapeId?, offset? }` — stays honest without per-call-site plumbing.
 * Same-buffer duplicates are handled earlier, at typing time, by the
 * editor plugin in `editor/plugins/you-are-here.js`.
 */

import { findNodeByFileId, findAncestorIds } from "./state/tree-helpers.js";

export const YAH_TOKEN = "YOUAREHERE";

/** Every offset of the literal token in `text`. */
export function findMarkerOffsets(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  let i = text.indexOf(YAH_TOKEN);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(YAH_TOKEN, i + YAH_TOKEN.length);
  }
  return out;
}

/** The desk node an id lives under, or null for strays / Local Sync. */
function deskOfNode(state, nodeId) {
  const tree = state.fileTree || [];
  const direct = tree.find((n) => n.type === "desk" && n.id === nodeId);
  if (direct) return direct;
  const ancestors = findAncestorIds(tree, nodeId) || [];
  for (const aid of ancestors) {
    const desk = tree.find((n) => n.type === "desk" && n.id === aid);
    if (desk) return desk;
  }
  return null;
}

function registry(state) {
  const reg = state.settings?.youAreHere;
  return reg && typeof reg === "object" ? reg : {};
}

async function writeRegistry(state, next) {
  await state.updateSettings({ youAreHere: next });
  state.emit("you-are-here-changed");
}

// ── Init ──────────────────────────────────────────────────────────────

let _initialized = false;

export function initYouAreHere(state) {
  if (_initialized) return;
  _initialized = true;

  // Every save path in the app reports through this hook with the
  // written content — the one choke point where fileId + fresh content
  // are both known, whatever surface produced the write.
  const prevSync = state.syncFileToExternal.bind(state);
  state.syncFileToExternal = async function (fileId, content, ...rest) {
    const result = await prevSync(fileId, content, ...rest);
    try { await onFileContentSaved(state, fileId, content); }
    catch (e) { console.warn("YOUAREHERE scan failed:", e); }
    return result;
  };

  // Files get deleted / moved between desks — keep the registry honest.
  state.on("files-changed", () => { void pruneRegistry(state); });

  // Self-heal: opening a doc whose buffer carries the token re-plants
  // the registry entry when the desk's slot is empty (or already this
  // file). Recovers from any historical registry wipe without waiting
  // for an edit — the marker text in the doc is the source of truth.
  state.on("file-opened", () => healOpenDoc(state));
  // This module initializes AFTER state.init already opened the boot
  // file (its file-opened fired before the listener above existed), so
  // run the heal once for whatever is open right now.
  queueMicrotask(() => healOpenDoc(state));

  // Debug handle — inspect the live registry and force a rescan of the
  // open doc from a console: __hushYouAreHere().
  if (typeof window !== "undefined") {
    window.__hushYouAreHere = () => {
      healOpenDoc(state);
      return {
        registry: state.settings?.youAreHere ?? null,
        activeDeskId: state.getActiveDesk?.()?.id || null,
        currentFileId: state.currentFileId || null,
      };
    };
  }
}

/** Re-register the open doc's marker when the desk slot is empty or
 *  already points at it (mere opening never steals another file's
 *  marker — a real edit settles that through the save pipeline). */
function healOpenDoc(state) {
  try {
    const fileId = state.currentFileId;
    if (!fileId || state.currentProjectId || !state.editor?.view) return;
    const content = state.editor.view.state.doc.toString();
    if (!content.includes(YAH_TOKEN)) return;
    const node = findNodeByFileId(state.fileTree || [], fileId);
    const desk = node ? deskOfNode(state, node.id) : null;
    if (!desk) return;
    const entry = registry(state)[desk.id];
    if (entry && entry.fileId && entry.fileId !== fileId) return;
    void onFileContentSaved(state, fileId, content);
  } catch (e) {
    console.warn("YOUAREHERE heal-on-open failed:", e);
  }
}

/** Drop registry entries whose file vanished; re-home entries whose
 *  file moved to a different desk (only when that desk's slot is free —
 *  when it's taken, the next save of either file settles the winner). */
async function pruneRegistry(state) {
  const tree = state.fileTree || [];
  // A transient tree state (mid-rebuild, boot tick, desk adoption)
  // must never wipe the registry — same guard the sticky module's
  // orphan pruning uses. Only prune against a tree that has desks.
  if (!tree.length || !tree.some((n) => n.type === "desk")) return;
  const reg = registry(state);
  const next = { ...reg };
  let changed = false;
  for (const [deskId, entry] of Object.entries(reg)) {
    if (!entry || !entry.fileId) { delete next[deskId]; changed = true; continue; }
    const node = findNodeByFileId(state.fileTree || [], entry.fileId);
    if (!node) { delete next[deskId]; changed = true; continue; }
    const desk = deskOfNode(state, node.id);
    if (!desk) { delete next[deskId]; changed = true; continue; }
    if (desk.id !== deskId) {
      delete next[deskId];
      if (!next[desk.id]) next[desk.id] = entry;
      changed = true;
    }
  }
  if (changed) await writeRegistry(state, next);
}

// ── Save-time detection + enforcement ─────────────────────────────────

/** Scan freshly-saved content for the marker and enforce the one-per-
 *  desk rule. `content` is a doc body for documents and the JSON
 *  envelope for notebooks. */
async function onFileContentSaved(state, fileId, content) {
  if (!fileId || typeof content !== "string") return;
  const node = findNodeByFileId(state.fileTree || [], fileId);
  if (!node || (node.type !== "document" && node.type !== "notebook")) return;
  const desk = deskOfNode(state, node.id);
  if (!desk) return;

  const has = content.includes(YAH_TOKEN);
  const reg = registry(state);
  const entry = reg[desk.id];

  if (!has) {
    // The marker's holder no longer carries it — the user deleted it.
    if (entry && entry.fileId === fileId) {
      const next = { ...reg };
      delete next[desk.id];
      await writeRegistry(state, next);
    }
    return;
  }

  if (node.type === "notebook") await ensureEnvelopeCodec();
  const fresh = markerLocation(node.type, content, entry, fileId);
  if (!fresh) return; // envelope didn't decode / marker only in non-text shapes

  // A new holder evicts the previous one — strip the old file's token.
  if (entry && entry.fileId && entry.fileId !== fileId) {
    await stripMarkerFromFile(state, entry);
  }

  const nextEntry = { fileId, fileType: node.type, ...fresh.extra };
  const next = { ...reg, [desk.id]: nextEntry };
  // The same file can't hold the marker in two desks (covers a marker
  // file that was moved across desks between saves).
  let crossDeskDrop = false;
  for (const [dId, e] of Object.entries(next)) {
    if (dId !== desk.id && e?.fileId === fileId) { delete next[dId]; crossDeskDrop = true; }
  }
  // Persist only structural changes. The doc offset drifts on every
  // edit above the marker — refreshing it in memory is enough (it's a
  // dedup tie-break heuristic, re-scanned live on jump), and skipping
  // the disk write avoids a settings save + sidebar repaint per
  // autosave while the marker's doc is being edited.
  const structural = !entry
    || entry.fileId !== nextEntry.fileId
    || entry.fileType !== nextEntry.fileType
    || (entry.shapeId || null) !== (nextEntry.shapeId || null)
    || crossDeskDrop;
  if (structural) {
    await writeRegistry(state, next);
  } else if (state.settings.youAreHere) {
    state.settings.youAreHere[desk.id] = nextEntry;
  }

  // Same-file duplicates that slipped past the live editor dedup (e.g.
  // a paste landing while the plugin was absent, or two notebook
  // shapes): keep the newest instance, drop the rest.
  if (fresh.duplicates) await stripDuplicatesInFile(state, node.type, fileId, content, nextEntry);
}

/** Where the marker sits in the saved content. Returns
 *  `{ extra: { offset } | { shapeId }, duplicates: boolean }` or null. */
function markerLocation(type, content, prevEntry, fileId) {
  if (type === "document") {
    const offsets = findMarkerOffsets(content);
    if (!offsets.length) return null;
    // With several instances the "new" one is whichever is NOT the
    // previously-recorded offset; keep the last as a tiebreak.
    let keep = offsets[offsets.length - 1];
    if (offsets.length > 1 && prevEntry?.fileId === fileId && typeof prevEntry.offset === "number") {
      const others = offsets.filter((o) => o !== nearestTo(offsets, prevEntry.offset));
      if (others.length) keep = others[others.length - 1];
    }
    return { extra: { offset: keep }, duplicates: offsets.length > 1 };
  }
  // Notebook envelope — find the text shapes carrying the token.
  const holders = notebookMarkerShapes(content);
  if (!holders.length) return null;
  let keep = holders[holders.length - 1];
  if (holders.length > 1 && prevEntry?.fileId === fileId && prevEntry.shapeId) {
    const others = holders.filter((id) => id !== prevEntry.shapeId);
    if (others.length) keep = others[others.length - 1];
  }
  const dupInShape = holders.length === 1 && countInShape(content, keep) > 1;
  return { extra: { shapeId: keep }, duplicates: holders.length > 1 || dupInShape };
}

function nearestTo(offsets, target) {
  let best = offsets[0];
  for (const o of offsets) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
  return best;
}

/** Shape ids of text shapes containing the token, in shapes-array order
 *  (commitText appends new shapes last, so later ≈ newer). */
function notebookMarkerShapes(envelope) {
  const parsed = tryDecodeEnvelope(envelope);
  if (!parsed) return [];
  const out = [];
  for (const s of parsed.shapes || []) {
    if (s?.type !== "text" || typeof s.text !== "string" || s.headerLabel) continue;
    if (s.text.includes(YAH_TOKEN)) out.push(s.id);
  }
  return out;
}

function countInShape(envelope, shapeId) {
  const parsed = tryDecodeEnvelope(envelope);
  const shape = parsed?.shapes?.find((s) => s.id === shapeId);
  return shape ? findMarkerOffsets(shape.text).length : 0;
}

let _decodeEnvelope = null;
function tryDecodeEnvelope(envelope) {
  try {
    if (!_decodeEnvelope) return null; // loaded lazily below
    return _decodeEnvelope(envelope);
  } catch (_) {
    return null;
  }
}
// The notebook-content module is tiny and dependency-free, but load it
// lazily anyway so the boot path stays untouched for users who never
// plant a marker.
async function ensureEnvelopeCodec() {
  if (_decodeEnvelope) return;
  const m = await import("./notebook/notebook-content.ts");
  _decodeEnvelope = m.decodeNotebookContent;
  _encodeEnvelope = m.encodeNotebookContent;
}
let _encodeEnvelope = null;

// ── Stripping the previous marker ─────────────────────────────────────

/** Remove every token instance from the file a registry entry points
 *  at. Prefers live surfaces (undoable, keeps open buffers honest) and
 *  falls back to a disk rewrite + cross-window broadcast. */
async function stripMarkerFromFile(state, entry) {
  if (!entry?.fileId) return;
  if (entry.fileType === "notebook") return stripMarkerFromNotebook(state, entry.fileId);
  return stripMarkerFromDoc(state, entry.fileId, null);
}

/** Remove token instances from a document, optionally keeping the one
 *  at `keepOffset` (null keeps none). */
async function stripMarkerFromDoc(state, fileId, keepOffset) {
  // Live main editor?
  if (state.currentFileId === fileId && !state.currentProjectId && state.editor?.view) {
    stripInView(state.editor.view, keepOffset);
    return;
  }
  // Live doc pane in this window?
  try {
    const { getDocPaneViewsForFile } = await import("./pane/pane-manager.js");
    const views = getDocPaneViewsForFile(fileId);
    if (views.length) {
      stripInView(views[0], keepOffset);
      return;
    }
  } catch (_) {}
  // Not open here — rewrite on disk and tell sibling windows.
  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const file = await invoke("load_file", { id: fileId });
    if (!file || typeof file.content !== "string") return;
    const next = removeToken(file.content, keepOffset);
    if (next === file.content) return;
    await invoke("save_file", { id: fileId, content: next });
    const { broadcastDocChanged } = await import("./multi-window.js");
    void broadcastDocChanged(fileId, next);
  } catch (e) {
    console.warn("YOUAREHERE strip (doc) failed:", e);
  }
}

/** Dispatch an ordinary (undoable) transaction deleting the token.
 *  `keepOffset` came from *saved* content — the live buffer may have
 *  drifted since, so keep the live instance nearest to it rather than
 *  requiring an exact match (an exact-only keep could delete every
 *  instance when offsets shifted). */
function stripInView(view, keepOffset) {
  const text = view.state.doc.toString();
  const offsets = findMarkerOffsets(text);
  if (!offsets.length) return;
  const keep = keepOffset != null ? nearestTo(offsets, keepOffset) : null;
  const changes = [];
  for (const o of offsets) {
    if (keep != null && o === keep) continue;
    changes.push({ from: o, to: o + YAH_TOKEN.length });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "delete" });
}

function removeToken(text, keepOffset) {
  const offsets = findMarkerOffsets(text);
  let out = "";
  let cursor = 0;
  for (const o of offsets) {
    if (keepOffset != null && o === keepOffset) continue;
    out += text.slice(cursor, o);
    cursor = o + YAH_TOKEN.length;
  }
  out += text.slice(cursor);
  return out;
}

/** Remove the token from a notebook's text shapes, optionally keeping
 *  the instance(s) inside `keepShapeId`. */
async function stripMarkerFromNotebook(state, fileId, keepShapeId = null) {
  await ensureEnvelopeCodec();
  // Live canvas? Mutate through mirrorContent so undo + autosave behave.
  if (state.currentNotebookFileId === fileId) {
    try {
      const { getCanvasInstance } = await import("./notebook/notebook-bridge.js");
      const ci = getCanvasInstance?.();
      if (ci?.state) {
        const shapes = ci.getShapes().map((s) => {
          if (s.type !== "text" || typeof s.text !== "string" || s.id === keepShapeId) return s;
          if (!s.text.includes(YAH_TOKEN)) return s;
          return { ...s, text: removeToken(s.text, null) };
        });
        ci.mirrorContent({
          shapes,
          layers: ci.state.layers,
          flowEdges: ci.state.flowchart.serialize(),
          bookmarks: ci.state.bookmarks,
        });
        return;
      }
    } catch (e) {
      console.warn("YOUAREHERE strip (live notebook) failed:", e);
    }
  }
  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const file = await invoke("load_file", { id: fileId });
    const parsed = file && _decodeEnvelope ? _decodeEnvelope(file.content) : null;
    if (!parsed) return;
    let changed = false;
    for (const s of parsed.shapes || []) {
      if (s?.type !== "text" || typeof s.text !== "string" || s.id === keepShapeId) continue;
      if (!s.text.includes(YAH_TOKEN)) continue;
      s.text = removeToken(s.text, null);
      changed = true;
    }
    if (!changed) return;
    await invoke("save_file", { id: fileId, content: _encodeEnvelope(parsed) });
    const { broadcastNotebookChanged } = await import("./multi-window.js");
    void broadcastNotebookChanged(fileId);
  } catch (e) {
    console.warn("YOUAREHERE strip (notebook) failed:", e);
  }
}

/** Same-file duplicate cleanup — keep the registry-recorded instance. */
async function stripDuplicatesInFile(state, type, fileId, content, entry) {
  if (type === "document") {
    await stripMarkerFromDoc(state, fileId, entry?.offset ?? null);
  } else {
    await stripMarkerFromNotebook(state, fileId, entry?.shapeId ?? null);
  }
}

// ── Sidebar entries + jump ────────────────────────────────────────────

/** `[{ deskId, fileId, fileType, fileName }]` for the desks whose
 *  markers should show in the sidebar right now (the active desk, or
 *  every desk in the all-desks view). */
export function youAreHereEntriesFor(state, deskIds) {
  const reg = registry(state);
  const out = [];
  for (const deskId of deskIds) {
    const entry = reg[deskId];
    if (!entry?.fileId) continue;
    const node = findNodeByFileId(state.fileTree || [], entry.fileId);
    if (!node) continue;
    out.push({
      deskId,
      fileId: entry.fileId,
      fileType: entry.fileType || node.type,
      fileName: node.name || "Untitled",
    });
  }
  return out;
}

/** Open the marker's file and land the view on the marker itself:
 *  docs select + centre the token, notebooks pan to its shape. */
export async function jumpToYouAreHere(state, entry) {
  if (!entry?.fileId) return;
  if (entry.fileType === "notebook") {
    if (state.currentNotebookFileId !== entry.fileId) {
      await state.openNotebook(entry.fileId);
    }
    const { getCanvasInstance } = await import("./notebook/notebook-bridge.js");
    // openNotebook fires an event; the actual canvas mount is async —
    // poll briefly (same pattern as the find panel's jump).
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const ci = getCanvasInstance?.();
      if (ci?.state && Array.isArray(ci.getShapes?.())) {
        const target = ci.getShapes().find(
          (s) => s.type === "text" && typeof s.text === "string" && s.text.includes(YAH_TOKEN)
        );
        if (target) {
          ci.state.focusShape(target.id);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    return;
  }
  // Document: open, wait for the editor to mount the buffer, then
  // select + centre the token (re-scanned live, so edits since the
  // registry write can't strand the jump).
  if (state.ratchetMode) return;
  if (state.currentFileId !== entry.fileId || state.currentProjectId) {
    await state.openFile(entry.fileId);
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  }
  const view = state.editor?.view;
  if (!view) return;
  const offset = view.state.doc.toString().indexOf(YAH_TOKEN);
  if (offset < 0) return;
  const { EditorView } = await import("@codemirror/view");
  view.dispatch({
    selection: { anchor: offset, head: offset + YAH_TOKEN.length },
    effects: EditorView.scrollIntoView(offset, { y: "center" }),
  });
  view.focus();
}
