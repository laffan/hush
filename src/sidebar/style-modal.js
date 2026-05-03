/**
 * Two-column style editor modal — settings on the left, live preview on
 * the right. Edits autosave with a short debounce; close = flush.
 *
 * Pulled out of styles-panel.js to keep that file focused on the sidebar
 * list. Helpers shared with the list (escAttr/escHtml/migrateStyle/theme
 * color maps) live in styles-panel-shared.js.
 */
import { themeList, getThemeById } from "../themes.js";
import {
  escAttr,
  escHtml,
  migrateStyle,
  themeBackgrounds,
  themeForegrounds,
} from "./styles-panel-shared.js";

// ── lorem ipsum preview text ───────────────────────────────────────────────────
const PREVIEW_MD = `# The Art of Writing

## Finding Your Voice

Every writer begins with a blank page and a spark of intention. The words that follow are shaped by years of reading, thinking, and living.

### On Simplicity

Good prose is like a window pane — clear, direct, and invisible. **Bold ideas** need not hide behind *ornate language*. Strip away the excess until only the essential remains.

> "Write drunk, edit sober." — Ernest Hemingway

The best sentences carry weight without effort, landing softly in the reader's mind. ~~Perfection~~ is not the goal — clarity is.`;

// ── theme & font option lists ──────────────────────────────────────────────────
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
  { key: "bg", label: "Background" },
  { key: "fg", label: "Text" },
  { key: "header", label: "Header" },
  { key: "cursor", label: "Cursor" },
  { key: "selection", label: "Selection" },
];

function fontFallback(family) {
  const map = {
    "Helvetica": "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
    "EB Garamond": "'EB Garamond', 'Georgia', 'Times New Roman', serif",
    "Inter": "'Inter', system-ui, -apple-system, sans-serif",
    "Fira Code": "'Fira Code', 'Fira Mono', 'Consolas', monospace",
    "Source Sans Pro": "'Source Sans Pro', 'Helvetica Neue', 'Arial', sans-serif",
    "Source Serif Pro": "'Source Serif Pro', 'Georgia', 'Times New Roman', serif",
    "Libre Franklin": "'Libre Franklin', 'Helvetica Neue', 'Arial', sans-serif",
    "Libre Baskerville": "'Libre Baskerville', 'Georgia', 'Times New Roman', serif",
    "Karla": "'Karla', 'Helvetica Neue', 'Arial', sans-serif",
    "Lora": "'Lora', 'Georgia', 'Times New Roman', serif",
    "iA Writer Duo": "'iA Writer Duo', 'Menlo', 'Consolas', monospace",
    "iA Writer Mono": "'iA Writer Mono', 'Menlo', 'Consolas', monospace",
    "iA Writer Quattro": "'iA Writer Quattro', 'Helvetica Neue', 'Arial', sans-serif",
  };
  return map[family] || `'${family}', system-ui, sans-serif`;
}

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
  };
}

/** Resolve a specific color key against the given theme. Returns a hex
 * colour suitable for <input type="color"> — falls back to sensible
 * defaults for keys the theme doesn't define (selection in particular
 * isn't a solid colour in our themes, so we pick a neutral approximation).
 */
function themeColorFor(key, themeId, colorTab) {
  const theme = getThemeById(themeId);
  const bg = themeBackgrounds[themeId] || (colorTab === "light" ? "#fafafa" : "#1a1a1a");
  const fg = themeForegrounds[themeId] || (colorTab === "light" ? "#1a1a1a" : "#e0e0e0");
  switch (key) {
    case "bg": return bg;
    case "fg": return fg;
    case "header": return theme?.headingColor || fg;
    case "cursor": return fg;
    case "selection": return colorTab === "light" ? "#c8c8c8" : "#3a3a3a";
    default: return fg;
  }
}

/** Fill the color overrides for the given appearance with the theme's own
 * resolved colors. Gives users a starting point when they pick a theme. */
function seedColorsFromTheme(draft, colorTab, themeId) {
  if (!themeId) return;
  const filled = {
    bg: themeColorFor("bg", themeId, colorTab),
    fg: themeColorFor("fg", themeId, colorTab),
    header: themeColorFor("header", themeId, colorTab),
    cursor: themeColorFor("cursor", themeId, colorTab),
    selection: themeColorFor("selection", themeId, colorTab),
  };
  if (colorTab === "light") draft.lightColors = filled;
  else draft.darkColors = filled;
}

