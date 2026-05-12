/**
 * Style sync via `.hush/styles.json`.
 *
 * Carries the user's named styles. Merge is additive by `id` (a style
 * edited on one device shows up on the other), with the most-recently-
 * edited entry winning for any overlapping ids.
 *
 * The active-style pointer is now per-desk and rides `.hush/desks.json`
 * via `desksMeta[<deskId>].globalStyleId`, so this file no longer
 * carries the global pointer. The legacy `activeStyleId` /
 * `globalStyleId` fields are still emitted (always null) and tolerated
 * on receive so older clients don't crash.
 */

const STYLES_FILENAME = "styles.json";
const FORMAT_VERSION = 1;

// ===== Outbound =====

export function serializeStyles(settings) {
  return JSON.stringify({
    format: "hush-styles",
    version: FORMAT_VERSION,
    styles: Array.isArray(settings?.styles) ? settings.styles : [],
    // Legacy fields retained as null so older builds don't trip on a
    // schema mismatch. Per-desk pointer lives in `.hush/desks.json`.
    activeStyleId: null,
    globalStyleId: null,
  }, null, 2);
}

export async function pushStylesToDropbox(state) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
  if (state.runtime?.reseedActive) return;
  const payload = serializeStyles(state.settings);
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  await enqueueMetaUpload(STYLES_FILENAME, payload);
}

// ===== Inbound =====

/** Latest-wins merge over style id. Each style is expected to carry an
 *  `updatedAt` (Unix seconds); entries without one fall back to remote
 *  always-wins so the first sync after upgrade still propagates. */
function mergeStyleArrays(local, remote) {
  const localById = new Map();
  for (const s of (Array.isArray(local) ? local : [])) {
    if (s && s.id) localById.set(s.id, s);
  }
  const remoteById = new Map();
  for (const s of (Array.isArray(remote) ? remote : [])) {
    if (s && s.id) remoteById.set(s.id, s);
  }
  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  const merged = [];
  for (const id of allIds) {
    const a = localById.get(id);
    const b = remoteById.get(id);
    if (a && b) {
      const aTs = typeof a.updatedAt === "number" ? a.updatedAt : 0;
      const bTs = typeof b.updatedAt === "number" ? b.updatedAt : 0;
      merged.push(bTs >= aTs ? b : a);
    } else {
      merged.push(a || b);
    }
  }
  return merged;
}

export async function applyStylesFile(state, payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { return { matched: 0, added: 0, applied: 0, error: "parse" }; }
  if (!parsed || parsed.format !== "hush-styles") {
    return { matched: 0, added: 0, applied: 0, error: "format" };
  }

  const localStyles = state.settings?.styles || [];
  const remoteStyles = Array.isArray(parsed.styles) ? parsed.styles : [];
  const merged = mergeStyleArrays(localStyles, remoteStyles);

  // Detect change: skip the settings write (and the resulting upload
  // round-trip) when nothing differs.
  const sameLength = merged.length === localStyles.length;
  const sameContent = sameLength && merged.every((s, i) =>
    JSON.stringify(s) === JSON.stringify(localStyles[i])
  );

  const update = {};
  if (!sameContent) update.styles = merged;
  // The active/global pointers are per-desk now; any non-null value in
  // the payload comes from a pre-migration peer. Apply it only when we
  // don't already have a per-desk choice for the active desk so a fresh
  // device coming online still picks up something sensible.
  const havePerDeskChoice = (() => {
    const meta = state.settings?.desksMeta || {};
    const activeId = state.settings?.activeDeskId;
    return activeId ? meta[activeId]?.globalStyleId !== undefined : false;
  })();
  if (!havePerDeskChoice
      && parsed.globalStyleId !== undefined
      && parsed.globalStyleId !== state.settings.globalStyleId) {
    update.globalStyleId = parsed.globalStyleId;
  }
  if (Object.keys(update).length === 0) {
    return { matched: localStyles.length, added: 0, applied: 0 };
  }

  // Apply via state.updateSettings so the UI re-renders normally. The
  // settings-changed handler that pushes styles back to Dropbox needs
  // to know this update came from sync — pass a flag the hook checks.
  await state.updateSettings(update, { fromSync: true });
  state.emit("styles-applied-from-sync");

  const added = Math.max(0, merged.length - localStyles.length);
  return { matched: merged.length - added, added, applied: merged.length };
}

export const STYLES_RELATIVE_PATH = `.hush/${STYLES_FILENAME}`;
