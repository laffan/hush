import { createEditor } from "./editor.js";
import { createSidebar } from "./sidebar.js";
import { AppState } from "./state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";
import { applyAppearance, isIOS } from "./settings-ui.js";
import { getThemeById } from "./themes.js";
import { setupFileDrop } from "./file-drop.js";
import { findNext, findPrev } from "./find-replace.js";
import { createLongView } from "./longview.js";

// Bundled Google Fonts (offline use) — imported from JS so Vite resolves npm packages
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/600.css";
import "@fontsource/eb-garamond/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-sans-pro/400.css";
import "@fontsource/source-sans-pro/400-italic.css";
import "@fontsource/source-sans-pro/600.css";
import "@fontsource/source-sans-pro/700.css";
import "@fontsource/source-serif-pro/400.css";
import "@fontsource/source-serif-pro/400-italic.css";
import "@fontsource/source-serif-pro/600.css";
import "@fontsource/source-serif-pro/700.css";
import "@fontsource/libre-franklin/400.css";
import "@fontsource/libre-franklin/400-italic.css";
import "@fontsource/libre-franklin/600.css";
import "@fontsource/libre-franklin/700.css";
import "@fontsource/libre-baskerville/400.css";
import "@fontsource/libre-baskerville/400-italic.css";
import "@fontsource/libre-baskerville/700.css";
import "@fontsource/karla/400.css";
import "@fontsource/karla/400-italic.css";
import "@fontsource/karla/600.css";
import "@fontsource/karla/700.css";
import "@fontsource/lora/400.css";
import "@fontsource/lora/400-italic.css";
import "@fontsource/lora/500.css";
import "@fontsource/lora/600.css";
import "@fontsource/lora/700.css";

const fontFallbacks = {
  "Helvetica": "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
  "EB Garamond": "'EB Garamond', 'Georgia', 'Times New Roman', serif",
  "Inter": "'Inter', system-ui, -apple-system, sans-serif",
  "Fira Code": "'Fira Code', 'Fira Mono', 'Consolas', monospace",
  "Source Sans Pro": "'Source Sans Pro', 'Helvetica Neue', 'Arial', sans-serif",
  "Source Serif Pro": "'Source Serif Pro', 'Georgia', 'Times New Roman', serif",
  "Libre Franklin": "'Libre Franklin', 'Helvetica Neue', 'Arial', sans-serif",
  "Libre Baskerville": "'Libre Baskerville', 'Georgia', 'Times New Roman', serif",
  "Karla": "'Karla', 'Helvetica Neue', 'Arial', sans-serif",
  "Lora": "'Lora', 'Georgia', 'Times New Roman', serif",
};

