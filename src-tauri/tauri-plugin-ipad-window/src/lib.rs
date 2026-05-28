// iPad single-file multi-window bridge — Rust side.
//
// Mirrors the structure of `tauri-plugin-pencil`. The actual window
// (UIScene) creation lives in Swift; this crate just proxies the
// `open_single_file_window` command into the iOS plugin via
// `run_mobile_plugin`, and is a no-op on every non-iOS target so the
// macOS / Linux builds stay clean.
//
// See `IPAD-MULTI-WINDOW-PLANNING.md` for the full architecture. This is
// Stage 1: the command opens a second scene that renders a placeholder
// webview seeded with the requested file id / type, proving the
// scene-activation bridge before the satellite editor is wired up.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ipad_window);

pub struct IpadWindow<R: Runtime>(Option<PluginHandle<R>>);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWindowArgs {
    file_id: String,
    file_type: String,
}

/// Open `file_id` in a new iPad window (UIScene). `file_type` is
/// `"document"` or `"notebook"` (projects are out of scope for v1).
/// No-op off iOS.
#[tauri::command]
async fn open_single_file_window<R: Runtime>(
    app: AppHandle<R>,
    file_id: String,
    file_type: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IpadWindow<R>>();
        if let Some(handle) = plugin.0.as_ref() {
            // Deserialize the Swift response into a permissive `Value`:
            // the plugin resolves with no data (null), which can't be
            // coerced into a struct (that's the "invalid type: null"
            // error the pencil plugin hits), so a struct here would make
            // this command report failure even when the window opened.
            handle
                .run_mobile_plugin::<serde_json::Value>(
                    "openWindow",
                    OpenWindowArgs { file_id, file_type },
                )
                .map(|_| ())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, file_id, file_type);
        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ipad-window")
        .invoke_handler(tauri::generate_handler![open_single_file_window])
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_ipad_window)?;
                app.manage(IpadWindow::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "ios"))]
            {
                app.manage(IpadWindow::<R>(None));
            }
            Ok(())
        })
        .build()
}
