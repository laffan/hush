//! iPadOS scene triage — what to do with a `UIScene` the system hands us.
//!
//! Hush opts into multiple scenes (`UIApplicationSupportsMultipleScenes`),
//! and Tauri turns every system-requested scene into a
//! `RunEvent::SceneRequested`. The obvious handler — build a window for
//! it — is wrong, because not every scene the system offers is a window
//! the user asked for:
//!
//!  * **External display.** The multi-scene opt-in also makes the app
//!    eligible for an external-display session, so plugging a monitor
//!    into the iPad hands us a scene whose role is
//!    `UIWindowSceneSessionRoleExternalDisplayNonInteractive`. Building a
//!    window for it boots a second full copy of the app onto a surface
//!    the pointer can't reach and nothing in the app can close.
//!    `tauri-plugin-scene-reuse` refuses that session from the Swift
//!    side; this module is the Rust half of the same refusal, because
//!    the two run off different notifications and either can arrive
//!    first.
//!
//!  * **Scenes we asked for by accident.** tao's iOS `set_focus` calls
//!    `activateSceneSessionForRequest:` with an empty
//!    `UISceneSessionActivationRequest` on iOS 17+, and an empty request
//!    means *make me a new scene*. A focus call therefore comes back as
//!    a scene request, which — handled naively — becomes another window,
//!    which can focus itself, and so on. The JS side no longer calls
//!    `setFocus` on iOS (see `src/editor/modes.js`), and the cap below
//!    is the backstop for anything else that trips the same wire.
//!
//! Everything here goes through raw `msg_send!` rather than typed
//! bindings: `RunEvent::SceneRequested` carries an `objc2` 0.6
//! `Retained<UIScene>` while this crate's own Objective-C bridges are on
//! objc2 0.5, and the two `Retained` types don't mix. A pointer is a
//! pointer, so we take one and speak Objective-C to it — the same thing
//! `commands/window.rs` does to reach `UIWindowScene.title`.

use objc2::msg_send;
use objc2::runtime::AnyObject;

use crate::commands::apple_objc::nsstring_to_string;

/// Ceiling on windows built for system scene requests in one app run.
/// Not a feature limit — nobody opens nine iPad windows — but a stop on
/// the runaway case, where something requests a scene per scene and each
/// new window boots a full copy of the app until the OS kills us for
/// memory. Hitting it is logged loudly because it means a loop, not a
/// user.
const MAX_SCENE_WINDOWS: u32 = 8;

/// What a scene is for, as far as we care.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneKind {
    /// An ordinary app window: the user picked "New Window", or dragged
    /// one out under Stage Manager. This is the only kind we build for.
    Application,
    /// iPadOS driving a connected monitor. Refused.
    ExternalDisplay,
    /// CarPlay, or a role introduced after this was written. Refused —
    /// Hush has no presentation mode for a surface it doesn't know.
    Other,
}

/// A scene's identity, for the log. `role` is the raw
/// `UISceneSession.role` string; `persistent_id` is the session's
/// `persistentIdentifier`, which is what iPadOS uses to match a scene
/// back to its restored state — the field to watch when the same window
/// keeps coming back after it was closed.
#[derive(Debug, Clone)]
pub struct SceneInfo {
    pub kind: SceneKind,
    pub role: String,
    pub persistent_id: String,
}

impl SceneInfo {
    pub fn detail(&self) -> serde_json::Value {
        serde_json::json!({
            "role": self.role,
            "persistentId": self.persistent_id,
            "kind": format!("{:?}", self.kind),
        })
    }
}

/// Read a scene's session role and persistent id.
///
/// The role is matched on its raw string rather than against the
/// `UIWindowSceneSessionRole*` constants: the external-display role was
/// renamed (`…RoleExternalDisplay` →
/// `…RoleExternalDisplayNonInteractive`) in iOS 16 and both spellings
/// are still handed out, so a substring test is both shorter and more
/// durable than linking two constants and comparing pointers.
///
/// # Safety
/// `scene` must be a live `UIScene`. Callers hold a `Retained<UIScene>`
/// for the duration of the call.
pub unsafe fn describe(scene: *mut AnyObject) -> SceneInfo {
    if scene.is_null() {
        return SceneInfo {
            kind: SceneKind::Other,
            role: String::new(),
            persistent_id: String::new(),
        };
    }
    let session: *mut AnyObject = msg_send![scene, session];
    let (role, persistent_id) = if session.is_null() {
        (String::new(), String::new())
    } else {
        let role_str: *mut AnyObject = msg_send![session, role];
        let id_str: *mut AnyObject = msg_send![session, persistentIdentifier];
        (
            nsstring_to_string(role_str).unwrap_or_default(),
            nsstring_to_string(id_str).unwrap_or_default(),
        )
    };
    let kind = if role.contains("ExternalDisplay") {
        SceneKind::ExternalDisplay
    } else if role.contains("WindowSceneSessionRoleApplication") {
        SceneKind::Application
    } else {
        SceneKind::Other
    };
    SceneInfo {
        kind,
        role,
        persistent_id,
    }
}

