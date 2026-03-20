import { createEditor } from "./editor.js";
import { createSidebar } from "./sidebar.js";
import { AppState } from "./state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";
import { applyAppearance } from "./settings-ui.js";
import { getThemeById } from "./themes.js";

const fontFallbacks = {
  "EB Garamond": "'EB Garamond', 'Georgia', 'Times New Roman', serif",
  "Inter": "'Inter', system-ui, -apple-system, sans-serif",
  "Fira Code": "'Fira Code', 'Fira Mono', 'Consolas', monospace",
};

// Known theme background colors for luminance calculation
const themeBackgrounds = {
  dracula: "#282a36", ayuLight: "#fafafa", clouds: "#ffffff",
  noctisLilac: "#f2f1f8", rosePineDawn: "#faf4ed", solarizedLight: "#fdf6e3",
  smoothy: "#f4e8e1", amy: "#200020", barf: "#1a2b34", bespin: "#28211c",
  birdsOfParadise: "#3b2627", boysAndGirls: "#1c1d21", cobalt: "#002240",
  coolGlow: "#060521", espresso: "#2a211c", tomorrow: "#1d1f21",
};

function hexLuminance(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function updatePrivateBoxColor(state, overrideBg) {
  // Determine the actual editor background color
  let bg = overrideBg || null;

  if (!bg) {
    // Check active style color override first
    if (state.settings.activeStyleId && state.settings.styles) {
      const style = state.settings.styles.find(s => s.id === state.settings.activeStyleId);
      if (style) {
        bg = (style.colorOverrides && style.colorOverrides.bg) || themeBackgrounds[style.themeId];
      }
    }

    // Fall back to current theme's bg
    if (!bg) {
      let appearance = state.settings.appearance || "dark";
      if (appearance === "auto") {
        appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      const themeId = appearance === "dark" ? state.settings.darkTheme : state.settings.lightTheme;
      bg = themeBackgrounds[themeId];
    }
  }

  // Final fallback to CSS var
  if (!bg) {
    bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  }

  if (bg && bg.startsWith("#")) {
    const luminance = hexLuminance(bg);
    document.documentElement.style.setProperty("--private-box", luminance > 0.5 ? "#000000" : "#ffffff");
  }
}

function applyFontFamily(family) {
  const value = fontFallbacks[family] || `'${family}', system-ui, sans-serif`;
  document.documentElement.style.setProperty("--font-family", value);
}

function applyActiveStyle(state) {
  const styleId = state.settings.activeStyleId;
  if (!styleId) {
    // Default style — use standard editor settings, remove style overrides
    document.documentElement.style.removeProperty("--style-bg");
    document.documentElement.style.removeProperty("--style-fg");
    document.documentElement.style.removeProperty("--style-cursor");
    document.body.classList.remove("style-active");
    // Re-apply standard settings
    applyAppearance(state.settings.appearance || "dark");
    applyFontFamily(state.settings.fontFamily);
    document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
    document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
    state.emit("theme-changed");
    updatePrivateBoxColor(state);
    return;
  }

  const style = (state.settings.styles || []).find(s => s.id === styleId);
  if (!style) return;

  // Apply style overrides
  document.body.classList.add("style-active");

  if (style.fontFamily) {
    applyFontFamily(style.fontFamily);
  }
  if (style.fontSize) {
    document.documentElement.style.setProperty("--font-size", style.fontSize + "px");
  }
  if (style.lineHeight) {
    document.documentElement.style.setProperty("--line-height", style.lineHeight);
  }

  // Color overrides
  const overrides = style.colorOverrides || {};
  if (overrides.bg) {
    document.documentElement.style.setProperty("--bg", overrides.bg);
    document.documentElement.style.setProperty("--style-bg", overrides.bg);
  }
  if (overrides.fg) {
    document.documentElement.style.setProperty("--fg", overrides.fg);
    document.documentElement.style.setProperty("--cursor", overrides.fg);
    document.documentElement.style.setProperty("--style-fg", overrides.fg);
  }
  if (overrides.cursor) {
    document.documentElement.style.setProperty("--cursor", overrides.cursor);
    document.documentElement.style.setProperty("--style-cursor", overrides.cursor);
  }

  // Apply the style's theme
  state.emit("theme-changed");
  updatePrivateBoxColor(state);
}

async function init() {
  const state = new AppState();
  await state.init();

  // Apply appearance and CSS vars
  applyAppearance(state.settings.appearance || "dark");
  document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
  document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
  applyFontFamily(state.settings.fontFamily);
  updatePrivateBoxColor(state);

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
    if (panel && !panel.classList.contains("hidden") && x <= 350) return;
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

      // If there's an active style, apply it; otherwise apply standard settings
      if (state.settings.activeStyleId) {
        applyActiveStyle(state);
      } else {
        applyAppearance(state.settings.appearance || "dark");
        document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
        document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
        applyFontFamily(state.settings.fontFamily);
      }

      // Apply visibility setting
      const { invoke } = await import("@tauri-apps/api/core");
      const vis = state.settings.visibility;
      const policy = (vis === "dock" || vis === "both") ? "regular" : "accessory";
      await invoke("set_activation_policy", { policy }).catch(() => {});
      // Apply always-on-top setting
      await invoke("set_always_on_top", { onTop: !!state.settings.alwaysOnTop }).catch(() => {});
      state.emit("settings-changed");
      state.emit("theme-changed");
      updatePrivateBoxColor(state);
    });
  }

  // Style changes (from sidebar or settings)
  state.on("style-changed", () => {
    applyActiveStyle(state);
  });

  // Style preview (hover or live edit) — temporarily apply a style
  let previewActive = false;
  state.on("style-preview", (styleObj) => {
    previewActive = true;
    // Temporarily apply style overrides
    if (styleObj.fontFamily) applyFontFamily(styleObj.fontFamily);
    if (styleObj.fontSize) document.documentElement.style.setProperty("--font-size", styleObj.fontSize + "px");
    if (styleObj.lineHeight) document.documentElement.style.setProperty("--line-height", styleObj.lineHeight);
    const overrides = styleObj.colorOverrides || {};
    if (overrides.bg) document.documentElement.style.setProperty("--bg", overrides.bg);
    if (overrides.fg) {
      document.documentElement.style.setProperty("--fg", overrides.fg);
      document.documentElement.style.setProperty("--cursor", overrides.fg);
    }
    if (overrides.cursor) document.documentElement.style.setProperty("--cursor", overrides.cursor);
    // Apply theme
    if (styleObj.themeId) {
      const theme = getThemeById(styleObj.themeId);
      if (theme && state.editor) state.editor.reconfigureTheme(theme.extension);
    }
    // Determine preview bg for private mode
    const previewBg = overrides.bg || themeBackgrounds[styleObj.themeId] || null;
    updatePrivateBoxColor(state, previewBg);
  });
  state.on("style-preview-end", () => {
    if (!previewActive) return;
    previewActive = false;
    // Restore actual settings
    applyActiveStyle(state);
  });

  // System appearance changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.appearance === "auto") {
      applyAppearance("auto");
      updatePrivateBoxColor(state);
    }
  });
}

init().catch(console.error);
