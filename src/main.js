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

  // Sidebar hover trigger — a fixed invisible zone on the left edge
  // Works more reliably than CSS ::before in fullscreen contexts
  const sidebarTrigger = document.createElement("div");
  sidebarTrigger.style.cssText =
    "position:fixed;top:0;left:0;width:50px;height:100%;z-index:250;pointer-events:auto;";
  document.body.appendChild(sidebarTrigger);
  sidebarTrigger.addEventListener("mouseenter", () => {
    sidebar.classList.add("visible");
  });
  // Hide sidebar when mouse leaves the sidebar area entirely
  // (must track leave on the sidebar + trigger combined)
  function checkSidebarLeave(e) {
    const x = e.clientX;
    // Still inside sidebar or panel zone
    if (x <= 50) return;
    const panel = document.getElementById("panel-overlay");
    if (panel && !panel.classList.contains("hidden") && x <= 330) return;
    sidebar.classList.remove("visible");
  }
  document.addEventListener("mousemove", checkSidebarLeave);

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
