/**
 * Document bodies, read after the first surface is on screen.
 *
 * The boot listing (`list_files` with `documents: false`) gives every
 * document a row — id, name, mtime — but leaves its body on disk: in a
 * synced desk folder the first read of each file is what costs, and on an
 * iPhone with a 19-document local desk it was 2.5 s of black screen. The
 * one boot consumer that judges a body, the empty-Untitled sweep, still
 * gets the bodies it needs (Rust reads placeholder-named docs anyway).
 *
 * What does read bodies out of `state.files` under Tauri is the sidebar's
 * tab, heading and card rows (`files-panel-tabs.js#readDocContent`); every
 * other reader goes to `load_file`. So this fills in what the listing left
 * out and announces it with `files-changed`, and those rows draw the way
 * they always did, a moment later.
 *
 * Only a row still holding `null` is filled. Anything that set a body in
 * the meantime — a save, a re-listing after a delete — knows better than
 * a read that may have started before it.
 */

import { logActivity } from "../activity-log.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function hydrateDocumentBodies(state) {
  if (!IS_TAURI) return;
  const started = performance.now();
  let bodies;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    bodies = await invoke("read_document_bodies");
  } catch (e) {
    logActivity("boot", "warn", "Could not read document bodies after launch", { error: String(e) });
    return;
  }
  let filled = 0;
  for (const file of state.files || []) {
    if (!file || file.content != null) continue;
    const body = bodies?.[file.id];
    if (typeof body !== "string") continue;
    file.content = body;
    filled++;
  }
  logActivity("boot", "info", "Document bodies read after launch", {
    documents: Object.keys(bodies || {}).length,
    filled,
    ms: Math.round(performance.now() - started),
  });
  if (filled) state.emit("files-changed");
}
