/**
 * Two-column style editor modal — settings left, live preview right.
 * Edits autosave on a short debounce; close = flush. Embeddable inside
 * a host element via `options.host` (used by the Edit Styles modal).
 */
import { themeList, getThemeById } from "../themes/index.js";
import {
  escAttr,
  escHtml,
  migrateStyle,
  resolveCursorMode,
  renderCursorOptions,
} from "./styles-panel-shared.js";
import { renderShaderSection, bindShaderSection, endShaderPreview } from "./style-modal-shader.js";
import { renderStyleExtras, bindStyleExtras } from "./style-modal-background.js";
import { applyActiveStyle } from "../style-application.js";
import { bindCustomDropdown } from "./custom-dropdown.js";
import {
  PREVIEW_MD,
  fontFallback,
  themeColorFor,
  seedColorsFromTheme,
  formatPreviewHtml,
  updatePreview as renderPreview,
} from "./style-modal-preview.js";

const lightThemes = themeList.filter(t => t.type === "light");
const darkThemes = themeList.filter(t => t.type === "dark");
const builtInFonts = ["Source Sans Pro", "Source Serif Pro", "Libre Franklin", "Libre Baskerville", "Karla", "Lora", "EB Garamond", "Inter", "Fira Code", "iA Writer Duo", "iA Writer Mono", "iA Writer Quattro"];
const systemFonts = [
  "Arial", "Avenir", "Avenir Next", "Baskerville", "Courier New",
  "Futura", "Garamond", "Georgia", "Gill Sans", "Helvetica",
  "Helvetica Neue", "Lucida Grande", "Menlo", "Monaco", "Optima",
  "Palatino", "SF Mono", "SF Pro", "Times New Roman", "Verdana",
];
const colorKeys = [
  { key: "bg", label: "Background" }, { key: "fg", label: "Text" },
  { key: "header", label: "Header" }, { key: "links", label: "Links" },
  { key: "cursor", label: "Cursor" }, { key: "selection", label: "Selection" },
  { key: "lineIndicator", label: "Line Indicator Color" },
];

/** Build a Style-shaped draft from global AppSettings — used when editing the Default style. */
function buildDefaultDraftFromSettings(state) {
  const s = state.settings;
  return {
    id: "__default__",
    name: "Default",
    fontFamily: s.fontFamily || null,
    fontSize: s.fontSize || null,
    lineHeight: s.lineHeight || null,
    lightThemeId: s.lightTheme || "ayuLight",
    darkThemeId: s.darkTheme || "dracula",
    lightColors: s.defaultLightColors ? { ...s.defaultLightColors } : {},
    darkColors: s.defaultDarkColors ? { ...s.defaultDarkColors } : {},
    suppressHeaderSize: !!s.normalizeHeaders,
    suppressHeaderColor: !!s.normalizeHeaderColor,
    underlineHeaders: !!s.underlineHeaders,
    headerScale: s.headerScale != null ? s.headerScale : 1.0,
    blockCursor: !!s.blockCursor,
    cursorMode: s.cursorMode || (s.blockCursor ? "block" : "system"),
    lineIndicator: s.lineIndicator || "none",
    // Default style's shader rides a top-level AppSettings field so
    // it persists alongside the other Default-only knobs.
    shaderLayer: s.shaderLayer ? { ...s.shaderLayer } : null,
  };
}

const LINE_INDICATOR_OPTIONS = [
  { value: "none", label: "None" },
  { value: "left-arrow", label: "Left Arrow" },
  { value: "double-arrow", label: "Double Arrow" },
  { value: "left-border", label: "Left Border" },
  { value: "border", label: "Border" },
  { value: "highlight", label: "Highlight" },
];

