import { createEditor } from "./editor.js";
import { createSidebar } from "./sidebar.js";
import { AppState } from "./state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";
import { applyAppearance } from "./settings-ui.js";

const fontFallbacks = {
  "EB Garamond": "'EB Garamond', 'Georgia', 'Times New Roman', serif",
  "Inter": "'Inter', system-ui, -apple-system, sans-serif",
  "Fira Code": "'Fira Code', 'Fira Mono', 'Consolas', monospace",
};

function applyFontFamily(family) {
  const value = fontFallbacks[family] || fontFallbacks["EB Garamond"];
  document.documentElement.style.setProperty("--font-family", value);
}

async function init() {
  const state = new AppState();
  await state.init();

  // Apply appearance and CSS vars
  applyAppearance(state.settings.appearance || "dark");
  document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
  document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
  applyFontFamily(state.settings.fontFamily);

  const editor = createEditor(document.getElementById("editor-container"), state);
  state.setEditor(editor);

  const sidebar = document.getElementById("sidebar");
  createSidebar(sidebar, state);

  // JS-based sidebar hover detection (works reliably in fullscreen)
  document.addEventListener("mousemove", (e) => {
    if (e.clientX <= 20) {
      sidebar.classList.add("visible");
    } else if (e.clientX > 60 && sidebar.classList.contains("visible")) {
      // Only auto-hide if no panel is open
      const panel = document.getElementById("panel-overlay");
      if (!panel || panel.classList.contains("hidden")) {
        sidebar.classList.remove("visible");
      }
    }
  });

  await setupTauriIntegration(state);

  // Listen for settings updates from the settings window
  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("settings-updated", (event) => {
      const newSettings = event.payload;
      Object.assign(state.settings, newSettings);
      applyAppearance(state.settings.appearance || "dark");
      document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
      document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
      applyFontFamily(state.settings.fontFamily);
      state.emit("settings-changed");
      state.emit("theme-changed");
    });
  }

  // System appearance changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.appearance === "auto") {
      applyAppearance("auto");
    }
  });
}

init().catch(console.error);
