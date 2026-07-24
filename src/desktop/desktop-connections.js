/**
 * Desktop document connections — the arrows that show a project's
 * current document order across its thumbnails.
 *
 * These reuse the notebook's flowchart layer (`src/notebook/flowchart.ts`)
 * so the routing, bezier geometry, and arrowheads are exactly the ones a
 * hand-drawn chart uses. What's different is where the edges come from
 * and who owns them: they're **derived** from `collectDesktopFiles`'
 * walk order (the same order the files sidebar shows), rebuilt on every
 * reconcile, painted at 40 % opacity, and locked — the per-edge delete
 * dot / X is suppressed canvas-wide via `DrawingState.flowEdgesLocked`,
 * so a connection can't be removed one at a time. The whole set is
 * turned off with the per-Desktop **Show Document Connections** option.
 *
 * Because they're derived they're never persisted: `desktop-view`'s
 * envelope writes an empty `flowEdges` list and this module re-derives
 * on the next open.
 */

/** Derived arrows paint at 40 % so they annotate the layout rather than
 *  competing with the thumbnails. */
export const DOC_CONNECTION_ALPHA = 0.4;

const edgeId = (fromKey, toKey) => `docorder:${fromKey}>${toKey}`;

/**
 * Chain the doc thumbnails together in project order. `entries` comes
 * from `collectDesktopFiles` (tree order); `shapes` supplies the canvas
 * ids. Non-doc entries and docs with no thumbnail on the canvas (e.g.
 * pocketed) drop out of the chain rather than breaking it.
 */
export function docOrderEdges(entries, shapes) {
  const idByKey = new Map();
  for (const s of shapes) {
    if (s.type === "image" && s.fileRef?.key && !s.pocketed) idByKey.set(s.fileRef.key, s.id);
  }
  const chain = [];
  for (const entry of entries || []) {
    if (entry.kind !== "doc") continue;
    const id = idByKey.get(entry.key);
    if (id) chain.push({ key: entry.key, id });
  }
  const edges = [];
  for (let i = 1; i < chain.length; i++) {
    edges.push({ id: edgeId(chain[i - 1].key, chain[i].key), from: chain[i - 1].id, to: chain[i].id });
  }
  return edges;
}

function sameEdges(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].from !== b[i].from || a[i].to !== b[i].to) return false;
  }
  return true;
}

/** Mark a Desktop canvas's flowchart as derived-and-locked: 40 % arrows,
 *  no per-edge delete affordance. Called once at mount. */
export function initDesktopConnections(canvas) {
  const st = canvas?.state;
  if (!st) return;
  st.flowArrowAlpha = DOC_CONNECTION_ALPHA;
  st.flowEdgesLocked = true;
}

/**
 * Re-derive the connection set and push it onto the canvas. Repaints
 * through the `"interaction"` notify key — the edges aren't content, so
 * this must not mark the Desktop dirty for a save. No-ops when the set
 * already matches, so it's safe to call on every reconcile.
 */
export function applyDocConnections(canvas, entries, enabled) {
  const st = canvas?.state;
  if (!st) return;
  const next = enabled ? docOrderEdges(entries, st.shapes) : [];
  if (sameEdges(st.flowchart.serialize(), next)) return;
  st.flowchart.deserialize(next);
  st.notify("interaction");
}
