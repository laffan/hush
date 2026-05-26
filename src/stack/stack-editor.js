/**
 * Lightweight CodeMirror editor for stack document columns.
 * Reuses the base extension set from the main editor but skips
 * heavy plugins (typewriter, ratchet, zen) that don't apply in
 * a stack context.
 */

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let _editorModulePromise = null;

async function getEditorModule() {
  if (!_editorModulePromise) {
    _editorModulePromise = import("../editor/editor.js");
  }
  return _editorModulePromise;
}

export function createStackEditor(host, content, state, fileId) {
  const handle = { view: null, fileId, _dirty: false };

  (async () => {
    try {
      const { EditorView } = await import("@codemirror/view");
      const { EditorState: CMState } = await import("@codemirror/state");
      const { markdown } = await import("@codemirror/lang-markdown");
      const { defaultHighlightStyle, syntaxHighlighting } = await import("@codemirror/language");
      const { keymap, lineNumbers } = await import("@codemirror/view");
      const { defaultKeymap, history, historyKeymap } = await import("@codemirror/commands");

      const extensions = [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": { height: "100%", fontSize: (state.settings?.fontSize || 16) + "px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { padding: "16px" },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            handle._dirty = true;
            scheduleAutoSave(handle);
          }
        }),
      ];

      const view = new EditorView({
        state: CMState.create({ doc: content, extensions }),
        parent: host,
      });

      handle.view = view;
    } catch (e) {
      console.error("createStackEditor failed:", e);
      host.textContent = content.slice(0, 500);
    }
  })();

  return handle;
}

let _saveTimers = new Map();

function scheduleAutoSave(handle) {
  if (_saveTimers.has(handle.fileId)) return;
  _saveTimers.set(handle.fileId, setTimeout(async () => {
    _saveTimers.delete(handle.fileId);
    if (!handle.view || !handle._dirty) return;
    handle._dirty = false;
    const content = handle.view.state.doc.toString();
    if (IS_TAURI) {
      try {
        await tauriInvoke("save_file", { id: handle.fileId, content });
      } catch (e) {
        console.error("Stack doc autosave failed:", e);
      }
    }
  }, 2000));
}
