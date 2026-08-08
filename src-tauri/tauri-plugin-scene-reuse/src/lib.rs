//! Scene-reuse plugin (Rust side).
//!
//! Pure registration: there are no commands. The Swift half marks every
//! UIScene as willing to handle incoming external events, so iPadOS
//! delivers a `hushwriter://` open to a window that is already on screen
//! instead of spawning a fresh scene for it. No-op on every non-iOS
//! target, so registering it unconditionally is safe.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_scene_reuse);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("scene-reuse")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                _api.register_ios_plugin(init_plugin_scene_reuse)?;
            }
            Ok(())
        })
        .build()
}
