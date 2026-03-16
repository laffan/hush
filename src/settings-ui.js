/**
 * Settings window UI
 */
import { themeList } from "./themes.js";

export function createSettingsUI(container, state) {
  function render() {
    const s = state.settings;
    const lightThemes = themeList.filter((t) => t.type === "light");
    const darkThemes = themeList.filter((t) => t.type === "dark");

    container.innerHTML = `
      <div class="settings-container">
        <div class="settings-header">
          <h1>Settings</h1>
          <button class="settings-close" id="settings-close-btn">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
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

          <h3>Text</h3>
          <div class="settings-slider-row">
            <label>Font size</label>
            <div class="slider-group">
              <input type="range" id="setting-font-size" min="12" max="36" step="1" value="${s.fontSize}" />
              <span class="slider-value">${s.fontSize}px</span>
            </div>
          </div>
          <div class="settings-slider-row">
            <label>Line height</label>
            <div class="slider-group">
              <input type="range" id="setting-line-height" min="1.0" max="2.5" step="0.1" value="${s.lineHeight}" />
              <span class="slider-value">${s.lineHeight}</span>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h2>Shortcuts</h2>
          <div class="settings-row">
            <label>Open</label>
            <input type="text" id="setting-shortcut-open" value="${s.shortcutOpenEditor}" />
          </div>
          <div class="settings-row">
            <label>Open fullscreen</label>
            <input type="text" id="setting-shortcut-fullscreen" value="${s.shortcutOpenFullscreen}" />
          </div>
          <div class="settings-row">
            <label>Toggle private mode</label>
            <input type="text" id="setting-shortcut-private" value="${s.shortcutTogglePrivate}" />
          </div>
        </div>
      </div>
    `;

    bind();
  }

  function bind() {
    container.querySelector("#settings-close-btn").addEventListener("click", () => {
      container.classList.remove("open");
    });

    bindSelect("setting-visibility", "visibility");
    bindSelect("setting-appearance", "appearance", (val) => {
      applyAppearance(val, state);
    });
    bindSelect("setting-light-theme", "lightTheme", () => {
      state.emit("theme-changed");
    });
    bindSelect("setting-dark-theme", "darkTheme", () => {
      state.emit("theme-changed");
    });

    bindSlider("setting-font-size", "fontSize", (val) => {
      document.documentElement.style.setProperty("--font-size", val + "px");
      container.querySelector("#setting-font-size").nextElementSibling.textContent = val + "px";
    });
    bindSlider("setting-line-height", "lineHeight", (val) => {
      document.documentElement.style.setProperty("--line-height", val);
      container.querySelector("#setting-line-height").nextElementSibling.textContent = val;
    });

    bindInput("setting-shortcut-open", "shortcutOpenEditor");
    bindInput("setting-shortcut-fullscreen", "shortcutOpenFullscreen");
    bindInput("setting-shortcut-private", "shortcutTogglePrivate");
  }

  function bindSelect(id, key, onChange) {
    const el = container.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener("change", () => {
      state.updateSettings({ [key]: el.value });
      if (onChange) onChange(el.value);
    });
  }

  function bindSlider(id, key, onChange) {
    const el = container.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener("input", () => {
      const val = parseFloat(el.value);
      state.updateSettings({ [key]: val });
      if (onChange) onChange(val);
    });
  }

  function bindInput(id, key) {
    const el = container.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener("change", () => {
      state.updateSettings({ [key]: el.value });
    });
  }

  render();

  return {
    open() {
      render();
      container.classList.add("open");
    },
    close() {
      container.classList.remove("open");
    },
  };
}

export function applyAppearance(appearance, state) {
  let theme;
  if (appearance === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } else {
    theme = appearance;
  }
  document.documentElement.setAttribute("data-theme", theme);
}
