/**
 * Single source of truth for "is it safe to push to Dropbox right now?"
 *
 * Before this module existed, every push path (`syncFileToExternal`,
 * `pushDesk`, `pushAllDesks`, `pushProjectsToDropbox`,
 * `pushStylesToDropbox`, `migrateFromDesksJson`, `reconcileSync`,
 * the op-log drain) had its own copy of the same three checks:
 *   1. Sync configured? (`dropboxEnabled` && `dropboxSyncPath`)
 *   2. Mid-reseed? (`state.runtime.reseedActive`)
 *   3. Mid-initial-sync? (the barrier flag in `sync-polling.js`)
 *
 * Forgetting any of them produced a race (e.g. a push during reseed
 * leaked half-built state to Dropbox). Centralising the predicate
 * means: one place to read, one place to extend, and every call site
 * is a single function call.
 */

export function isSyncConfigured(state) {
  return !!(state?.settings?.dropboxEnabled && state?.settings?.dropboxSyncPath);
}

export function isReseedActive(state) {
  return !!state?.runtime?.reseedActive;
}

export async function isInitialSyncBarrierActive() {
  try {
    const sp = await import("./sync-polling.js");
    return !!(sp.isInitialSyncBarrierActive && sp.isInitialSyncBarrierActive());
  } catch (_) { return false; }
}

/**
 * Synchronous version that skips the barrier check. Callers that
 * already imported `sync-polling.js` or that don't need barrier
 * coverage (e.g. the editor's pre-save guard) prefer this.
 */
export function isSyncWriteGatedSync(state) {
  if (!isSyncConfigured(state)) return true;
  if (isReseedActive(state)) return true;
  return false;
}

/**
 * Full predicate including the initial-sync barrier. Use this from the
 * push paths in desk-sync / project-sync / style-sync / sync-state's
 * reconcile + content uploads.
 */
export async function isSyncWriteGated(state) {
  if (!isSyncConfigured(state)) return true;
  if (isReseedActive(state)) return true;
  if (await isInitialSyncBarrierActive()) return true;
  return false;
}
