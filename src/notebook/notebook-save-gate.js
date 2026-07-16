/**
 * Save gating for the notebook bridge — quiet-moment deferral, version-
 * snapshot throttling, and adaptive backpressure. Extracted from
 * notebook-bridge.js (700-line cap). The bridge manages a single main
 * notebook, so one instance lives there and `reset()` runs per mount.
 */

/** Version snapshots are throttled independently of the 2-second
 *  autosave: continuous writing keeps the notebook dirty on every
 *  tick, and snapshotting each one wrote a full multi-MB copy of the
 *  notebook to disk every 2 s for the whole session. The file write
 *  itself still happens on eligible dirty ticks — only the version-
 *  history slot is rate-limited. `snapshotPending` tracks content that
 *  was saved without earning a slot, so unmount (and the next eligible
 *  save) can flush it — the last state of a session always lands in
 *  history. */
const NOTEBOOK_SNAPSHOT_MIN_MS = 45_000;

/** Quiet-moment gating: a save's IPC marshal blocks the JS thread long
 *  enough to drop pointer samples, so never save while a stroke is in
 *  flight or the camera moved in the last few hundred ms (covers every
 *  pan source — wheel, pinch, space-drag, two-finger — since they all
 *  notify the camera). A starvation guard saves anyway after 15 s of
 *  continuous deferral so an endless doodle can't block persistence
 *  forever. */
const SAVE_QUIET_PAN_MS = 400;
const SAVE_DEFER_MAX_MS = 15_000;

/** Camera-only saves ship the full envelope just to persist a
 *  viewport — cap those at one per 20 s (unmount forces a final one,
 *  so the resting viewport always lands). */
const CAMERA_ONLY_SAVE_MIN_MS = 20_000;

export class NotebookSaveGate {
  lastSnapshotAtMs = 0;
  snapshotPending = false;
  lastSaveEndAt = 0;
  lastSaveDurationMs = 0;
  _lastCameraChangeAt = 0;
  _deferredSince = 0;

  /** Fresh notebook, fresh gates — the first content change after a
   *  mount earns a version slot immediately. */
  reset() {
    this.lastSnapshotAtMs = 0;
    this.snapshotPending = false;
    this.lastSaveEndAt = 0;
    this.lastSaveDurationMs = 0;
    this._lastCameraChangeAt = 0;
    this._deferredSince = 0;
  }

  noteCameraChange() {
    this._lastCameraChangeAt = performance.now();
  }

  noteSaveEnded(durationMs) {
    this.lastSaveEndAt = performance.now();
    this.lastSaveDurationMs = durationMs;
  }

  /** Quiet-moment gate — see SAVE_QUIET_PAN_MS above. */
  shouldDefer(strokeActive) {
    const now = performance.now();
    const panActive = now - this._lastCameraChangeAt < SAVE_QUIET_PAN_MS;
    if (!strokeActive && !panActive) {
      this._deferredSince = 0;
      return false;
    }
    if (!this._deferredSince) this._deferredSince = now;
    if (now - this._deferredSince > SAVE_DEFER_MAX_MS) {
      this._deferredSince = 0;
      return false;
    }
    return true;
  }

  cameraOnlyTooSoon() {
    return performance.now() - this.lastSaveEndAt < CAMERA_ONLY_SAVE_MIN_MS;
  }

  /** Adaptive backpressure: a save that took X ms doesn't run again
   *  for at least 4X (never below the 2 s autosave tick, capped at
   *  10 s), so a slow pipe / huge notebook can't be saturated with
   *  back-to-back multi-MB writes. Skipped ticks lose nothing — dirty
   *  flags stay set and the next eligible tick writes. */
  backpressureTooSoon() {
    const minGap = Math.min(10_000, this.lastSaveDurationMs * 4);
    return performance.now() - this.lastSaveEndAt < minGap;
  }

  /** True when a content save right now should also earn a version slot. */
  snapshotDue(force) {
    return force || Date.now() - this.lastSnapshotAtMs >= NOTEBOOK_SNAPSHOT_MIN_MS;
  }

  markSnapshotTaken() {
    this.lastSnapshotAtMs = Date.now();
    this.snapshotPending = false;
  }
}
