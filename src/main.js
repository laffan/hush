import { createEditor } from "./editor/editor.js";
import { createSidebar } from "./sidebar/sidebar.js";
import { AppState } from "./state/state.js";
import { setupTauriIntegration } from "./tauri-bridge.js";
import { applyAppearance, isIOS, openSettingsWindow } from "./settings/settings-ui.js";
import { getThemeById } from "./themes.js";
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";
import { setupFileDrop } from "./editor/file-drop.js";
import { dispatchDomShortcut, matchesDomEvent } from "./shortcuts.js";
import { buildEditorCommands } from "./editor/commands.js";
import { toggleCommandPalette } from "./command-palette.js";
import { fontFallbacks, themeBackgrounds, hexLuminance, updatePrivateBoxColor, applyFontFamily } from "./theme-colors.js";
import { mountNotebook, unmountNotebook, saveNotebook, applyNotebookSettings, getCanvasInstance, setNotebookLeftInset, reloadNotebookShapes } from "./notebook/notebook-bridge.js";
import { initPaneManager, isPaneActive } from "./pane/pane-manager.js";

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
  // Expose on window so lazy helpers (e.g. pane/text-drag.js's notebook-to-
  // doc image path) can reach the live AppState without a hard import cycle.
  if (typeof window !== "undefined") window.__hushState__ = state;

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

  // Cmd-drag a selection out of the main editor to drop into a pane or
  // notebook canvas (same behaviour as pane editors).
  const { attachEditorTextDrag } = await import("./pane/text-drag.js");
  attachEditorTextDrag(editor.view, editorContainer);
  // Cmd-drag also works on image chips / raw image refs — route them via
  // the same text-drag pipeline so the markdown ref is inserted at the
  // drop point (the receiving editor re-decorates it).
  const { attachImageDrag } = await import("./editor/plugins/image-decorator.js");
  attachImageDrag(editor.view, editorContainer, state);

  // Emit content-change events so floating panes can sync.
  // Patch markDirty to also fire "doc-content-changed" — this is called
  // by the editor's updateListener on every docChanged event.
  const _origMarkDirty = state.markDirty.bind(state);
  state.markDirty = function() {
    _origMarkDirty();
    state.emit("doc-content-changed");
  };

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
  state.on("notebook-unmount", async () => {
    const result = await unmountNotebook();
    if (result) state.syncFileToExternal(result.fileId, result.content);
    showEditor();
  });
  state.on("notebook-autosave", async () => {
    const result = await saveNotebook();
    if (result) state.syncFileToExternal(result.fileId, result.content);
  });
  state.on("notebook-sync-reload", (content) => reloadNotebookShapes(content));
  state.on("file-opened", () => { if (!state.currentNotebookFileId) showEditor(); });

  // Notebook commands from the command palette
  state.on("notebook-toggle-shelf", () => {
    for (const btn of notebookContainer.querySelectorAll("button")) {
      if (btn.textContent === "\u2039" || btn.textContent === "\u203a") { btn.click(); break; }
    }
  });
  state.on("notebook-toggle-brainstorm", () => {
    const c = getCanvasInstance();
    if (!c) return;
    c.state.brainstormMode = !c.state.brainstormMode;
    if (c.state.brainstormMode) { c.state.tool = "text"; c.state.notify("tool"); }
    c.state.notify("brainstormMode");
  });

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

  // Focus editor when window gains focus (unless a floating pane is active)
  window.addEventListener("focus", () => {
    if (isPaneActive()) return;
    if (state.editor) state.editor.focus();
  });

  // Window-level keyboard shortcut fallback (for when focus is outside editor)
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

    // A small set of global UI shortcuts should fire regardless of focus —
    // the sidebar/outline/fullscreen toggles are expected to work whether
    // the user is inside the editor, a notebook text shape, a pane, or the
    // body. Check these up front before the text-field guard so they
    // aren't swallowed by focus state.
    const alwaysAllowedKeys = ["shortcutToggleSidebar", "shortcutToggleOutline", "shortcutOpenFullscreen"];
    for (const key of alwaysAllowedKeys) {
      const sc = state.settings[key];
      if (sc && matchesDomEvent(e, sc)) {
        const handler = windowCommands[key];
        if (handler) { e.preventDefault(); handler(state, null); return; }
      }
    }

    const t = e.target;
    const tag = t && t.tagName;
    const isTextField = !!t && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable);
    const inNotebook = document.body.classList.contains("notebook-mode");
    const inNotebookInlineEditor = !!t && tag === "TEXTAREA" && t.classList?.contains("inline-text-editor");
    if (isTextField && inNotebook) {
      // Cmd+, — open settings (also hardcoded below for canvas focus)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
        e.preventDefault(); openSettingsWindow(state); return;
      }
      // Zotero — allow Insert Reference to fire from inside an inline
      // text-shape editor so users can cite while editing a text shape.
      // The modal's insert path routes back into the textarea (see
      // zotero.js getActiveNotebookTextEditor).
      if (inNotebookInlineEditor) {
        const sc = state.settings.shortcutZotero;
        if (sc && matchesDomEvent(e, sc)) {
          const handler = windowCommands.shortcutZotero;
          const mainView = state.editor ? state.editor.view : null;
          if (handler) { e.preventDefault(); handler(state, mainView); return; }
        }
      }
    }
    // Don't hijack keystrokes in text input fields.  In notebook mode the
    // target is the canvas element, not body — let shortcuts through.
    if (isTextField) return;
    // Cmd+, — open settings (CodeMirror handles this in doc mode, but
    // we need an explicit check for notebook mode)
    if (state.currentNotebookFileId && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
      e.preventDefault(); openSettingsWindow(state); return;
    }

    const view = state.editor ? state.editor.view : null;
    if (dispatchDomShortcut(e, state, windowCommands, view)) {
      e.preventDefault();
    }
  });

  // Sidebar toggle (left panel)
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

  state.on("toggle-outline-panel", () => {
    // In notebook mode the right sidebar is the Shelf, not the outline.
    // Share the keyboard shortcut between the two so it just means
    // "toggle the right panel" regardless of which mode is active.
    if (state.currentNotebookFileId) {
      state.emit("notebook-toggle-shelf");
      return;
    }
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

  // Initialize floating pane system (includes global click-outside-to-deactivate)
  initPaneManager(state);

  // Local Sync watcher — refresh the files panel when mounted folders
  // change on disk, and reload the open file if it was the one that
  // changed.
  if (IS_TAURI) {
    const { startLocalSyncWatcher } = await import("./sync/local-sync.js");
    startLocalSyncWatcher(state, () => {
      import("./sidebar/files-panel.js")
        .then(m => m.refreshFilesPanel(state))
        .catch(() => {});
    }).catch(() => {});

    // Settings window fires this after add/remove so the files panel
    // refreshes even if the user hasn't re-opened it yet. The generic
    // settings-updated broadcast also triggers a refresh, but this
    // dedicated path is faster and doesn't depend on the full settings
    // round-trip.
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen("local-sync-folders-updated", async () => {
        // Pull fresh settings so state.settings.localSyncFolders is
        // current before the refresh reads it.
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const fresh = await invoke("get_settings");
          if (fresh) Object.assign(state.settings, fresh);
        } catch (_) {}
        const { refreshFilesPanel } = await import("./sidebar/files-panel.js");
        refreshFilesPanel(state);
      });
    } catch (e) {
      console.error("Failed to listen for local-sync-folders-updated:", e);
    }
  }

  // Sync notebook left inset when sidebar/panel visibility changes
  function syncNotebookInset() {
    if (!state.currentNotebookFileId) return;
    const po = document.getElementById("panel-overlay");
    const panelOpen = po && !po.classList.contains("hidden");
    const sbVisible = sidebar.classList.contains("pinned") || sidebar.classList.contains("visible");
    const panelW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    setNotebookLeftInset(panelOpen ? (50 + panelW) : sbVisible ? 50 : 0);
  }
  new MutationObserver(syncNotebookInset).observe(document.getElementById("panel-overlay"), { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(syncNotebookInset).observe(sidebar, { attributes: true, attributeFilter: ["class"] });

  // Panel inset mode — the left sidebar only overlays the text on narrow
  // windows. At >= 800px the panel insets alongside the editor (the column
  // shrinks / shifts to make room); narrower than that, it overlays.
  const panelOverlay = document.getElementById("panel-overlay");
  const OVERLAY_BREAKPOINT = 800;
  function updatePanelMode() {
    const w = window.innerWidth;
    if (w >= OVERLAY_BREAKPOINT) {
      panelOverlay.classList.add("panel-inset");
      panelOverlay.classList.remove("panel-overlay-mode");
    } else {
      panelOverlay.classList.remove("panel-inset");
      panelOverlay.classList.add("panel-overlay-mode");
    }
    // Above 600px, the panel is open-or-closed only — no pin concept, no
    // auto-close on click-outside. The sidebar keeps its hover-to-show
    // behaviour so it doesn't steal screen space when not in use.
    if (w > 600) {
      document.body.classList.add("wide-viewport");
    } else {
      document.body.classList.remove("wide-viewport");
    }
  }
  updatePanelMode();
  window.addEventListener("resize", updatePanelMode);
  state.on("settings-changed", updatePanelMode);

  // Re-apply column layout when settings change (e.g. makeSpaceForPanes toggled)
  state.on("settings-changed", () => { if (state._columnResizeHandler) state._columnResizeHandler(); });

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
  function checkSidebarLeave(e) {
    if (sidebar.classList.contains("pinned")) return;
    const x = e.clientX;
    // Still inside sidebar zone
    if (x <= 50) return;
    // Still inside panel zone (if panel is open) — width is user-resizable
    const panelW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    if (!panelOverlay.classList.contains("hidden") && x <= 50 + panelW) return;
    // Don't hide sidebar if a panel is open — buttons should stay accessible
    if (!panelOverlay.classList.contains("hidden")) return;
    sidebar.classList.remove("visible");
    // Re-enable trigger for next hover
    sidebarTrigger.style.pointerEvents = "auto";
  }
  document.addEventListener("mousemove", checkSidebarLeave);

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
          const { invoke } = await import("@tauri-apps/api/core");
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

  // System appearance changes — when set to "auto", re-apply appearance AND
  // the active style so its light/dark palette follows the system switch.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.appearance === "auto") {
      applyAppearance("auto");
      if (state.settings.activeStyleId) {
        applyActiveStyle(state);
      }
      updatePrivateBoxColor(state);
      state.emit("theme-changed");
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
