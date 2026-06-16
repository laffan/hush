/**
 * Settings tab rendering — entry point. Each render function accepts a
 * context object { settings, drySearchQuery }. Larger tabs are split
 * into sibling files and re-exported here so settings-window.js can
 * import everything from one place:
 *   - settings-tabs-shortcuts.js   (Shortcuts tab + categories)
 *   - settings-tabs-sync.js        (Dropbox + Local Sync tab)
 *   - settings-tabs-zotero.js      (Zotero tab)
 */
import { DEFAULT_STOPWORDS } from "../editor/plugins/dry-highlight.js";
import { renderFlagsTab } from "../longview/longview-settings.js";

// ===== Shared helpers (also used by sibling tab files) =====
export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// iPadOS 13+ reports as Macintosh; accept any positive maxTouchPoints
// (real Macs expose 0; some WKWebView versions on iPad only expose 1).
export function isIOSSettings() {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const tp = navigator.maxTouchPoints || 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

// Re-export sibling-file APIs so settings-window.js's single import
// statement keeps working without touching every call site.
export {
  shortcutCategories, shortcutDefs, normalizeShortcut, findConflict,
  renderShortcutsTab, renderShortcutKeys,
} from "./settings-tabs-shortcuts.js";
export { renderSyncTab } from "./settings-tabs-sync.js";
export { renderZoteroTab } from "./settings-tabs-zotero.js";
export { renderProofreadTab, bindProofreadTab } from "./settings-tabs-proofread.js";

// ===== General Tab =====
export function renderGeneralTab(settings) {
  const s = settings;
  return `
    <div class="settings-section">
      <h2>Visibility</h2>
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
      <div class="settings-row">
        <label>Show tooltips</label>
        <input type="checkbox" id="setting-show-tooltips" ${s.showTooltips ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Show Recent Files</label>
        <input type="checkbox" id="setting-show-recent-files" ${s.showRecentFiles ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Desks</label>
        <select id="setting-desk-display-mode">
          <option value="single" ${s.deskDisplayMode !== "all" ? "selected" : ""}>Show single desk</option>
          <option value="all" ${s.deskDisplayMode === "all" ? "selected" : ""}>Show all desks</option>
        </select>
      </div>
      ${isIOSSettings() ? `<div class="settings-row"><label>Touch mode</label><input type="checkbox" id="setting-touch-mode" ${s.touchMode ? "checked" : ""} /></div>` : ""}
      ${isIOSSettings() ? `<div class="settings-row"><label>Hide system chrome</label><input type="checkbox" id="setting-hide-system-chrome" ${s.hideSystemChrome !== false ? "checked" : ""} /></div>` : ""}
    </div>
  `;
}

// ===== Editor Tab =====
export function renderEditorTab(settings) {
  const s = settings;

  return `
    <div class="settings-section">
      <h2>Headers</h2>
      <div class="settings-row">
        <label>Sticky headers</label>
        <input type="checkbox" id="setting-sticky-headers" ${s.stickyHeaders ? "checked" : ""} />
      </div>
    </div>

    <div class="settings-section">
      <h2>Typewriter</h2>
      <div class="settings-slider-row">
        <label>Line opacity</label>
        <div class="slider-group">
          <input type="range" id="setting-typewriter-line-opacity" min="0" max="1" step="0.01" value="${s.typewriterLineOpacity ?? 0.08}" />
          <span class="slider-value">${((s.typewriterLineOpacity ?? 0.08) * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Focus mode</h2>
      <div class="settings-slider-row">
        <label>Dimmed opacity</label>
        <div class="slider-group">
          <input type="range" id="setting-focus-mode-opacity" min="0" max="1" step="0.05" value="${s.focusModeOpacity ?? 0.5}" />
          <span class="slider-value">${((s.focusModeOpacity ?? 0.5) * 100).toFixed(0)}%</span>
        </div>
      </div>
      <p class="settings-help">When focus mode is on, text outside the current sentence and any open panes fade to this opacity.</p>
    </div>

    <div class="settings-section">
      <h2>Comments</h2>
      <div class="settings-slider-row">
        <label>Comment opacity</label>
        <div class="slider-group">
          <input type="range" id="setting-comment-opacity" min="0.1" max="1" step="0.05" value="${s.commentOpacity ?? 0.5}" />
          <span class="slider-value">${((s.commentOpacity ?? 0.5) * 100).toFixed(0)}%</span>
        </div>
      </div>
      <p class="settings-help">Opacity of <code>%%…%%</code> comments. Markers dim to ⅔ of this value.</p>
    </div>

    <div class="settings-section">
      <h2>Zen Focus</h2>
      <div class="settings-slider-row">
        <label>Font size</label>
        <div class="slider-group">
          <input type="range" id="setting-zen-focus-font-size" min="18" max="72" step="1" value="${s.zenFocusFontSize || 30}" />
          <span class="slider-value">${s.zenFocusFontSize || 30}px</span>
        </div>
      </div>
      <div class="settings-row">
        <label>Window</label>
        <select id="setting-zen-focus-window">
          ${[1, 3, 5, 7].map((n) => `<option value="${n}" ${(s.zenFocusWindow || 1) === n ? "selected" : ""}>${n} ${n === 1 ? "line" : "lines"}</option>`).join("")}
        </select>
      </div>
      <p class="settings-help">Font size while Zen is open. Focus mode auto-engages in Zen — surrounding-sentence dim is governed by the Focus mode opacity slider above. The Window setting controls how many lines the cursor can move before the document scrolls underneath it: 1 keeps the cursor pinned to the centre (pure typewriter), 3 / 5 / 7 widen the centred band so the cursor can drift one, two, or three lines either side before scrolling kicks in. Toggle Zen with the configured shortcut, default ⌘⇧S.</p>
    </div>

    <div class="settings-section">
      <h2>Notebook text</h2>
      <div class="settings-slider-row">
        <label>Default size</label>
        <div class="slider-group">
          <input type="range" id="setting-notebook-font-size" min="10" max="48" step="1" value="${s.notebookFontSize || 16}" />
          <span class="slider-value">${s.notebookFontSize || 16}px</span>
        </div>
      </div>
      <p class="settings-help">Font size used for newly-created text shapes on the notebook canvas. Existing shapes aren't affected.</p>
      <div class="settings-slider-row">
        <label>Max width</label>
        <div class="slider-group">
          <input type="range" id="setting-notebook-text-max-width" min="200" max="800" step="10" value="${s.notebookTextMaxWidth || 350}" />
          <span class="slider-value">${s.notebookTextMaxWidth || 350}px</span>
        </div>
      </div>
      <p class="settings-help">Width cap for new text shapes and brainstorm cards on the notebook canvas. Existing shapes you've manually resized aren't affected.</p>
    </div>

    <div class="settings-section">
      <h2>Flowchart</h2>
      <div class="settings-row">
        <label>Edge connections</label>
        <select id="setting-flow-connect-mode">
          <option value="closest" ${(s.flowConnectMode || "closest") === "closest" ? "selected" : ""}>Connect closest edge</option>
          <option value="horizontal" ${s.flowConnectMode === "horizontal" ? "selected" : ""}>Connect left/right edges</option>
        </select>
      </div>
      <p class="settings-help">How flowchart arrows route between linked text shapes. "Closest" picks the nearest pair of cardinal edges so a child placed below a parent connects bottom-to-top; "Left/right" always exits a parent's right edge and enters the child's left.</p>
    </div>

    <div class="settings-section">
      <h2>Footnotes</h2>
      <div class="settings-slider-row">
        <label>Font size</label>
        <div class="slider-group">
          <input type="range" id="setting-footnote-font-size" min="50" max="150" step="5" value="${s.footnoteFontSize || 100}" />
          <span class="slider-value">${s.footnoteFontSize || 100}%</span>
        </div>
      </div>
      <div class="settings-row">
        <label>Font family</label>
        <select id="setting-footnote-font-family">
          <option value="sans-serif" ${(s.footnoteFontFamily || "sans-serif") === "sans-serif" ? "selected" : ""}>Sans-serif</option>
          <option value="serif" ${s.footnoteFontFamily === "serif" ? "selected" : ""}>Serif</option>
          <option value="match" ${s.footnoteFontFamily === "match" ? "selected" : ""}>Match main text</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Use colors</label>
        <input type="checkbox" id="setting-footnote-use-colors" ${s.footnoteUseColors !== false ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Margin placement</label>
        <select id="setting-footnote-margin-side">
          <option value="closest" ${(s.footnoteMarginSide || "closest") === "closest" ? "selected" : ""}>Use closest</option>
          <option value="split" ${s.footnoteMarginSide === "split" ? "selected" : ""}>Split</option>
          <option value="left" ${s.footnoteMarginSide === "left" ? "selected" : ""}>Left only</option>
          <option value="right" ${s.footnoteMarginSide === "right" ? "selected" : ""}>Right only</option>
        </select>
      </div>
    </div>
  `;
}

// ===== D.R.Y. Tab =====
export function renderDryTab(settings, drySearchQuery) {
  const s = settings;
  const stopwords = s.dryStopwords || DEFAULT_STOPWORDS;
  const filtered = stopwords
    .filter(w => w.includes(drySearchQuery.toLowerCase()))
    .sort();

  return `
    <div class="settings-section">
      <h2>Detection</h2>
      <div class="settings-row">
        <label>Detection range</label>
        <select id="setting-dry-range">
          <option value="paragraph" ${s.dryRange === "paragraph" ? "selected" : ""}>Current paragraph</option>
          <option value="two-paragraphs" ${s.dryRange === "two-paragraphs" ? "selected" : ""}>Two paragraphs</option>
          <option value="document" ${s.dryRange === "document" ? "selected" : ""}>Full document</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Ignore proper nouns</label>
        <input type="checkbox" id="setting-dry-proper-nouns" ${s.dryIgnoreProperNouns ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Include base word repeats</label>
        <input type="checkbox" id="setting-dry-base-words" ${s.dryIncludeBaseWords ? "checked" : ""} />
      </div>
    </div>
    <div class="settings-section">
      <h2>Stopwords</h2>
      <p class="settings-help">Common words to ignore when detecting repeats.</p>
      <div class="dry-add-row">
        <input type="text" id="dry-add-input" placeholder="Add stopword…" />
        <button id="dry-add-btn">Add</button>
      </div>
      <div class="dry-search-row">
        <input type="text" id="dry-search-input" placeholder="Search stopwords…" value="${escAttr(drySearchQuery)}" />
      </div>
      <div class="dry-stopwords-list">
        <div class="dry-stopwords-grid">
          ${filtered.map(word => `
            <div class="dry-stopword-item">
              <span>${escHtml(word)}</span>
              <button class="dry-stopword-remove" data-word="${escAttr(word)}">✕</button>
            </div>
          `).join("")}
        </div>
        <p class="dry-stopwords-count">${filtered.length} stopword${filtered.length !== 1 ? "s" : ""} ${drySearchQuery ? "found" : "total"}</p>
      </div>
      <div class="dry-reset-row">
        <button id="dry-reset-btn" class="dry-reset-button">Reset to defaults</button>
      </div>
    </div>
  `;
}

// ===== Flags Tab =====
export function renderFlagsSettingsTab(settings) {
  return renderFlagsTab(settings);
}

// ===== Privacy Tab =====
export function renderPrivacyTab(settings) {
  const s = settings;
  const mode = s.privacyMode || "blackout";
  const hasDummy = !!(s.dummyText && s.dummyText.trim());

  return `
    <div class="settings-section">
      <h2>Privacy Mode Style</h2>
      <p class="settings-help">Choose what happens when you toggle private mode.</p>
      <div class="settings-row">
        <label>Mode</label>
        <select id="setting-privacy-mode">
          <option value="blackout" ${mode === "blackout" ? "selected" : ""}>Blackout (opaque boxes)</option>
          <option value="dummy" ${mode === "dummy" ? "selected" : ""}>Dummy document</option>
        </select>
      </div>
    </div>
    <div class="settings-section">
      <h2>Dummy Document</h2>
      <p class="settings-help">Paste the text of a dummy document below. When dummy mode is active, your writing will appear to be this text instead. Line breaks and formatting are stripped on paste.</p>
      <textarea id="setting-dummy-text" rows="12" placeholder="Paste your dummy document text here... e.g. a boring quarterly report, meeting notes, etc.">${escHtml(s.dummyText || "")}</textarea>
      ${hasDummy ? `<p class="settings-help" style="margin-top: 8px;">${s.dummyText.length.toLocaleString()} characters loaded</p>` : ""}
    </div>
  `;
}
