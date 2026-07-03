/**
 * Shared last mile for every sync provider: apply externally-produced
 * doc content to the live editor buffer.
 *
 * Historically each provider — the Dropbox cursor apply
 * (sync-polling.js), acceptExternalChange (sync-state.js), the
 * 409-conflict handler, Local Sync's watcher + foreground refresh, and
 * multi-window's sibling broadcast — carried its own copy of the
 * "acquire pull lock → setContent → dirty = false" dance, and the
 * copies drifted (the Local Sync watcher forgot the dirty guard; none
 * preserved the cursor). This is the single implementation. Providers
 * differ only in how they *detect* an external change (revs vs content
 * hashes — see echo-ring.js), never in how they apply one.
 *
 * Guarantees:
 *   - The pull lock is held across the dispatch so markDirty /
 *     saveCurrentFile can't race the apply. Reentrant-safe: when the
 *     caller already holds the lock under the same key (the Dropbox
 *     cursor holds it across the whole download), it's left in place
 *     for the caller's own release.
 *   - The edit lands as a minimal diff (editor.applyExternalContent),
 *     so the cursor/selection maps through the change instead of
 *     collapsing to the top of the document.
 *   - `state.dirty` is cleared — an applied external change is not a
 *     user edit, and a dirty flag left up would autosave the
 *     just-applied content straight back over the wire.
 *   - Identical content skips the dispatch entirely (dirty still
 *     clears): re-applying the same text would move the cursor for no
 *     user-visible reason.
 */

/**
 * Apply `content` to the open editor.
 *
 * `lockKey` is the pull-lock key `_isPullLockedForCurrent` matches
 * against — the internal fileId for synced docs, the synthetic
 * `localsync:<folderId>:<relPath>` for Local Sync mounts.
 *
 * `skipWhenDirty: true` is the conservative policy for providers whose
 * "remote" can hand back stale content (Local Sync, where iCloud
 * mutates the mounted folder behind our back): unsaved keystrokes are
 * strictly newer than anything on disk, so the buffer wins and the
 * next autosave reasserts it. Dropbox's most-recent-wins policy leaves
 * it false and applies over a dirty buffer (Versions is the safety
 * net).
 *
 * Returns true when the buffer now matches `content`, false when the
 * apply was skipped (no editor, dirty guard).
 */
export function applyExternalDocContent(state, { content, lockKey, skipWhenDirty = false }) {
  if (!state?.editor || typeof content !== "string") return false;
  if (skipWhenDirty && state.dirty) return false;
  if (state.editor.getContent() === content) {
    state.dirty = false;
    return true;
  }
  const alreadyHeld =
    !!state.runtime?.syncPulling && state.runtime.syncPullingFileId === lockKey;
  if (!alreadyHeld) state.acquirePullLock(lockKey);
  try {
    if (typeof state.editor.applyExternalContent === "function") {
      state.editor.applyExternalContent(content);
    } else {
      state.editor.setContent(content);
    }
    state.dirty = false;
  } finally {
    if (!alreadyHeld) state.releasePullLock();
  }
  return true;
}
