/**
 * Tauri-specific integration: global shortcuts, tray events, theme events
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function setupTauriIntegration(state) {
  if (!IS_TAURI) return;

  try {
    // Listen for theme changes from tray menu
    const { listen } = await import("@tauri-apps/api/event");

    await listen("theme-change", (event) => {
      const theme = event.payload;
      document.documentElement.setAttribute("data-theme", theme);
      state.updateSettings({ theme });
    });

    // Register global shortcuts
    try {
      const { register, isRegistered } = await import("@tauri-apps/plugin-global-shortcut");

      const openShortcut = state.settings.shortcutOpenEditor;
      if (openShortcut && !(await isRegistered(openShortcut))) {
        await register(openShortcut, async () => {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        });
      }

      const privateShortcut = state.settings.shortcutTogglePrivate;
      if (privateShortcut && !(await isRegistered(privateShortcut))) {
        await register(privateShortcut, () => {
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
