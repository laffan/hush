/**
 * Command palette section headers + the recently-used list.
 *
 * Every command descriptor carries a `section` string; this module owns
 * the order those sections appear in and the grouping pass the renderer
 * runs over the filtered list. Sections are display-only — filtering,
 * keyboard navigation and `runCommand` all still work off the flat
 * `filteredCommands` array, so a header can never become something the
 * arrow keys land on.
 *
 * Picker sub-modes (file picker, desk picker) hand the palette rows with
 * no `section` at all; `groupBySection` returns a single unlabelled run
 * for those, so a list of filenames doesn't grow a header it can't mean.
 */

/** Display order. Anything with an unlisted section sorts to the end in
 *  first-seen order, which keeps a new section visible rather than
 *  silently dropping it. */
export const SECTION_ORDER = [
  "Recent",
  "Active Modes",
  "Create",
  "Open",
  "Document",
  "Writing",
  "Outline",
  "Folding",
  "View",
  "Panes",
  "Stacks",
  "Notebook",
  "Desktops",
  "Sticky Notes",
  "Research",
  "Google",
  "Styles",
  "Desks",
  "App",
];

/**
 * Group `cmds` into `[{ section, items }]` runs, ordered by
 * `SECTION_ORDER`. `section` is null for a sectionless run, which the
 * renderer draws without a header.
 */
export function groupBySection(cmds) {
  const bySection = new Map();
  for (const cmd of cmds) {
    const key = cmd.section || null;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(cmd);
  }
  if (bySection.size === 1 && bySection.has(null)) {
    return [{ section: null, items: bySection.get(null) }];
  }
  const seen = [...bySection.keys()];
  const ordered = [
    ...SECTION_ORDER.filter((s) => bySection.has(s)),
    ...seen.filter((s) => s && !SECTION_ORDER.includes(s)),
  ];
  const out = ordered.map((s) => ({ section: s, items: bySection.get(s) }));
  // Sectionless rows (a picker row mixed into a sectioned list) lead,
  // unlabelled — they are never the tail of someone else's group.
  if (bySection.has(null)) out.unshift({ section: null, items: bySection.get(null) });
  return out;
}

// ── Recently-used commands ────────────────────────────────────────────

const RECENT_LIMIT = 5;

/** The stored MRU of command ids (newest first). */
export function recentCommandIds(state) {
  const ids = state?.settings?.recentCommandIds;
  return Array.isArray(ids) ? ids.filter((v) => typeof v === "string") : [];
}

/**
 * Record `id` as the most recently run command. `knownIds` is the set of
 * ids the palette was built from — a picker row (a filename, a desk)
 * carries an id too, and those are not commands anyone wants back at the
 * top of the list.
 */
export function recordRecentCommand(state, id, knownIds) {
  if (!id || !knownIds?.has(id)) return;
  const next = [id, ...recentCommandIds(state).filter((v) => v !== id)].slice(0, RECENT_LIMIT);
  const prev = recentCommandIds(state);
  if (next.length === prev.length && next.every((v, i) => v === prev[i])) return;
  try { state.updateSettings({ recentCommandIds: next }); } catch (_) { /* settings write is best-effort */ }
}

/**
 * The "Recent" rows for this open: the stored ids resolved against the
 * commands actually available right now, re-labelled into the Recent
 * section. Resolving against the live list is what keeps a recent entry
 * from outliving its context — a notebook command doesn't come back
 * while a doc is open, because it isn't in `cmds` to resolve.
 */
export function buildRecentCommands(state, cmds) {
  const ids = recentCommandIds(state);
  if (!ids.length) return [];
  const byId = new Map();
  for (const c of cmds) if (c.id && !byId.has(c.id)) byId.set(c.id, c);
  const out = [];
  for (const id of ids) {
    const cmd = byId.get(id);
    // A "Turn off …" row is already pinned to the top of the palette by
    // the turnoffs builder; repeating it under Recent is noise.
    if (!cmd || cmd.section === "Active Modes") continue;
    out.push({ ...cmd, section: "Recent" });
  }
  return out;
}
