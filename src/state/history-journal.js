/**
 * History journal — the session-level tier of undo, between per-editor
 * undo/redo (keystroke granularity) and Versions (file-content
 * granularity).
 *
 * A ring buffer of the last 100 workspace states. Every semantic app
 * transition — opening a doc / notebook / stack / PDF / project /
 * Local Folder file, opening / closing / focusing a pane — records an
 * entry that captures EVERYTHING needed to return to that moment:
 * which surface was open, the full serialized pane layout (same shape
 * `panes.json` persists), the main editor scroll / notebook camera,
 * and which pane held focus. `restoreJournalEntry` is the orchestrator
 * that walks it all back: reopen the surface, rebuild the pane set,
 * re-apply scroll / camera / focus.
 *
 * Recording is event-driven (appState events + the `pane-activity`
 * breadcrumbs pane-manager emits); the journal never polls. The panel
 * UI lives in sidebar/history-panel.js.
 */

import { findNode, findNodeByFileId } from "./tree-helpers.js";

const MAX_ENTRIES = 100;

let _state = null;
let _entries = [];
let _seq = 0;
let _suppressDepth = 0;

export function getJournalEntries() {
  return _entries;
}

/** Suppress recording while the journal itself (or boot) mutates the
 *  workspace, so a restore doesn't spam entries for every pane it
 *  rebuilds. */
export function suppressJournal(on) {
  _suppressDepth = Math.max(0, _suppressDepth + (on ? 1 : -1));
}

export function initHistoryJournal(state) {
  _state = state;
  state.on("file-opened", () => record("open", describeSurface(captureSurface())));
  state.on("notebook-open", () => record("open", describeSurface(captureSurface())));
  state.on("stack-open", () => record("open", describeSurface(captureSurface())));
  state.on("pdf-open", () => record("open", describeSurface(captureSurface())));
  state.on("no-file-state", () => record("open", "No file"));
  state.on("pane-activity", (info) => {
    if (!info) return;
    const name = info.name || "Untitled";
    if (info.kind === "opened") record("pane-opened", `Pane opened: ${name}`, name);
    else if (info.kind === "closed") record("pane-closed", `Pane closed: ${name}`, name);
    else if (info.kind === "focused") record("focus", `Focus: ${name}`, name);
  });
  // The boot open fired before this module loaded — seed the timeline
  // with the session's starting state.
  record("open", describeSurface(captureSurface()));
}

/** Record a journal entry for the workspace as it stands right now. */
function record(type, label, subject = "") {
  if (!_state || _suppressDepth > 0) return;
  const surface = captureSurface();
  const signature = `${type}|${subject}|${surfaceKey(surface)}`;
  const last = _entries[_entries.length - 1];
  // Dedupe noise: identical consecutive transitions (e.g. re-clicking
  // the already-open file), and the focus event that immediately
  // follows a pane's own open.
  if (last && last.signature === signature) { last.timestamp = Date.now(); return; }
  if (type === "focus" && last && last.type === "pane-opened"
      && last.subject === subject && Date.now() - last.timestamp < 1000) return;

  const entry = {
    id: ++_seq,
    type,
    label,
    subject,
    signature,
    timestamp: Date.now(),
    state: {
      surface,
      panes: [],
      activePaneFileId: null,
      scrollTop: null,
      camera: null,
      // Content ghost for the hover preview: the doc buffer's text, or
      // the notebook's shapes (image bitmaps stripped). The preview is
      // meant to be an exact picture of what the user saw — pane boxes
      // over the wrong base document read as the wrong state entirely.
      docText: null,
      notebook: null,
    },
  };
  _entries.push(entry);
  if (_entries.length > MAX_ENTRIES) _entries.shift();

  // Pane layout + viewport are captured best-effort and async (dynamic
  // imports keep the state layer from statically depending on the pane
  // layer). Anything that lands after the entry is fine — the entry is
  // "the workspace around this moment".
  void fillWorkspaceDetail(entry);
  _state.emit("history-journal-changed");
}

async function fillWorkspaceDetail(entry) {
  try {
    const [{ serializePanes }, paneState] = await Promise.all([
      import("../pane/pane-persistence.js"),
      import("../pane/pane-state.js"),
    ]);
    entry.state.panes = serializePanes();
    const activeId = paneState.activePaneId;
    const active = activeId ? paneState.panes.get(activeId) : null;
    entry.state.activePaneFileId = active ? active.fileId : null;
  } catch (_) {}
  // Give surface opens a couple of frames so their own scroll / camera
  // restores settle before we sample them.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const kind = entry.state.surface.kind;
    if (kind === "notebook") {
      const { getCanvasInstance } = await import("../notebook/notebook-bridge.js");
      const canvas = getCanvasInstance();
      const cam = canvas?.state?.camera;
      if (cam) entry.state.camera = { x: cam.x, y: cam.y, zoom: cam.zoom };
      if (canvas) {
        // Deep-clone shapes with image bitmaps dropped — an ImageShape
        // inlines its whole file as a dataUrl, and 100 retained entries
        // must not hoard megabytes of pixels. The preview re-resolves
        // images from the live canvas's cache when it can.
        const shapes = canvas.getShapes().map((s) =>
          s.type === "image" ? { ...s, dataUrl: "" } : s);
        const json = JSON.stringify({ shapes, layers: canvas.state.layers });
        if (json.length <= 2_000_000) entry.state.notebook = JSON.parse(json);
      }
    } else if (kind === "doc" || kind === "localsync-doc" || kind === "project") {
      if (_state?.editor?.view) entry.state.scrollTop = _state.editor.view.scrollDOM.scrollTop;
      const text = _state?.editor?.getContent?.();
      if (typeof text === "string") entry.state.docText = text.slice(0, 200_000);
    }
  } catch (_) {}
}

