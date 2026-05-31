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
import { fontFallbacks, themeBackgrounds, themeForegrounds, hexLuminance, updatePrivateBoxColor, applyFontFamily } from "./theme-colors.js";
import { applyNotebookSettings, previewNotebookStyle, setNotebookLeftInset } from "./notebook/notebook-bridge.js";
import { setupModeSwitching } from "./main-modes.js";
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

  // Drop any bundled style presets the user hasn't seen yet into the
  // styles list so they show up as normal entries in the rail. Each
  // preset is tracked by filename so deleting one keeps it gone.
  try {
    const { seedStylePresets } = await import("./sidebar/style-presets.js");
    await seedStylePresets(state);
  } catch (e) { console.warn("seedStylePresets failed:", e); }

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
  const stackContainer = document.getElementById("stack-container");
  const editor = createEditor(editorContainer, state);
  state.setEditor(editor);

  // "In the trash" banner — pinned above the editor whenever the active
  // file is a doc that lives in a Trash folder. Pairs with the editor's
  // setReadOnly() lock so trashed content can be read but not edited
  // (autosave would otherwise quietly write changes into a file the
  // user has already chosen to throw away). Restore (Remove from trash)
  // or Permanently Delete actions live on the sidebar row's menu.
  const trashBanner = document.createElement("div");
  trashBanner.id = "trash-banner";
  trashBanner.className = "trash-banner hidden";
  trashBanner.textContent = "In the Trash — read only";
  editorContainer.parentElement?.insertBefore(trashBanner, editorContainer);

  async function syncTrashLock() {
    if (!state.editor) return;
    const fileId = state.currentNotebookFileId || state.currentFileId;
    let inTrash = false;
    if (fileId) {
      const { findNodeByFileId } = await import("./state/tree-helpers.js");
      const node = findNodeByFileId(state.fileTree, fileId);
      if (node && state.isInTrash(node.id)) inTrash = true;
    }
    // Only the doc editor carries the readOnly compartment; the notebook
    // canvas gates input via the body-level class instead.
    state.editor.setReadOnly(inTrash && !state.currentNotebookFileId);
    trashBanner.classList.toggle("hidden", !inTrash);
    document.body.classList.toggle("file-in-trash", inTrash);
  }
  state.on("file-opened", syncTrashLock);
  state.on("notebook-open", syncTrashLock);
  state.on("notebook-unmount", syncTrashLock);
  // Restore / Permanently Delete fire `files-changed` after the move —
  // re-evaluate so a file restored back into the inbox loses the banner
  // without needing to be re-opened.
  state.on("files-changed", syncTrashLock);
  syncTrashLock();

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
  await setupModeSwitching(state);

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
  // Multi-window registry + sibling-mutation listeners (desktop + native
  // iPad multi-window). Cross-window live sync rides this.
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
      const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
      const handleUrl = async (url) => {
        if (url.startsWith("hushwriter://auth/callback")) {
          const code = new URLSearchParams(url.split("?")[1] || "").get("code");
          if (code) {
            try { await handleOAuthCode(state, invoke, code, "dropbox"); } catch (e) { console.warn("OAuth deep-link completion failed:", e); }
          }
          return;
        }
        // iPadOS hands externally-opened .hushnote / .hushstack / .md
        // files to the app as file:// URLs (cold launch surfaces
        // through getCurrent(); already-running launches through
        // onOpenUrl).
        if (url.startsWith("file://") || url.startsWith("/")) {
          try {
            const { importExternalFile } = await import("./editor/external-open.js");
            await importExternalFile(state, url);
          } catch (e) {
            console.warn("External file open failed:", e);
            try {
              const { showImportToast } = await import("./editor/import-toast.js");
              showImportToast(`Couldn't open ${url.split("/").pop()}: ${e?.message || e}`, "error");
            } catch (_) {}
          }
        }
      };
      // Cold launch: the OS hands the URL to the process before any JS
      // listener exists; getCurrent() returns those pending URLs so we
      // don't drop the open-with payload that woke the app.
      try {
        const launchUrls = await getCurrent();
        if (Array.isArray(launchUrls)) {
          for (const url of launchUrls) await handleUrl(url);
        }
      } catch (e) { console.warn("Deep-link getCurrent failed:", e); }
      await onOpenUrl(async (urls) => {
        for (const url of urls) await handleUrl(url);
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
    const previewFg = overrides.fg || themeForegrounds[styleObj.themeId] || null;
    updatePrivateBoxColor(state, previewBg, previewFg);
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
    if (overrides.selection) document.documentElement.style.setProperty("--selection", overrides.selection); else document.documentElement.style.removeProperty("--selection");
    if (overrides.links) document.documentElement.style.setProperty("--link", overrides.links); else document.documentElement.style.removeProperty("--link");
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
