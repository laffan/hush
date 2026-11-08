/**
 * Portable per-desk metadata — style choice, Ratchet mode, last-open
 * file, custom icon (and whether its name shows beside it), desk
 * stickies, the desk's to-dos (todo/todo-store.js) — mirrored into each
 * desk's `.hushdesk` "meta"
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
 *
 * Pushes and pulls for one desk run one at a time, and a pull never
 * overwrites a local change that hasn't reached disk yet. Before that,
 * a reconcile's pull could read `.hushdesk` while a style pick was
 * still on its way there: the pull put the old style back into
 * `desksMeta` and recorded it as synced, so the push that followed
 * found nothing to write — and the desk showed its old style the next
 * time it was switched to.
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

function deskTodos(state, deskId) {
  const all = Array.isArray(state.settings?.todos) ? state.settings.todos : [];
  return all.filter((t) => t && t.deskId === deskId);
}

/** The `.hushdesk` meta payload for one desk, from current app state. */
function payloadFor(state, deskId) {
  const meta = state.settings?.desksMeta?.[deskId] || {};
  return {
    styleId: meta.globalStyleId ?? null,
    ratchet: !!meta.ratchet,
    lastFileId: meta.lastFileId ?? null,
    lastFileType: meta.lastFileType ?? null,
    icon: meta.icon ?? null,
    showName: !!meta.showName,
    stickies: deskStickies(state, deskId),
    todos: deskTodos(state, deskId),
  };
}

// deskId → tail of that desk's push/pull chain.
const queues = new Map();

/** Run `task` after every push / pull already queued for this desk. */
function enqueue(deskId, task) {
  const run = (queues.get(deskId) || Promise.resolve()).then(task, task);
  queues.set(deskId, run.catch(() => {}));
  return run;
}

/** True when this desk's meta in memory differs from what was last
 *  written to (or read from) its `.hushdesk` — a local change on its way
 *  to disk. Unknown before the desk's first sync. */
function hasUnpushedChange(state, deskId) {
  if (!pulledOnce || !lastSynced.has(deskId)) return false;
  return lastSynced.get(deskId) !== JSON.stringify(payloadFor(state, deskId));
}

/** The push itself, unqueued. Resolves true when disk now holds the
 *  in-memory payload. */
async function pushNow(state, deskId) {
  const payload = payloadFor(state, deskId);
  const serialized = JSON.stringify(payload);
  if (lastSynced.get(deskId) === serialized) return true;
  try {
    await invoke("desk_meta_set", { deskId, patch: payload });
    lastSynced.set(deskId, serialized);
    return true;
  } catch (e) {
    console.warn("desk_meta_set failed:", e);
    return false;
  }
}

/** Write one desk's meta through to its `.hushdesk`. */
export async function pushDeskMeta(state, deskId) {
  if (!IS_TAURI || !deskId || !pulledOnce) return;
  await enqueue(deskId, () => pushNow(state, deskId));
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
  await enqueue(deskId, () => pullNow(state, deskId));
}

async function pullNow(state, deskId) {
  // A local change not yet on disk is newer than anything the disk can
  // hold: write it rather than read the older value back over it.
  if (hasUnpushedChange(state, deskId) && await pushNow(state, deskId)) return;
  const before = JSON.stringify(payloadFor(state, deskId));
  let meta = null;
  try {
    meta = await invoke("desk_meta_get", { deskId });
  } catch (e) {
    console.warn("desk_meta_get failed:", e);
    return;
  }
  if (!meta || typeof meta !== "object") return;
  // Changed here while the read was in flight — the push queued behind
  // this pull carries it; the disk's copy is already stale.
  if (JSON.stringify(payloadFor(state, deskId)) !== before) return;

  const patch = {};

  // Per-desk preferences (style / last file / icon) — only keys the desk file
  // actually carries; an absent key means "never set", not "clear".
  const current = state.settings?.desksMeta?.[deskId] || {};
  const next = { ...current };
  if ("styleId" in meta) next.globalStyleId = meta.styleId ?? null;
  if ("ratchet" in meta) next.ratchet = !!meta.ratchet;
  if ("lastFileId" in meta) next.lastFileId = meta.lastFileId ?? null;
  if ("lastFileType" in meta) next.lastFileType = meta.lastFileType ?? null;
  if ("icon" in meta) next.icon = meta.icon ?? null;
  if ("showName" in meta) next.showName = !!meta.showName;
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

  // To-dos — the same rule as stickies: the desk's share is replaced
  // wholesale, and the rest of the list keeps its order. An absent key
  // is a desk written before to-dos existed, not "none".
  let todosChanged = false;
  if (Array.isArray(meta.todos)) {
    const mine = deskTodos(state, deskId);
    if (JSON.stringify(meta.todos) !== JSON.stringify(mine)) {
      const all = Array.isArray(state.settings?.todos) ? state.settings.todos : [];
      const incoming = meta.todos.filter((t) => t && typeof t.id === "string").map((t) => ({ ...t, deskId }));
      // Keep the desk's place in the list: its first item's slot.
      const at = all.findIndex((t) => t && t.deskId === deskId);
      const others = all.filter((t) => !(t && t.deskId === deskId));
      const slot = at < 0 ? others.length : all.slice(0, at).filter((t) => !(t && t.deskId === deskId)).length;
      patch.todos = [...others.slice(0, slot), ...incoming, ...others.slice(slot)];
      todosChanged = true;
    }
  }

  const ratchetChanged = "ratchet" in meta && !!meta.ratchet !== !!current.ratchet;

  if (Object.keys(patch).length > 0) {
    await state.updateSettings(patch);
  }
  lastSynced.set(deskId, JSON.stringify(payloadFor(state, deskId)));
  if (stickiesChanged) state.emit("desk-meta-pulled", { deskId });
  if (todosChanged) state.emit("todos-changed", { deskId });
  // A desk arriving in (or out of) Ratchet mode is a mode flip for the
  // open editor, not just a settings write — it has to re-lock the
  // buffer it's already showing.
  if (ratchetChanged) state.emit("mode-changed");
}

/** Boot pull across every desk. Unlocks pushes afterwards. */
export async function pullAllDeskMeta(state) {
  if (!IS_TAURI) { pulledOnce = true; return; }
  for (const deskId of deskIds(state)) {
    await pullDeskMeta(state, deskId);
  }
  pulledOnce = true;
}
