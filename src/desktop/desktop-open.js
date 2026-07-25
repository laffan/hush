/**
 * Desktop open actions — what the thumbnail gestures, hover buttons and
 * outline rows actually do. Extracted from desktop-view.js (700-line cap).
 *
 *   openFileRef            double-click / double-tap (and an outline row
 *                          click): open the file in place. A nested
 *                          project opens its own Desktop — a project is
 *                          a Desktop, so that's what "open" means for it.
 *   openFileRefWithGutter  "Open with Gutter Visible" — open the doc and
 *                          re-dock its paired gutter notebook
 *   openFileRefSecondary   the pane button: open the file as a floating
 *                          pane over the Desktop. For a nested project
 *                          that's its Desktop in a pane (desktop-pane.js)
 *                          rather than the project's joined buffer.
 *
 * The pane opened here belongs to the *Desktop*, not to a file: it's
 * tagged `desktopPane` so it's exempt from the rule that hides every
 * other pane while `body.desktop-active` is set, and owned by the
 * Desktop's own pane context (`dt:<containerId>`) so it hides when you
 * leave and comes back when you return.
 */

/** Opt-in stage timing for the "Open as pane" path — set
 *  `window.__hushDesktopDebug = true` in the console to turn it on.
 *  Off by default and free when off. */
export function dtLog(...args) {
  if (typeof window !== "undefined" && window.__hushDesktopDebug) {
    console.log("[desktop]", performance.now().toFixed(0), ...args);
  }
}

/** Open a thumbnail's file in place. `openDesktopFor(nodeId)` is
 *  desktop-view's own `openDesktop`, passed in to keep this module free
 *  of a circular import. */
export function openFileRef(state, ref, openDesktopFor) {
  if (!ref) return;
  if (ref.kind === "project") { openDesktopFor?.(ref.nodeId); return; }
  if (ref.kind === "doc") { state.openFile(ref.fileId); return; }
  if (ref.kind === "notebook") { state.openNotebook(ref.fileId); return; }
  if (ref.kind === "stack") { state.openStack(ref.fileId); return; }
  if (ref.kind === "pdf") {
    import("../sync/pdf-sync.js").then(({ isPdfDownloaded }) => {
      if (isPdfDownloaded(ref.fileId)) state.openPdf(ref.fileId);
    });
  }
}

/** "Open with Gutter Visible" — open the doc, then re-dock its paired
 *  gutter notebook (the pairing survives closes, so Open Gutter just
 *  re-docks it). */
export async function openFileRefWithGutter(state, ref) {
  if (!ref || ref.kind !== "doc") return;
  await state.openFile(ref.fileId);
  try {
    const { openGutter } = await import("../project/gutter-commands.js");
    await openGutter(state);
  } catch (e) {
    console.warn("Open with gutter failed:", e);
  }
}

/** The hover row's pane button. A nested project opens as a `desktop`
 *  pane — its own canvas of thumbnails, floating over the parent's.
 *
 *  `createPane` centres a pane on the point it's given, which for a
 *  *button* click means the new pane lands squarely on top of the button
 *  you just pressed — so a second click hits the pane instead of the
 *  control, and the thumbnail disappears behind its own pane. The anchor
 *  is nudged so the pane opens just down-and-right of the button
 *  instead, leaving the thumbnail and its controls reachable.
 *  (`clampPaneAxis` inside `createPane` pulls it back on screen near an
 *  edge.) */
export async function openFileRefSecondary(state, ref, ev, containerId) {
  if (!ref) return;
  const typeMap = { doc: "document", notebook: "notebook", pdf: "pdf", stack: "stack", project: "desktop" };
  dtLog("openFileRefSecondary", ref.kind, ref.name);
  const { createPane } = await import("../pane/pane-manager.js");
  const { DEFAULT_WIDTH, TITLEBAR_HEIGHT } = await import("../pane/pane-state.js");
  dtLog("pane modules resolved");
  const anchorX = (ev?.clientX ?? 200) + DEFAULT_WIDTH / 2 + 24;
  const anchorY = (ev?.clientY ?? 120) + TITLEBAR_HEIGHT / 2;
  try {
    await createPane(
      ref.kind === "project" ? ref.nodeId : ref.fileId,
      ref.name, typeMap[ref.kind] || "document",
      anchorX, anchorY,
      { desktopPane: true, ownerContext: containerId ? `dt:${containerId}` : "" },
    );
    dtLog("createPane resolved");
  } catch (e) {
    console.error("Open as pane failed:", e);
  }
}
