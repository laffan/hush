/**
 * Settings helpers — opens settings in a separate native window (desktop)
 * or as a modal overlay (iOS/iPadOS).
 */
import settingsCssUrl from "./settings-window.css?url";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** Detect iOS/iPadOS (includes iPad reporting as "MacIntel" with touch).
 *  Threshold lowered to `maxTouchPoints > 0` — some WKWebView versions
 *  on iPad expose only 1 touch point even though the device handles
 *  multi-touch fine. */
export function isIOS() {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const platform = navigator.platform || "";
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(platform) && tp > 0;
}

/** Detect a phone-sized screen — iPhone explicitly, or any iOS device with
 *  a short viewport. iPads in portrait sit around 810 px on the short
 *  axis; iPhones max out around 430 px. The 600 px threshold sits well
 *  between the two and only activates the phone-only layout adjustments
 *  for the narrow form factor — iPads keep their existing chrome. */
export function isPhone() {
  if (/iPhone|iPod/.test(navigator.userAgent || "")) return true;
  if (!isIOS()) return false;
  return Math.min(window.innerWidth, window.innerHeight) < 600;
}

let settingsModal = null;

/** Serialise a {tab, subTab} request into the URL-hash form the settings
 *  window reads on init (`#tab` or `#tab/subTab`). Returns "" when no
 *  tab is requested so callers can land on the default landing tab. */
function tabHash(opts) {
  const tab = opts?.tab;
  if (!tab) return "";
  const sub = opts?.subTab;
  let hash = sub ? `#${tab}/${sub}` : `#${tab}`;
  // Carry a Shortcuts-tab search query so a deep-link can land on a
  // single shortcut (used by the Show Shortcuts modal's Edit button).
  if (opts?.shortcutSearch) hash += `?q=${encodeURIComponent(opts.shortcutSearch)}`;
  return hash;
}

export async function openSettingsWindow(state, opts) {
  if (isIOS()) {
    openSettingsModal(state, opts);
    return;
  }

  const hash = tabHash(opts);

  if (IS_TAURI) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      await existing.setFocus();
      if (opts?.tab) {
        // Re-route the open window to the requested tab without forcing
        // a reload, so any in-progress edits the user has on screen
        // (e.g. an unsaved shortcut rebind) aren't lost.
        const { emit } = await import("@tauri-apps/api/event");
        await emit("settings-goto-tab", { tab: opts.tab, subTab: opts.subTab || null, shortcutSearch: opts.shortcutSearch || null });
      }
      return;
    }
    new WebviewWindow("settings", {
      url: "/settings.html" + hash,
      title: "Hush Settings",
      width: 640,
      height: 580,
      resizable: true,
      center: true,
      decorations: true,
    });
  } else {
    window.open("/settings.html" + hash, "_blank");
  }
}

async function openSettingsModal(state, opts) {
  // If already open and a specific tab was requested, switch to it
  // in-place rather than toggling the modal closed. With no tab arg
  // the icon behaves as a toggle (matches the prior open-on-click,
  // close-on-second-click sidebar Settings button).
  if (settingsModal) {
    if (opts?.tab) {
      const { setActiveTab } = await import("./settings-window.js");
      setActiveTab(opts.tab, opts.subTab || null, opts.shortcutSearch || null);
      return;
    }
    closeSettingsModal();
    return;
  }

  // Load settings-window CSS if not already loaded
  if (!document.getElementById("settings-modal-css")) {
    const link = document.createElement("link");
    link.id = "settings-modal-css";
    link.rel = "stylesheet";
    link.href = settingsCssUrl;
    document.head.appendChild(link);
  }

  // Create modal overlay
  const modal = document.createElement("div");
  modal.className = "settings-modal-backdrop";
  modal.innerHTML = `
    <div class="settings-modal">
      <button class="settings-modal-close">\u00d7</button>
      <div class="settings-modal-root"></div>
    </div>
  `;
  document.body.appendChild(modal);
  settingsModal = modal;

  // Block keyboard / pointer routing into the editor while the modal is
  // up. Without this, hardware-keyboard typing on iPad reaches the
  // CodeMirror editor that's still focused beneath the backdrop.
  const appRoot = document.getElementById("app");
  if (appRoot) appRoot.setAttribute("inert", "");
  if (state?.editor?.view?.contentDOM) {
    try { state.editor.view.contentDOM.blur(); } catch (_) {}
  }
  if (document.activeElement instanceof HTMLElement) {
    try { document.activeElement.blur(); } catch (_) {}
  }

  function closeSettingsModal() {
    if (!settingsModal) return;
    settingsModal.remove();
    settingsModal = null;
    if (appRoot) appRoot.removeAttribute("inert");
  }

  // Close button
  modal.querySelector(".settings-modal-close").addEventListener("click", closeSettingsModal);

  // Close on backdrop click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeSettingsModal();
  });

  // Render settings into the modal root
  const { initSettingsInto, setActiveTab } = await import("./settings-window.js");
  const root = modal.querySelector(".settings-modal-root");
  if (opts?.tab) setActiveTab(opts.tab, opts.subTab || null, opts.shortcutSearch || null);

  await initSettingsInto(root, (newSettings) => {
    // Directly apply settings to state (same window, no cross-window emit).
    // The desktop path runs through Tauri's "settings-updated" listener in
    // main.js which calls applyActiveStyle() before emitting; on iPad we
    // never go through that listener, so emit "style-changed" too — its
    // handler is the one that re-runs applyActiveStyle and refreshes the
    // CSS vars (--bg, --fg, --cursor, etc.) the pane chrome reads.
    if (state) {
      Object.assign(state.settings, newSettings);
      state.emit("settings-changed");
      state.emit("style-changed");
      state.emit("theme-changed");
    }
  });
}

export function applyAppearance(appearance) {
  let theme;
  if (appearance === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } else {
    theme = appearance;
  }
  document.documentElement.setAttribute("data-theme", theme);
}
