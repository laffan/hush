/**
 * The Overview Doc's column — fixed down the left of the Project
 * Overview, beside the scrolling list of the project's documents.
 *
 * It is the project's Overview Doc (board-model.js `board.doc`: a
 * document called Overview, pinned first in the project) embedded as a
 * Doc — the editor a stack column uses (createPaneEditor), with no pane
 * around it: no frame, no title bar. On top of a Doc's own behaviour it
 * carries the section links (section-links.js): select text, pick a
 * section, and the words link to it; a click on them scrolls the list
 * to that section.
 *
 * Until the project has an Overview Doc the column is an empty Doc, and
 * the first words typed make the document (createOverviewDoc) — opening
 * the Overview, or typing only spaces and returns, never makes a file.
 * An Overview Doc emptied again stays, but the file browser leaves it
 * out until it has words in it (board-model.js#overviewDocHasText); the
 * column keeps the files cache current for that, and says when the
 * answer turns.
 *
 * The whole column is the Doc's: a press anywhere in it that isn't on
 * the text puts the caret in the Doc — at the end, as a click below a
 * Doc's last line does — so the column never has to be hit just so.
 *
 * Like a stack column it is its own writer: a 2 s autosave, a flush on
 * close and from the background flush (`flush`), and a re-read when a
 * sync brings the file in from elsewhere (`refreshFromDisk`, under the
 * same dirty guard). It is built once per opening and kept across the
 * board's re-renders, which rebuild only the list beside it.
 */
import { findNode } from "../../state/tree-helpers.js";
import { overviewDocNode, createOverviewDoc, sectionList, resolveSectionTarget } from "./board-model.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const SAVE_MS = 2000;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/**
 * @param {object} o
 * @param {object} o.state      app state
 * @param {string} o.projectId  the board's project
 * @param {(target: {fileId?: string, phId?: string}) => void} o.onFollow
 *   scroll the list to a section
 */
