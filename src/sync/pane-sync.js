/**
 * Pane sync — serialize the open panes to `.hush/panes.json` on Dropbox
 * and merge incoming pane state from other devices.
 *
 * Identity model: across devices, a file's local UUID (`fileId`) is
 * different on each install. The only stable cross-device identity is
 * the Dropbox file `remote_id`. So this module translates fileId →
 * remote_id at upload time and remote_id → fileId at apply time, using
 * the existing sync map. Panes whose underlying file isn't synced
 * (no remote_id, or local-sync-only) are skipped — they can't survive
 * the round-trip in any meaningful way.
 *
 * Pixel layout (`x`, `y`, `width`, `height`) is intentionally NOT
 * synced. Different device classes have wildly different viewports;
 * each device picks its own placement. Anchored panes (canvas-attached
 * notebooks, scroll-anchored docs) DO carry their anchor across so the
 * pane snaps back to the right paragraph or canvas point.
 *
 * Merge policy: additive. Panes that exist locally but not remotely are
 * kept (you didn't lose anything by going to another device). Remote
 * panes that already match a local pane by (ownerContext, fileId,
 * fileType) update that local pane's anchor in place. Unmatched remote
 * panes are added with default placement; viewport recovery then nudges
 * any that landed off-screen into view.
 */

const SYNC_FOLDER_ID = "__dropbox_sync__";
const PANES_PATH = ".hush/panes.json";
const PANES_FORMAT_VERSION = 1;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Split `"doc:abc123"` into `{ kind: "doc", id: "abc123" }`. Returns
 *  `{ kind: "", id: "" }` for empty / malformed inputs (global panes). */
function parseOwnerContext(ctx) {
  if (!ctx || typeof ctx !== "string") return { kind: "", id: "" };
  const idx = ctx.indexOf(":");
  if (idx <= 0) return { kind: "", id: "" };
  return { kind: ctx.slice(0, idx), id: ctx.slice(idx + 1) };
}

function buildOwnerContext(kind, id) {
  if (!kind || !id) return "";
  return `${kind}:${id}`;
}

// ===== Outbound =====

/**
 * Serialize the local panes map into the cross-device payload string.
 * Skips panes that can't be represented across devices: local-sync,
 * not-yet-synced, projects (no Dropbox file backs a project context).
 */
export async function serializePanesForSync(panesMap) {
  const out = [];

  // Pre-resolve all referenced fileIds to remote_ids in one batch via
  // get_sync_file_info. There aren't usually many panes so the loop is
  // fine; if this grows we can optimize.
  for (const [, pane] of panesMap) {
    if (!pane || !pane.fileId || !pane.fileType) continue;
    if (pane.localSync) continue; // local-sync panes have no Dropbox identity

    const fileInfo = await tauriInvoke("get_sync_file_info", { internalId: pane.fileId })
      .catch(() => null);
    if (!fileInfo || !fileInfo.remoteId) continue; // not yet uploaded — skip

    const owner = parseOwnerContext(pane.ownerContext);
    let ownerRemoteId = "";
    if (owner.kind === "doc" || owner.kind === "nb") {
      const ownerInfo = await tauriInvoke("get_sync_file_info", { internalId: owner.id })
        .catch(() => null);
      if (!ownerInfo || !ownerInfo.remoteId) continue; // owner not synced — drop
      ownerRemoteId = ownerInfo.remoteId;
    } else if (owner.kind === "pj") {
      // Projects don't have a Dropbox file (they're folders + .hushproject).
      // Skip pj-scoped panes for now; future work could map by folder path.
      continue;
    }

    out.push({
      remoteFileId: fileInfo.remoteId,
      fileType: pane.fileType,
      ownerKind: owner.kind,
      ownerRemoteId,
      attached: !!pane.attached,
      pinned: !!pane.pinned,
      collapsed: !!pane.collapsed,
      canvasX: pane._canvasX ?? null,
      canvasY: pane._canvasY ?? null,
      scrollRelY: pane._scrollRelY ?? null,
      fontSize: typeof pane.fontSize === "number" ? pane.fontSize : null,
    });
  }

  return JSON.stringify({
    format: "hush-panes",
    version: PANES_FORMAT_VERSION,
    panes: out,
  }, null, 2);
}

