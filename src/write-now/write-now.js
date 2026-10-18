/**
 * Write Now — a fresh document, set up to write an idea down before it
 * goes: full screen, Midnight mode, the chosen desk (Settings → General →
 * Write Now), a new document, the sidebar closed, Zen Focus. Each step is
 * skipped when it is already so. Reached by tapping Option three times
 * (write-now-trigger.js) or from the command palette.
 *
 * Full screen on iPad is Hush's own: iPadOS gives an app no way to make
 * its window fill the screen (that is the system's window controls), so
 * the step hides Hush's chrome, as the fullscreen command does there.
 */
import { isMidnightActive } from "../midnight/midnight-mode.js";
import { setMidnightMode } from "../midnight/midnight-controller.js";
import { findNode, findNodeByFileId } from "../state/tree-helpers.js";
import { getActiveDesk } from "../state/state-desks.js";
import { isEmptyUntitled } from "../state/empty-untitled.js";
import { mainEditorHoldsDoc } from "../state/open-surface.js";
import { deactivateAllPanes } from "../pane/pane-manager.js";

/** How long a desk switch may take to land before Write Now carries on
 *  regardless (a local desk's folder can be slow to answer). */
const DESK_LANDING_MS = 5000;

let running = false;

export async function writeNow(state) {
  if (running) return;
  running = true;
  try {
    // Zen holds a copy of the document it opened over; leave it (writing
    // that back) before the document underneath changes.
    if (state.zenFocus) state.toggleZenFocus();

    if (!state.isFullscreen) state.toggleFullscreen();
    if (!isMidnightActive(state.settings)) await setMidnightMode(state, true);
    await switchToWriteNowDesk(state);
    if (!blankDocumentOpen(state)) await state.newFile();
    if (!document.getElementById("panel-overlay")?.classList.contains("hidden")) state.emit("hide-panel");

    // Zen opens over the surface the keyboard is on; a floating pane
    // under the pointer would otherwise be the one it takes.
    deactivateAllPanes();
    // Let the new document's surface swap in (`file-opened`) and take
    // focus before Zen reads it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!state.zenFocus) state.toggleZenFocus();
  } catch (e) {
    console.error("Write Now failed:", e);
  } finally {
    running = false;
  }
}

/** Switch to the desk chosen in Settings, and wait for the switch to
 *  land on that desk's last file: the landing is asynchronous, and a new
 *  document made before it finishes would be replaced by it. */
async function switchToWriteNowDesk(state) {
  const deskId = state.settings?.writeNowDeskId;
  if (!deskId || deskId === state.settings?.activeDeskId) return;
  if (!(state.settings?.desks || []).some((d) => d.id === deskId)) return;
  const landed = new Promise((resolve) => {
    const done = () => { clearTimeout(timer); state.off("desk-overview-restore", done); resolve(); };
    const timer = setTimeout(done, DESK_LANDING_MS);
    // main.js's desk-switch handler emits this once the desk's file is open.
    state.on("desk-overview-restore", done);
  });
  await state.setActiveDesk(deskId);
  await landed;
}

/** The main editor already holds an empty, unnamed document on the
 *  active desk — making another would only leave this one behind. */
function blankDocumentOpen(state) {
  if (!mainEditorHoldsDoc(state) || !state.currentFileId || state.currentProjectId || state.currentLocalSync) return false;
  const node = findNodeByFileId(state.fileTree, state.currentFileId);
  if (!node || !isEmptyUntitled(node.name, state.editor?.getContent?.() || "")) return false;
  const desk = getActiveDesk(state);
  return !!(desk && findNode(desk.children || [], node.id));
}