export function createDocColumn({ state, projectId, onFollow }) {
  const el = document.createElement("aside");
  el.className = "po-doc-col";
  const host = document.createElement("div");
  host.className = "po-doc";
  el.appendChild(host);

  let editor = null;
  let refresh = null;      // section-links.js's refresh effect
  let fileId = null;       // the document the editor holds; null until made
  let hasText = false;     // whether it holds anything but white space
  let dirty = false;
  let snapKeystrokes = 0;
  let creating = null;
  let destroyed = false;
  let saveTimer = null;

  const project = () => findNode(state.fileTree || [], projectId);
  const node = () => (project() ? overviewDocNode(project()) : null);

  /** The style the document is locked to, if any, else the session's. */
  let styledLock = null;
  const restyle = () => {
    if (!editor || destroyed) return;
    styledLock = node()?.lockedStyleId || null;
    editor.reconfigureTheme?.(state.settings, styledLock);
  };
  const themeEvents = ["theme-changed", "style-changed", "style-preview-end"];
  // A tree change restyles only when it locked or unlocked the Doc's style:
  // a restyle reconfigures the editor, and tree changes come often (every
  // save of the tree, the Doc's own first words).
  const onFilesChanged = () => { if ((node()?.lockedStyleId || null) !== styledLock) restyle(); };

  // A press in the column that isn't on the editor's text (its margins,
  // or below the editor where an engine sized it to its text) focuses
  // the Doc with the caret at its end. A press on the text, or on the
  // editor's own scroller — its scrollbar, the space under the last line
  // — is CodeMirror's to place.
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !editor || e.target.closest?.(".cm-content, .cm-scroller, button")) return;
    e.preventDefault();
    const view = editor.view;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  });

  /** Keep the files cache's copy current — the file browser reads it to
   *  decide whether the Doc is empty. */
  function cacheContent(text) {
    const cached = fileId ? (state.files || []).find((f) => f.id === fileId) : null;
    if (cached) cached.content = text;
  }

  /** Note whether the Doc has words in it; when that turns, the file
   *  browser shows or hides its row. */
  function noteText(text) {
    const has = /\S/.test(text);
    if (has === hasText) return;
    hasText = has;
    cacheContent(text);
    // Never from inside an editor update: a `files-changed` restyles
    // this editor, and an editor can't be dispatched to mid-update.
    queueMicrotask(() => { if (!destroyed) state.emit("files-changed"); });
  }

  // Runs inside the editor's update (createBaseExtensions' listener).
  function onEdit() {
    dirty = true;
    snapKeystrokes++;
    const text = editor.getContent();
    if (fileId) noteText(text);
    else if (/\S/.test(text)) queueMicrotask(() => void ensureDoc());
  }

  /** The first words typed in an empty column make the Overview Doc. */
  function ensureDoc() {
    if (creating) return creating;
    if (fileId || destroyed || !/\S/.test(editor.getContent())) return null;
    creating = (async () => {
      try {
        const made = await createOverviewDoc(state, projectId, editor.getContent());
        if (made && !destroyed) { fileId = made.fileId; hasText = true; dirty = true; restyle(); }
      } finally {
        creating = null;
      }
    })();
    return creating;
  }

  async function flush() {
    if (!dirty || !fileId || !editor) return;
    dirty = false;
    const text = editor.getContent();
    if (IS_TAURI) {
      try { await invoke("save_file", { id: fileId, content: text }); }
      catch (e) { dirty = true; console.error("Overview Doc save failed:", e); return; }
      cacheContent(text);
      // A version snapshot every 30 keystrokes, as panes and stack
      // columns take theirs.
      if (snapKeystrokes >= 30) {
        snapKeystrokes = 0;
        try { await invoke("create_snapshot", { documentId: fileId, content: text }); } catch (_) {}
      }
    }
    state.syncFileToExternal?.(fileId, text);
  }

  async function load(id) {
    fileId = id;
    dirty = false;
    snapKeystrokes = 0;
    let text = "";
    if (IS_TAURI && id) {
      try { text = (await invoke("load_file", { id }))?.content || ""; }
      catch (e) { console.error("Overview Doc load failed:", e); }
    }
    if (destroyed || fileId !== id) return;
    // A programmatic load: no undo step, no `onEdit`.
    editor.setContent(text);
    hasText = /\S/.test(text);
    cacheContent(text);
    restyle();
  }

  const ready = (async () => {
    const [{ createPaneEditor }, { createModeContext }, links] = await Promise.all([
      import("../../pane/pane-editor.js"),
      import("../../state/mode-context.js"),
      import("../section-links.js"),
    ]);
    if (destroyed) return;
    refresh = links.refreshSectionLinks;
    const mc = createModeContext(state);
    editor = createPaneEditor(host, state, onEdit, {
      modeContext: mc.proxy,
      runway: true,
      placeholder: "Overview ...",
      getFileId: () => fileId,
      extraExtensions: [links.sectionLinks({
        resolve: (target) => resolveSectionTarget(project(), target),
        sections: () => (project() ? sectionList(project()) : []),
        onFollow: (target) => {
          const to = resolveSectionTarget(project(), target);
          if (to) onFollow(to);
        },
      })],
    });
    restyle();
    for (const ev of themeEvents) state.on(ev, restyle);
    state.on("files-changed", onFilesChanged);
    saveTimer = setInterval(() => { void flush(); }, SAVE_MS);
    import("../../pane/text-drag.js").then(({ attachEditorTextDrag }) => {
      if (!destroyed && editor) attachEditorTextDrag(editor.view, host);
    }).catch(() => {});
    const doc = node();
    if (doc) await load(doc.fileId);
  })();

  /** Bring the column up to date with the project — its Overview Doc
   *  made elsewhere (a sync), moved out of the project, deleted — and
   *  redraw the links against the sections as they now are. */
  function update() {
    if (!editor || creating || destroyed) return;
    const id = node()?.fileId || null;
    if (id !== fileId) {
      // Write what was typed into the one that was here, then show what
      // is here now — or an empty Doc again.
      void flush().then(() => {
        if (destroyed) return;
        if (id) void load(id);
        else { fileId = null; hasText = false; dirty = false; editor.setContent(""); }
      });
      return;
    }
    if (refresh) editor.view.dispatch({ effects: refresh.of(null) });
  }

  /** A sync brought the file in from elsewhere: take it, unless there
   *  are edits here not yet written — those are newer, and the next
   *  save writes them. */
  async function refreshFromDisk() {
    if (!IS_TAURI || !fileId || dirty || !editor) return;
    try {
      const file = await invoke("load_file", { id: fileId });
      if (dirty || destroyed || typeof file?.content !== "string") return;
      if (file.content !== editor.getContent()) {
        editor.setContent(file.content);
        noteText(file.content);
        cacheContent(file.content);
      }
    } catch (_) { /* removed or unreadable — keep what is shown */ }
  }

  /** Write what is unsaved and take the editor down (the board is
   *  closing). */
  async function destroy() {
    if (destroyed) return;
    await ready.catch(() => {});
    clearInterval(saveTimer);
    if (creating) await creating.catch(() => {});
    await flush();
    destroyed = true;
    for (const ev of themeEvents) state.off?.(ev, restyle);
    state.off?.("files-changed", onFilesChanged);
    editor?.destroy();
    editor = null;
  }

  return { el, update, flush, refreshFromDisk, destroy };
}
