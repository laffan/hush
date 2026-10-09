/**
 * Major versions — snapshots the user has marked to keep.
 *
 * The mark lives in the snapshot's filename (`snapshots.rs`: `…-major.snap`),
 * so it travels with the desk and the decay policy never thins a marked one.
 * Two ways in: the star on a row of the Versions list (outlined on hover,
 * filled once marked, a click toggles it), and **Save major version** in
 * the command palette, which snapshots what is on screen and marks it in
 * the same write.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const STAR_PATH = "M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z";

/** The star for one row of the Versions list. `onToggled(major)` runs
 *  once the mark is on disk; a failed write leaves the star as it was. */
export function buildMajorStar(snap, docId, onToggled) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "version-major-star";
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
  const paint = () => {
    btn.classList.toggle("on", !!snap.major);
    btn.title = snap.major ? "Major version — click to unmark" : "Mark as major version";
    btn.setAttribute("aria-pressed", String(!!snap.major));
  };
  paint();
  // The row selects on click and previews on hover; the star does neither.
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!IS_TAURI || !docId) return;
    const next = !snap.major;
    try {
      await tauriInvoke("set_snapshot_major", { documentId: docId, id: snap.id, major: next });
    } catch (err) {
      console.error("Marking major version failed:", err);
      return;
    }
    snap.major = next;
    paint();
    btn.closest("li")?.classList.toggle("major", next);
    onToggled?.(next);
  });
  return btn;
}

/** The main notebook's content, assembled the way its autosave does. */
async function notebookContent() {
  const [{ getCanvasInstance }, { encodeNotebookContent }] = await Promise.all([
    import("../notebook/notebook-bridge.js"),
    import("../notebook/notebook-content.ts"),
  ]);
  const canvas = getCanvasInstance();
  if (!canvas) return null;
  const s = canvas.state;
  return encodeNotebookContent({
    shapes: canvas.getShapes(),
    layers: s.layers,
    flowEdges: s.flowchart.serialize(),
    bookmarks: s.bookmarks,
    splits: s.splits,
    proof: s.proof,
    camera: s.camera,
    background: {
      pattern: s.backgroundPattern,
      spacing: s.gridSpacing,
      opacity: s.gridOpacity,
      rotationEnabled: s.canvasRotationEnabled,
      snapToGrid: s.snapToGrid,
      snapGridSize: s.snapGridSize,
    },
  });
}

/** Snapshot the main surface — the history the Versions list shows — as
 *  a major version. */
export async function saveMajorVersion(state) {
  const { getActiveDocumentId } = await import("./versions-panel.js");
  const { showImportToast } = await import("../editor/import-toast.js");
  const docId = getActiveDocumentId(state);
  if (!docId || !IS_TAURI) return;
  let content = null;
  try {
    content = state.currentNotebookFileId ? await notebookContent() : state.editor?.getContent?.();
  } catch (e) {
    console.error("Reading content for a major version failed:", e);
  }
  if (content == null) {
    showImportToast("Nothing to save as a major version", "error");
    return;
  }
  try {
    await tauriInvoke("create_snapshot", { documentId: docId, content, major: true });
    showImportToast("Saved major version", "info");
  } catch (e) {
    console.error("Saving major version failed:", e);
    showImportToast(`Couldn't save major version: ${e?.message || e}`, "error");
  }
}
