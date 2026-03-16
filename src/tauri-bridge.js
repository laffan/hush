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

    // Register global shortcuts — always unregister first to clear stale handlers
    try {
      const { register, unregister, isRegistered } = await import("@tauri-apps/plugin-global-shortcut");

      async function registerShortcut(shortcut, handler) {
        if (!shortcut) return;
        try {
          if (await isRegistered(shortcut)) {
            await unregister(shortcut);
          }
        } catch (_) { /* ignore */ }
        await register(shortcut, handler);
      }

      // Toggle editor visibility
      await registerShortcut(state.settings.shortcutOpenEditor, async (event) => {
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

      // Open fullscreen
      await registerShortcut(state.settings.shortcutOpenFullscreen, async (event) => {
        if (event.state === "Released") return;
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
        state.toggleFullscreen();
      });

      // Toggle private mode
      await registerShortcut(state.settings.shortcutTogglePrivate, (event) => {
        if (event.state === "Released") return;
        state.togglePrivate();
      });
    } catch (e) {
      console.warn("Global shortcut registration failed:", e);
    }
  } catch (e) {
    console.warn("Tauri integration setup failed:", e);
  }
}
