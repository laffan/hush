import { createEditor } from "./editor/editor.js";
import { createSidebar } from "./sidebar/sidebar.js";
import { AppState } from "./state/state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";
import { applyAppearance, isIOS } from "./settings/settings-ui.js";
import { getThemeById } from "./themes.js";
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";
import { setupFileDrop } from "./editor/file-drop.js";
import { dispatchDomShortcut } from "./shortcuts.js";
import { buildEditorCommands } from "./editor/commands.js";
import { toggleCommandPalette } from "./command-palette.js";
import { fontFallbacks, themeBackgrounds, hexLuminance, updatePrivateBoxColor, applyFontFamily } from "./theme-colors.js";
import { mountNotebook, unmountNotebook, saveNotebook, applyNotebookSettings } from "./notebook/notebook-bridge.js";

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

  // Resolve the correct color set for current appearance (light vs dark)
  const { colors: resolvedColors } = resolveStyleForAppearance(style, state.settings.appearance);
  // Also support legacy single-mode colorOverrides
  const overrides = resolvedColors || style.colorOverrides || {};
  updatePrivateBoxColor(state);

  const cmEditorEl = document.querySelector('.cm-editor');
  // Always update --bg to match the actual background (override or theme)
  const { themeId: resolvedThemeId } = resolveStyleForAppearance(style, state.settings.appearance);
  const effectiveBg = overrides.bg || themeBackgrounds[resolvedThemeId] || null;
  if (overrides.bg) {
    document.documentElement.style.setProperty("--bg", overrides.bg);
    document.documentElement.style.setProperty("--style-bg", overrides.bg);
    if (cmEditorEl) cmEditorEl.style.backgroundColor = overrides.bg;
  } else {
    if (effectiveBg) {
      document.documentElement.style.setProperty("--bg", effectiveBg);
    }
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

/** Handle an OAuth authorization code from a deep-link callback. */
async function handleOAuthCode(state, invoke, code) {
  try {
    const verifier = sessionStorage.getItem("hush_oauth_verifier");
    const { getRedirectUri } = await import("./sync/dropbox.js");
    const redirectUri = sessionStorage.getItem("hush_oauth_redirect") || getRedirectUri();
    if (verifier) {
      const dbx = await import("./sync/dropbox.js");
      await dbx.completeOAuthFlow(code, verifier, redirectUri);
      sessionStorage.removeItem("hush_oauth_verifier");
      sessionStorage.removeItem("hush_oauth_redirect");
      state.settings = await invoke("get_settings");
      state.emit("settings-changed");
    }
  } catch (e) {
    console.error("OAuth callback failed:", e);
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

  const editorContainer = document.getElementById("editor-container");
  const notebookContainer = document.getElementById("notebook-container");
  const editor = createEditor(editorContainer, state);
  state.setEditor(editor);

  // === Notebook / Editor mode switching ===
  // #app.notebook-mode hides all editor chrome (resizers, right panel, drag
  // region) via CSS so the notebook canvas occupies the full space.

  const appEl = document.getElementById("app");

  function showEditor() {
    appEl.classList.remove("notebook-mode");
    document.body.classList.remove("notebook-mode");
    notebookContainer.classList.add("hidden");
  }

  function showNotebook() {
    appEl.classList.add("notebook-mode");
    document.body.classList.add("notebook-mode");
    notebookContainer.classList.remove("hidden");
    state.emit("hide-outline");
  }

  state.on("notebook-open", async (fileId) => { await mountNotebook(notebookContainer, fileId, state); showNotebook(); });
  state.on("notebook-unmount", async () => { await unmountNotebook(); showEditor(); });
  state.on("notebook-autosave", () => saveNotebook());
  state.on("file-opened", () => { if (!state.currentNotebookFileId) showEditor(); });

  // Seed globalStyleId for existing users who have an activeStyleId but no globalStyleId yet
  if (state.settings.activeStyleId && !state.settings.globalStyleId) {
    state.settings.globalStyleId = state.settings.activeStyleId;
  }

  // Apply active style if one was persisted — must happen after editor creation
  if (state.settings.activeStyleId) {
    applyActiveStyle(state);
  }

  // Load current file content into the newly created editor
  // (init() already opened the last file/project — re-open only if editor wasn't set yet)
  if (state.currentNotebookFileId) {
    // Restore last opened notebook
    await mountNotebook(notebookContainer, state.currentNotebookFileId, state);
    showNotebook();
  } else if (state.currentProjectId) {
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

  // Window-level keyboard shortcuts — the CodeMirror keymap handles every
  // shortcut while the editor has focus (which is >99% of the time).  This
  // listener is a fallback for when focus is outside the editor (e.g. right
  // after closing a modal, before focus is returned to the editor).  It
  // reads from the exact same shortcut settings + commands map as the
  // editor keymap, so behaviour stays in sync and changes in the settings
  // panel take effect instantly.
  const windowCommands = buildEditorCommands();
  window.addEventListener("keydown", (e) => {
    // Skip shortcuts already consumed by CodeMirror's keymap.  When the
    // editor is focused, CM calls `preventDefault()` as soon as it handles
    // a binding, so we avoid double-firing here.
    if (e.defaultPrevented) return;

    // Cmd+P — toggle command palette (works even from input fields)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "p") {
      e.preventDefault();
      toggleCommandPalette(state);
      return;
    }

    // Don't hijack keystrokes while the user is typing into some other
    // input (e.g. a sidebar search box, a settings field).  The editor
    // itself uses CodeMirror's contentDOM, which never matches these
    // selectors — so the fallback still works when focus is on body/etc.
    const t = e.target;
    if (t && t !== document.body) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) {
        return;
      }
    }

    const view = state.editor ? state.editor.view : null;
    if (dispatchDomShortcut(e, state, windowCommands, view)) {
      e.preventDefault();
    }
  });

  // Sidebar toggle (left panel) — emitted by the centralised shortcut
  // dispatcher via `state.emit("toggle-left-panel")`.  The DOM-touching
  // logic lives here where the sidebar/panel elements are created.
  state.on("toggle-left-panel", () => {
    const sb = document.getElementById("sidebar");
    const po = document.getElementById("panel-overlay");
    if (!sb || !po) return;
    const isVisible = sb.classList.contains("pinned") ||
                      sb.classList.contains("visible") ||
                      !po.classList.contains("hidden");
    if (isVisible) {
      state.emit("hide-panel");
    } else {
      sb.classList.add("pinned");
      state.emit("show-files-panel");
    }
  });

  // Outline toggle (right panel) — emitted by the shortcut dispatcher.
  state.on("toggle-outline-panel", () => {
    // Don't show outline when a notebook is active
    if (state.currentNotebookFileId) return;
    const rp = document.getElementById("right-panel-overlay");
    if (!rp) return;
    if (rp.classList.contains("hidden")) {
      state.emit("show-outline");
    } else {
      state.emit("hide-outline");
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
  sidebarTrigger.className = "sidebar-trigger";
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

  // Right sidebar (Outline View) — delegated to ui/right-panel-setup.js
  import("./ui/right-panel-setup.js").then(m => m.setupRightPanel(state));

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
    // iPad: reset zoom level and refresh background when returning from another app
    if (document.visibilityState === "visible" && isIOS()) {
      const viewport = document.querySelector('meta[name="viewport"]');
      if (viewport) {
        // Force viewport reset by toggling the meta tag
        const content = viewport.getAttribute("content");
        viewport.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover");
        // Ensure visualViewport scale is reset
        if (window.visualViewport && window.visualViewport.scale !== 1) {
          viewport.setAttribute("content", content);
          requestAnimationFrame(() => {
            viewport.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover");
          });
        }
      }
      // Re-apply background color to prevent black safe-area bars
      updatePrivateBoxColor(state);
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

    // Listen for Dropbox sync start from settings window
    await listen("dropbox-sync-start", async (event) => {
      const { path } = event.payload || {};
      if (path) {
        try {
          // Reload settings from backend to ensure tokens are current
          state.settings = await invoke("get_settings");
          const dbx = await import("./sync/dropbox.js");
          if (state.settings.dropboxAccessToken) {
            dbx.setTokens(state.settings.dropboxAccessToken, state.settings.dropboxRefreshToken);
          }
          // Perform initial full sync and log results
          const { performInitialSync } = await import("./sync/sync-state.js");
          const result = await performInitialSync(state, path);
          // Write sync log entries
          const logEntries = [];
          if (result.uploaded.length > 0) {
            for (const f of result.uploaded) logEntries.push(`Uploaded ${f}`);
          }
          if (result.downloaded.length > 0) {
            for (const f of result.downloaded) logEntries.push(`Downloaded ${f}`);
          }
          if (logEntries.length > 0) {
            const s = await invoke("get_settings");
            const log = s.dropboxSyncLog || [];
            const now = new Date();
            const ts = now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            for (const entry of logEntries) log.push(`${ts}  ${entry}`);
            if (log.length > 50) log.splice(0, log.length - 50);
            s.dropboxSyncLog = log;
            await invoke("save_settings", { settings: s });
          }
          // Start polling
          const sp = await import("./sync/sync-polling.js");
          sp.startSyncPolling(state);
        } catch (e) {
          console.error("Initial sync failed:", e);
        }
      }
    });

    // Listen for Dropbox sync stop from settings window
    await listen("dropbox-sync-stop", async (event) => {
      const { removeFromDropbox } = event.payload || {};
      try {
        const sp = await import("./sync/sync-polling.js");
        sp.stopSyncPolling();
        const { disconnectSync } = await import("./sync/sync-state.js");
        await disconnectSync(state, removeFromDropbox);
      } catch (e) {
        console.error("Sync disconnect failed:", e);
      }
    });

    // Listen for OAuth callback via deep-link plugin
    try {
      const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      await onOpenUrl(async (urls) => {
        for (const url of urls) {
          if (url.startsWith("hushwriter://auth/callback")) {
            const params = new URLSearchParams(url.split("?")[1] || "");
            const code = params.get("code");
            if (code) await handleOAuthCode(state, invoke, code);
          }
        }
      });
    } catch (e) {
      console.error("Deep-link setup failed:", e);
    }

    // Also listen for oauth-callback event (from Rust deep-link handler)
    await listen("oauth-callback", async (event) => {
      const { code } = event.payload || {};
      if (code) await handleOAuthCode(state, invoke, code);
    });
  }

  // Auto-apply locked style when opening a document, or revert to global style
  state.on("file-opened", () => {
    if (!state.currentFileId || !state.fileTree) return;
    function findLockedStyle(nodes) {
      for (const n of nodes) {
        if (n.fileId === state.currentFileId) return n.lockedStyleId || null;
        if (n.children) { const r = findLockedStyle(n.children); if (r) return r; }
      }
      return null;
    }
    const lockedId = findLockedStyle(state.fileTree);
    if (lockedId) {
      // This document has a locked style — apply it
      if (lockedId === "__default__") {
        // Locked to "Default" (no style)
        if (state.settings.activeStyleId) {
          state.updateSettings({ activeStyleId: null });
          state.emit("style-changed");
        }
      } else {
        const styleExists = (state.settings.styles || []).some(s => s.id === lockedId);
        if (styleExists && state.settings.activeStyleId !== lockedId) {
          state.updateSettings({ activeStyleId: lockedId });
          state.emit("style-changed");
        }
      }
    } else {
      // No lock — revert to the user's global style choice
      const globalId = state.settings.globalStyleId || null;
      if (state.settings.activeStyleId !== globalId) {
        state.updateSettings({ activeStyleId: globalId });
        state.emit("style-changed");
      }
    }
  });

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
    // Always update --bg to match the actual background (theme or override)
    if (previewBg) {
      document.documentElement.style.setProperty("--bg", previewBg);
      const cmEditor = document.querySelector('.cm-editor');
      if (cmEditor) cmEditor.style.backgroundColor = previewBg;
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

  // Apply notebook settings when settings, style, or theme changes
  function syncNotebookIfActive() {
    if (state.currentNotebookFileId) applyNotebookSettings(state);
  }
  state.on("settings-changed", syncNotebookIfActive);
  state.on("style-changed", syncNotebookIfActive);
  state.on("theme-changed", syncNotebookIfActive);

  // System appearance changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.appearance === "auto") {
      applyAppearance("auto");
      updatePrivateBoxColor(state);
      syncNotebookIfActive();
    }
  });

  // Dropbox sync: start polling if sync is enabled.
  // Initialize tokens from settings on startup.
  if (IS_TAURI && state.settings.dropboxEnabled && state.settings.dropboxSyncPath) {
    (async () => {
      try {
        const dbx = await import("./sync/dropbox.js");
        if (state.settings.dropboxAccessToken) {
          dbx.setTokens(state.settings.dropboxAccessToken, state.settings.dropboxRefreshToken);
        }
        const sp = await import("./sync/sync-polling.js");
        sp.startSyncPolling(state);
      } catch (e) {
        console.error("Sync startup failed:", e);
      }
    })();
  }
  state.on("settings-changed", async () => {
    const sp = await import("./sync/sync-polling.js");
    if (IS_TAURI && state.settings.dropboxEnabled && state.settings.dropboxSyncPath) {
      // Re-initialize tokens in case they changed
      const dbx = await import("./sync/dropbox.js");
      if (state.settings.dropboxAccessToken) {
        dbx.setTokens(state.settings.dropboxAccessToken, state.settings.dropboxRefreshToken);
      }
      sp.startSyncPolling(state);
    } else {
      sp.stopSyncPolling();
    }
  });

  // Reconcile Dropbox sync when the window regains focus.
  if (IS_TAURI) {
    let lastFocusReconcile = 0;
    const maybeReconcile = async () => {
      if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) return;
      const now = Date.now();
      if (now - lastFocusReconcile < 2000) return;
      lastFocusReconcile = now;
      try {
        const sp = await import("./sync/sync-polling.js");
        sp.triggerFullReconcile();
      } catch (e) {
        console.error("Focus reconcile failed:", e);
      }
    };
    window.addEventListener("focus", maybeReconcile);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") maybeReconcile();
    });
  }
}

init().catch(console.error);
