/**
 * Desks — top-level containers above all other file-tree nodes.
 *
 * When `settings.useDesks` is false, the file tree is flat: a single
 * top-level Inbox + Images + Trash plus the user's docs/folders/projects.
 * When useDesks is true, the top level is one or more `type: "desk"`
 * nodes; each carries its own namespaced Inbox / Images / Trash plus
 * the user's content.
 *
 * Special-node IDs follow a deterministic shape:
 *   - desks off: `__inbox__`, `__images__`, `__trash__`
 *   - desks on:  `__inbox__:<deskId>`, `__images__:<deskId>`,
 *                `__trash__:<deskId>` (one set per desk)
 *
 * Toggle migrations:
 *   - `enableDesks(state, name)` wraps the existing flat tree under a
 *     single new desk named `name` (default "Personal"). The single
 *     existing Inbox / Images / Trash become that desk's specials,
 *     just with renamed ids.
 *   - `disableDesks(state)` reverses the wrap. Every desk's Inbox /
 *     Images / Trash content is *merged* into a single fresh global
 *     Inbox / Images / Trash; non-special children of each desk become
 *     a top-level folder named after the desk.
 *
 * Active-desk-id is per-device; it's stored on `settings` for
 * persistence but isn't intended to round-trip via Dropbox sync.
 */

const SPECIAL_KINDS = ["__inbox__", "__images__", "__trash__"];

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Build a special-node id for a given desk. With `deskId` null,
 *  returns the legacy global id. */
export function specialNodeId(kind, deskId) {
  if (!SPECIAL_KINDS.includes(kind)) throw new Error(`unknown special kind: ${kind}`);
  return deskId ? `${kind}:${deskId}` : kind;
}

/** True if `id` is any special node (across any desk + the legacy
 *  flat-tree ids). Match-by-prefix avoids hardcoding every desk id. */
export function isSpecialNodeId(id) {
  if (!id) return false;
  if (SPECIAL_KINDS.includes(id)) return true;
  return SPECIAL_KINDS.some((kind) => id.startsWith(kind + ":"));
}

/** Decode `__inbox__:abc123` → { kind: "__inbox__", deskId: "abc123" }.
 *  Returns null for non-special ids. */
export function parseSpecialNodeId(id) {
  if (!id) return null;
  if (SPECIAL_KINDS.includes(id)) return { kind: id, deskId: null };
  for (const kind of SPECIAL_KINDS) {
    if (id.startsWith(kind + ":")) return { kind, deskId: id.slice(kind.length + 1) };
  }
  return null;
}

export function getActiveDesk(state) {
  if (!state.settings?.useDesks) return null;
  const id = state.settings.activeDeskId;
  if (!id) return null;
  return (state.fileTree || []).find((n) => n.type === "desk" && n.id === id) || null;
}

/** Resolve the special-node id for the *current* context (active desk
 *  if useDesks is on, legacy global id otherwise). */
export function activeSpecialId(state, kind) {
  if (!state.settings?.useDesks) return kind;
  const desk = getActiveDesk(state);
  if (!desk) return kind; // pre-toggle / corrupt state — fall back to global
  return specialNodeId(kind, desk.id);
}

/** Ensure each desk node has its own Inbox / Images / Trash children
 *  with the correct ordering (Inbox first, Images / Trash pinned to
 *  the tail). */
export function ensureDeskSpecials(deskNode) {
  if (!deskNode || deskNode.type !== "desk") return;
  if (!Array.isArray(deskNode.children)) deskNode.children = [];
  const c = deskNode.children;
  const ensure = (kind, type, name) => {
    const id = specialNodeId(kind, deskNode.id);
    if (!c.some((n) => n.id === id)) {
      const node = { id, type, name, children: [], flagged: false };
      if (kind === "__inbox__") c.unshift(node); else c.push(node);
    }
  };
  ensure("__inbox__", "project", "Inbox");
  ensure("__images__", "folder", "Images");
  ensure("__trash__", "folder", "Trash");
  // Order: Inbox first, Images then Trash pinned to the tail.
  const moveTo = (id, idx) => {
    const i = c.findIndex((n) => n.id === id);
    if (i >= 0 && i !== idx) { const [n] = c.splice(i, 1); c.splice(idx, 0, n); }
  };
  moveTo(specialNodeId("__inbox__", deskNode.id), 0);
  moveTo(specialNodeId("__trash__", deskNode.id), c.length - 1);
  moveTo(specialNodeId("__images__", deskNode.id), c.length - 2);
}

/** Wrap the existing flat tree under a single new desk. The wrap is
 *  only applied when `useDesks` flips on; subsequent toggles see the
 *  tree already has desks and just preserve them. */
