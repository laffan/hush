/**
 * Write Now — a fresh document, set up to write an idea down before it
 * goes: full screen, Midnight mode, the chosen desk (Settings → General →
 * Write Now), a new document headed with the time (`2026.9.23-12h33`,
 * which the naming rule makes its filename) with the caret on the line
 * under it, the sidebar closed, Zen Focus — where the title line is off
 * limits (editor/zen-title-lock.js), so the caret can't stray back onto
 * the timestamp. Each step is skipped when it is already so. The steps
 * run behind a fade to black (write-now-veil.js) that lifts once the
 * caret is waiting under the timestamp. Reached by tapping
 * Option three times (triple-tap-triggers.js) or from the command palette.
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
import { raiseVeil, lowerVeil, windowSettled } from "./write-now-veil.js";

/** How long a desk switch may take to land before Write Now carries on
 *  regardless (a local desk's folder can be slow to answer). */
const DESK_LANDING_MS = 5000;

let running = false;

export async function writeNow(state) {
  if (running) return;
  running = true;
  let veil = null;
  try {
    veil = await raiseVeil();
    // Zen holds a copy of the document it opened over; leave it (writing
    // that back) before the document underneath changes.
    if (state.zenFocus) state.toggleZenFocus();

    const resizing = !state.isFullscreen;
    if (resizing) state.toggleFullscreen();
    if (!isMidnightActive(state.settings)) await setMidnightMode(state, true);
    await switchToWriteNowDesk(state);
    if (!blankDocumentOpen(state)) await state.newFile();
    if (!document.getElementById("panel-overlay")?.classList.contains("hidden")) state.emit("hide-panel");

    // Zen opens over the surface the keyboard is on; a floating pane
    // under the pointer would otherwise be the one it takes.
    deactivateAllPanes();
    // Let the new document's surface swap in (`file-opened`) and take
    // focus before it is written into and Zen reads it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const head = insertTimestampHead(state);
    if (!state.zenFocus) state.toggleZenFocus();
    if (head) restoreCaretLine(state.runtime.zenView || state.editor?.view, head);
    // The fullscreen handler re-focuses the editor 100 ms after the
    // switch, and the native animation keeps resizing the window past
    // that; lift the veil only once both are over.
    if (resizing) await windowSettled();
    else await new Promise((r) => setTimeout(r, 120));
  } catch (e) {
    console.error("Write Now failed:", e);
  } finally {
    running = false;
    await lowerVeil(veil);
  }
}

/** "2026.9.23-12h33" — month, day and hour unpadded, minutes padded,
 *  24-hour clock. */
export function writeNowStamp(d = new Date()) {
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}-${d.getHours()}h${mm}`;
}

/** The document's opening text: the timestamp, caret on the line under
 *  it. */
function headText(stamp) {
  return stamp + "\n";
}

/** Head the empty document with the time. Dispatched
 *  as a user edit: the document goes dirty and saves, and the caret
 *  leaving line 1 is what names the file after the timestamp
 *  (state-naming.js). Returns the stamp, or null when nothing was
 *  written. */
function insertTimestampHead(state) {
  if (!mainEditorHoldsDoc(state) || state.currentProjectId || state.currentLocalSync) return null;
  const view = state.editor?.view;
  if (!view || (state.editor.getContent?.() || "").trim()) return null;
  const stamp = writeNowStamp();
  const text = headText(stamp);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return stamp;
}

/** Put the line under the timestamp back in the editor being typed
 *  into, caret on it. Opening Zen emits `mode-changed`, and with
 *  typewriter mode off that strips every trailing blank line from the
 *  main editor (`stripTypewriterRunway`) — before anything is typed,
 *  the one under the stamp. Zen's own editor is the one written in
 *  until it closes, and its write-back carries it home once there is
 *  text on it. */
function restoreCaretLine(view, stamp) {
  if (!view) return;
  const text = headText(stamp);
  const doc = view.state.doc.toString();
  if (doc.replace(/\s+$/u, "") !== stamp) return;
  view.dispatch({
    changes: doc === text ? [] : { from: 0, to: doc.length, insert: text },
    selection: { anchor: text.length },
    scrollIntoView: true,
    userEvent: "input",
  });
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
