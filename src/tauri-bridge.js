/**
 * Tauri-specific integration: global shortcuts, tray events, theme events
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function setupTauriIntegration(state) {
  if (!IS_TAURI) return;

  try {
    const { listen } = await import("@tauri-apps/api/event");

    await listen("theme-change", (event) => {
      const theme = event.payload;
      document.documentElement.setAttribute("data-theme", theme);
      state.updateSettings({ appearance: theme });
    });

    // Register global shortcuts
    try {
      const { register, isRegistered } = await import("@tauri-apps/plugin-global-shortcut");

      const openShortcut = state.settings.shortcutOpenEditor;
      if (openShortcut && !(await isRegistered(openShortcut))) {
        await register(openShortcut, async (event) => {
          // Only fire on key-down, not key-up
          if (event.state === "Released") return;
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        });
      }

      const fullscreenShortcut = state.settings.shortcutOpenFullscreen;
      if (fullscreenShortcut && !(await isRegistered(fullscreenShortcut))) {
        await register(fullscreenShortcut, async (event) => {
          if (event.state === "Released") return;
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
          if (!state.isFullscreen) {
            state.toggleFullscreen();
          }
        });
      }

      const privateShortcut = state.settings.shortcutTogglePrivate;
      if (privateShortcut && !(await isRegistered(privateShortcut))) {
        await register(privateShortcut, (event) => {
          // Only fire on key-down to prevent double toggle
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
