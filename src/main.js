import { createEditor } from "./editor.js";
import { createSidebar } from "./sidebar.js";
import { createSettingsUI, applyAppearance } from "./settings-ui.js";
import { AppState } from "./state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";

async function init() {
  const state = new AppState();
  await state.init();

  // Apply appearance (sets data-theme) and CSS vars
  applyAppearance(state.settings.appearance || "dark", state);
  document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
  document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);

  const editor = createEditor(document.getElementById("editor-container"), state);
  state.setEditor(editor);

  const settingsUI = createSettingsUI(document.getElementById("settings-overlay"), state);
  createSidebar(document.getElementById("sidebar"), state, settingsUI);

  await setupTauriIntegration(state);

  // Listen for system appearance changes when set to auto
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.appearance === "auto") {
      applyAppearance("auto", state);
    }
  });
}

init().catch(console.error);
