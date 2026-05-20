use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

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