export async function enableDesks(state, name = "Personal") {
  if (state.settings?.useDesks) return;
  const t = state.fileTree || [];

  // Pull the legacy specials out of the top level (we'll re-namespace
  // their ids under the new desk so children stay attached).
  const popById = (id) => {
    const i = t.findIndex((n) => n.id === id);
    if (i < 0) return null;
    return t.splice(i, 1)[0];
  };
  const inbox = popById("__inbox__");
  const images = popById("__images__");
  const trash = popById("__trash__");

  const deskId = uid();
  const desk = {
    id: deskId,
    type: "desk",
    name,
    children: [],
    flagged: false,
    createdAt: Math.floor(Date.now() / 1000),
  };

  // Re-id the legacy specials so they live under this desk.
  if (inbox) { inbox.id = specialNodeId("__inbox__", deskId); desk.children.push(inbox); }
  if (images) { images.id = specialNodeId("__images__", deskId); }
  if (trash) { trash.id = specialNodeId("__trash__", deskId); }

  // Move every remaining top-level node into the desk; specials added
  // last so the ordering helper can re-pin them.
  while (t.length > 0) desk.children.push(t.shift());
  if (images) desk.children.push(images);
  if (trash) desk.children.push(trash);

  ensureDeskSpecials(desk);
  t.push(desk);

  const desks = [{ id: deskId, name, createdAt: desk.createdAt }];
  await state.updateSettings({
    useDesks: true,
    desks,
    activeDeskId: deskId,
  });
  await state.saveFileTree();
  state.emit("desks-changed");
}

/** Reverse the wrap. Every desk's Inbox / Images / Trash is merged
 *  into a single fresh global Inbox / Images / Trash; non-special
 *  children of each desk become a top-level folder named after the
 *  desk. (When there's exactly one desk, its non-special children get
 *  hoisted directly to the top level.) */
export async function disableDesks(state) {
  if (!state.settings?.useDesks) return;
  const tree = state.fileTree || [];
  const desks = tree.filter((n) => n.type === "desk");
  if (desks.length === 0) {
    await state.updateSettings({ useDesks: false, desks: [], activeDeskId: null, desksMeta: {} });
    await state.saveFileTree();
    state.emit("desks-changed");
    return;
  }

  const mergedInbox = { id: "__inbox__", type: "project", name: "Inbox", children: [], flagged: false };
  const mergedImages = { id: "__images__", type: "folder", name: "Images", children: [], flagged: false };
  const mergedTrash = { id: "__trash__", type: "folder", name: "Trash", children: [], flagged: false };
  const hoistedTopLevel = [];

  const isSingleDesk = desks.length === 1;

  for (const desk of desks) {
    const nonSpecials = [];
    for (const child of (desk.children || [])) {
      const parsed = parseSpecialNodeId(child.id);
      if (parsed?.kind === "__inbox__") {
        mergedInbox.children.push(...(child.children || []));
      } else if (parsed?.kind === "__images__") {
        mergedImages.children.push(...(child.children || []));
      } else if (parsed?.kind === "__trash__") {
        mergedTrash.children.push(...(child.children || []));
      } else {
        nonSpecials.push(child);
      }
    }
    if (isSingleDesk || nonSpecials.length === 0) {
      hoistedTopLevel.push(...nonSpecials);
    } else {
      hoistedTopLevel.push({
        id: uid(),
        type: "folder",
        name: desk.name || "Untitled desk",
        children: nonSpecials,
        flagged: false,
      });
    }
  }

  // Replace the tree contents in place so existing references stay valid.
  tree.length = 0;
  tree.push(mergedInbox, ...hoistedTopLevel, mergedImages, mergedTrash);

  await state.updateSettings({ useDesks: false, desks: [], activeDeskId: null, desksMeta: {} });
  await state.saveFileTree();
  state.emit("desks-changed");
}

/** Add a new empty desk to the tree. Returns the new desk id. */
export async function createDesk(state, name = "Untitled desk") {
  if (!state.settings?.useDesks) throw new Error("desks not enabled");
  const id = uid();
  const desk = {
    id,
    type: "desk",
    name,
    children: [],
    flagged: false,
    createdAt: Math.floor(Date.now() / 1000),
  };
  ensureDeskSpecials(desk);
  state.fileTree.push(desk);
  const desks = [...(state.settings.desks || []), { id, name, createdAt: desk.createdAt }];
  await state.updateSettings({ desks });
  await state.saveFileTree();
  state.emit("desks-changed");
  return id;
}

