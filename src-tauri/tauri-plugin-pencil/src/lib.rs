use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pencil);

pub struct Pencil<R: Runtime>(Option<PluginHandle<R>>);

#[derive(Serialize, Deserialize)]
struct ChromeArgs {
    hidden: bool,
}

#[derive(Deserialize)]
struct EmptyResponse {}

#[tauri::command]
async fn set_chrome_hidden<R: Runtime>(
    app: AppHandle<R>,
    hidden: bool,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let pencil = app.state::<Pencil<R>>();
        if let Some(handle) = pencil.0.as_ref() {
            handle
                .run_mobile_plugin::<EmptyResponse>("setChromeHidden", ChromeArgs { hidden })
                .map(|_| ())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, hidden);
        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pencil")
        .invoke_handler(tauri::generate_handler![set_chrome_hidden])
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_pencil)?;
                app.manage(Pencil::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "ios"))]
            {
                app.manage(Pencil::<R>(None));
            }
            Ok(())
        })
        .build()
}
