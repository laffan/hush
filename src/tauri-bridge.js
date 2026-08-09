/**
 * Tauri-specific integration: global shortcuts, tray events
 */

import { openSettingsWindow, isIOS } from "./settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Track registered shortcuts so we can unregister them on re-registration
let registeredShortcuts = [];
// The registration failure is worth one line, not one per settings save
// (registerAllShortcuts re-runs on every settings-changed event).
let warnedShortcutFailure = null;

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
      // The global-shortcut plugin is desktop-only (registered behind
      // cfg(desktop) in lib.rs) — there is no system-wide "summon the
      // app" shortcut on iOS/iPadOS. Registering anyway failed with
      // "plugin global-shortcut not found" on every settings save.
      if (isIOS()) return;
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

        // Toggle editor visibility — the ONLY global shortcut that should work
        // when the window is not focused, so the user can summon/hide the editor
        // from any app.
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

        // All other shortcuts (fullscreen, private mode, sidebar, outline) are
        // handled via in-window keydown listeners so they don't capture keys
        // when the app is in the background.
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg !== warnedShortcutFailure) {
          warnedShortcutFailure = msg;
          console.warn("Global shortcut registration failed:", e);
        }
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
