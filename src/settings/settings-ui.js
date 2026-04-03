/**
 * Settings helpers — opens settings in a separate native window (desktop)
 * or as a modal overlay (iOS/iPadOS).
 */
import settingsCssUrl from "./settings-window.css?url";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** Detect iOS/iPadOS (includes iPad reporting as "MacIntel" with touch) */
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
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
    settingsModal.remove();
    settingsModal = null;
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

  // Close button
  modal.querySelector(".settings-modal-close").addEventListener("click", () => {
    modal.remove();
    settingsModal = null;
  });

  // Close on backdrop click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.remove();
      settingsModal = null;
    }
  });

  // Render settings into the modal root
  const { initSettingsInto } = await import("./settings-window.js");
  const root = modal.querySelector(".settings-modal-root");

  await initSettingsInto(root, (newSettings) => {
    // Directly apply settings to state (same window, no cross-window emit)
    if (state) {
      Object.assign(state.settings, newSettings);
      state.emit("settings-changed");
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
