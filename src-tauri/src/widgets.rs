//! Home screen widgets — the app's commands (see widgets/README-WIDGETS.md).
//!
//! * `publish_widget_snapshot` takes the JSON snapshot the frontend builds
//!   (src/widgets/widget-snapshot.js) and hands it to the widget
//!   extension: on iOS through `tauri-plugin-hush-widgets` (App Group
//!   container + WidgetKit reload, in Swift); on macOS, in builds with the
//!   `macos-widgets` feature, through the small Swift bridge in
//!   `widget-bridge-macos/`. Everywhere else — and in a macOS build
//!   without the feature, which has no extension to feed — it is a no-op.
//! * `claim_widget_link` decides whether one delivery of a widget's
//!   `hushwriter://widget` link should act. Its memory is this process,
//!   which is exactly the lifetime the rule needs (see the fn).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[allow(unused_imports)] // Manager is unused in the macos-widgets build
use tauri::{AppHandle, Manager, Runtime};

/// The App Group the iOS app and its widget extension share. Must match
/// `HUSH_APP_GROUP` in scripts/ios-add-widgets.mjs, which writes it into
/// both targets' entitlements and the extension's Info.plist.
#[cfg(target_os = "ios")]
pub const IOS_APP_GROUP: &str = "group.com.hushwriter.app";

/// Last snapshot handed over this process, so an unchanged one costs
/// nothing (several windows publish the same state).
static LAST_PUBLISHED: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub async fn publish_widget_snapshot<R: Runtime>(
    app: AppHandle<R>,
    snapshot: String,
) -> Result<bool, String> {
    {
        let mut last = LAST_PUBLISHED.lock().map_err(|e| e.to_string())?;
        if last.as_deref() == Some(snapshot.as_str()) {
            return Ok(false);
        }
        *last = Some(snapshot.clone());
    }
    let written = publish_platform(&app, &snapshot);
    if written.is_err() {
        // Let the next publish try again rather than skipping it as a repeat.
        if let Ok(mut last) = LAST_PUBLISHED.lock() {
            *last = None;
        }
    }
    written
}

#[cfg(target_os = "ios")]
fn publish_platform<R: Runtime>(app: &AppHandle<R>, snapshot: &str) -> Result<bool, String> {
    let widgets = app.state::<tauri_plugin_hush_widgets::HushWidgets<R>>();
    widgets.publish(snapshot, IOS_APP_GROUP)
}

#[cfg(all(target_os = "macos", feature = "macos-widgets"))]
fn publish_platform<R: Runtime>(_app: &AppHandle<R>, snapshot: &str) -> Result<bool, String> {
    macos::publish(snapshot)
}

#[cfg(not(any(target_os = "ios", all(target_os = "macos", feature = "macos-widgets"))))]
fn publish_platform<R: Runtime>(app: &AppHandle<R>, snapshot: &str) -> Result<bool, String> {
    // Registered so the plugin's state exists everywhere; nothing to feed.
    let _ = (app.try_state::<tauri_plugin_hush_widgets::HushWidgets<R>>(), snapshot);
    Ok(false)
}

/// macOS: the extension's App Group must be prefixed with the signing
/// team's ID (macOS rejects a `group.` identifier for a Developer ID
/// app), so it can't be a constant in source. The build that turns the
/// feature on passes it in (`scripts/macos-build-widgets.sh`).
#[cfg(all(target_os = "macos", feature = "macos-widgets"))]
mod macos {
    use std::ffi::CString;
    use std::os::raw::c_char;

    const APP_GROUP: &str = env!(
        "HUSH_MACOS_APP_GROUP",
        "build with HUSH_MACOS_APP_GROUP=<TeamID>.com.hushwriter.app (scripts/macos-build-widgets.sh)"
    );

    extern "C" {
        /// widget-bridge-macos/Sources/HushWidgetBridge.swift. Writes the
        /// snapshot into the group container (resolved through
        /// FileManager, which is what macOS 15 requires of group
        /// container access) and reloads every timeline. 1 = written,
        /// 0 = unchanged, negative = failed.
        fn hush_widgets_publish(json: *const c_char, app_group: *const c_char) -> i32;
    }

