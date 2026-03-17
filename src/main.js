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

  // Load current file content into the newly created editor
  if (state.currentFileId) {
    await state.openFile(state.currentFileId);
  }

  // If ratchet mode was restored from localStorage, activate UI (timer, visual state)
  if (state.ratchetMode) {
    state.emit("mode-changed");
  }

  // Always focus the editor when the window gains focus
  // This handles: startup, reveal via shortcut, fullscreen toggle, tray click
  window.addEventListener("focus", () => {
    if (state.editor) state.editor.focus();
  });
  // Initial focus
  editor.focus();

  const sidebar = document.getElementById("sidebar");
  createSidebar(sidebar, state);

  // Sidebar hover trigger — a fixed invisible zone on the left edge
  // Must live inside #app so it shares the same stacking context in fullscreen
  const sidebarTrigger = document.createElement("div");
  sidebarTrigger.style.cssText =
    "position:fixed;top:0;left:0;width:50px;height:100%;z-index:250;";
  document.getElementById("app").appendChild(sidebarTrigger);
  sidebarTrigger.addEventListener("mouseenter", () => {
    sidebar.classList.add("visible");
    // Disable trigger so clicks pass through to sidebar buttons
    sidebarTrigger.style.pointerEvents = "none";
  });
  // Hide sidebar when mouse leaves the sidebar area entirely
  function checkSidebarLeave(e) {
    // Don't auto-hide if pinned via Cmd+/
    if (sidebar.classList.contains("pinned")) return;
    const x = e.clientX;
    // Still inside sidebar zone
    if (x <= 50) return;
    // Still inside panel zone (if panel is open)
    const panel = document.getElementById("panel-overlay");
    if (panel && !panel.classList.contains("hidden") && x <= 330) return;
    // Don't hide sidebar if a panel is open — buttons should stay accessible
    if (panel && !panel.classList.contains("hidden")) return;
    sidebar.classList.remove("visible");
    // Re-enable trigger for next hover
    sidebarTrigger.style.pointerEvents = "auto";
  }
  document.addEventListener("mousemove", checkSidebarLeave);

  await setupTauriIntegration(state);

  // Apply initial always-on-top setting
  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    if (state.settings.alwaysOnTop) {
      await invoke("set_always_on_top", { onTop: true }).catch(() => {});
    }
  }

  // Listen for settings updates from the settings window
  if (IS_TAURI) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("toggle-fullscreen", () => {
      state.toggleFullscreen();
    });
    await listen("settings-updated", async (event) => {
      const newSettings = event.payload;
      Object.assign(state.settings, newSettings);
      applyAppearance(state.settings.appearance || "dark");
      document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
      document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
      applyFontFamily(state.settings.fontFamily);
      // Apply visibility setting
      const { invoke } = await import("@tauri-apps/api/core");
      const vis = state.settings.visibility;
      const policy = (vis === "dock" || vis === "both") ? "regular" : "accessory";
      await invoke("set_activation_policy", { policy }).catch(() => {});
      // Apply always-on-top setting
      await invoke("set_always_on_top", { onTop: !!state.settings.alwaysOnTop }).catch(() => {});
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
