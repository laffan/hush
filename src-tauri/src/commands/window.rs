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

/// Paint the native layers *under* the webview in the active theme's
/// background colour. iOS only; a no-op everywhere else.
///
/// Hush's window is configured transparent, and on iPadOS the surface
/// behind a transparent `WKWebView` is a `UIWindow` with no background
/// colour of its own — which renders black. Any moment the web content
/// isn't painting the full window shows that black through: while the
/// webview re-composites after the window changes display (plugging in a
/// monitor is the reliable way to see it), across a safe-area band during
/// a rotation, in the gap before first paint. The CSS-side mitigation
/// (`updatePrivateBoxColor` force-writing inline backgrounds under
/// `html.ios`) only helps once the page is painting again; this closes
/// the hole underneath it, so there is no black to see in the first
/// place.
///
/// `color` is `#rrggbb`. Tauri's own `set_background_color` documents
/// itself as unimplemented on iOS, hence the objc walk — webview →
/// `UIWindow`, plus the webview's own view and its internal scroll view,
/// which paints its own background over the window's.
#[tauri::command]
pub fn set_native_background_color(
    _app: AppHandle,
    _label: String,
    _color: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let rgb = parse_hex_rgb(&_color).ok_or_else(|| format!("Bad colour: {_color}"))?;
        let window = _app
            .get_webview_window(&_label)
            .ok_or_else(|| format!("Window not found: {_label}"))?;
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
                    let cls = objc2::class!(UIColor);
                    let color: *mut AnyObject = msg_send![
                        cls,
                        colorWithRed: rgb.0,
                        green: rgb.1,
                        blue: rgb.2,
                        alpha: 1.0f64
                    ];
                    if color.is_null() {
                        return;
                    }
                    let _: () = msg_send![ui_view, setBackgroundColor: color];
                    let ui_window: *mut AnyObject = msg_send![ui_view, window];
                    if !ui_window.is_null() {
                        let _: () = msg_send![ui_window, setBackgroundColor: color];
                    }
                    // A `WKWebView` carries its own scroll view, which
                    // paints its own background over everything set
                    // above — colour that too, or the fix works
                    // everywhere except the surface actually on screen.
                    // The handle Tauri gives us is the window's root
                    // view, so the webview is normally one level down;
                    // check both rather than assume which.
                    paint_webviews(ui_view, color);
                }
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Colour `view` (and one level of its subviews) wherever it is a
/// `WKWebView`, including the scroll view each one owns.
///
/// # Safety
/// `view` must be a live `UIView` and `color` a live `UIColor`; call on
/// the main thread.
#[cfg(target_os = "ios")]
unsafe fn paint_webviews(
    view: *mut objc2::runtime::AnyObject,
    color: *mut objc2::runtime::AnyObject,
) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    /// Colour one view if — and only if — it is a `WKWebView`.
    unsafe fn paint_one(candidate: *mut AnyObject, color: *mut AnyObject) {
        if candidate.is_null() {
            return;
        }
        let is_web: bool = msg_send![candidate, isKindOfClass: objc2::class!(WKWebView)];
        if !is_web {
            return;
        }
        let _: () = msg_send![candidate, setBackgroundColor: color];
        let scroll: *mut AnyObject = msg_send![candidate, scrollView];
        if !scroll.is_null() {
            let _: () = msg_send![scroll, setBackgroundColor: color];
        }
    }

    paint_one(view, color);
    let subviews: *mut AnyObject = msg_send![view, subviews];
    if subviews.is_null() {
        return;
    }
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let sub: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
        paint_one(sub, color);
    }
}

/// `#rrggbb` → the 0–1 component triple `UIColor` wants. Returns `None`
/// for anything else, so a caller passing a CSS colour name or an `rgba()`
/// string fails loudly rather than painting the window black.
#[cfg(target_os = "ios")]
fn parse_hex_rgb(hex: &str) -> Option<(f64, f64, f64)> {
    let h = hex.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let c = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|v| v as f64 / 255.0);
    Some((c(0)?, c(2)?, c(4)?))
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