export async function renameDesk(state, deskId, newName) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;
  desk.name = newName;
  const desks = (state.settings.desks || []).map((d) => d.id === deskId ? { ...d, name: newName } : d);
  await state.updateSettings({ desks });
  await state.saveFileTree();
  state.emit("desks-changed");
}

/** Delete a desk and all of its content. The very last desk can't be
 *  deleted while `useDesks` is on — caller should toggle off instead. */
export async function deleteDesk(state, deskId) {
  if (!state.settings?.useDesks) return;
  const tree = state.fileTree || [];
  const desks = tree.filter((n) => n.type === "desk");
  if (desks.length <= 1) throw new Error("cannot delete the last desk");
  const idx = tree.findIndex((n) => n.type === "desk" && n.id === deskId);
  if (idx < 0) return;
  tree.splice(idx, 1);

  const remaining = (state.settings.desks || []).filter((d) => d.id !== deskId);
  const meta = { ...(state.settings.desksMeta || {}) };
  delete meta[deskId];

  let activeDeskId = state.settings.activeDeskId;
  if (activeDeskId === deskId) activeDeskId = remaining[0]?.id || null;

  await state.updateSettings({ desks: remaining, desksMeta: meta, activeDeskId });
  await state.saveFileTree();
  state.emit("desks-changed");
  if (activeDeskId !== state.settings.activeDeskId) state.emit("active-desk-changed", activeDeskId);
}

/** Every special-node id of `kind` currently in the tree — global + per-desk. */
export function allSpecialOfKind(state, kind) {
  const out = [kind];
  if (state.settings?.useDesks) {
    for (const d of (state.settings.desks || [])) out.push(`${kind}:${d.id}`);
  }
  return out;
}

/** Desks-off branch of `ensureSpecialNodes`. Mutates `tree` in place
 *  to ensure a single global Inbox / Images / Trash with the canonical
 *  ordering (Inbox first, Images then Trash pinned to the tail). */
export function ensureGlobalTreeSpecials(tree) {
  if (!tree.some((n) => n.id === "__inbox__")) tree.unshift({ id: "__inbox__", type: "project", name: "Inbox", children: [], flagged: false });
  if (!tree.some((n) => n.id === "__images__")) tree.push({ id: "__images__", type: "folder", name: "Images", children: [], flagged: false });
  if (!tree.some((n) => n.id === "__trash__")) tree.push({ id: "__trash__", type: "folder", name: "Trash", children: [], flagged: false });
  const moveTo = (id, idx) => {
    const i = tree.findIndex((n) => n.id === id);
    if (i >= 0 && i !== idx) { const [n] = tree.splice(i, 1); tree.splice(idx, 0, n); }
  };
  moveTo("__inbox__", 0);
  moveTo("__trash__", tree.length - 1);
  moveTo("__images__", tree.length - 2);
}

/** Desks-on branch of `ensureSpecialNodes`. Mutates `tree` in place to
 *  drop any orphan global specials, fold loose top-level non-desk
 *  nodes into the active (or first) desk, and ensure every desk has
 *  Inbox/Images/Trash. */
export function ensureDesksTreeSpecials(state, tree) {
  const desks = tree.filter((n) => n.type === "desk");
  const target = desks.find((d) => d.id === state.settings?.activeDeskId) || desks[0];
  if (target) {
    const stragglers = tree.filter((n) => n.type !== "desk" && !isSpecialNodeId(n.id));
    for (const s of stragglers) {
      const idx = tree.indexOf(s);
      if (idx >= 0) tree.splice(idx, 1);
      if (!Array.isArray(target.children)) target.children = [];
      target.children.push(s);
    }
    for (const id of ["__inbox__", "__images__", "__trash__"]) {
      const i = tree.findIndex((n) => n.id === id);
      if (i >= 0) tree.splice(i, 1);
    }
  }
  for (const d of desks) ensureDeskSpecials(d);
}

export async function setActiveDesk(state, deskId) {
  if (!state.settings?.useDesks) return;
  const desks = state.settings.desks || [];
  if (!desks.some((d) => d.id === deskId)) return;
  if (state.settings.activeDeskId === deskId) return;
  await state.updateSettings({ activeDeskId: deskId });
  state.emit("active-desk-changed", deskId);
}

/** Listen for `desks-toggle-request` from the settings window and run
 *  the matching enable/disable migration. Called once during boot. */
export async function wireDesksTauri(state) {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("desks-toggle-request", async (event) => {
    try {
      await (event.payload?.enabled ? enableDesks(state, "Personal") : disableDesks(state));
      state.emit("settings-changed");
      state.emit("files-changed");
    } catch (e) { console.error("desks toggle failed:", e); }
  });
}
