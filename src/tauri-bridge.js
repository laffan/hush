/**
 * Tauri-specific integration: global shortcuts, tray events
 */

import { openSettingsWindow } from "./settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function setupTauriIntegration(state) {
  if (!IS_TAURI) return;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");

    // Settings menu item opens settings window
    await listen("open-settings", () => {
      openSettingsWindow();
    });

    // Register global shortcuts
    try {
      const { register, isRegistered } = await import("@tauri-apps/plugin-global-shortcut");

      // Toggle editor visibility
      const toggleShortcut = state.settings.shortcutOpenEditor;
      if (toggleShortcut && !(await isRegistered(toggleShortcut))) {
        await register(toggleShortcut, async (event) => {
          if (event.state === "Released") return;
          const win = getCurrentWindow();
          const visible = await win.isVisible();
          if (visible) {
            await win.hide();
          } else {
            await win.show();
            await win.setFocus();
          }
        });
      }

      // Open fullscreen
      const fullscreenShortcut = state.settings.shortcutOpenFullscreen;
      if (fullscreenShortcut && !(await isRegistered(fullscreenShortcut))) {
        await register(fullscreenShortcut, async (event) => {
          if (event.state === "Released") return;
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
          if (!state.isFullscreen) {
            state.toggleFullscreen();
          }
        });
      }

      // Toggle private mode
      const privateShortcut = state.settings.shortcutTogglePrivate;
      if (privateShortcut && !(await isRegistered(privateShortcut))) {
        await register(privateShortcut, (event) => {
          if (event.state === "Released") return;
          state.togglePrivate();
        });
      }
    } catch (e) {
      console.warn("Global shortcut registration failed:", e);
    }
  } catch (e) {
    console.warn("Tauri integration setup failed:", e);
  }
}
