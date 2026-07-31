use tauri::AppHandle;
#[cfg(any(desktop, target_os = "ios"))]
use tauri::Manager;

/// Set a window's user-facing title — "[Desk Name]-[File Name]". The
/// in-window chrome hides it (`hiddenTitle` / overlay title bar), but
/// macOS still surfaces it in Mission Control and the Window menu, and
/// iPadOS in the app switcher / Stage Manager window pickers. Desktop
/// goes through Tauri's `set_title`; on iOS that's a windowing no-op,
/// so the scene title (`UIWindowScene.title` — the string the window
/// pickers actually read) is set directly via the objc bridge, walking
/// webview → UIWindow → windowScene on the main thread.
#[tauri::command]
pub fn set_window_display_title(app: AppHandle, label: String, title: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Some(window) = app.get_webview_window(&label) {
            window.set_title(&title).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(target_os = "ios")]
    {
        let window = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("Window not found: {label}"))?;
        let w = window.clone();
        window
            .run_on_main_thread(move || {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};

                let Ok(handle) = w.window_handle() else { return };
                let RawWindowHandle::UiKit(h) = handle.as_raw() else { return };
                let ui_view = h.ui_view.as_ptr() as *mut AnyObject;
                unsafe {
                    let ui_window: *mut AnyObject = msg_send![ui_view, window];
                    if ui_window.is_null() {
                        return;
                    }
                    let scene: *mut AnyObject = msg_send![ui_window, windowScene];
                    if scene.is_null() {
                        return;
                    }
                    if let Ok(ns) = super::apple_objc::nsstring_from_str(&title) {
                        let _: () = msg_send![scene, setTitle: ns];
                        let _: () = msg_send![ns, release];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(not(desktop), not(target_os = "ios")))]
    {
        let _ = (app, label, title);
        Ok(())
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_activation_policy(_app: AppHandle, _policy: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match _policy.as_str() {
            "regular" => _app.set_activation_policy(tauri::ActivationPolicy::Regular),
            "accessory" => _app.set_activation_policy(tauri::ActivationPolicy::Accessory),
            _ => return Err(format!("Unknown policy: {}", _policy)),
        }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show or hide the three macOS traffic-light buttons (close /
/// miniaturize / zoom) on a Tauri window. No-op on every non-macOS
/// platform. JS calls this from a mouseenter/mouseleave handler over
/// the top-left of the editor so the buttons fade in only on hover.
#[tauri::command]
pub fn set_traffic_lights_visible(_app: AppHandle, _label: Option<String>, _visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let label = _label.as_deref().unwrap_or("main");
        let window = _app
            .get_webview_window(label)
            .ok_or_else(|| format!("Window not found: {}", label))?;
        let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
        if ns_window_ptr.is_null() {
            return Err("ns_window returned null".to_string());
        }
        // NSWindowButton kinds: 0 = close, 1 = miniaturize, 2 = zoom.
        // hidden = !visible (Objective-C BOOL is u8 with non-zero = true).
        let hidden: bool = !_visible;
        unsafe {
            for kind in 0u64..=2 {
                let btn: *mut AnyObject = msg_send![ns_window_ptr, standardWindowButton: kind];
                if !btn.is_null() {
                    let _: () = msg_send![btn, setHidden: hidden];
                }
            }
        }
    }
    Ok(())
}
