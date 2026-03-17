/**
 * Tauri-specific integration: global shortcuts, tray events
 */

import { openSettingsWindow } from "./settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Track registered shortcuts so we can unregister them on re-registration
let registeredShortcuts = [];

export async function setupTauriIntegration(state) {
  if (!IS_TAURI) return;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");

    // Settings menu item opens settings window
    await listen("open-settings", () => {
      openSettingsWindow();
    });

    async function registerAllShortcuts() {
      try {
        const { register, unregister, isRegistered } = await import("@tauri-apps/plugin-global-shortcut");

        // Unregister all previously registered shortcuts
        for (const s of registeredShortcuts) {
          try {
            if (await isRegistered(s)) await unregister(s);
          } catch (_) { /* ignore */ }
        }
        registeredShortcuts = [];

        async function registerShortcut(shortcut, handler) {
          if (!shortcut) return;
          try {
            if (await isRegistered(shortcut)) {
              await unregister(shortcut);
            }
          } catch (_) { /* ignore */ }
          await register(shortcut, handler);
          registeredShortcuts.push(shortcut);
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
    }

    // Register shortcuts on startup
    await registerAllShortcuts();

    // Re-register when settings change
    state.on("settings-changed", () => {
      registerAllShortcuts();
    });
  } catch (e) {
    console.warn("Tauri integration setup failed:", e);
  }
}
