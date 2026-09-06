/**
 * Portable per-desk metadata — style choice, Ratchet mode, file view,
 * last-open file, desk stickies — mirrored into each desk's `.hushdesk` "meta"
 * object so the preferences ride along when a desk is handed off to
 * another install or synced through a shared folder.
 *
 * `settings.desksMeta` and `settings.stickyNotes` remain the app's
 * runtime store; this module is a thin sync layer around them:
 *
 * - **push** — write-through after a desk-scoped mutation (style pick,
 *   last-file record, sticky edit). De-duped per desk against the last
 *   pushed payload so bursts don't rewrite `.hushdesk` needlessly.
 * - **pull** — disk wins, at boot and after every desk reconcile /
 *   adopt. A lost race between two devices costs a preference, never
 *   content (the design rule for small JSONs in a synced folder).
 *
 * Pushes are gated until the first pull completes: the sticky module
 * re-persists on boot, and letting that reach disk before the pull
 * would clobber another device's newer meta with ours.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// deskId → JSON of the last payload pushed (or pulled), so unchanged
// state never touches disk.
const lastSynced = new Map();
let pulledOnce = false;

function deskIds(state) {
  return (state.fileTree || []).filter((n) => n.type === "desk").map((n) => n.id);
}

function deskStickies(state, deskId) {
  return (state.settings?.stickyNotes || [])
    .filter((s) => s && s.kind === "desk" && s.target === deskId);
}

/** The `.hushdesk` meta payload for one desk, from current app state. */
function payloadFor(state, deskId) {
  const meta = state.settings?.desksMeta?.[deskId] || {};
  return {
    styleId: meta.globalStyleId ?? null,
    ratchet: !!meta.ratchet,
    fileView: meta.fileView ?? null,
    lastFileId: meta.lastFileId ?? null,
    lastFileType: meta.lastFileType ?? null,
    stickies: deskStickies(state, deskId),
  };
}

/** Write one desk's meta through to its `.hushdesk`. */
export async function pushDeskMeta(state, deskId) {
  if (!IS_TAURI || !deskId || !pulledOnce) return;
  const payload = payloadFor(state, deskId);
  const serialized = JSON.stringify(payload);
  if (lastSynced.get(deskId) === serialized) return;
  try {
    await invoke("desk_meta_set", { deskId, patch: payload });
    lastSynced.set(deskId, serialized);
  } catch (e) {
    console.warn("desk_meta_set failed:", e);
  }
}

/** Push every desk whose stickies (or other meta) changed — the sticky
 *  module calls this after each persist without tracking targets. */
export async function pushAllDeskMeta(state) {
  for (const deskId of deskIds(state)) await pushDeskMeta(state, deskId);
}

/** Read one desk's `.hushdesk` meta and fold it into app state (disk
 *  wins). Emits `desk-meta-pulled` when its stickies changed so the
 *  sticky layer can rebuild that desk's notes. */
export async function pullDeskMeta(state, deskId) {
  if (!IS_TAURI || !deskId) return;
  let meta = null;
  try {
    meta = await invoke("desk_meta_get", { deskId });
  } catch (e) {
    console.warn("desk_meta_get failed:", e);
    return;
  }
  if (!meta || typeof meta !== "object") return;

  const patch = {};

  // Per-desk preferences (style / last file) — only keys the desk file
  // actually carries; an absent key means "never set", not "clear".
  const current = state.settings?.desksMeta?.[deskId] || {};
  const next = { ...current };
  if ("styleId" in meta) next.globalStyleId = meta.styleId ?? null;
  if ("ratchet" in meta) next.ratchet = !!meta.ratchet;
  if ("fileView" in meta) next.fileView = meta.fileView ?? null;
  if ("lastFileId" in meta) next.lastFileId = meta.lastFileId ?? null;
  if ("lastFileType" in meta) next.lastFileType = meta.lastFileType ?? null;
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    patch.desksMeta = { ...(state.settings?.desksMeta || {}), [deskId]: next };
  }

  // Desk stickies — replaced wholesale per desk (last writer wins).
  let stickiesChanged = false;
  if (Array.isArray(meta.stickies)) {
    const mine = deskStickies(state, deskId);
    if (JSON.stringify(meta.stickies) !== JSON.stringify(mine)) {
      const others = (state.settings?.stickyNotes || [])
        .filter((s) => !(s && s.kind === "desk" && s.target === deskId));
      patch.stickyNotes = [...others, ...meta.stickies];
      stickiesChanged = true;
    }
  }

  const ratchetChanged = "ratchet" in meta && !!meta.ratchet !== !!current.ratchet;
  const viewChanged = "fileView" in meta && (meta.fileView ?? null) !== (current.fileView ?? null);

  if (Object.keys(patch).length > 0) {
    await state.updateSettings(patch);
  }
  lastSynced.set(deskId, JSON.stringify(payloadFor(state, deskId)));
  if (stickiesChanged) state.emit("desk-meta-pulled", { deskId });
  // A desk arriving in (or out of) Ratchet mode is a mode flip for the
  // open editor, not just a settings write — it has to re-lock the
  // buffer it's already showing.
  if (ratchetChanged) state.emit("mode-changed");
  // A desk that arrived in a different file view has to rebuild the
  // sidebar body, not just record the preference — but only when it is
  // the desk on screen. A background desk's pull is a preference write.
  if (viewChanged && deskId === state.settings?.activeDeskId) {
    state.emit("file-view-changed", { deskId, mode: next.fileView || "list" });
  }
}

/** Boot pull across every desk. Unlocks pushes afterwards. */
export async function pullAllDeskMeta(state) {
  if (!IS_TAURI) { pulledOnce = true; return; }
  for (const deskId of deskIds(state)) {
    await pullDeskMeta(state, deskId);
  }
  pulledOnce = true;
}