// ===== Inbound =====

/**
 * Apply a remote pane payload to the local pane state. Returns a summary
 * `{ matched, added, skipped }` for the sync indicator.
 *
 * Caller is responsible for guarding against re-upload loops (e.g. by
 * setting a flag the persist hook checks).
 */
export async function applyRemotePanes(payloadString, deps) {
  const { panes, createPaneFn, recoverOffscreenFn, suppressPersist } = deps;

  let parsed;
  try { parsed = JSON.parse(payloadString); }
  catch { return { matched: 0, added: 0, skipped: 0, error: "parse" }; }

  if (!parsed || parsed.format !== "hush-panes" || !Array.isArray(parsed.panes)) {
    return { matched: 0, added: 0, skipped: 0, error: "format" };
  }

  let matched = 0;
  let added = 0;
  let skipped = 0;

  // Translate each remote pane to the local fileId space. Drop entries
  // we can't resolve — the underlying file probably hasn't synced down
  // to this device yet; we'll pick them up on a future poll.
  const resolved = [];
  for (const p of parsed.panes) {
    if (!p || !p.remoteFileId || !p.fileType) { skipped++; continue; }

    const localFile = await tauriInvoke("find_synced_file_by_remote_id", {
      remoteId: p.remoteFileId,
    }).catch(() => null);
    if (!localFile) { skipped++; continue; }

    let ownerContext = "";
    if (p.ownerKind && p.ownerRemoteId) {
      const ownerLocal = await tauriInvoke("find_synced_file_by_remote_id", {
        remoteId: p.ownerRemoteId,
      }).catch(() => null);
      if (!ownerLocal) { skipped++; continue; }
      ownerContext = buildOwnerContext(p.ownerKind, ownerLocal.internalId);
    }

    resolved.push({
      fileId: localFile.internalId,
      fileType: p.fileType,
      ownerContext,
      attached: !!p.attached,
      pinned: !!p.pinned,
      collapsed: !!p.collapsed,
      canvasX: p.canvasX,
      canvasY: p.canvasY,
      scrollRelY: p.scrollRelY,
      fontSize: typeof p.fontSize === "number" ? p.fontSize : null,
      fileName: localFile.relativePath?.split("/").pop()?.replace(/\.(md|hushnote)$/, "") || "Untitled",
    });
  }

  // Index existing panes by (ownerContext, fileId, fileType) so we can
  // match additive merges in O(1).
  const localByKey = new Map();
  for (const [, pane] of panes) {
    const key = `${pane.ownerContext || ""}|${pane.fileId}|${pane.fileType}`;
    localByKey.set(key, pane);
  }

  const newlyAdded = [];

  // Suppress persist + re-upload while we mutate. Caller passes a token
  // to clear when this batch is done.
  if (suppressPersist) suppressPersist(true);
  try {
    for (const r of resolved) {
      const key = `${r.ownerContext || ""}|${r.fileId}|${r.fileType}`;
      const existing = localByKey.get(key);
      if (existing) {
        // Update anchoring + soft state; pixel layout stays put.
        if (r.canvasX != null) existing._canvasX = r.canvasX;
        if (r.canvasY != null) existing._canvasY = r.canvasY;
        if (r.scrollRelY != null) existing._scrollRelY = r.scrollRelY;
        if (r.attached !== undefined) existing.attached = r.attached;
        if (r.pinned !== undefined) existing.pinned = r.pinned;
        if (r.collapsed !== undefined) existing.collapsed = r.collapsed;
        if (r.fontSize !== null) existing.fontSize = r.fontSize;
        matched++;
      } else if (createPaneFn) {
        const pane = await createPaneFn({
          fileId: r.fileId,
          fileType: r.fileType,
          ownerContext: r.ownerContext,
          attached: r.attached,
          pinned: r.pinned,
          collapsed: r.collapsed,
          canvasX: r.canvasX,
          canvasY: r.canvasY,
          scrollRelY: r.scrollRelY,
          fontSize: r.fontSize,
          fileName: r.fileName,
          fromSync: true,
        });
        if (pane) { newlyAdded.push(pane); added++; }
        else skipped++;
      } else {
        skipped++;
      }
    }
  } finally {
    if (suppressPersist) suppressPersist(false);
  }

  if (recoverOffscreenFn && newlyAdded.length) {
    recoverOffscreenFn(newlyAdded);
  }

  return { matched, added, skipped };
}

