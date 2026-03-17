/**
 * Settings window — runs in a separate Tauri WebviewWindow.
 * Communicates with main window via Tauri events.
 */
import { themeList } from "./themes.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let settings = {};

async function init() {
  // Load settings from backend
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    settings = await invoke("get_settings");
  } else {
    const saved = localStorage.getItem("hush_settings");
    if (saved) settings = JSON.parse(saved);
  }

  // Apply appearance for this window
  const appearance = settings.appearance || "dark";
  const theme = appearance === "auto"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : appearance;
  document.documentElement.setAttribute("data-theme", theme);

  render();
}

function render() {
  const s = settings;
  const lightThemes = themeList.filter((t) => t.type === "light");
  const darkThemes = themeList.filter((t) => t.type === "dark");

  document.getElementById("settings-root").innerHTML = `
    <div class="settings-container">
      <div class="settings-header">
        <h1>Settings</h1>
      </div>

      <div class="settings-section">
        <h2>General</h2>
        <h3>Visibility</h3>
        <div class="settings-row">
          <label>App visibility</label>
          <select id="setting-visibility">
            <option value="menubar" ${s.visibility === "menubar" ? "selected" : ""}>Show only menu bar</option>
            <option value="dock" ${s.visibility === "dock" ? "selected" : ""}>Show dock icon</option>
            <option value="both" ${s.visibility === "both" ? "selected" : ""}>Show both</option>
          </select>
        </div>
        <div class="settings-row">
          <label>Show app above all other windows</label>
          <input type="checkbox" id="setting-always-on-top" ${s.alwaysOnTop ? "checked" : ""} />
        </div>
      </div>

      <div class="settings-section">
        <h2>Editor</h2>
        <h3>Appearance</h3>
        <div class="settings-row">
          <label>Color scheme</label>
          <select id="setting-appearance">
            <option value="light" ${s.appearance === "light" ? "selected" : ""}>Light</option>
            <option value="dark" ${s.appearance === "dark" ? "selected" : ""}>Dark</option>
            <option value="auto" ${s.appearance === "auto" ? "selected" : ""}>Automatic</option>
          </select>
        </div>

        <h3>Themes</h3>
        <div class="settings-row">
          <label>Default light theme</label>
          <select id="setting-light-theme">
            ${lightThemes.map((t) => `<option value="${t.id}" ${s.lightTheme === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
          </select>
        </div>
        <div class="settings-row">
          <label>Default dark theme</label>
          <select id="setting-dark-theme">
            ${darkThemes.map((t) => `<option value="${t.id}" ${s.darkTheme === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
          </select>
        </div>

        <h3>Font</h3>
        <div class="settings-row">
          <label>Font family</label>
          <select id="setting-font-family">
            <option value="EB Garamond" ${s.fontFamily === "EB Garamond" ? "selected" : ""} style="font-family: 'EB Garamond', serif">EB Garamond</option>
            <option value="Inter" ${s.fontFamily === "Inter" ? "selected" : ""} style="font-family: 'Inter', sans-serif">Inter</option>
            <option value="Fira Code" ${s.fontFamily === "Fira Code" ? "selected" : ""} style="font-family: 'Fira Code', monospace">Fira Code</option>
          </select>
        </div>

        <h3>Text</h3>
        <div class="settings-slider-row">
          <label>Font size</label>
          <div class="slider-group">
            <input type="range" id="setting-font-size" min="12" max="36" step="1" value="${s.fontSize || 20}" />
            <span class="slider-value">${s.fontSize || 20}px</span>
          </div>
        </div>
        <div class="settings-slider-row">
          <label>Line height</label>
          <div class="slider-group">
            <input type="range" id="setting-line-height" min="1.0" max="2.5" step="0.1" value="${s.lineHeight || 1.6}" />
            <span class="slider-value">${s.lineHeight || 1.6}</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>Shortcuts</h2>
        <div class="settings-row">
          <label>Toggle editor</label>
          <div class="shortcut-display">
            ${renderShortcutKeys(s.shortcutOpenEditor)}
            <button class="shortcut-clear" data-shortcut="shortcutOpenEditor" title="Change shortcut">&times;</button>
          </div>
        </div>
        <div class="settings-row">
          <label>Open fullscreen</label>
          <div class="shortcut-display">
            ${renderShortcutKeys(s.shortcutOpenFullscreen)}
            <button class="shortcut-clear" data-shortcut="shortcutOpenFullscreen" title="Change shortcut">&times;</button>
          </div>
        </div>
        <div class="settings-row">
          <label>Toggle private mode</label>
          <div class="shortcut-display">
            ${renderShortcutKeys(s.shortcutTogglePrivate)}
            <button class="shortcut-clear" data-shortcut="shortcutTogglePrivate" title="Change shortcut">&times;</button>
          </div>
        </div>
      </div>
    </div>
  `;

  bind();
}

function renderShortcutKeys(shortcut) {
  if (!shortcut) return `<span class="shortcut-keys"><kbd>None</kbd></span>`;
  const parts = shortcut.split("+").map((p) => {
    const display = p
      .replace("CmdOrCtrl", navigator.platform.includes("Mac") ? "\u2318" : "Ctrl")
      .replace("Shift", "\u21E7")
      .replace("Alt", navigator.platform.includes("Mac") ? "\u2325" : "Alt");
    return `<kbd>${display}</kbd>`;
  });
  return `<span class="shortcut-keys">${parts.join("")}</span>`;
}

function bind() {
  bindSelect("setting-visibility", "visibility");
  bindSelect("setting-appearance", "appearance");
  bindSelect("setting-light-theme", "lightTheme");
  bindSelect("setting-dark-theme", "darkTheme");
  bindSelect("setting-font-family", "fontFamily");

  const alwaysOnTopCb = document.getElementById("setting-always-on-top");
  if (alwaysOnTopCb) {
    alwaysOnTopCb.addEventListener("change", () => {
      saveSetting("alwaysOnTop", alwaysOnTopCb.checked);
    });
  }

  const fontSlider = document.getElementById("setting-font-size");
  if (fontSlider) {
    fontSlider.addEventListener("input", () => {
      const val = parseFloat(fontSlider.value);
      fontSlider.nextElementSibling.textContent = val + "px";
      saveSetting("fontSize", val);
    });
  }

  const lineSlider = document.getElementById("setting-line-height");
  if (lineSlider) {
    lineSlider.addEventListener("input", () => {
      const val = parseFloat(lineSlider.value);
      lineSlider.nextElementSibling.textContent = val;
      saveSetting("lineHeight", val);
    });
  }

  // Shortcut clear/record buttons
  document.querySelectorAll(".shortcut-clear").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.shortcut;
      startShortcutRecording(btn, key);
    });
  });
}

function bindSelect(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    saveSetting(key, el.value);
  });
}

async function saveSetting(key, value) {
  settings[key] = value;
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_settings", { settings });
    // Notify main window
    const { emit } = await import("@tauri-apps/api/event");
    await emit("settings-updated", settings);
  } else {
    localStorage.setItem("hush_settings", JSON.stringify(settings));
  }
}

function startShortcutRecording(btn, settingKey) {
  const display = btn.previousElementSibling;
  display.innerHTML = "";
  display.classList.add("recording");

  function onKeyDown(e) {
    e.preventDefault();
    e.stopPropagation();

    // Ignore lone modifier keys
    if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;

    // Escape cancels
    if (e.key === "Escape") {
      cleanup();
      render();
      return;
    }

    // Build shortcut string
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);

    const shortcut = parts.join("+");
    cleanup();
    saveSetting(settingKey, shortcut);
    render();
  }

  function cleanup() {
    document.removeEventListener("keydown", onKeyDown, true);
    display.classList.remove("recording");
  }

  document.addEventListener("keydown", onKeyDown, true);
}

init().catch(console.error);
