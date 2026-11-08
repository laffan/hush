/**
 * Desk sections — named dividers that loosely group desks under a
 * heading, in the desk switcher's dropdown and on the Desk Dashboard.
 *
 * A section is not a container: desks keep their one flat order
 * (`settings.desks`, mirrored into the tree by `reorderDesks`), and each
 * section only says where it sits in that order — `beforeDeskId`, the
 * desk it heads, or null for after the last desk. Sections that head the
 * same desk keep their array order. Every reorder goes through
 * `commitDeskLayout`, which takes the whole visual list and re-derives
 * both the desk order and every anchor from it, so moving a desk away
 * from under a heading leaves the heading where it was.
 *
 * Stored in `settings.deskSections` (`desk_sections` on the Rust side,
 * opaque JSON), per install like the desk list itself.
 */

function uid() {
  return "sec-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** The stored sections, always an array of well-formed entries. */
export function getDeskSections(state) {
  const raw = state.settings?.deskSections;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s.id === "string")
    .map((s) => ({ id: s.id, name: String(s.name ?? ""), beforeDeskId: s.beforeDeskId || null }));
}

/** Desks and sections interleaved in display order:
 *  `[{ kind: "section", section } | { kind: "desk", desk }]`. `desks` is
 *  the caller's list (in the user's order) of objects carrying `id`. A
 *  section whose desk is gone falls to the end. */
export function deskLayout(state, desks) {
  const sections = getDeskSections(state);
  const deskIds = new Set(desks.map((d) => d.id));
  const out = [];
  for (const desk of desks) {
    for (const section of sections) {
      if (section.beforeDeskId === desk.id) out.push({ kind: "section", section });
    }
    out.push({ kind: "desk", desk });
  }
  for (const section of sections) {
    if (!section.beforeDeskId || !deskIds.has(section.beforeDeskId)) out.push({ kind: "section", section });
  }
  return out;
}

/** Commit a visual order — `[{ kind: "desk" | "section", id }]`, top to
 *  bottom — as the desk order plus each section's anchor. */
export async function commitDeskLayout(state, items) {
  const deskIds = items.filter((it) => it.kind === "desk").map((it) => it.id);
  const byId = new Map(getDeskSections(state).map((s) => [s.id, s]));
  const next = [];
  items.forEach((it, i) => {
    if (it.kind !== "section" || !byId.has(it.id)) return;
    const below = items.slice(i + 1).find((x) => x.kind === "desk");
    next.push({ ...byId.get(it.id), beforeDeskId: below?.id || null });
  });
  // Sections the list didn't carry (none should be missing) keep theirs.
  for (const s of byId.values()) if (!next.some((n) => n.id === s.id)) next.push(s);
  const changed = JSON.stringify(next) !== JSON.stringify(getDeskSections(state));
  if (changed) await state.updateSettings({ deskSections: next });
  const current = (state.settings?.desks || []).map((d) => d.id);
  // reorderDesks emits desks-changed itself; without a desk move the
  // section change still has to repaint the lists.
  if (deskIds.join() !== current.join()) await state.reorderDesks(deskIds);
  else if (changed) state.emit("desks-changed");
}

/** Add a section at the end of the list. Returns its id. */
export async function addDeskSection(state, name = "New section") {
  const id = uid();
  await state.updateSettings({ deskSections: [...getDeskSections(state), { id, name, beforeDeskId: null }] });
  state.emit("desks-changed");
  return id;
}

export async function renameDeskSection(state, id, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return;
  const list = getDeskSections(state);
  if (!list.some((s) => s.id === id && s.name !== trimmed)) return;
  await state.updateSettings({ deskSections: list.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) });
  state.emit("desks-changed");
}

/** Remove a heading. The desks under it stay where they are. */
export async function deleteDeskSection(state, id) {
  const list = getDeskSections(state);
  if (!list.some((s) => s.id === id)) return;
  await state.updateSettings({ deskSections: list.filter((s) => s.id !== id) });
  state.emit("desks-changed");
}
