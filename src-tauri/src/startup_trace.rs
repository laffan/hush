//! Native half of the startup trace (JS half: `src/startup-trace.js`).
//!
//! Everything `run()` does before Tauri hands a window to the webview —
//! settings load, the two one-shot migrations, snapshot cleanup, watcher
//! re-arming, desk registration repair — happens with no window on screen
//! and no JS timer running, so from the frontend it is indistinguishable
//! from a slow launch. Each of those is wrapped in `record` here and read
//! back by `get_startup_native_timings` for Settings → Debug.
//!
//! Recording is unconditional: a phase costs one `Instant::now()` pair and
//! a short `String`, and the whole table is a dozen rows. Nothing here may
//! fail the operation it measures — same rule as the activity log.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static LAUNCH: OnceLock<Instant> = OnceLock::new();
static PHASES: OnceLock<Mutex<Vec<Phase>>> = OnceLock::new();

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub name: String,
    /// Milliseconds after process launch that this phase began.
    pub start_ms: f64,
    /// How long it took.
    pub ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTrace {
    pub phases: Vec<Phase>,
    /// Age of the process when the trace was read. The frontend subtracts
    /// its own `performance.now()` from this to learn how long the app was
    /// alive before the webview began navigating.
    pub since_launch_ms: f64,
}

/// Stamp the launch instant. Call once, first thing in `run()` — every
/// `start_ms` is relative to it.
pub fn mark_launch() {
    let _ = LAUNCH.get_or_init(Instant::now);
}

fn launch() -> &'static Instant {
    LAUNCH.get_or_init(Instant::now)
}

fn phases() -> &'static Mutex<Vec<Phase>> {
    PHASES.get_or_init(|| Mutex::new(Vec::new()))
}

fn ms_since_launch() -> f64 {
    launch().elapsed().as_secs_f64() * 1000.0
}

/// Run `f`, recording how long it took under `name`.
pub fn record<T>(name: &str, f: impl FnOnce() -> T) -> T {
    let start_ms = ms_since_launch();
    let t = Instant::now();
    let out = f();
    let phase = Phase {
        name: name.to_string(),
        start_ms,
        ms: t.elapsed().as_secs_f64() * 1000.0,
    };
    if let Ok(mut list) = phases().lock() {
        list.push(phase);
    }
    out
}

/// The trace so far.
pub fn snapshot() -> NativeTrace {
    NativeTrace {
        phases: phases().lock().map(|l| l.clone()).unwrap_or_default(),
        since_launch_ms: ms_since_launch(),
    }
}
