//! iCloud-folder plugin (Rust side).
//!
//! Thin proxy: each Tauri command forwards to the iOS Swift plugin via
//! `run_mobile_plugin`. On non-iOS targets the commands compile to a
//! clear "iOS only" error so the desktop build still links — the demo
//! harness surfaces that error verbatim.
//!
//! Once a folder's bookmark has been resolved and access is held, the
//! Swift side reads/writes by absolute path. That is the same shape the
//! existing `local_sync.rs` `std::fs` code already uses, so wiring this
//! into real Local Sync later is mostly a matter of resolving bookmarks
//! at startup before the existing read/write paths run.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_icloud_folder);

pub struct IcloudFolder<R: Runtime>(#[allow(dead_code)] Option<PluginHandle<R>>);

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
struct ResolveArgs {
    bookmark: String,
}

#[derive(Serialize)]
struct PathArgs {
    path: String,
}

#[derive(Serialize)]
struct WriteArgs {
    path: String,
    contents: String,
}

#[derive(Serialize)]
struct WriteBytesArgs {
    path: String,
    base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
    pub path: String,
    pub bookmark: String,
    pub name: String,
    #[serde(default)]
    pub access_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub access_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListResult {
    pub entries: Vec<DirEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadResult {
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadBytesResult {
    /// File bytes, base64-encoded (the bridge can't carry large raw
    /// byte arrays reliably).
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteBytesResult {
    /// Actual filename written (collision auto-suffixed) so the caller
    /// can build a matching markdown ref.
    pub name: String,
}

const IOS_ONLY: &str = "iCloud folder access is iOS-only (no-op on this platform)";

#[tauri::command]
async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<PickResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<PickResult>("pickFolder", Empty {})
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn resolve_bookmark<R: Runtime>(
    app: AppHandle<R>,
    bookmark: String,
) -> Result<ResolveResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ResolveResult>("resolveBookmark", ResolveArgs { bookmark })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, bookmark);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn stop_access<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("stopAccess", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn list_dir<R: Runtime>(app: AppHandle<R>, path: String) -> Result<ListResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ListResult>("listDir", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn read_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<ReadResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ReadResult>("readFile", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn write_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    contents: String,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<serde_json::Value>("writeFile", WriteArgs { path, contents })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path, contents);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn read_file_bytes<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<ReadBytesResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<ReadBytesResult>("readFileBytes", PathArgs { path })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path);
        Err(IOS_ONLY.into())
    }
}

#[tauri::command]
async fn write_file_bytes<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    base64: String,
) -> Result<WriteBytesResult, String> {
    #[cfg(target_os = "ios")]
    {
        let plugin = app.state::<IcloudFolder<R>>();
        let handle = plugin.0.as_ref().ok_or("plugin not initialised")?;
        handle
            .run_mobile_plugin::<WriteBytesResult>("writeFileBytes", WriteBytesArgs { path, base64 })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, path, base64);
        Err(IOS_ONLY.into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("icloud-folder")
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            resolve_bookmark,
            stop_access,
            list_dir,
            read_file,
            write_file,
            read_file_bytes,
            write_file_bytes
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_icloud_folder)?;
                app.manage(IcloudFolder::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "ios"))]
            {
                app.manage(IcloudFolder::<R>(None));
            }
            Ok(())
        })
        .build()
}
