//! Home screen widgets plugin (Rust side).
//!
//! No JS commands. The app's `publish_widget_snapshot` command calls
//! [`HushWidgets::publish`], which on iOS hands the snapshot to the Swift
//! half (write into the App Group container, reload WidgetKit timelines)
//! and everywhere else does nothing — macOS widgets go through the app's
//! own `widgets.rs`, since a desktop Tauri build has no Swift plugin
//! layer. Registering it unconditionally is safe.

use serde::Serialize;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_hush_widgets);

/// Managed state: the Swift plugin's handle on iOS, nothing elsewhere.
pub struct HushWidgets<R: Runtime>(#[allow(dead_code)] Option<PluginHandle<R>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishArgs<'a> {
    json: &'a str,
    app_group: &'a str,
}

impl<R: Runtime> HushWidgets<R> {
    /// Write `json` into the `app_group` container as the widgets'
    /// snapshot and reload their timelines. Returns whether anything was
    /// written (false: unchanged, no container, or not iOS).
    pub fn publish(&self, json: &str, app_group: &str) -> Result<bool, String> {
        #[cfg(target_os = "ios")]
        {
            let handle = self.0.as_ref().ok_or("widgets plugin not initialised")?;
            let out: serde_json::Value = handle
                .run_mobile_plugin("publish", PublishArgs { json, app_group })
                .map_err(|e| e.to_string())?;
            Ok(out.get("written").and_then(|v| v.as_bool()).unwrap_or(false))
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = PublishArgs { json, app_group };
            Ok(false)
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("hush-widgets")
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_hush_widgets)?;
                app.manage(HushWidgets::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "ios"))]
            {
                app.manage(HushWidgets::<R>(None));
            }
            Ok(())
        })
        .build()
}
