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

/** Quiet-moment gating: whatever a save costs, it shouldn't cost it
 *  while the user is mid-gesture. Saves wait until ALL of:
 *    - no stroke in flight,
 *    - no camera movement in the last 400 ms (covers every pan source —
 *      wheel, pinch, space-drag, two-finger — they all notify camera),
 *    - no content change in the last 1.5 s — i.e. the user paused
 *      writing, not just lifted the pen between letters. This is what
 *      makes saves land between *sections* of writing instead of
 *      between strokes, where even a small hitch reads as a skip.
 *  A starvation guard saves anyway after 15 s of continuous deferral so
 *  an endless doodle can't block persistence forever. */
const SAVE_QUIET_PAN_MS = 400;
const SAVE_QUIET_CONTENT_MS = 1500;
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
  _lastContentChangeAt = 0;
  _deferredSince = 0;

  /** Fresh notebook, fresh gates — the first content change after a
   *  mount earns a version slot immediately. */
  reset() {
    this.lastSnapshotAtMs = 0;
    this.snapshotPending = false;
    this.lastSaveEndAt = 0;
    this.lastSaveDurationMs = 0;
    this._lastCameraChangeAt = 0;
    this._lastContentChangeAt = 0;
    this._deferredSince = 0;
  }

  noteCameraChange() {
    this._lastCameraChangeAt = performance.now();
  }

  noteContentChange() {
    this._lastContentChangeAt = performance.now();
  }

  noteSaveEnded(durationMs) {
    this.lastSaveEndAt = performance.now();
    this.lastSaveDurationMs = durationMs;
  }

  /** Quiet-moment gate — see the constants block above. */
  shouldDefer(strokeActive) {
    const now = performance.now();
    const panActive = now - this._lastCameraChangeAt < SAVE_QUIET_PAN_MS;
    const writingActive = now - this._lastContentChangeAt < SAVE_QUIET_CONTENT_MS;
    if (!strokeActive && !panActive && !writingActive) {
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