// Known theme background colors — must match thememirror's actual settings.background
const themeBackgrounds = {
  dracula: "#2d2f3f", ayuLight: "#fcfcfc", clouds: "#ffffff",
  noctisLilac: "#f2f1f8", rosePineDawn: "#faf4ed", solarizedLight: "#fef7e5",
  smoothy: "#ffffff", amy: "#200020", barf: "#15191e", bespin: "#2e241d",
  birdsOfParadise: "#3b2627", boysAndGirls: "#000205", cobalt: "#00254b",
  coolGlow: "#060521", espresso: "#ffffff", tomorrow: "#ffffff",
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
    const isDark = luminance <= 0.5;
    const root = document.documentElement.style;

    // Private mode
    root.setProperty("--private-box", isDark ? "#ffffff" : "#000000");

    // Theme-derived colors for sidebar + panels
    root.setProperty("--theme-bg", bg);
    root.setProperty("--fg", isDark ? "#e0e0e0" : "#1a1a1a");
    root.setProperty("--cursor", isDark ? "#e0e0e0" : "#1a1a1a");
    root.setProperty("--sidebar-icon-color", isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)");
    root.setProperty("--sidebar-icon-hover", isDark ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.85)");
    root.setProperty("--sidebar-fg", isDark ? "#888" : "#888");

    // Panel colors derived from actual theme bg
    const r = parseInt(bg.slice(1, 3), 16);
    const g = parseInt(bg.slice(3, 5), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    root.setProperty("--panel-bg", `rgba(${r}, ${g}, ${b}, 0.98)`);
    root.setProperty("--panel-border", isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)");
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
    document.documentElement.style.removeProperty("--selection");
    document.body.classList.remove("style-active");
    // Clear editor overrides
    const cmEditor = document.querySelector('.cm-editor');
    if (cmEditor) {
      cmEditor.style.backgroundColor = '';
      cmEditor.style.color = '';
    }
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

  // Apply the style's theme first, then color overrides on top
  state.emit("theme-changed");

  // Color overrides — applied AFTER theme and updatePrivateBoxColor
  // so they take precedence over theme-derived values
  const overrides = style.colorOverrides || {};
  updatePrivateBoxColor(state);

  const cmEditorEl = document.querySelector('.cm-editor');
  if (overrides.bg) {
    document.documentElement.style.setProperty("--bg", overrides.bg);
    document.documentElement.style.setProperty("--style-bg", overrides.bg);
    if (cmEditorEl) cmEditorEl.style.backgroundColor = overrides.bg;
  } else {
    if (cmEditorEl) cmEditorEl.style.backgroundColor = '';
  }
  if (overrides.fg) {
    // Apply text color to editor only, not sidebar/panels (--fg is global)
    document.documentElement.style.setProperty("--style-fg", overrides.fg);
    if (cmEditorEl) cmEditorEl.style.color = overrides.fg;
    if (!overrides.cursor) {
      document.documentElement.style.setProperty("--cursor", overrides.fg);
    }
  } else {
    document.documentElement.style.removeProperty("--style-fg");
    if (cmEditorEl) cmEditorEl.style.color = '';
  }
  if (overrides.cursor) {
    document.documentElement.style.setProperty("--cursor", overrides.cursor);
    document.documentElement.style.setProperty("--style-cursor", overrides.cursor);
  }
  if (overrides.selection) {
    document.documentElement.style.setProperty("--selection", overrides.selection);
  } else {
    document.documentElement.style.removeProperty("--selection");
  }
}

async function init() {
  const state = new AppState();
  await state.init();

  // On iOS, set html background to prevent black bars behind the webview
  if (isIOS()) {
    document.documentElement.classList.add("ios");
  }

  // Apply appearance and CSS vars
  applyAppearance(state.settings.appearance || "dark");
  document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
  document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
  applyFontFamily(state.settings.fontFamily);
  updatePrivateBoxColor(state);

  const editor = createEditor(document.getElementById("editor-container"), state);
  state.setEditor(editor);

  // Apply active style if one was persisted — must happen after editor creation
  if (state.settings.activeStyleId) {
    applyActiveStyle(state);
  }

  // Load current file content into the newly created editor
  // (init() already opened the last file/project — re-open only if editor wasn't set yet)
  if (state.currentProjectId) {
    await state.openProject(state.currentProjectId);
  } else if (state.currentFileId) {
    await state.openFile(state.currentFileId);
  }

  // Restore mode states (typewriter, DRY) that were loaded from settings
  if (state.typewriterMode || state.dryMode || state.ratchetMode) {
    state.emit("mode-changed");
  }

  // Restore scroll position after content is loaded
  if (state._pendingScrollPosition != null && state.editor) {
    requestAnimationFrame(() => {
      state.editor.view.scrollDOM.scrollTop = state._pendingScrollPosition;
      state._pendingScrollPosition = null;
    });
  }

  // Always focus the editor when the window gains focus
  // This handles: startup, reveal via shortcut, fullscreen toggle, tray click
  window.addEventListener("focus", () => {
    if (state.editor) state.editor.focus();
  });

  // Global keyboard shortcuts that work even when editor doesn't have focus
  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd+Shift+\ — toggle right sidebar (LongView) — check BEFORE Cmd+\
    if (mod && e.shiftKey && e.key === "\\") {
      e.preventDefault();
      const rp = document.getElementById("right-panel-overlay");
      if (rp.classList.contains("hidden")) {
        state.emit("show-longview");
      } else {
        state.emit("hide-longview");
      }
      return;
    }
    // Cmd+\ — toggle left sidebar
    if (mod && !e.shiftKey && e.key === "\\") {
      e.preventDefault();
      const sb = document.getElementById("sidebar");
      const po = document.getElementById("panel-overlay");
      const isVisible = sb.classList.contains("pinned") ||
                        sb.classList.contains("visible") ||
                        !po.classList.contains("hidden");
      if (isVisible) {
        state.emit("hide-panel");
      } else {
        sb.classList.add("pinned");
        state.emit("show-files-panel");
      }
    }
    // Cmd+G — next find match
    if (mod && !e.shiftKey && e.key === "g") {
      if (findNext()) e.preventDefault();
    }
    // Cmd+Shift+G — previous find match
    if (mod && e.shiftKey && e.key === "G") {
      if (findPrev()) e.preventDefault();
    }
  });

  // Initial focus
  editor.focus();

  const sidebar = document.getElementById("sidebar");
  createSidebar(sidebar, state);
  setupFileDrop(state);

  // Panel inset mode — push into editor margin when there's enough space
  const panelOverlay = document.getElementById("panel-overlay");
  function updatePanelMode() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth || 600;
    const sidePad = Math.max(50, Math.floor((w - colW) / 2));
    // Panel (300px) + sidebar (50px) = 350px; fits if sidePad >= 350
    if (sidePad >= 350) {
      panelOverlay.classList.add("panel-inset");
      panelOverlay.classList.remove("panel-overlay-mode");
    } else {
      panelOverlay.classList.remove("panel-inset");
      panelOverlay.classList.add("panel-overlay-mode");
    }
  }
  updatePanelMode();
  window.addEventListener("resize", updatePanelMode);
  // Also update when column width changes
  state.on("settings-changed", updatePanelMode);

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
    // Don't auto-hide if pinned via Cmd+\ or panel is pinned (inset mode only)
    if (sidebar.classList.contains("pinned")) return;
    if (panelOverlay.classList.contains("panel-pinned") && panelOverlay.classList.contains("panel-inset")) return;
    const x = e.clientX;
    // Still inside sidebar zone
    if (x <= 50) return;
    // Still inside panel zone (if panel is open)
    if (!panelOverlay.classList.contains("hidden") && x <= 350) return;
    // Don't hide sidebar if a panel is open — buttons should stay accessible
    if (!panelOverlay.classList.contains("hidden")) return;
    sidebar.classList.remove("visible");
    // Re-enable trigger for next hover
    sidebarTrigger.style.pointerEvents = "auto";
  }
  document.addEventListener("mousemove", checkSidebarLeave);

  // ===== Right sidebar (LongView) =====
  const rightPanelOverlay = document.getElementById("right-panel-overlay");
  let longViewInstance = null;
  let rightPanelPinned = false;

  // Right panel inset mode — mirror left panel logic
  function updateRightPanelMode() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth || 600;
    const rightPad = Math.max(50, Math.floor((w - colW) / 2));
    if (rightPad >= 300) {
      rightPanelOverlay.classList.add("panel-inset");
      rightPanelOverlay.classList.remove("panel-overlay-mode");
    } else {
      rightPanelOverlay.classList.remove("panel-inset");
      rightPanelOverlay.classList.add("panel-overlay-mode");
    }
  }
  updateRightPanelMode();
  window.addEventListener("resize", updateRightPanelMode);
  state.on("settings-changed", updateRightPanelMode);

  // Right panel pin button
  const rightPinBtn = document.createElement("button");
  rightPinBtn.className = "right-panel-pin-btn";
  rightPinBtn.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12" style="transform:rotate(-90deg)"><polygon points="0,0 12,12 12,0" fill="currentColor"/></svg>`;
  rightPinBtn.title = "Pin panel open";
  document.body.appendChild(rightPinBtn);

  rightPinBtn.addEventListener("click", () => {
    rightPanelPinned = !rightPanelPinned;
    rightPanelOverlay.classList.toggle("panel-pinned", rightPanelPinned);
    rightPinBtn.title = rightPanelPinned ? "Unpin panel" : "Pin panel open";
    syncRightPinBtn();
  });

  function syncRightPinBtn() {
    const isInset = rightPanelOverlay.classList.contains("panel-inset");
    const isOpen = !rightPanelOverlay.classList.contains("hidden");
    if (!isInset || !isOpen) {
      rightPinBtn.classList.remove("pin-visible", "pin-active");
    } else if (rightPanelPinned) {
      rightPinBtn.className = "right-panel-pin-btn pin-active";
    }
  }

  document.addEventListener("mousemove", (e) => {
    const isInset = rightPanelOverlay.classList.contains("panel-inset");
    const isOpen = !rightPanelOverlay.classList.contains("hidden");
    if (!isInset || !isOpen || rightPanelPinned) return;
    const w = window.innerWidth;
    if (e.clientX >= w - 300) {
      rightPinBtn.classList.add("pin-visible");
    } else {
      rightPinBtn.classList.remove("pin-visible");
    }
  });

  // Show/hide LongView
  state.on("show-longview", () => {
    rightPanelOverlay.classList.remove("hidden");
    if (!longViewInstance) {
      longViewInstance = createLongView(rightPanelOverlay, state);
    }
    longViewInstance.render();
    if (state._columnResizeHandler) state._columnResizeHandler();
    syncRightPinBtn();
  });

  state.on("hide-longview", () => {
    if (rightPanelPinned && rightPanelOverlay.classList.contains("panel-inset")) return;
    rightPanelOverlay.classList.add("hidden");
    rightPanelPinned = false;
    rightPanelOverlay.classList.remove("panel-pinned");
    rightPinBtn.classList.remove("pin-active", "pin-visible");
    if (state._columnResizeHandler) state._columnResizeHandler();
  });

  // Close right panel on click outside (unless pinned in inset mode)
  document.addEventListener("mousedown", (e) => {
    const pinActive = rightPanelPinned && rightPanelOverlay.classList.contains("panel-inset");
    if (!rightPanelOverlay.classList.contains("hidden") && !pinActive &&
        !rightPanelOverlay.contains(e.target) && !rightPinBtn.contains(e.target)) {
      state.emit("hide-longview");
    }
  });

  // Right sidebar trigger zone — invisible zone on right edge
  const rightTrigger = document.createElement("div");
  rightTrigger.style.cssText = "position:fixed;top:0;right:0;width:20px;height:100%;z-index:250;";
  document.getElementById("app").appendChild(rightTrigger);
  rightTrigger.addEventListener("mouseenter", () => {
    state.emit("show-longview");
  });

  // Refresh LongView on file open
  state.on("file-opened", () => {
    if (longViewInstance && !rightPanelOverlay.classList.contains("hidden")) {
      longViewInstance.render();
    }
  });

  // Save scroll position periodically (debounced on scroll)
  let scrollSaveTimer = null;
  if (state.editor) {
    state.editor.view.scrollDOM.addEventListener("scroll", () => {
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        const scrollTop = state.editor.view.scrollDOM.scrollTop;
        state.updateSettings({ scrollPosition: scrollTop });
      }, 1000);
    });
  }
  // Also save session state when the window becomes hidden
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      state.saveSessionState();
    }
  });

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
    // Apply theme first
    if (styleObj.themeId) {
      const theme = getThemeById(styleObj.themeId);
      if (theme && state.editor) state.editor.reconfigureTheme(theme.extension);
    }
    // Determine preview bg for private mode
    const overrides = styleObj.colorOverrides || {};
    const previewBg = overrides.bg || themeBackgrounds[styleObj.themeId] || null;
    updatePrivateBoxColor(state, previewBg);
    // Apply color overrides AFTER updatePrivateBoxColor so they take precedence
    if (overrides.bg) {
      document.documentElement.style.setProperty("--bg", overrides.bg);
      const cmEditor = document.querySelector('.cm-editor');
      if (cmEditor) cmEditor.style.backgroundColor = overrides.bg;
    }
    if (overrides.fg) {
      document.documentElement.style.setProperty("--style-fg", overrides.fg);
      const cmEd = document.querySelector('.cm-editor');
      if (cmEd) cmEd.style.color = overrides.fg;
      if (!overrides.cursor) document.documentElement.style.setProperty("--cursor", overrides.fg);
    }
    if (overrides.cursor) document.documentElement.style.setProperty("--cursor", overrides.cursor);
    if (overrides.selection) {
      document.documentElement.style.setProperty("--selection", overrides.selection);
    } else {
      document.documentElement.style.removeProperty("--selection");
    }
  });
  state.on("style-preview-end", () => {
    if (!previewActive) return;
    previewActive = false;
    // Clear editor overrides before restoring
    const cmEditor = document.querySelector('.cm-editor');
    if (cmEditor) {
      cmEditor.style.backgroundColor = '';
      cmEditor.style.color = '';
    }
    document.documentElement.style.removeProperty("--style-fg");
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
