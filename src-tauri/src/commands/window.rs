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