// ===== Viewport recovery =====

/**
 * Bring panes that landed off-screen back into view. Anchored panes are
 * the trickier case:
 *   * Canvas-attached notebook panes: don't move. The pane is anchored
 *     to a point in canvas space; the user pans the canvas to reach it.
 *   * Doc scroll-anchored panes: only x-axis correction. The y position
 *     is computed from `_scrollRelY` so it represents "how far down the
 *     doc the pane lives." Touching y would break the anchor; touching
 *     x just nudges off-screen panes back onto the visible side.
 *   * Floating / unpinned / globally-pinned panes: full clamp into view.
 */
export function recoverOffscreenPanes(panesToCheck, viewport) {
  const vw = viewport?.width || (typeof window !== "undefined" ? window.innerWidth : 1024);
  const vh = viewport?.height || (typeof window !== "undefined" ? window.innerHeight : 768);
  const margin = 40; // keep at least this much pane visible

  for (const pane of panesToCheck) {
    if (!pane || !pane.el) continue;

    const w = pane.width || 280;
    const h = pane.height || 200;

    const isDocAnchored = pane.fileType === "document" && pane._scrollRelY != null;
    const isCanvasAnchored = pane.fileType === "notebook" && pane.attached;

    if (isCanvasAnchored) continue; // user pans canvas to reach it

    const offRight = pane.x > vw - margin;
    const offLeft = pane.x + w < margin;
    const offBottom = pane.y > vh - margin;
    const offTop = pane.y + h < margin;

    let newX = pane.x;
    let newY = pane.y;

    if (offRight) newX = Math.max(margin, vw - w - margin);
    if (offLeft) newX = margin;

    if (!isDocAnchored) {
      // Floating panes get full clamp.
      if (offBottom) newY = Math.max(margin, vh - h - margin);
      if (offTop) newY = margin;
    }
    // Doc-anchored: y is derived from scroll position; leave it.

    if (newX !== pane.x || newY !== pane.y) {
      pane.x = newX;
      pane.y = newY;
      pane.el.style.left = newX + "px";
      pane.el.style.top = newY + "px";
    }
  }
}

// ===== Upload trigger =====

/**
 * Enqueue an upload of the panes payload via the op log.
 *
 * Multiple enqueues before the drain fires upload more than once; the
 * last write wins on Dropbox so it's correct, just slightly wasteful.
 * The `persistPanesNow` debounce (300ms) makes flurries rare in practice.
 */
export async function enqueuePaneUpload(payload) {
  const { enqueueUploadPayload, triggerDrain } = await import("./op-log.js");
  await enqueueUploadPayload({ path: PANES_PATH, payload });
  triggerDrain();
}

/**
 * In-memory set of `rev` tokens we've recently uploaded ourselves. The
 * cursor consumer asks `isOurRev` before applying a meta event so we
 * don't re-apply our own writes. The set is bounded; older entries get
 * dropped FIFO.
 *
 * Meta files don't live in the `synced_files` table (they aren't user
 * content), so the SQLite-backed `last_known_rev` echo suppression
 * doesn't cover them. This is the minimal local equivalent.
 */
const _ourRevs = new Set();
const _ourRevsOrder = [];
const OUR_REVS_MAX = 32;

export function markOurRev(rev) {
  if (!rev || _ourRevs.has(rev)) return;
  _ourRevs.add(rev);
  _ourRevsOrder.push(rev);
  while (_ourRevsOrder.length > OUR_REVS_MAX) {
    const old = _ourRevsOrder.shift();
    _ourRevs.delete(old);
  }
}

export function isOurRev(rev) {
  return !!rev && _ourRevs.has(rev);
}

export const PANES_RELATIVE_PATH = PANES_PATH;