export function openStyleModal(state, existingStyle, onDone) {
  // existingStyle === null → create a new user style
  // existingStyle === "__default__" → edit the Default (global settings)
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

  let colorTab = "light"; // which tab is shown in the color section
  // Theme id currently being hovered in the theme dropdown. Non-null
  // overrides `draft.lightThemeId` / `darkThemeId` inside `updatePreview`
  // so the right-hand preview pane reflects whichever option the user is
  // pointing at — matching the on-hover behaviour of the Styles sidebar.
  // Cleared at every `render()` so a stale hover from one color tab can't
  // leak into the other tab's dropdown rebuild.
  let previewThemeId = null;

  // ── build the backdrop ───────────────────────────────────────────────────
  const backdrop = document.createElement("div");
  backdrop.className = "style-modal-backdrop";
  document.body.appendChild(backdrop);

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
    state.emit("style-changed");
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
    backdrop.remove();
  }

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  function render() {
    previewThemeId = null;
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
      <div class="style-modal">
        <button class="style-modal-close">&times;</button>
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
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-block-cursor" ${(draft.blockCursor != null ? draft.blockCursor : !!state.settings.blockCursor) ? 'checked' : ''} />
                  <span class="style-checkbox-label">Block</span>
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
                    ${(colorTab === 'light' ? lightThemes : darkThemes).map(t => {
                      const selId = colorTab === 'light' ? ltId : dtId;
                      return `<div class="custom-dropdown-option${t.id === selId ? ' selected' : ''}" data-value="${t.id}">${escHtml(t.name)}</div>`;
                    }).join('')}
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
          </div>

          <!-- Draggable divider — only visible in narrow-window stack layout -->
          <div class="style-modal-divider" role="separator" aria-orientation="horizontal"></div>

          <!-- RIGHT: preview pane (sits on top in narrow-window stack mode) -->
          <div class="style-modal-preview" id="style-preview-pane">
            <div class="style-preview-content">${formatPreviewHtml(PREVIEW_MD)}</div>
            <div class="style-preview-cursor-demo">
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

  // ── preview rendering ────────────────────────────────────────────────────
  function updatePreview() {
    const pane = backdrop.querySelector("#style-preview-pane");
    if (!pane) return;

    // Hover-preview path: if the user is pointing at a theme option, the
    // pane shows that theme's *seeded* colors (the same ones a click would
    // commit) rather than the draft's overrides — that way the theme
    // itself is what's being previewed, not the user's prior tweaks.
    const draftThemeId = colorTab === "light" ? draft.lightThemeId : draft.darkThemeId;
    const themeId = previewThemeId || draftThemeId;
    const colors = previewThemeId
      ? {
          bg: themeColorFor("bg", previewThemeId, colorTab),
          fg: themeColorFor("fg", previewThemeId, colorTab),
          header: themeColorFor("header", previewThemeId, colorTab),
          cursor: themeColorFor("cursor", previewThemeId, colorTab),
          selection: themeColorFor("selection", previewThemeId, colorTab),
        }
      : (colorTab === "light" ? (draft.lightColors || {}) : (draft.darkColors || {}));

    const bg = colors.bg || themeBackgrounds[themeId] || (colorTab === "light" ? "#fafafa" : "#1a1a1a");
    const fg = colors.fg || themeForegrounds[themeId] || (colorTab === "light" ? "#1a1a1a" : "#e0e0e0");
    const cursor = colors.cursor || fg;
    const selection = colors.selection || "rgba(128, 128, 128, 0.3)";
    const font = draft.fontFamily ? fontFallback(draft.fontFamily) : fontFallback(state.settings.fontFamily || "EB Garamond");
    const size = (draft.fontSize || state.settings.fontSize || 20) + "px";
    const lh = draft.lineHeight || state.settings.lineHeight || 1.6;
    const isBlock = draft.blockCursor != null ? draft.blockCursor : !!state.settings.blockCursor;

    pane.style.background = bg;
    pane.style.color = fg;
    pane.style.fontFamily = font;
    pane.style.fontSize = size;
    pane.style.lineHeight = lh;

    const cursorEl = pane.querySelector(".preview-cursor");
    if (cursorEl) {
      const themeObj = getThemeById(themeId);
      const blockColor = (themeObj && themeObj.headingColor) || cursor;
      if (isBlock) {
        cursorEl.style.borderLeft = "none";
        cursorEl.style.background = blockColor;
        cursorEl.style.opacity = "0.55";
        cursorEl.style.width = "0.6em";
      } else {
        cursorEl.style.borderLeft = `2px solid ${cursor}`;
        cursorEl.style.background = "none";
        cursorEl.style.opacity = "1";
        cursorEl.style.width = "0";
      }
    }

    const selEl = pane.querySelector(".preview-selected");
    if (selEl) {
      selEl.style.background = selection;
    }

    const theme = getThemeById(themeId);
    const headingColor = draft.suppressHeaderColor
      ? fg
      : (colors.header || (theme ? theme.headingColor : fg));
    const scale = draft.headerScale != null ? draft.headerScale : 1.0;
    const baseSize = draft.fontSize || state.settings.fontSize || 20;
    const suppressSize = !!draft.suppressHeaderSize;
    const scales = { h1: 1.8, h2: 1.5, h3: 1.3 };
    pane.querySelectorAll(".preview-h1, .preview-h2, .preview-h3").forEach(el => {
      el.style.color = headingColor;
      el.style.textDecoration = draft.underlineHeaders ? "underline" : "";
      if (suppressSize) {
        el.style.fontSize = baseSize + "px";
      } else {
        const tag = el.classList.contains("preview-h1") ? "h1"
          : el.classList.contains("preview-h2") ? "h2" : "h3";
        el.style.fontSize = (baseSize * scales[tag] * scale) + "px";
      }
    });
  }

  // ── event bindings ───────────────────────────────────────────────────────
  function bind() {
    backdrop.querySelector(".style-modal-close").addEventListener("click", close);

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

    bindCustomDropdown(backdrop.querySelector("#style-font-dropdown"), (val) => {
      draft.fontFamily = val || null;
      updatePreview();
      scheduleSave();
    });

    bindCustomDropdown(backdrop.querySelector("#style-theme-dropdown"), (val) => {
      if (colorTab === "light") draft.lightThemeId = val;
      else draft.darkThemeId = val;
      seedColorsFromTheme(draft, colorTab, val);
      render();
      scheduleSave();
    }, {
      onHover: (val) => {
        previewThemeId = val || null;
        updatePreview();
      },
      onClose: () => {
        if (previewThemeId !== null) {
          previewThemeId = null;
          updatePreview();
        }
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

    const bcEl = backdrop.querySelector("#style-block-cursor");
    if (bcEl) bcEl.addEventListener("change", () => {
      draft.blockCursor = bcEl.checked;
      updatePreview();
      scheduleSave();
    });

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
}

// ── simple markdown→HTML for the preview pane ──────────────────────────────────
function formatPreviewHtml(md) {
  return md.split("\n").map(line => {
    if (line.startsWith("### ")) return `<div class="preview-h3">${fmtInline(line.slice(4))}</div>`;
    if (line.startsWith("## ")) return `<div class="preview-h2">${fmtInline(line.slice(3))}</div>`;
    if (line.startsWith("# ")) return `<div class="preview-h1">${fmtInline(line.slice(2))}</div>`;
    if (line.startsWith("> ")) return `<div class="preview-bq">${fmtInline(line.slice(2))}</div>`;
    if (line.trim() === "") return `<div class="preview-blank">&nbsp;</div>`;
    return `<div>${fmtInline(line)}</div>`;
  }).join("");
}

function fmtInline(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

// ── shared custom dropdown ─────────────────────────────────────────────────────
function bindCustomDropdown(dropdown, onSelect, opts) {
  if (!dropdown) return;
  const selected = dropdown.querySelector(".custom-dropdown-selected");
  const optionsList = dropdown.querySelector(".custom-dropdown-options");
  const onClose = opts && opts.onClose;
  const onHover = opts && opts.onHover;

  function closeDropdown() {
    if (!dropdown.classList.contains("open")) return;
    dropdown.classList.remove("open");
    if (onClose) onClose();
  }

  selected.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains("open");
    // Closing every other open dropdown also clears their hover preview.
    document.querySelectorAll(".custom-dropdown.open").forEach(d => {
      if (d !== dropdown) d.classList.remove("open");
    });
    if (isOpen) {
      closeDropdown();
    } else {
      dropdown.classList.add("open");
      setTimeout(() => {
        document.addEventListener("mousedown", function handler(e2) {
          if (!dropdown.contains(e2.target)) { closeDropdown(); document.removeEventListener("mousedown", handler); }
        });
      }, 0);
    }
  });

  optionsList.querySelectorAll(".custom-dropdown-option").forEach(opt => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = opt.dataset.value;
      dropdown.dataset.value = value;
      selected.textContent = opt.textContent;
      const optFont = opt.style.fontFamily;
      if (optFont) selected.style.fontFamily = optFont;
      optionsList.querySelectorAll(".custom-dropdown-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      closeDropdown();
      if (onSelect) onSelect(value);
    });
    if (onHover) {
      opt.addEventListener("mouseenter", () => onHover(opt.dataset.value));
    }
  });
  if (onHover) {
    // Cursor leaves the entire option list — clear the hover preview so
    // the pane snaps back to the committed draft state.
    optionsList.addEventListener("mouseleave", () => onHover(null));
  }
}