    pub fn publish(snapshot: &str) -> Result<bool, String> {
        let json = CString::new(snapshot).map_err(|e| e.to_string())?;
        let group = CString::new(APP_GROUP).map_err(|e| e.to_string())?;
        // SAFETY: both pointers are valid NUL-terminated strings for the
        // duration of the call; the Swift side copies what it keeps.
        let rc = unsafe { hush_widgets_publish(json.as_ptr(), group.as_ptr()) };
        match rc {
            1 => Ok(true),
            0 => Ok(false),
            -1 => Err("no App Group container (is the entitlement signed in?)".into()),
            _ => Err(format!("widget snapshot write failed ({})", rc)),
        }
    }
}

// ---------------------------------------------------------------------
// Link claims
// ---------------------------------------------------------------------

/// A second delivery of the same link inside this window is the same tap.
const REPEAT_WINDOW: Duration = Duration::from_secs(4);

#[derive(Default)]
struct Claims {
    /// When each link last acted, for the repeat window.
    last: HashMap<String, Instant>,
    /// Every link that has acted in this process.
    seen: HashSet<String>,
}

static CLAIMS: Mutex<Option<Claims>> = Mutex::new(None);

/// Should this delivery of a widget link act?
///
/// A widget's links are fixed (the same URL every time that button is
/// tapped), so unlike a companion app's request they carry no nonce,
/// and iPadOS delivers one link several times: to every window, and
/// again from a replayed `getCurrent()` after a webview reload. Two
/// rules, both scoped to this process:
///
/// * the same link within `REPEAT_WINDOW` of acting is the same tap;
/// * a `cold` delivery (one that was waiting when a window booted — the
///   kind a reload replays) acts only if that link hasn't acted at all in
///   this process. A launch the tap itself caused is a fresh process, so
///   its link always acts; a reload replaying it, or a second window
///   booting, never does.
///
/// The same button tapped again later is an ordinary warm delivery and
/// acts — that is the case a time-based or nonce-only rule gets wrong.
#[tauri::command]
pub fn claim_widget_link(url: String, cold: bool) -> bool {
    let Ok(mut guard) = CLAIMS.lock() else { return true };
    let claims = guard.get_or_insert_with(Claims::default);
    let now = Instant::now();
    if cold && claims.seen.contains(&url) {
        return false;
    }
    if let Some(at) = claims.last.get(&url) {
        if now.duration_since(*at) < REPEAT_WINDOW {
            return false;
        }
    }
    claims.last.retain(|_, at| now.duration_since(*at) < REPEAT_WINDOW);
    claims.last.insert(url.clone(), now);
    claims.seen.insert(url);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        *CLAIMS.lock().unwrap() = None;
    }

    // One test, run in sequence: the claims are process-global.
    #[test]
    fn claims_follow_the_tap_not_the_delivery() {
        reset();
        let a = "hushwriter://widget?action=new-doc&desk=d1".to_string();
        let b = "hushwriter://widget?action=new-notebook&desk=d1".to_string();
        // A cold launch caused by the tap acts once…
        assert!(claim_widget_link(a.clone(), true));
        // …its duplicate deliveries don't…
        assert!(!claim_widget_link(a.clone(), false));
        assert!(!claim_widget_link(a.clone(), true));
        // …and a different button is its own tap.
        assert!(claim_widget_link(b.clone(), false));
        // A webview reload replaying the launch link, long after, doesn't act.
        claim_last_backdate(&a);
        assert!(!claim_widget_link(a.clone(), true));
        // The same button tapped again later does.
        assert!(claim_widget_link(a.clone(), false));
        reset();
    }

    /// Pretend `url` last acted well outside the repeat window.
    fn claim_last_backdate(url: &str) {
        let mut guard = CLAIMS.lock().unwrap();
        let claims = guard.as_mut().unwrap();
        let past = Instant::now()
            .checked_sub(REPEAT_WINDOW * 2)
            .expect("monotonic clock has run long enough");
        claims.last.insert(url.to_string(), past);
    }
}
