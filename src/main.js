import { createEditor } from "./editor/editor.js";
import { createSidebar } from "./sidebar/sidebar.js";
import { AppState } from "./state/state.js";
import { findNodeByFileId } from "./state/tree-helpers.js";
import { setupTauriIntegration } from "./tauri-bridge.js";
import { applyAppearance, isIOS, isPhone, openSettingsWindow } from "./settings/settings-ui.js";
import { getThemeById } from "./themes/index.js";
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";
import { setupFileDrop } from "./editor/file-drop.js";
import { initZenFocus } from "./editor/zen-focus.js";
import { dispatchDomShortcut, matchesDomEvent } from "./shortcuts.js";
import { buildEditorCommands } from "./editor/commands.js";
import { toggleCommandPalette, openFilePalette } from "./command-palette.js";
import { fontFallbacks, themeBackgrounds, hexLuminance, updatePrivateBoxColor, applyFontFamily } from "./theme-colors.js";
import { mountNotebook, unmountNotebook, saveNotebook, applyNotebookSettings, previewNotebookStyle, getCanvasInstance, setNotebookLeftInset, reloadNotebookShapes } from "./notebook/notebook-bridge.js";
import { initPaneManager } from "./pane/pane-manager.js";
import { initCmdButton } from "./cmd-button.js";
import { initCmdHeldSliders } from "./cmd-held-sliders.js";
import { applyActiveStyle, applyFocusModeOpacity, applyDeskGlobalStyle, handleOAuthCode } from "./style-application.js";
import { installWindowShortcuts, installActivationFocus } from "./window-shortcuts.js";
import { setTooltipsEnabled } from "./tooltips.js";
import {
  getInitialFileFromHash,
  getCurrentWindowLabel,
  setupMultiWindow,
} from "./multi-window.js";
import "./font-imports.js";

