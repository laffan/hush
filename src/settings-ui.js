/**
 * Settings helpers — opens settings in a separate native window
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function openSettingsWindow() {
  if (IS_TAURI) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    // Check if already open
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow("settings", {
      url: "/settings.html",
      title: "Hush Settings",
      width: 520,
      height: 580,
      resizable: true,
      center: true,
      decorations: true,
    });
  } else {
    // Browser fallback: open in new tab
    window.open("/settings.html", "_blank");
  }
}

export function applyAppearance(appearance) {
  let theme;
  if (appearance === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } else {
    theme = appearance;
  }
  document.documentElement.setAttribute("data-theme", theme);
}