export function openStyleModal(state, existingStyle, onDone, options = {}) {
  // existingStyle === null → create a new user style
  // existingStyle === "__default__" → edit the Default (global settings)
  // options.host (optional) → render into this element instead of a fresh
  //   .style-modal-backdrop. The caller owns the close button and the
  //   surrounding chrome. Used by the three-column Edit Styles modal.
  const isDefault = existingStyle === "__default__";
  const isNew = !existingStyle;
  const draft = isDefault
    ? buildDefaultDraftFromSettings(state)
    : existingStyle
      ? JSON.parse(JSON.stringify(migrateStyle(existingStyle)))
      : {
          id: "", name: "", fontFamily: null, fontSize: null, lineHeight: null,
          lightThemeId: state.settings.lightTheme || "ayuLight",
          darkThemeId: state.settings.darkTheme || "dracula",
          lightColors: {}, darkColors: {},
        };

  // Pre-select the tab that matches the current appearance so editors
  // land on the colour set they're actually looking at. "auto" resolves
  // through the system preference, sepia falls back to light for tab
  // purposes.
  function resolveInitialColorTab() {
    const appearance = state.settings.appearance || "dark";
    if (appearance === "dark") return "dark";
    if (appearance === "light" || appearance === "sepia") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  let colorTab = resolveInitialColorTab();
  // Hover-preview overrides for the theme + font dropdowns — non-null
  // wins over the draft inside `updatePreview`, mirroring the Styles
  // sidebar's hover-preview. Cleared on render() and on dropdown close.
  let previewThemeId = null;
  let previewFontFamily = null; // "" = the "Default" entry; null = no hover

  // ── build the backdrop ───────────────────────────────────────────────────
  // Host mode lets a parent modal (the three-column Edit Styles shell)
  // render the editor body into its own pane instead of spawning a fresh
  // fullscreen backdrop. `ownsBackdrop` controls whether close() tears
  // the whole element down or just clears the contents.
  const ownsBackdrop = !options.host;
  const backdrop = options.host || document.createElement("div");
  if (ownsBackdrop) {
    backdrop.className = "style-modal-backdrop";
    document.body.appendChild(backdrop);
  }

  // ── autosave ────────────────────────────────────────────────────────────
  // Edits flush to settings on a short debounce — there are no Save /
  // Cancel buttons. New user styles materialise on the first edit
  // (using the typed name or "Untitled" as a placeholder) and become
  // ordinary updates from then on.
  let createdNewStyle = !isNew;
  let saveTimer = null;

  function applyDraftLive() {
    if (isDefault) {
      Object.assign(state.settings, {
        fontFamily: draft.fontFamily || state.settings.fontFamily,
        fontSize: draft.fontSize || state.settings.fontSize,
        lineHeight: draft.lineHeight || state.settings.lineHeight,
        lightTheme: draft.lightThemeId || state.settings.lightTheme,
        darkTheme: draft.darkThemeId || state.settings.darkTheme,
        defaultLightColors: draft.lightColors || {},
        defaultDarkColors: draft.darkColors || {},
        normalizeHeaders: !!draft.suppressHeaderSize,
        normalizeHeaderColor: !!draft.suppressHeaderColor,
        underlineHeaders: !!draft.underlineHeaders,
        headerScale: draft.headerScale != null ? draft.headerScale : 1.0,
        blockCursor: !!draft.blockCursor,
        cursorMode: draft.cursorMode || (draft.blockCursor ? "block" : "system"),
        lineIndicator: draft.lineIndicator || "none",
        shaderLayer: draft.shaderLayer || null,
      });
    } else {
      const name = (draft.name || "").trim() || "Untitled";
      draft.name = name;
      delete draft._migrated;
      if (!state.settings.styles) state.settings.styles = [];
      if (!createdNewStyle) {
        draft.id = "style_" + Date.now();
        state.settings.styles.push(draft);
        createdNewStyle = true;
      } else {
        const idx = state.settings.styles.findIndex(s => s.id === draft.id);
        if (idx >= 0) state.settings.styles[idx] = draft;
        else state.settings.styles.push(draft);
      }
    }
    // `style-changed` → applyActiveStyle repaints the editor; `settings-changed`
    // re-runs editor.js's listener so font-size / line-height / block-cursor
    // edits land live instead of only on re-selecting the style.
    state.emit("style-changed");
    state.emit("settings-changed");
  }

  function commitDraft() {
    applyDraftLive();
    if (isDefault) {
      state.updateSettings({
        fontFamily: state.settings.fontFamily,
        fontSize: state.settings.fontSize,
        lineHeight: state.settings.lineHeight,
        lightTheme: state.settings.lightTheme,
        darkTheme: state.settings.darkTheme,
        defaultLightColors: state.settings.defaultLightColors,
        defaultDarkColors: state.settings.defaultDarkColors,
        normalizeHeaders: state.settings.normalizeHeaders,
        normalizeHeaderColor: state.settings.normalizeHeaderColor,
        underlineHeaders: state.settings.underlineHeaders,
        headerScale: state.settings.headerScale,
        blockCursor: state.settings.blockCursor,
        cursorMode: state.settings.cursorMode,
        lineIndicator: state.settings.lineIndicator || "none",
        shaderLayer: state.settings.shaderLayer || null,
      });
    } else {
      state.updateSettings({ styles: state.settings.styles });
    }
    if (onDone) onDone();
  }

  function scheduleSave() {
    applyDraftLive();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; commitDraft(); }, 200);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; commitDraft(); }
  }

  function close() {
    flushSave();
    if (ownsBackdrop) backdrop.remove();
    else backdrop.innerHTML = "";
    // Drop any modal-driven shader preview, then re-apply the active
    // style so its shader (if any) takes the screen back.
    endShaderPreview(applyActiveStyle, state);
  }

  // Backdrop-click closes only when this function owns the backdrop —
  // a host-mode mount lives inside a parent modal that owns dismissal.
  if (ownsBackdrop) {
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  }

  function render() {
    previewThemeId = null;
    previewFontFamily = null;
    const prevSettingsScroll = backdrop.querySelector(".style-modal-settings")?.scrollTop ?? 0;
    const prevBodyScroll = backdrop.querySelector(".style-modal-body")?.scrollTop ?? 0;
    const selectedFont = draft.fontFamily || "";
    const selectedFontLabel = selectedFont || `Default (${state.settings.fontFamily || "EB Garamond"})`;
    const ltId = draft.lightThemeId || "";
    const dtId = draft.darkThemeId || "";
    const ltObj = getThemeById(ltId);
    const dtObj = getThemeById(dtId);
    const ltLabel = ltObj ? ltObj.name : "Select theme";
    const dtLabel = dtObj ? dtObj.name : "Select theme";

    const activeColors = colorTab === "light" ? (draft.lightColors || {}) : (draft.darkColors || {});

    const headerScale = draft.headerScale != null ? draft.headerScale : 1.0;
    const title = isDefault ? "Edit Default Style" : isNew ? "New Style" : "Edit Style";

    const nameSection = isDefault ? "" : `
      <div class="style-modal-section">
        <h3 class="style-modal-section-title">Name</h3>
        <div class="style-editor-row">
          <input type="text" id="style-name" value="${escAttr(draft.name)}" placeholder="Style name" />
        </div>
      </div>`;

    backdrop.innerHTML = `
      <div class="style-modal${ownsBackdrop ? "" : " in-host"}">
        ${ownsBackdrop ? '<button class="style-modal-close">&times;</button>' : ""}
        <div class="style-modal-body">

          <!-- LEFT: settings column -->
          <div class="style-modal-settings">
            <h2 class="style-modal-title">${title}</h2>

            ${nameSection}

            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Editing</h3>
              <div class="style-editor-row">
                <label>Font</label>
                <div class="custom-dropdown" id="style-font-dropdown" data-value="${escAttr(selectedFont)}">
                  <div class="custom-dropdown-selected" style="font-family: ${fontFallback(selectedFont || state.settings.fontFamily || "EB Garamond")};">${escHtml(selectedFontLabel)}</div>
                  <div class="custom-dropdown-options">
                    <div class="custom-dropdown-option${!selectedFont ? ' selected' : ''}" data-value="" style="font-family: ${fontFallback(state.settings.fontFamily || "EB Garamond")};">Default (${escHtml(state.settings.fontFamily || "EB Garamond")})</div>
                    <div class="custom-dropdown-group-label">Built-in</div>
                    ${builtInFonts.map(f => `<div class="custom-dropdown-option${draft.fontFamily === f ? ' selected' : ''}" data-value="${f}" style="font-family: ${fontFallback(f)};">${escHtml(f)}</div>`).join('')}
                    <div class="custom-dropdown-group-label">System</div>
                    ${systemFonts.map(f => `<div class="custom-dropdown-option${draft.fontFamily === f ? ' selected' : ''}" data-value="${f}" style="font-family: ${fontFallback(f)};">${escHtml(f)}</div>`).join('')}
                  </div>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Size</label>
                <div class="style-slider-group">
                  <input type="range" id="style-font-size" min="12" max="36" step="1" value="${draft.fontSize || state.settings.fontSize || 20}" />
                  <span class="style-slider-value">${draft.fontSize || state.settings.fontSize || 20}px</span>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Line height</label>
                <div class="style-slider-group">
                  <input type="range" id="style-line-height" min="1.0" max="2.5" step="0.1" value="${draft.lineHeight || state.settings.lineHeight || 1.6}" />
                  <span class="style-slider-value">${draft.lineHeight || state.settings.lineHeight || 1.6}</span>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Cursor</label>
                <div class="style-select-group">
                  <select id="style-cursor-mode" class="style-native-select">
                    ${renderCursorOptions(resolveCursorMode(draft, state.settings))}
                  </select>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Line Indicator</label>
                <div class="style-select-group">
                  <select id="style-line-indicator" class="style-native-select">
                    ${LINE_INDICATOR_OPTIONS.map(o => `<option value="${o.value}"${(draft.lineIndicator || "none") === o.value ? ' selected' : ''}>${o.label}</option>`).join("")}
                  </select>
                </div>
              </div>
            </div>

            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Headers</h3>
              <div class="style-editor-row">
                <label>Suppress color</label>
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-suppress-header-color" ${draft.suppressHeaderColor ? 'checked' : ''} />
                </div>
              </div>
              <div class="style-editor-row">
                <label>Suppress size</label>
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-suppress-header-size" ${draft.suppressHeaderSize ? 'checked' : ''} />
                </div>
              </div>
              <div class="style-editor-row">
                <label>Underline</label>
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-underline-headers" ${draft.underlineHeaders ? 'checked' : ''} />
                </div>
              </div>
              <div class="style-editor-row${draft.suppressHeaderSize ? ' style-row-hidden' : ''}" id="header-scale-row">
                <label>Size</label>
                <div class="style-slider-group">
                  <input type="range" id="style-header-scale" min="0.8" max="2.0" step="0.05" value="${headerScale}" />
                  <span class="style-slider-value">${headerScale.toFixed(2)}x</span>
                </div>
              </div>
            </div>

            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Colors</h3>
              <div class="style-color-tabs">
                <button class="style-color-tab${colorTab === 'light' ? ' active' : ''}" data-mode="light">Light</button>
                <button class="style-color-tab${colorTab === 'dark' ? ' active' : ''}" data-mode="dark">Dark</button>
              </div>
              <div class="style-editor-row">
                <label>Theme</label>
                <div class="custom-dropdown" id="style-theme-dropdown" data-value="${escAttr(colorTab === 'light' ? ltId : dtId)}">
                  <div class="custom-dropdown-selected">${escHtml(colorTab === 'light' ? ltLabel : dtLabel)}</div>
                  <div class="custom-dropdown-options">
                    ${(() => {
                      const selId = colorTab === 'light' ? ltId : dtId;
                      const opt = (t) => `<div class="custom-dropdown-option${t.id === selId ? ' selected' : ''}" data-value="${t.id}">${escHtml(t.name)}</div>`;
                      const section = (label, themes) => themes.length
                        ? `<div class="custom-dropdown-group-label">${label}</div>${themes.map(opt).join('')}`
                        : '';
                      return section('Light', lightThemes) + section('Dark', darkThemes);
                    })()}
                  </div>
                </div>
              </div>
              ${colorKeys.map(ck => {
                const overrideVal = activeColors[ck.key];
                const themeId = colorTab === 'light' ? ltId : dtId;
                const val = overrideVal || themeColorFor(ck.key, themeId, colorTab);
                return `<div class="style-editor-color-row">
                  <label>${ck.label}</label>
                  <div class="style-color-group">
                    <input type="color" data-color-key="${ck.key}" value="${val}" />
                    ${overrideVal ? `<button class="style-reset-color" data-color-key="${ck.key}" title="Reset">&times;</button>` : ''}
                  </div>
                </div>`;
              }).join("")}
            </div>

            ${renderShaderSection(draft)}
            ${renderStyleExtras(draft)}
          </div>

          <!-- Draggable divider — only visible in narrow-window stack layout -->
          <div class="style-modal-divider" role="separator" aria-orientation="horizontal"></div>

          <!-- RIGHT: preview pane (sits on top in narrow-window stack mode) -->
          <div class="style-modal-preview" id="style-preview-pane">
            <div class="style-preview-content">${formatPreviewHtml(PREVIEW_MD)}</div>
            <div class="style-preview-cursor-demo preview-active-line">
              <span class="preview-selected">clarity</span><span class="preview-cursor"></span> is.
            </div>
          </div>

        </div>
      </div>`;
    bind();
    updatePreview();
    const settings = backdrop.querySelector(".style-modal-settings");
    if (settings) settings.scrollTop = prevSettingsScroll;
    const body = backdrop.querySelector(".style-modal-body");
    if (body) body.scrollTop = prevBodyScroll;
  }

  function updatePreview() {
    renderPreview(state, backdrop, draft, colorTab, {
      themeId: previewThemeId,
      fontFamily: previewFontFamily,
    });
  }

  // ── event bindings ───────────────────────────────────────────────────────
  function bind() {
    const closeBtn = backdrop.querySelector(".style-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", close);

    const divider = backdrop.querySelector(".style-modal-divider");
    const previewPane = backdrop.querySelector(".style-modal-preview");
    const modalBody = backdrop.querySelector(".style-modal-body");
    if (divider && previewPane && modalBody) {
      divider.addEventListener("pointerdown", (e) => {
        if (window.innerWidth > 700) return;
        e.preventDefault();
        const bodyRect = modalBody.getBoundingClientRect();
        const startY = e.clientY;
        const startH = previewPane.getBoundingClientRect().height;
        divider.setPointerCapture(e.pointerId);
        divider.classList.add("dragging");
        const onMove = (me) => {
          const bodyH = bodyRect.height;
          const newH = Math.max(80, Math.min(bodyH - 120, startH + (me.clientY - startY)));
          previewPane.style.flex = `0 0 ${newH}px`;
        };
        const onUp = () => {
          divider.classList.remove("dragging");
          divider.removeEventListener("pointermove", onMove);
          divider.removeEventListener("pointerup", onUp);
          divider.removeEventListener("pointercancel", onUp);
        };
        divider.addEventListener("pointermove", onMove);
        divider.addEventListener("pointerup", onUp);
        divider.addEventListener("pointercancel", onUp);
      });
    }

    backdrop.querySelectorAll(".style-color-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        colorTab = btn.dataset.mode;
        render();
      });
    });

    // Hover-preview hooks: onHover fires with the option's value (null
    // when the cursor leaves the option list); onClose fires when the
    // dropdown collapses without a click. Both reset the preview var
    // and re-run updatePreview so the pane snaps to the committed draft.
    bindCustomDropdown(backdrop.querySelector("#style-font-dropdown"), (val) => {
      draft.fontFamily = val || null;
      updatePreview();
      scheduleSave();
    }, {
      onHover: (val) => { previewFontFamily = val; updatePreview(); },
      onClose: () => {
        if (previewFontFamily !== null) { previewFontFamily = null; updatePreview(); }
      },
    });

    bindCustomDropdown(backdrop.querySelector("#style-theme-dropdown"), (val) => {
      if (colorTab === "light") draft.lightThemeId = val;
      else draft.darkThemeId = val;
      seedColorsFromTheme(draft, colorTab, val);
      render();
      scheduleSave();
    }, {
      onHover: (val) => { previewThemeId = val || null; updatePreview(); },
      onClose: () => {
        if (previewThemeId !== null) { previewThemeId = null; updatePreview(); }
      },
    });

    const fsEl = backdrop.querySelector("#style-font-size");
    if (fsEl) fsEl.addEventListener("input", () => {
      fsEl.nextElementSibling.textContent = fsEl.value + "px";
      draft.fontSize = parseFloat(fsEl.value);
      updatePreview();
      scheduleSave();
    });
    const lhEl = backdrop.querySelector("#style-line-height");
    if (lhEl) lhEl.addEventListener("input", () => {
      lhEl.nextElementSibling.textContent = lhEl.value;
      draft.lineHeight = parseFloat(lhEl.value);
      updatePreview();
      scheduleSave();
    });

    const nameEl = backdrop.querySelector("#style-name");
    if (nameEl) nameEl.addEventListener("input", () => {
      draft.name = nameEl.value;
      scheduleSave();
    });

    const shsEl = backdrop.querySelector("#style-suppress-header-size");
    if (shsEl) shsEl.addEventListener("change", () => {
      draft.suppressHeaderSize = shsEl.checked;
      const row = backdrop.querySelector("#header-scale-row");
      if (row) row.classList.toggle("style-row-hidden", shsEl.checked);
      updatePreview();
      scheduleSave();
    });
    const shcEl = backdrop.querySelector("#style-suppress-header-color");
    if (shcEl) shcEl.addEventListener("change", () => {
      draft.suppressHeaderColor = shcEl.checked;
      updatePreview();
      scheduleSave();
    });
    const uhEl = backdrop.querySelector("#style-underline-headers");
    if (uhEl) uhEl.addEventListener("change", () => {
      draft.underlineHeaders = uhEl.checked;
      updatePreview();
      scheduleSave();
    });

    const hsEl = backdrop.querySelector("#style-header-scale");
    if (hsEl) hsEl.addEventListener("input", () => {
      const v = parseFloat(hsEl.value);
      hsEl.nextElementSibling.textContent = v.toFixed(2) + "x";
      draft.headerScale = v;
      updatePreview();
      scheduleSave();
    });

    const cursorEl = backdrop.querySelector("#style-cursor-mode");
    if (cursorEl) cursorEl.addEventListener("change", () => {
      const mode = cursorEl.value || "system";
      draft.cursorMode = mode;
      // Keep `blockCursor` in lockstep for backwards-compat with
      // existing consumers (settings serializer, exported styles, sync).
      draft.blockCursor = mode === "block";
      updatePreview();
      scheduleSave();
    });

    const lineIndEl = backdrop.querySelector("#style-line-indicator");
    if (lineIndEl) lineIndEl.addEventListener("change", () => {
      draft.lineIndicator = lineIndEl.value || "none";
      updatePreview();
      scheduleSave();
    });

    bindShaderSection(backdrop, draft, scheduleSave);
    bindStyleExtras(backdrop, draft, scheduleSave, render, flushSave);

    backdrop.querySelectorAll(".style-editor-color-row input[type='color']").forEach(input => {
      input.addEventListener("input", () => {
        const key = input.dataset.colorKey;
        const target = colorTab === "light" ? draft.lightColors : draft.darkColors;
        target[key] = input.value;
        updatePreview();
        scheduleSave();
      });
    });
    backdrop.querySelectorAll(".style-reset-color").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.colorKey;
        const target = colorTab === "light" ? draft.lightColors : draft.darkColors;
        delete target[key];
        render();
        scheduleSave();
      });
    });
  }

  render();

  // Host-mode callers (the Edit Styles shell) need to flush in-flight
  // edits before swapping the editor target, so return a small handle.
  return { close, flush: flushSave };
}

// The three-column Edit Styles entry point lives in `style-editor-modal.js`
// so this file stays under the 700-line repo cap. Re-exported here for
// callers that import from the historical location.
export { openStyleEditorModal } from "./style-editor-modal.js";