async function init() {
  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  const state = new AppState();

  if (IS_TAURI) {
    try {
      const label = await getCurrentWindowLabel();
      state.isSecondaryWindow = label !== "main";
    } catch (_) { /* fall back to main-window behaviour */ }
  }
  // Register the wikilink open hook before state.init so cmd-clicks on
  // an auto-opened notebook resolve immediately.
  if (typeof window !== "undefined") {
    const { openWikilink } = await import("./links/wikilink-index.js");
    window.__hushOpenWikilink = (title) => { void openWikilink(state, title); };
  }
  const initialFile = state.isSecondaryWindow ? getInitialFileFromHash() : null;
  await state.init({ initialFile });
  if (typeof window !== "undefined") window.__hushState__ = state;

  // On iOS, set html background to prevent black bars behind the webview
  if (isIOS()) document.documentElement.classList.add("ios");
  if (isPhone()) document.documentElement.classList.add("phone");

  // Apply appearance and CSS vars
  applyAppearance(state.settings.appearance || "dark");
  document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
  document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
  applyFontFamily(state.settings.fontFamily);
  applyFocusModeOpacity(state);
  updatePrivateBoxColor(state);

  const editorContainer = document.getElementById("editor-container");
  const notebookContainer = document.getElementById("notebook-container");
  const editor = createEditor(editorContainer, state);
  state.setEditor(editor);

  import("./google-docs/link-bar.js").then((m) => m.initLinkBar(state)).catch((e) => console.warn("[google-docs] link-bar mount failed", e));

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
  // === Mode switching (notebook / PDF / stack) ===
  const appEl = document.getElementById("app");
  const pdfContainer = document.getElementById("pdf-container");
  const stackContainer = document.getElementById("stack-container");
  const modeCls = ["notebook-mode", "pdf-mode", "stack-mode"];
  const modeContainers = { "notebook-mode": notebookContainer, "pdf-mode": pdfContainer, "stack-mode": stackContainer };

  function activateMode(mode) {
    modeCls.forEach(c => { appEl.classList.remove(c); document.body.classList.remove(c); });
    Object.values(modeContainers).forEach(el => el.classList.add("hidden"));
    if (mode) {
      appEl.classList.add(mode); document.body.classList.add(mode);
      modeContainers[mode]?.classList.remove("hidden");
      state.emit("hide-outline");
    }
  }
  const showEditor = () => activateMode(null);
  const showNotebook = () => activateMode("notebook-mode");
  const showPdf = () => activateMode("pdf-mode");
  const showStack = () => activateMode("stack-mode");

  state.on("notebook-open", async (fileId) => { await mountNotebook(notebookContainer, fileId, state); showNotebook(); });
  state.on("notebook-unmount", async () => {
    const result = await unmountNotebook();
    if (result) state.syncFileToExternal(result.fileId, result.content);
    showEditor();
  });
  state.on("pdf-open", async (fileId) => {
    const { mountPdf } = await import("./pdf/pdf-bridge.js");
    await mountPdf(pdfContainer, fileId, state);
    showPdf();
  });
  state.on("pdf-toggle-shelf", () => {
    import("./pdf/pdf-bridge.js").then(({ getPdfInstance }) => {
      const v = getPdfInstance();
      if (v) v.toggleShelf();
    });
  });
  state.on("pdf-unmount", async () => {
    const { unmountPdf } = await import("./pdf/pdf-bridge.js");
    await unmountPdf();
    showEditor();
  });
  state.on("stack-open", async (fileId) => {
    const { mountStack } = await import("./stack/stack-bridge.js");
    await mountStack(stackContainer, fileId, state);
    showStack();
  });
  state.on("stack-unmount", async () => {
    const { unmountStack } = await import("./stack/stack-bridge.js");
    const result = await unmountStack();
    if (result) state.syncFileToExternal(result.fileId, result.content);
    showEditor();
  });
  state.on("project-demoted", async (projectId) => {
    const { getStackInstance } = await import("./stack/stack-bridge.js");
    const inst = getStackInstance();
    if (!inst) return;
    const victims = inst._items.filter(i => i.fileType === "project" && i.fileId === projectId);
    for (const v of victims) inst.removeItem(v.id);
  });
  // Notebook minimap + desks toggle bridge — both wire themselves to AppState.
  import("./notebook/minimap.js").then(m => m.wireMinimap(state));
  import("./state/state-desks.js").then(m => m.wireDesksTauri(state));
  state.on("notebook-autosave", async () => {
    const result = await saveNotebook();
    if (result) {
      state.syncFileToExternal(result.fileId, result.content);
      // Fan the fresh envelope out to sibling windows so any one of them
      // currently displaying the same notebook can `reloadNotebookShapes`
      // and pick up the new shape set without remounting.
      state.emit("notebook-cross-window-broadcast", {
        fileId: result.fileId,
        content: result.content,
      });
    }
  });
  state.on("notebook-sync-reload", (content) => {
    reloadNotebookShapes(content).catch((e) => console.warn("notebook-sync-reload failed:", e));
  });
  state.on("file-opened", () => { if (!state.currentNotebookFileId && !state.currentPdfFileId && !state.currentStackFileId) showEditor(); });

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

  // Apply active style — runs even when activeStyleId is null so the
  // Default style's post-processing layer (settings.shaderLayer) mounts
  // on startup. The no-style branch of applyActiveStyle is a near-no-op
  // for everything else (just re-asserts standard font/theme/color
  // values that are already in place from earlier init steps).
  applyActiveStyle(state);

  // Load current file content into the newly created editor
  // (init() already opened the last file/project — re-open only if editor wasn't set yet)
  if (state.currentNotebookFileId) {
    await mountNotebook(notebookContainer, state.currentNotebookFileId, state);
    showNotebook();
  } else if (state.currentPdfFileId) {
    const { mountPdf } = await import("./pdf/pdf-bridge.js");
    await mountPdf(pdfContainer, state.currentPdfFileId, state);
    showPdf();
  } else if (state.currentStackFileId) {
    const { mountStack } = await import("./stack/stack-bridge.js");
    await mountStack(stackContainer, state.currentStackFileId, state);
    showStack();
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
  if (state.runtime.pendingScrollPosition != null && state.editor) {
    requestAnimationFrame(() => {
      state.editor.view.scrollDOM.scrollTop = state.runtime.pendingScrollPosition;
      state.runtime.pendingScrollPosition = null;
    });
  }

  installActivationFocus(state, notebookContainer);

  // Track CMD held state on the body so the column resizers (and any
  // future modifier-gated affordance) can reveal themselves only while
  // the user is intentionally reaching for them.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey) document.body.classList.add("cmd-held");
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Meta" || e.key === "Control" || (!e.metaKey && !e.ctrlKey)) {
      document.body.classList.remove("cmd-held");
    }
  });
  window.addEventListener("blur", () => document.body.classList.remove("cmd-held"));

  // Window-level keyboard shortcut fallback (for when focus is outside editor)
  const windowCommands = buildEditorCommands();
  installWindowShortcuts(state, windowCommands);

  // Sidebar toggle (left panel) — single Files panel now.
  state.on("toggle-left-panel", () => {
    const po = document.getElementById("panel-overlay");
    if (!po) return;
    if (!po.classList.contains("hidden")) {
      state.emit("hide-panel");
    } else {
      state.emit("show-files-panel");
    }
  });

  state.on("toggle-outline-panel", async () => {
    // Stack mode: toggle the active item's sidebar
    if (state.currentStackFileId) {
      import("./stack/stack-bridge.js").then(async ({ getStackInstance }) => {
        const inst = getStackInstance(); const a = inst?.getActiveItem(); if (!a) return;
        const ld = inst._liveColumns.get(a.id);
        if (a.fileType === "notebook" && ld?.canvas) { const g = ld.canvas.container?.querySelector(".notebook-shelf button"); if (g) g.click(); }
        else if (a.fileType === "pdf" && ld?.pdfViewer?.toggleShelf) ld.pdfViewer.toggleShelf();
        else if ((a.fileType === "document" || a.fileType === "project") && ld?.editor?.view) {
          const col = document.querySelector(`.stack-column[data-item-id="${a.id}"] .stack-column-content`);
          if (col) { const { toggleStackDocOutline } = await import("./stack/stack-doc-outline.js"); toggleStackDocOutline(col, ld.editor.view); }
        }
      });
      return;
    }
    if (state.currentPdfFileId) { state.emit("pdf-toggle-shelf"); return; }
    if (state.currentNotebookFileId) { state.emit("notebook-toggle-shelf"); return; }
    const rp = document.getElementById("right-panel-overlay");
    if (!rp) return;
    if (rp.classList.contains("hidden")) state.emit("show-outline");
    else state.emit("hide-outline");
  });

  // Initial focus
  editor.focus();

  createSidebar(state);
  setupFileDrop(state);
  initZenFocus(state);
  // Listing view shown when 2+ docs are multi-selected in the sidebar.
  import("./multi-select-view.js").then(({ initMultiSelectView }) => initMultiSelectView(state));
  // Initialize floating pane system (includes global click-outside-to-deactivate)
  initPaneManager(state);

  // iOS-only on-screen Cmd button (gated by `showCmdButton` setting); plus pencil bridge on iOS Tauri.
  initCmdButton(state);
  initCmdHeldSliders(state);
  if (IS_TAURI) import("./notebook/pencil-bridge.js").then((m) => m.initPencilBridge?.(state)).catch(() => {});

  // Local Sync watcher — refresh the files panel when mounted folders
  // change on disk, and reload the open file if it was the one that
  // changed.
  if (IS_TAURI) {
    const { startLocalSyncWatcher } = await import("./sync/local-sync.js");
    startLocalSyncWatcher(state, async () => {
      try { (await import("./sidebar/files-panel-local-sync.js")).invalidateLocalSyncCache(); } catch (_) {}
      try { (await import("./sidebar/files-panel.js")).refreshFilesPanel(state); }
      catch (e) { console.warn("Failed to refresh files panel after local-sync change:", e); }
    }).catch((e) => console.warn("Failed to start local-sync watcher:", e));

    // Settings window fires this after add/remove. We update
    // state.settings.localSyncFolders directly from the payload (no
    // round-trip through get_settings) and then refresh the files panel
    // so the sidebar reflects the change immediately.
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen("local-sync-folders-updated", async (event) => {
        const payload = event?.payload;
        if (payload && Array.isArray(payload.folders)) {
          state.settings.localSyncFolders = payload.folders;
        } else {
          // Fallback — older settings window builds don't include the
          // payload, so pull fresh settings as a safety net.
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const fresh = await invoke("get_settings");
            if (fresh) Object.assign(state.settings, fresh);
          } catch (_) {}
        }
        try {
          const { refreshFilesPanel } = await import("./sidebar/files-panel.js");
          refreshFilesPanel(state);
        } catch (e) {
          console.error("Failed to refresh files panel:", e);
        }
      });
    } catch (e) {
      console.error("Failed to listen for local-sync-folders-updated:", e);
    }
  }

  // Sync notebook left inset when the sidebar opens / closes — grip strip stays visible even when the panel body is collapsed.
  function syncNotebookInset() {
    if (!state.currentNotebookFileId) return;
    const po = document.getElementById("panel-overlay");
    const panelOpen = po && !po.classList.contains("hidden");
    const panelW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    const gripW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-grip-width"), 10) || 24;
    setNotebookLeftInset(panelOpen ? panelW : gripW);
  }
  function syncStackInset() {
    if (!state.currentStackFileId) return;
    const po = document.getElementById("panel-overlay");
    const open = po && !po.classList.contains("hidden") && po.classList.contains("panel-inset");
    const cs = getComputedStyle(document.documentElement);
    const sb = open ? (parseInt(cs.getPropertyValue("--panel-width"), 10) || 300) : 0;
    const de = parseInt(cs.getPropertyValue("--pane-dock-left-edge"), 10) || 0;
    stackContainer.style.left = Math.max(sb, de) + "px";
  }
  const panelObs = new MutationObserver(() => { syncNotebookInset(); syncStackInset(); });
  panelObs.observe(document.getElementById("panel-overlay"), { attributes: true, attributeFilter: ["class"] });
  state.on("stack-open", syncStackInset);
  document.addEventListener("pane-dock-changed", syncStackInset);

  // Panel inset mode — wide viewports inset the sidebar alongside the editor; narrow ones overlay with pin + click-outside.
  const panelOverlay = document.getElementById("panel-overlay");
  const OVERLAY_BREAKPOINT = 700;
  function updatePanelMode() {
    const w = window.innerWidth;
    if (w > OVERLAY_BREAKPOINT) {
      panelOverlay.classList.add("panel-inset");
      panelOverlay.classList.remove("panel-overlay-mode");
      document.body.classList.add("wide-viewport");
    } else {
      panelOverlay.classList.remove("panel-inset");
      panelOverlay.classList.add("panel-overlay-mode");
      document.body.classList.remove("wide-viewport");
    }
  }
  updatePanelMode();
  window.addEventListener("resize", updatePanelMode);
  state.on("settings-changed", updatePanelMode);

  // Re-apply column layout (makeSpaceForPanes etc.) + keep CSS vars in sync.
  state.on("settings-changed", () => { if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler(); applyFocusModeOpacity(state); });

  // Mirror the "Show Tooltips" setting into the global tooltip helper so
  // every gated [data-tooltip] element gets / loses its native title attr.
  setTooltipsEnabled(!!state.settings.showTooltips);
  state.on("settings-changed", () => setTooltipsEnabled(!!state.settings.showTooltips));

  // The full-height .sidebar-grip on the panel's right edge is the sole
  // open/close affordance now — the left-edge hover trigger and the
  // floating circular toggle are both gone.
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
  import("./traffic-lights.js").then(m => m.setupTrafficLightsHoverReveal()).catch(() => {});
  // Multi-window: register with the Rust registry + listen for sibling mutations.
  await setupMultiWindow(state);

  // Apply initial always-on-top setting
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    if (state.settings.alwaysOnTop) {
      await invoke("set_always_on_top", { onTop: true })
        .catch((e) => console.warn("set_always_on_top failed:", e));
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
      // Preserve this window's per-window session keys — the settings
      // window's saved payload carries whichever lastFileId it picked
      // up at open time (typically main's), and merging it blindly
      // would yank a secondary window's view back to main's file.
      const keepPerWindow = state.isSecondaryWindow ? {
        lastFileId: state.settings.lastFileId,
        lastNotebookId: state.settings.lastNotebookId,
        lastProjectId: state.settings.lastProjectId,
        scrollPosition: state.settings.scrollPosition,
        typewriterMode: state.settings.typewriterMode,
        dryMode: state.settings.dryMode,
      } : {};
      Object.assign(state.settings, newSettings, keepPerWindow);

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
      await invoke("set_activation_policy", { policy })
        .catch((e) => console.warn("set_activation_policy failed:", e));
      // Apply always-on-top setting
      await invoke("set_always_on_top", { onTop: !!state.settings.alwaysOnTop })
        .catch((e) => console.warn("set_always_on_top failed:", e));
      state.emit("settings-changed");
      state.emit("theme-changed");
      updatePrivateBoxColor(state);
    });

    // Sync event listeners (dropbox-sync-start/stop, clear, force,
    // retry) live in sync/sync-event-bindings.js to keep this file
    // under the 700-line build cap.
    try {
      const { wireSyncEventBindings } = await import("./sync/sync-event-bindings.js");
      await wireSyncEventBindings(state);
    } catch (e) { console.error("sync event bindings failed:", e); }

    // Dropbox OAuth callback (deep link). Google uses a loopback HTTP
    // listener (see commands/google_docs.rs) instead — its code arrives
    // via the same `oauth-callback` event below, no deep-link needed.
    // iOS fires both paths for the same code; the second `handleOAuthCode`
    // sees "code already used" and we swallow that rather than bubble up.
    try {
      const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      await onOpenUrl(async (urls) => {
        for (const url of urls) {
          if (!url.startsWith("hushwriter://auth/callback")) continue;
          const code = new URLSearchParams(url.split("?")[1] || "").get("code");
          if (code) {
            try { await handleOAuthCode(state, invoke, code, "dropbox"); } catch (e) { console.warn("OAuth deep-link completion failed:", e); }
          }
        }
      });
    } catch (e) { console.error("Deep-link setup failed:", e); }

    // Also listen for oauth-callback event (from Rust deep-link handler).
    await listen("oauth-callback", async (event) => {
      const { code, provider } = event.payload || {};
      if (code) { try { await handleOAuthCode(state, invoke, code, provider || "dropbox"); } catch (e) { console.warn("OAuth event completion failed:", e); } }
    });
  }

  // Auto-apply locked style when opening a document, or revert to global style
  state.on("file-opened", () => {
    if (!state.currentFileId || !state.fileTree) return;
    const lockedId = findNodeByFileId(state.fileTree, state.currentFileId)?.lockedStyleId || null;
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
      // No lock — revert to the active desk's saved style (per-desk via
      // desksMeta in `.hush/desks.json`).
      applyDeskGlobalStyle(state);
    }
  });

  // Switching desks repaints the editor with the new desk's saved
  // style and lands the user on whatever they last had open there —
  // without the file-open the editor would keep showing the previous
  // desk's file, which reads as a glitch ("did the switch even happen?").
  state.on("active-desk-changed", async (deskId) => {
    const node = state.currentFileId ? findNodeByFileId(state.fileTree, state.currentFileId) : null;
    if (!node?.lockedStyleId) applyDeskGlobalStyle(state);
    await (await import("./state/state-desks-ops.js")).openLastFileForDesk(state, deskId || state.settings.activeDeskId);
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
    if (overrides.selection) document.documentElement.style.setProperty("--selection", overrides.selection);
    else document.documentElement.style.removeProperty("--selection");
    // Notebook canvas derives its theme/font/bg from the active style.
    if (state.currentNotebookFileId) previewNotebookStyle(state, styleObj.id);
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
    applyActiveStyle(state);
    if (state.currentNotebookFileId) applyNotebookSettings(state);
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
  // The matchMedia "change" event covers the foreground case, but iOS /
  // iPadOS WKWebView frequently doesn't fire it while Hush is backgrounded.
  // Re-checking on visibility/focus catches the missed transition so the
  // user doesn't have to restart the app to pick up the new appearance.
  let _lastSystemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  function refreshAutoAppearance() {
    if (state.settings.appearance !== "auto") return;
    const nowDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    _lastSystemDark = nowDark;
    applyAppearance("auto");
    if (state.settings.activeStyleId) applyActiveStyle(state);
    updatePrivateBoxColor(state);
    state.emit("theme-changed");
    syncNotebookIfActive();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshAutoAppearance);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (state.settings.appearance !== "auto") return;
    const nowDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (nowDark !== _lastSystemDark) refreshAutoAppearance();
  });
  window.addEventListener("focus", () => {
    if (state.settings.appearance !== "auto") return;
    const nowDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (nowDark !== _lastSystemDark) refreshAutoAppearance();
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
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") maybeReconcile(); });
  }
}

init().catch(console.error);
