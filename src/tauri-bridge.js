/**
 * Tauri-specific integration: global shortcuts, tray events
 */

import { openSettingsWindow } from "./settings/settings-ui.js";

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
      openSettingsWindow(state);
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

        // Toggle left sidebar (files panel)
        await registerShortcut(state.settings.shortcutToggleSidebar, async (event) => {
          if (event.state === "Released") return;
          const win = getCurrentWindow();
          if (!(await win.isVisible())) return;
          const sidebar = document.getElementById("sidebar");
          const panel = document.getElementById("panel-overlay");
          const isVisible = sidebar.classList.contains("pinned") ||
                            sidebar.classList.contains("visible") ||
                            !panel.classList.contains("hidden");
          if (isVisible) {
            state.emit("hide-panel");
          } else {
            sidebar.classList.add("pinned");
            state.emit("show-files-panel");
          }
        });

        // Toggle right sidebar (outline view)
        await registerShortcut(state.settings.shortcutToggleOutline, async (event) => {
          if (event.state === "Released") return;
          const win = getCurrentWindow();
          if (!(await win.isVisible())) return;
          const rPanel = document.getElementById("right-panel-overlay");
          if (rPanel.classList.contains("hidden")) {
            state.emit("show-outline");
          } else {
            state.emit("hide-outline");
          }
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

    // Cmd+Q — hide instead of quit when running as menu-bar-only app.
    // Uses a DOM keydown listener (not a global shortcut) so it only fires
    // when a Hush window is focused, allowing other apps to quit normally.
    document.addEventListener("keydown", async (e) => {
      if (state.settings.visibility === "menubar" && e.key === "q" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        await getCurrentWindow().hide();
      }
    });
  } catch (e) {
    console.warn("Tauri integration setup failed:", e);
  }
}
