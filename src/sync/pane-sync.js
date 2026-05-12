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
 * Pane size (`width`, `height`) and the editor's scroll position do
 * round-trip across devices so a reading layout stays put. Position
 * (`x`, `y`) does not — different device classes have wildly different
 * viewports, so each device picks its own placement and the
 * `recoverOffscreenPanes` pass nudges any incoming pane that landed
 * off-screen back into view. Anchored panes (canvas-attached notebooks,
 * scroll-anchored docs) carry their anchor across so the pane snaps
 * back to the right paragraph or canvas point.
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
// v2 adds `ownerDeskId` + `ownerInnerPath` for project-scoped panes,
// keyed on the desk's stable id rather than a folder-name path so
// desk renames don't orphan pane records. The apply branch reads
// both v1 (ownerRemoteId only) and v2 (with the desk-relative fields).
const PANES_FORMAT_VERSION = 2;

/** Walk the tree to find a node by id; return both the node and its
 *  enclosing desk + inner-path. Used to translate a local project
 *  id into the cross-device `{deskId, innerPath}` key. */
function locateNodeInDesk(fileTree, nodeId) {
  function walk(nodes, deskId, innerParts) {
    for (const n of nodes || []) {
      if (n.type === "desk") {
        const hit = walk(n.children || [], n.id, []);
        if (hit) return hit;
        continue;
      }
      const here = [...innerParts, n.name];
      if (n.id === nodeId) return { node: n, deskId, innerPath: here.join("/") };
      if (n.children?.length) {
        const hit = walk(n.children, deskId, here);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(fileTree || [], "", []);
}

/** Inverse of `locateNodeInDesk`: given `{deskId, innerPath}`, find
 *  the local project node and return its id (or null if missing —
 *  the project's folder may not have synced down yet). */
function findProjectIdByDeskInner(fileTree, deskId, innerPath) {
  if (!deskId || !innerPath) return null;
  const desk = (fileTree || []).find(n => n.type === "desk" && n.id === deskId);
  if (!desk) return null;
  const parts = innerPath.split("/");
  let cursor = desk.children || [];
  let found = null;
  for (const name of parts) {
    const next = cursor.find(n => (n.type === "folder" || n.type === "project") && n.name === name);
    if (!next) return null;
    found = next;
    cursor = next.children || [];
  }
  return found?.type === "project" ? found.id : null;
}

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

/** Compose the dedup match key for a pane. Zotero panes key on
 *  `attKey` (cross-device stable identity) instead of `fileId` (per
 *  install). All other panes key on `fileId`. */
function matchKey(ownerContext, fileType, fileId, attKey) {
  const ident = fileType === "zotero-highlights" ? `att:${attKey || ""}` : fileId || "";
  return `${ownerContext || ""}|${ident}|${fileType}`;
}

// ===== Outbound =====

/**
 * Serialize the local panes map into the cross-device payload string.
 * Skips panes that can't be represented across devices: local-sync,
 * not-yet-synced, projects (no Dropbox file backs a project context).
 *
 * The payload also carries `hiddenOwners` — a list of
 * `{ kind, remoteId }` entries derived from
 * `state.settings.panesHiddenByContext` so the "Hide / Show panes"
 * choice rides cross-device alongside the panes themselves. Each
 * locally-hidden context whose backing file has a Dropbox identity is
 * translated to its `remoteId`; projects and local-sync-only contexts
 * are skipped because they have no stable cross-device identity.
 */
export async function serializePanesForSync(panesMap, state = null) {
  const out = [];

  // Pre-resolve all referenced fileIds to remote_ids in one batch via
  // get_sync_file_info. There aren't usually many panes so the loop is
  // fine; if this grows we can optimize.
  for (const [, pane] of panesMap) {
    if (!pane || !pane.fileId || !pane.fileType) continue;
    if (pane.localSync) continue; // local-sync panes have no Dropbox identity

    // Zotero highlight panes have no underlying Dropbox file, but the
    // Zotero `attKey` is itself a stable cross-device identity. Use it
    // as the `remoteFileId` and ride along the rest of the wire format.
    let remoteFileId;
    let zoteroPayload = null;
    if (pane.fileType === "zotero-highlights") {
      const att = pane.zotero?.attKey;
      if (!att) continue; // still in search step — nothing to sync yet
      remoteFileId = `zotero:${att}`;
      zoteroPayload = {
        itemKey: pane.zotero.itemKey || null,
        attKey: pane.zotero.attKey,
        title: pane.zotero.title || "",
        authors: pane.zotero.authors || "",
        year: pane.zotero.year || "",
      };
    } else {
      const fileInfo = await tauriInvoke("get_sync_file_info", { internalId: pane.fileId })
        .catch(() => null);
      if (!fileInfo || !fileInfo.remoteId) continue; // not yet uploaded — skip
      remoteFileId = fileInfo.remoteId;
    }

    const owner = parseOwnerContext(pane.ownerContext);
    let ownerRemoteId = "";
    let ownerDeskId = "";
    let ownerInnerPath = "";
    if (owner.kind === "doc" || owner.kind === "nb") {
      const ownerInfo = await tauriInvoke("get_sync_file_info", { internalId: owner.id })
        .catch(() => null);
      if (!ownerInfo || !ownerInfo.remoteId) continue; // owner not synced — drop
      ownerRemoteId = ownerInfo.remoteId;
    } else if (owner.kind === "pj") {
      // Project-scoped panes: the owner is a folder, not a file, so
      // there's no remote_id. The stable cross-device key is the
      // enclosing desk's id + the inner path from the desk's root.
      // Skip projects that live outside a desk (legacy flat trees).
      const located = state?.fileTree ? locateNodeInDesk(state.fileTree, owner.id) : null;
      if (!located || !located.deskId || !located.innerPath) continue;
      ownerDeskId = located.deskId;
      ownerInnerPath = located.innerPath;
    }

    out.push({
      remoteFileId,
      fileType: pane.fileType,
      ownerKind: owner.kind,
      ownerRemoteId,
      ownerDeskId,
      ownerInnerPath,
      attached: !!pane.attached,
      pinned: !!pane.pinned,
      collapsed: !!pane.collapsed,
      canvasX: pane._canvasX ?? null,
      canvasY: pane._canvasY ?? null,
      scrollRelY: pane._scrollRelY ?? null,
      width: typeof pane.width === "number" ? pane.width : null,
      height: typeof pane.height === "number" ? pane.height : null,
      editorScrollTop: typeof pane.editorScrollTop === "number" ? pane.editorScrollTop : null,
      fontSize: typeof pane.fontSize === "number" ? pane.fontSize : null,
      zotero: zoteroPayload,
    });
  }

  const hiddenOwners = [];
  const localHidden = state?.settings?.panesHiddenByContext || {};
  for (const [ctxId, flag] of Object.entries(localHidden)) {
    if (!flag) continue;
    const { kind, id } = parseOwnerContext(ctxId);
    if (kind === "doc" || kind === "nb") {
      const info = await tauriInvoke("get_sync_file_info", { internalId: id }).catch(() => null);
      if (!info?.remoteId) continue;
      hiddenOwners.push({ kind, remoteId: info.remoteId });
    } else if (kind === "pj" && state?.fileTree) {
      const located = locateNodeInDesk(state.fileTree, id);
      if (!located || !located.deskId || !located.innerPath) continue;
      hiddenOwners.push({ kind, deskId: located.deskId, innerPath: located.innerPath });
    }
  }

  return JSON.stringify({
    format: "hush-panes",
    version: PANES_FORMAT_VERSION,
    panes: out,
    hiddenOwners,
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
  const { panes, createPaneFn, recoverOffscreenFn, suppressPersist, state } = deps;

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

    let localFileId = null;
    let fileName = "Untitled";
    let zoteroPayload = null;

    if (p.fileType === "zotero-highlights") {
      // Cross-device identity is the Zotero attKey; no local file to
      // resolve. The local fileId is minted by createPaneFn so it
      // doesn't collide with any existing pane.
      if (!p.zotero?.attKey) { skipped++; continue; }
      zoteroPayload = p.zotero;
      fileName = p.zotero.title || "Zotero highlights";
    } else {
      const localFile = await tauriInvoke("find_synced_file_by_remote_id", {
        remoteId: p.remoteFileId,
      }).catch(() => null);
      if (!localFile) { skipped++; continue; }
      localFileId = localFile.internalId;
      fileName = localFile.relativePath?.split("/").pop()?.replace(/\.(md|hushnote)$/, "") || "Untitled";
    }

    let ownerContext = "";
    if (p.ownerKind === "pj" && p.ownerDeskId && p.ownerInnerPath) {
      // Project-scoped pane (v2 schema). Resolve the project by
      // {deskId, innerPath}; skip if the folder hasn't synced down.
      const localProjectId = state?.fileTree
        ? findProjectIdByDeskInner(state.fileTree, p.ownerDeskId, p.ownerInnerPath)
        : null;
      if (!localProjectId) { skipped++; continue; }
      ownerContext = buildOwnerContext("pj", localProjectId);
    } else if (p.ownerKind && p.ownerRemoteId) {
      const ownerLocal = await tauriInvoke("find_synced_file_by_remote_id", {
        remoteId: p.ownerRemoteId,
      }).catch(() => null);
      if (!ownerLocal) { skipped++; continue; }
      ownerContext = buildOwnerContext(p.ownerKind, ownerLocal.internalId);
    }

    resolved.push({
      fileId: localFileId, // null for zotero — minted at create time
      fileType: p.fileType,
      ownerContext,
      attached: !!p.attached,
      pinned: !!p.pinned,
      collapsed: !!p.collapsed,
      canvasX: p.canvasX,
      canvasY: p.canvasY,
      scrollRelY: p.scrollRelY,
      width: typeof p.width === "number" ? p.width : null,
      height: typeof p.height === "number" ? p.height : null,
      editorScrollTop: typeof p.editorScrollTop === "number" ? p.editorScrollTop : null,
      fontSize: typeof p.fontSize === "number" ? p.fontSize : null,
      fileName,
      zotero: zoteroPayload,
    });
  }

  // Index existing panes for O(1) match. Regular panes key on local
  // fileId; zotero panes key on attKey (cross-device stable).
  const localByKey = new Map();
  for (const [, pane] of panes) {
    localByKey.set(matchKey(pane.ownerContext, pane.fileType, pane.fileId, pane.zotero?.attKey), pane);
  }

  const newlyAdded = [];

  // Suppress persist + re-upload while we mutate. Caller passes a token
  // to clear when this batch is done.
  if (suppressPersist) suppressPersist(true);
  try {
    for (const r of resolved) {
      const key = matchKey(r.ownerContext, r.fileType, r.fileId, r.zotero?.attKey);
      const existing = localByKey.get(key);
      if (existing) {
        // Update anchoring + soft state. Size + editor scroll round-trip;
        // position is left alone (different viewports across devices).
        if (r.canvasX != null) existing._canvasX = r.canvasX;
        if (r.canvasY != null) existing._canvasY = r.canvasY;
        if (r.scrollRelY != null) existing._scrollRelY = r.scrollRelY;
        if (r.attached !== undefined) existing.attached = r.attached;
        if (r.pinned !== undefined) existing.pinned = r.pinned;
        if (r.collapsed !== undefined) existing.collapsed = r.collapsed;
        if (r.fontSize !== null) {
          existing.fontSize = r.fontSize;
          // Re-apply the CSS var so the visual updates without waiting
          // for a remount. Without this the new size only takes effect
          // after the user toggles the +/- popover or restarts.
          const { applyPaneFontSize } = await import("../pane/pane-size-popover.js");
          applyPaneFontSize(existing);
        }
        if (r.width != null && r.width > 0) {
          existing.width = r.width;
          if (existing.el) existing.el.style.width = r.width + "px";
        }
        if (r.height != null && r.height > 0) {
          existing.height = r.height;
          if (existing.el && !existing.collapsed) existing.el.style.height = r.height + "px";
        }
        if (r.editorScrollTop != null) {
          existing.editorScrollTop = r.editorScrollTop;
          if (existing.editor && existing.editor.setScrollTop) {
            // Defer two frames so the editor has measured its viewport
            // before we set scrollTop. CodeMirror sometimes resets
            // scrollTop to 0 during its first layout pass; the rAFs let
            // that pass complete first.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              try { existing.editor.setScrollTop(r.editorScrollTop); } catch (_) {}
            }));
          }
        }
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
          width: r.width,
          height: r.height,
          editorScrollTop: r.editorScrollTop,
          fontSize: r.fontSize,
          fileName: r.fileName,
          zotero: r.zotero,
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

  // Merge the remote `hiddenOwners` list into `panesHiddenByContext`.
  // Field is optional (older clients omit it) so absence leaves the
  // local map alone. When present, the remote view replaces every
  // locally-hidden context whose backing file has a Dropbox identity;
  // local-sync / never-synced / project contexts are preserved since
  // they have no cross-device identity in this payload.
  if (state && Array.isArray(parsed.hiddenOwners)) {
    await mergeRemoteHiddenContexts(state, parsed.hiddenOwners);
  }

  return { matched, added, skipped };
}

async function mergeRemoteHiddenContexts(state, hiddenOwners) {
  const newMap = {};
  const localMap = state.settings?.panesHiddenByContext || {};
  // Preserve local entries the remote can't represent (local-only or
  // project entries whose folder hasn't synced down yet).
  for (const [ctxId, flag] of Object.entries(localMap)) {
    if (!flag) continue;
    const { kind, id } = parseOwnerContext(ctxId);
    if (kind === "pj") {
      // Carry over unless the remote authoritative list re-asserts it.
      // Project entries can be remote-represented now (deskId +
      // innerPath); the layer-on pass below overwrites in that case.
      newMap[ctxId] = true;
      continue;
    }
    if (kind !== "doc" && kind !== "nb") continue;
    const info = await tauriInvoke("get_sync_file_info", { internalId: id }).catch(() => null);
    if (!info?.remoteId) { newMap[ctxId] = true; continue; } // local-only, keep
    // Otherwise the remote payload is authoritative for this entry.
  }
  // Layer the remote view on top.
  for (const e of hiddenOwners) {
    if (!e) continue;
    if ((e.kind === "doc" || e.kind === "nb") && e.remoteId) {
      const local = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: e.remoteId })
        .catch(() => null);
      if (!local?.internalId) continue;
      newMap[buildOwnerContext(e.kind, local.internalId)] = true;
    } else if (e.kind === "pj" && e.deskId && e.innerPath) {
      const pid = findProjectIdByDeskInner(state.fileTree, e.deskId, e.innerPath);
      if (pid) newMap[buildOwnerContext("pj", pid)] = true;
    }
  }
  // Stable-stringify for cheap equality so we skip a no-op write.
  const prev = JSON.stringify(localMap);
  const next = JSON.stringify(newMap);
  if (prev === next) return;
  await state.updateSettings({ panesHiddenByContext: newMap }, { fromSync: true });
  const { refreshPaneContextVisibility } = await import("../pane/pane-manager.js");
  refreshPaneContextVisibility();
  state.emit("panes-hidden-changed", null);
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

export async function enqueuePaneUpload(payload) {
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  return enqueueMetaUpload("panes.json", payload);
}

// Re-export for callers that imported from here pre-meta-sync extraction.
export { markOurRev, isOurRev } from "./meta-sync.js";

/**
 * Cursor dispatcher for `.hush/panes.json`. Called by sync-polling when
 * a remote pane payload arrives. Keeps all the pane-sync orchestration
 * (lazy imports, deps wiring) here so the cursor handler stays generic.
 *
 * Signature matches the meta-dispatcher protocol: `(state, payload)`.
 * The `state` arg is currently unused — pane-sync pulls everything it
 * needs via the lazy imports below — but accepting it keeps the
 * function shape uniform with the other meta dispatchers and prevents
 * the silent arg-drop bug where the second arg (payload) gets thrown
 * away and JSON.parse ends up trying to parse the AppState object.
 */
export async function applyPanesFile(state, payload) {
  const { panes } = await import("../pane/pane-state.js");
  const { suppressPersist } = await import("../pane/pane-persistence.js");
  const { createPane, refreshPaneContextVisibility } = await import("../pane/pane-manager.js");

  const DEFAULT_X = 80;
  const DEFAULT_Y = 100;

  const result = await applyRemotePanes(payload, {
    panes,
    state,
    suppressPersist,
    createPaneFn: async (opts) => {
      try {
        // Zotero panes carry no synced file; mint a local-only fileId
        // so the de-dup check in createPane has something stable to
        // compare and the persistence layer has a key.
        const fileId = opts.fileType === "zotero-highlights"
          ? `zotero:${crypto.randomUUID()}`
          : opts.fileId;
        const pane = await createPane(
          fileId,
          opts.fileName || "Untitled",
          opts.fileType,
          DEFAULT_X,
          DEFAULT_Y,
          { ownerContext: opts.ownerContext, skipFocus: true, zotero: opts.zotero || null },
        );
        if (!pane) return null;
        if (opts.attached) {
          pane.attached = true;
          const aBtn = pane.el.querySelector(".fp-btn-attach");
          if (aBtn) aBtn.classList.add("attach-active");
        }
        if (opts.pinned) {
          pane.pinned = true;
          pane.el.classList.add("pinned");
          const pBtn = pane.el.querySelector(".fp-btn-pin");
          if (pBtn) pBtn.classList.add("pin-active");
        }
        if (opts.collapsed) {
          pane._savedHeight = pane.height;
          pane.el.classList.add("collapsed");
          pane.el.style.height = "32px";
          pane.collapsed = true;
        }
        if (opts.canvasX != null) pane._canvasX = opts.canvasX;
        if (opts.canvasY != null) pane._canvasY = opts.canvasY;
        if (opts.scrollRelY != null) pane._scrollRelY = opts.scrollRelY;
        if (opts.fontSize != null) {
          pane.fontSize = opts.fontSize;
          // Cascade the CSS var so the new pane paints at the synced size
          // immediately rather than at the document default.
          const { applyPaneFontSize } = await import("../pane/pane-size-popover.js");
          applyPaneFontSize(pane);
        }
        if (typeof opts.width === "number" && opts.width > 0) {
          pane.width = opts.width;
          if (pane.el) pane.el.style.width = opts.width + "px";
        }
        if (typeof opts.height === "number" && opts.height > 0) {
          pane.height = opts.height;
          if (pane.el && !pane.collapsed) pane.el.style.height = opts.height + "px";
        }
        if (typeof opts.editorScrollTop === "number") {
          pane.editorScrollTop = opts.editorScrollTop;
          if (pane.editor && pane.editor.setScrollTop) {
            // Defer two frames so CodeMirror has measured its viewport.
            // One rAF isn't always enough — the first frame after content
            // load can reset scrollTop to 0 during layout.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              try { pane.editor.setScrollTop(opts.editorScrollTop); } catch (_) {}
            }));
          }
        }
        return pane;
      } catch (e) {
        console.warn("createPane (from sync) failed:", e);
        return null;
      }
    },
    recoverOffscreenFn: (added) => recoverOffscreenPanes(added),
  });
  refreshPaneContextVisibility();
  return result;
}

export const PANES_RELATIVE_PATH = PANES_PATH;