/// Ask the system to tear a scene's session down.
///
/// Windows are hidden first: destruction is asynchronous, and a scene
/// that already has content on a monitor would otherwise flash it for a
/// frame or two on the way out. If the request fails the scene keeps
/// whatever it had — a hidden-but-attached scene owns the display and
/// paints it black, which is worse than the window we were declining.
///
/// # Safety
/// `scene` must be a live `UIScene`.
pub unsafe fn destroy_session(scene: *mut AnyObject) {
    if scene.is_null() {
        return;
    }
    let session: *mut AnyObject = msg_send![scene, session];
    if session.is_null() {
        return;
    }
    // `windows` is only on UIWindowScene; a scene of another class just
    // won't respond, and we skip the hide rather than risk the selector.
    let window_scene_cls = objc2::class!(UIWindowScene);
    let is_window_scene: bool = msg_send![scene, isKindOfClass: window_scene_cls];
    if is_window_scene {
        let windows: *mut AnyObject = msg_send![scene, windows];
        if !windows.is_null() {
            let count: usize = msg_send![windows, count];
            for i in 0..count {
                let window: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                if !window.is_null() {
                    let _: () = msg_send![window, setHidden: true];
                }
            }
        }
    }
    let cls = objc2::class!(UIApplication);
    let app: *mut AnyObject = msg_send![cls, sharedApplication];
    if app.is_null() {
        return;
    }
    let _: () = msg_send![
        app,
        requestSceneSessionDestruction: session,
        options: std::ptr::null_mut::<AnyObject>(),
        errorHandler: std::ptr::null_mut::<AnyObject>()
    ];
}

/// Decide what to do with a requested scene, and say so in the activity
/// log either way. Returns `true` when the caller should build a window
/// for it.
///
/// `built_so_far` is how many scene windows this run has already made;
/// the caller increments only on a `true`.
///
/// # Safety
/// `scene` must be a live `UIScene`.
pub unsafe fn accept_scene_request(scene: *mut AnyObject, built_so_far: u32) -> bool {
    let info = describe(scene);
    match info.kind {
        SceneKind::ExternalDisplay => {
            crate::activity_log::note_detail(
                "window",
                "warn",
                "Declined an external-display scene — iPadOS falls back to mirroring",
                info.detail(),
            );
            destroy_session(scene);
            false
        }
        SceneKind::Other => {
            crate::activity_log::note_detail(
                "window",
                "warn",
                "Declined a scene with an unrecognised session role",
                info.detail(),
            );
            false
        }
        SceneKind::Application => {
            if built_so_far >= MAX_SCENE_WINDOWS {
                let mut detail = info.detail();
                detail["builtSoFar"] = serde_json::json!(built_so_far);
                detail["cap"] = serde_json::json!(MAX_SCENE_WINDOWS);
                crate::activity_log::note_detail(
                    "window",
                    "error",
                    "Refused a scene request — window cap reached, something is requesting scenes in a loop",
                    detail,
                );
                return false;
            }
            crate::activity_log::note_detail(
                "window",
                "info",
                "Accepted a scene request — building a window for it",
                info.detail(),
            );
            true
        }
    }
}

/// Record a window lifecycle transition in the activity log.
///
/// iPad is the reason this exists at all. A scene can be created, moved
/// to another display, suspended in the app switcher, and torn down with
/// nothing on the JS side running to notice — `beforeunload` never fires
/// there, and a scene teardown can be entirely silent. What is written
/// here is often the only evidence left after the fact.
///
/// Only transitions are logged. `Moved` and the intermediate `Resized`
/// events of a Stage Manager drag arrive by the dozen and would drown
/// the trail; the JS side (`src/window-diagnostics.js`) coalesces those
/// and logs the settled geometry instead.
pub fn note_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
    label: &str,
) {
    use tauri::{Manager, WindowEvent};
    let live = window.app_handle().webview_windows().len();
    let base = |extra: serde_json::Value| {
        let mut v = serde_json::json!({ "label": label, "liveWindows": live });
        if let (Some(map), Some(more)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in more {
                map.insert(k.clone(), val.clone());
            }
        }
        v
    };
    match event {
        WindowEvent::Destroyed => {
            crate::activity_log::note_detail("window", "info", "Window destroyed", base(serde_json::json!({})))
        }
        WindowEvent::CloseRequested { .. } => crate::activity_log::note_detail(
            "window",
            "info",
            "Window close requested",
            base(serde_json::json!({})),
        ),
        // The window moved to a display with a different scale — dragged
        // onto or off an external monitor. Every canvas backing store in
        // the app is reallocated at the new ratio right afterwards, so
        // this is the marker to look for just before a memory kill.
        WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => crate::activity_log::note_detail(
            "window",
            "info",
            "Window changed display scale",
            base(serde_json::json!({
                "scaleFactor": scale_factor,
                "width": new_inner_size.width,
                "height": new_inner_size.height,
            })),
        ),
        // iPadOS backgrounded / foregrounded us. A log that ends on
        // "suspended" and picks up at a fresh boot is the signature of
        // the system reclaiming the app; one that just stops is a crash.
        WindowEvent::Suspended => {
            crate::activity_log::note_detail("window", "info", "App suspended", base(serde_json::json!({})))
        }
        WindowEvent::Resumed => {
            crate::activity_log::note_detail("window", "info", "App resumed", base(serde_json::json!({})))
        }
        _ => {}
    }
}
