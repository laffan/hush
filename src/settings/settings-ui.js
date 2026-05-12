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

export async function openSettingsWindow(state) {
  if (isIOS()) {
    openSettingsModal(state);
    return;
  }

  if (IS_TAURI) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow("settings", {
      url: "/settings.html",
      title: "Hush Settings",
      width: 640,
      height: 580,
      resizable: true,
      center: true,
      decorations: true,
    });
  } else {
    window.open("/settings.html", "_blank");
  }
}

async function openSettingsModal(state) {
  // If already open, focus it
  if (settingsModal) {
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
  const { initSettingsInto } = await import("./settings-window.js");
  const root = modal.querySelector(".settings-modal-root");

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