/** What the main surface is showing right now, with enough identity to
 *  reopen it later. */
function captureSurface() {
  const s = _state;
  if (!s) return { kind: "empty" };
  const ls = s.currentLocalSync;
  if (s.currentProjectId) {
    return { kind: "project", id: s.currentProjectId, name: findNode(s.fileTree, s.currentProjectId)?.name || "Project" };
  }
  if (s.currentNotebookFileId) {
    return {
      kind: "notebook", id: s.currentNotebookFileId,
      localSync: ls && ls.kind === "notebook" ? { folderId: ls.folderId, relPath: ls.relPath } : null,
      name: nameForFile(s, s.currentNotebookFileId, ls),
    };
  }
  if (s.currentStackFileId) {
    return {
      kind: "stack", id: s.currentStackFileId,
      localSync: ls && ls.kind === "stack" ? { folderId: ls.folderId, relPath: ls.relPath } : null,
      name: nameForFile(s, s.currentStackFileId, ls),
    };
  }
  if (s.currentPdfFileId) {
    return { kind: "pdf", id: s.currentPdfFileId, name: nameForFile(s, s.currentPdfFileId, null) };
  }
  if (ls && ls.kind === "doc") {
    return { kind: "localsync-doc", localSync: { folderId: ls.folderId, relPath: ls.relPath }, name: baseName(ls.relPath) };
  }
  if (s.currentFileId) {
    return { kind: "doc", id: s.currentFileId, name: nameForFile(s, s.currentFileId, null) };
  }
  return { kind: "empty" };
}

function nameForFile(s, fileId, ls) {
  if (ls && ls.relPath) return baseName(ls.relPath);
  return findNodeByFileId(s.fileTree, fileId)?.name
    || (s.files || []).find((f) => f.id === fileId)?.name
    || "Untitled";
}

function baseName(relPath) {
  const base = String(relPath || "").split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "") || base || "Untitled";
}

function surfaceKey(surface) {
  if (surface.localSync) return `${surface.kind}:${surface.localSync.folderId}:${surface.localSync.relPath}`;
  return `${surface.kind}:${surface.id || ""}`;
}

function describeSurface(surface) {
  const name = surface.name || "Untitled";
  switch (surface.kind) {
    case "doc": return `Opened: ${name}`;
    case "localsync-doc": return `Opened: ${name}`;
    case "project": return `Opened project: ${name}`;
    case "notebook": return `Opened notebook: ${name}`;
    case "stack": return `Opened stack: ${name}`;
    case "pdf": return `Opened PDF: ${name}`;
    default: return "No file";
  }
}

/** Walk the workspace back to `entry`: reopen its surface, rebuild its
 *  pane layout, re-apply scroll / camera / pane focus. Content is NOT
 *  rolled back — that's what per-editor undo and Versions are for; the
 *  journal restores *where you were*, so those tools regain their
 *  context (a pane's undo is reachable again once the pane is back). */
export async function restoreJournalEntry(state, entry) {
  if (!entry?.state) return;
  suppressJournal(true);
  try {
    const pm = await import("../pane/pane-manager.js");
    const { panes } = await import("../pane/pane-state.js");
    for (const id of [...panes.keys()]) pm.closePane(id);

    const surface = entry.state.surface || { kind: "empty" };
    await openSurface(state, surface);

    await pm.restorePanesFromList(entry.state.panes || []);

    // Viewport + focus, after layout settles.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        if (surface.kind === "notebook" && entry.state.camera) {
          import("../notebook/notebook-bridge.js").then(({ getCanvasInstance }) => {
            const st = getCanvasInstance()?.state;
            if (st) { st.camera = { ...entry.state.camera }; st.notify("camera"); }
          }).catch(() => {});
        } else if (typeof entry.state.scrollTop === "number" && state.editor?.view) {
          state.editor.view.scrollDOM.scrollTop = entry.state.scrollTop;
        }
        if (entry.state.activePaneFileId) {
          for (const [id, p] of panes) {
            if (p.fileId === entry.state.activePaneFileId) { pm.focusPane(id); break; }
          }
        }
      } catch (_) {}
    }));
  } finally {
    suppressJournal(false);
  }
  record("restore", `Returned to: ${entry.label}`, entry.label);
}

async function openSurface(state, surface) {
  switch (surface.kind) {
    case "doc":
      await state.openFile(surface.id);
      return;
    case "project":
      await state.openProject(surface.id);
      return;
    case "pdf":
      await state.openPdf(surface.id);
      return;
    case "notebook":
      if (surface.localSync) {
        const { openLocalNotebook } = await import("../sync/local-sync.js");
        await openLocalNotebook(state, surface.localSync.folderId, surface.localSync.relPath);
      } else {
        await state.openNotebook(surface.id);
      }
      return;
    case "stack":
      if (surface.localSync) {
        const { openLocalStack } = await import("../sync/local-sync.js");
        await openLocalStack(state, surface.localSync.folderId, surface.localSync.relPath);
      } else {
        await state.openStack(surface.id);
      }
      return;
    case "localsync-doc": {
      const { openLocalSyncFile } = await import("../sync/local-sync.js");
      await openLocalSyncFile(state, surface.localSync.folderId, surface.localSync.relPath);
      return;
    }
    default:
      await state.clearActiveFile();
  }
}
