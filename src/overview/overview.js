/**
 * Overview — the right-hand sidebar for document navigation.
 *
 * Named "outline view" until Outlines (the nested-checklist blocks in
 * `src/outline/`) shipped and the two became impossible to talk about
 * apart. Same panel, same settings — `overview*` keys carry their old
 * `longview*` spellings as serde aliases so nobody's tuning resets.
 * Ported from obsidian-long-view for Hush.
 *
 * Renders an overview with headings, condensed text, flags, and callout tinting.
 * Clicking headings/flags navigates the editor. The current heading is highlighted.
 */
import {
  parseDocument,
  computeHeadingCalloutStacks,
  getFirstWords,
} from "./overview-parser.js";
import { tokenizeLinesWithOffsets, renderLineWithCommentHighlights } from "./overview-lines.js";
import { CALLOUT_COLORS, getCalloutColor } from "../editor/plugins/callouts.js";
import { getActiveTheme } from "../themes/index.js";
import { buildTabContainers } from "./overview-tabs.js";
import { EditorView } from "@codemirror/view";

/** Default flag colors */
const DEFAULT_FLAG_COLORS = {
  TODO: "#ffd700",
  MISSING: "#ff4444",
  COMMENT: "#888888",
  REWRITE: "#ff66aa",
  RESEARCH: "#66aaff",
};

/** Default Overview settings */
export const OVERVIEW_DEFAULTS = {
  overviewShowParagraphs: true,
  overviewShowNumbers: true,
  overviewShowComments: false,
  overviewShowFlags: true,
  overviewShowFlagTypes: false,
  overviewWrapFlagText: true,
  overviewBodyFontSize: 3,
  overviewHeadingFontSize: 12,
  overviewFlagFontSize: 12,
  overviewLineGap: 2,
  overviewCurrentPositionColor: "#ff0000",
};

/**
 * Create and manage the Overview panel inside the right panel overlay.
 * @param {HTMLElement} container - The #right-panel-overlay element
 * @param {object} state - AppState instance
 */
export function createOverview(container, state) {
  let headingEntries = []; // { offset, element }
  let paragraphEntries = []; // { offset, element }
  let activeHeadingEl = null;
  let activeParagraphEl = null;
  let scrollHandler = null;
  let selectionHandler = null;

  function getSettings() {
    return { ...OVERVIEW_DEFAULTS, ...state.settings };
  }

  function render() {
    const s = getSettings();
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "overview-container";

    // Options toggle button (collapsible)
    const optionsToggle = document.createElement("button");
    optionsToggle.className = "overview-options-toggle";
    optionsToggle.textContent = "Options ▾";
    optionsToggle.addEventListener("click", () => {
      const panel = wrapper.querySelector(".overview-options-panel");
      const isOpen = !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", isOpen);
      optionsToggle.textContent = isOpen ? "Options ▸" : "Options ▾";
      optionsToggle.classList.toggle("is-open", !isOpen);
    });
    wrapper.appendChild(optionsToggle);

    const optionsPanel = document.createElement("div");
    optionsPanel.className = "overview-options-panel collapsed";
    // Prevent interactions inside options from closing the panel
    optionsPanel.addEventListener("mousedown", (e) => e.stopPropagation());

    // Toggle buttons grid (squared off) — the "buttons" section
    const filters = document.createElement("div");
    filters.className = "overview-filters overview-options-group";
    filters.appendChild(makeToggle("Text", s.overviewShowParagraphs, "overviewShowParagraphs"));
    filters.appendChild(makeToggle("Numbers", s.overviewShowNumbers, "overviewShowNumbers"));
    filters.appendChild(makeToggle("Comments", s.overviewShowComments, "overviewShowComments"));
    filters.appendChild(makeToggle("Flags", s.overviewShowFlags, "overviewShowFlags"));
    optionsPanel.appendChild(filters);

    // Checkbox area — flag type label + wrap toggle
    const checkboxes = document.createElement("div");
    checkboxes.className = "overview-options-group";
    checkboxes.appendChild(makeCheckboxRow("Show flag type labels", s.overviewShowFlagTypes, "overviewShowFlagTypes"));
    checkboxes.appendChild(makeCheckboxRow("Wrap flag text", s.overviewWrapFlagText, "overviewWrapFlagText"));
    optionsPanel.appendChild(checkboxes);

    // Slider area — sizes + gap
    const sliders = document.createElement("div");
    sliders.className = "overview-options-group";
    sliders.appendChild(makeSliderRow("Paragraph size", s.overviewBodyFontSize, 1, 12, 0.5, "overviewBodyFontSize", "px"));
    sliders.appendChild(makeSliderRow("Heading size", s.overviewHeadingFontSize, 8, 20, 1, "overviewHeadingFontSize", "px"));
    sliders.appendChild(makeSliderRow("Flag size", s.overviewFlagFontSize, 8, 18, 1, "overviewFlagFontSize", "px"));
    sliders.appendChild(makeSliderRow("Line gap", s.overviewLineGap, 0, 8, 0.5, "overviewLineGap", "px"));
    optionsPanel.appendChild(sliders);
    wrapper.appendChild(optionsPanel);

    wrapper.appendChild(buildContent(s));
    container.appendChild(wrapper);
    setupScrollTracking(state);
  }

  /** Build (or rebuild) just the outline content area */
  function buildContent(s) {
    const text = state.editor ? state.editor.getContent() : "";
    const { headings, flags, tabs } = parseDocument(text);
    const sectionColors = { ...CALLOUT_COLORS, ...(s.flagColors || {}), ...(s.overviewSectionColors || {}) };
    const calloutStacks = computeHeadingCalloutStacks(headings, sectionColors);

    const content = document.createElement("div");
    content.className = "overview-content";
    content.style.setProperty("--ov-body-font", s.overviewBodyFontSize + "px");
    content.style.setProperty("--ov-heading-font", s.overviewHeadingFontSize + "px");
    content.style.setProperty("--ov-flag-font", s.overviewFlagFontSize + "px");
    content.style.setProperty("--ov-line-gap", s.overviewLineGap + "px");
    content.style.setProperty("--ov-position-color", s.overviewCurrentPositionColor);
    // Active theme's heading colour drives the current-paragraph wash.
    const activeTheme = getActiveTheme(state.settings);
    if (activeTheme && activeTheme.headingColor) {
      content.style.setProperty("--ov-heading-color", activeTheme.headingColor);
    }

    // Tabs: every marker in the source becomes a foldable container at
    // the outline root. The root (pre-marker) section gets a wrapper
    // too but no header so single-tab docs look identical to the
    // pre-tabs outline.
    const { hasMarkers, routeFor: containerForOffset } = buildTabContainers(
      content,
      tabs,
      (offset) => scrollToOffset(state, offset),
    );

    headingEntries = [];
    paragraphEntries = [];
    let currentLevel = 0;
    let flowEl = null;
    const fragments = tokenizeContent(text, headings, flags);
    let openCalloutWrappers = [];
    let activeCalloutStack = [];
    let currentContainer = hasMarkers ? containerForOffset(0) : content;

    for (const frag of fragments) {
      const fragOffset = frag.type === "heading"
        ? frag.heading.startOffset
        : frag.type === "flag"
          ? frag.flag.startOffset
          : (frag.startOffset || 0);
      const targetContainer = containerForOffset(fragOffset);
      if (targetContainer !== currentContainer) {
        currentContainer = targetContainer;
        openCalloutWrappers = [];
        activeCalloutStack = [];
        currentLevel = 0;
        flowEl = null;
      }
      if (frag.type === "heading") {
        const h = frag.heading;
        const stack = calloutStacks.get(h.startOffset) || [];
        const result = updateCalloutWrappers(currentContainer, openCalloutWrappers, activeCalloutStack, stack, sectionColors);
        openCalloutWrappers = result.wrappers;
        activeCalloutStack = result.stack;
        currentLevel = h.level;
        flowEl = createSectionStructure(result.container, currentLevel);
        const numbering = s.overviewShowNumbers ? computeNumbering(headings, h) : "";
        const headingEl = document.createElement("div");
        headingEl.className = "overview-heading";
        headingEl.dataset.offset = String(h.startOffset);
        headingEl.dataset.level = String(h.level);
        headingEl.textContent = numbering ? `${numbering} ${h.text}` : h.text;
        headingEl.addEventListener("click", (e) => {
          e.stopPropagation();
          scrollToOffset(state, h.startOffset);
        });
        flowEl.appendChild(headingEl);
        headingEntries.push({ offset: h.startOffset, element: headingEl });
        if (h.callout) {
          const calloutTitle = document.createElement("div");
          calloutTitle.className = "overview-callout-title";
          const showType = s.overviewShowFlagTypes && h.callout.type !== "SUMMARY";
          if (showType) {
            const typeSpan = document.createElement("span");
            typeSpan.className = "overview-flag-type";
            typeSpan.textContent = h.callout.type;
            calloutTitle.appendChild(typeSpan);
            if (h.callout.title) calloutTitle.appendChild(document.createTextNode(" — " + h.callout.title));
          } else {
            calloutTitle.textContent = h.callout.title || "";
          }
          if (calloutTitle.textContent) flowEl.appendChild(calloutTitle);
        }
      } else if (frag.type === "text") {
        if (s.overviewShowParagraphs) {
          for (const entry of tokenizeLinesWithOffsets(frag.text, frag.startOffset || 0)) {
            // Each paragraph routes by its own offset — a text fragment
            // between a heading and a flag can straddle a tab marker,
            // and the routing decision at the fragment level would put
            // the trailing lines under the wrong tab.
            const lineContainer = containerForOffset(entry.offset);
            if (lineContainer !== currentContainer) {
              currentContainer = lineContainer;
              openCalloutWrappers = [];
              activeCalloutStack = [];
              currentLevel = 0;
              flowEl = null;
            }
            if (!flowEl) {
              const result = updateCalloutWrappers(currentContainer, openCalloutWrappers, activeCalloutStack, activeCalloutStack, sectionColors);
              openCalloutWrappers = result.wrappers;
              flowEl = createSectionStructure(result.container, currentLevel);
            }
            const p = document.createElement("p");
            p.className = "overview-line";
            p.dataset.offset = String(entry.offset);
            renderLineWithCommentHighlights(p, entry.line);
            // Click navigates the editor to this paragraph; mirrors the
            // heading-click behaviour so the whole outline is interactive.
            p.addEventListener("click", (e) => {
              e.stopPropagation();
              scrollToOffset(state, entry.offset);
              setActiveParagraph(p);
            });
            flowEl.appendChild(p);
            paragraphEntries.push({ offset: entry.offset, element: p });
          }
        }
      } else if (frag.type === "flag") {
        if (!s.overviewShowFlags) continue;
        if (!s.overviewShowComments && frag.flag.type === "COMMENT") continue;
        if (!flowEl) {
          const result = updateCalloutWrappers(currentContainer, openCalloutWrappers, activeCalloutStack, activeCalloutStack, sectionColors);
          openCalloutWrappers = result.wrappers;
          flowEl = createSectionStructure(result.container, currentLevel);
        }
        flowEl.appendChild(createFlagElement(frag.flag, s, state));
      }
    }
    return content;
  }

  /** Re-render only the content area (preserves options panel state) */
  function renderContent() {
    const wrapper = container.querySelector(".overview-container");
    if (!wrapper) return render();
    const oldContent = wrapper.querySelector(".overview-content");
    const newContent = buildContent(getSettings());
    if (oldContent) wrapper.replaceChild(newContent, oldContent);
    else wrapper.appendChild(newContent);
    setupScrollTracking(state);
  }

  /** Apply CSS variable changes live without rebuilding DOM */
  function applyLiveStyles() {
    const s = getSettings();
    const content = container.querySelector(".overview-content");
    if (!content) return;
    content.style.setProperty("--ov-body-font", s.overviewBodyFontSize + "px");
    content.style.setProperty("--ov-heading-font", s.overviewHeadingFontSize + "px");
    content.style.setProperty("--ov-flag-font", s.overviewFlagFontSize + "px");
    content.style.setProperty("--ov-line-gap", s.overviewLineGap + "px");
    content.style.setProperty("--ov-position-color", s.overviewCurrentPositionColor);
  }

  function makeToggle(label, value, key) {
    const btn = document.createElement("button");
    btn.className = "overview-filter-btn" + (value ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      state.settings[key] = !state.settings[key];
      state.updateSettings({ [key]: state.settings[key] });
      btn.classList.toggle("active", state.settings[key]);
      renderContent();
    });
    return btn;
  }

  function makeCheckboxRow(label, value, key) {
    const row = document.createElement("div");
    row.className = "overview-option-row";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => {
      state.settings[key] = cb.checked;
      state.updateSettings({ [key]: cb.checked });
      renderContent();
    });
    row.appendChild(lbl);
    row.appendChild(cb);
    return row;
  }

  function makeSliderRow(label, value, min, max, step, key, unit) {
    const row = document.createElement("div");
    row.className = "overview-option-row overview-option-stacked";
    const top = document.createElement("div");
    top.className = "overview-option-row-top";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    const val = document.createElement("span");
    val.className = "overview-option-value";
    val.textContent = value + unit;
    top.appendChild(lbl);
    top.appendChild(val);
    row.appendChild(top);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = value;
    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      val.textContent = v + unit;
      state.settings[key] = v;
      state.updateSettings({ [key]: v });
      applyLiveStyles();
    });
    row.appendChild(slider);
    return row;
  }

  function setupScrollTracking(state) {
    if (scrollHandler) {
      state.editor?.view?.scrollDOM?.removeEventListener("scroll", scrollHandler);
    }
    if (selectionHandler) {
      document.removeEventListener("selectionchange", selectionHandler);
    }
    scrollHandler = () => {
      if (!state.editor) return;
      const view = state.editor.view;
      const rect = view.scrollDOM.getBoundingClientRect();
      const contentEl = view.contentDOM;
      const contentRect = contentEl.getBoundingClientRect();
      const x = contentRect.left + 10; // inside actual content area
      const y = rect.top + rect.height / 3; // 1/3 down viewport
      const pos = view.posAtCoords({ x, y });
      if (pos != null) {
        highlightForOffset(pos);
      }
    };
    // Document-level `selectionchange` is the simplest cross-source
    // cursor hook — fires on arrow keys, clicks, and pointer drags
    // inside CodeMirror's contentDOM. We pick up the live cursor from
    // the editor's own selection state to avoid round-tripping through
    // window.getSelection() ranges.
    selectionHandler = () => {
      if (!state.editor) return;
      const view = state.editor.view;
      if (!view.hasFocus) return;
      highlightForOffset(view.state.selection.main.head);
    };
    state.editor?.view?.scrollDOM?.addEventListener("scroll", scrollHandler);
    document.addEventListener("selectionchange", selectionHandler);
    // Initial highlight
    if (state.editor) {
      const pos = state.editor.view.state.selection.main.head;
      highlightForOffset(pos);
    }
  }

  /** Update both the active heading and the active paragraph for the
   *  given source offset, then scroll the outline so the active row is
   *  visible. Drives both editor-scroll and cursor-change handlers. */
  function highlightForOffset(offset) {
    highlightHeadingForOffset(offset);
    highlightParagraphForOffset(offset);
    // Prefer scrolling the paragraph into view when paragraphs are
    // rendered; otherwise fall back to the heading. Both branches share
    // the same scroll container (.overview-content) which scrolls
    // independently of the rest of the panel chrome.
    const target = activeParagraphEl || activeHeadingEl;
    if (target) scrollIntoOverview(target);
  }

  function highlightHeadingForOffset(offset) {
    if (headingEntries.length === 0) {
      setActiveHeading(null);
      return;
    }
    let candidate = headingEntries[0].element;
    for (const entry of headingEntries) {
      if (entry.offset <= offset) {
        candidate = entry.element;
      } else {
        break;
      }
    }
    setActiveHeading(candidate);
  }

  function highlightParagraphForOffset(offset) {
    if (paragraphEntries.length === 0) {
      setActiveParagraph(null);
      return;
    }
    // Pick the last paragraph whose offset is ≤ the cursor position —
    // matches how headings track. `Math.abs` would oscillate at the
    // boundary between two paragraphs (the next paragraph's start is
    // closer than the current one's start once the cursor is past the
    // midpoint), which is what made click-once feel half-resolved.
    let candidate = paragraphEntries[0];
    for (const entry of paragraphEntries) {
      if (entry.offset <= offset) candidate = entry;
      else break;
    }
    setActiveParagraph(candidate.element);
  }

  function setActiveHeading(el) {
    if (activeHeadingEl === el) return;
    if (activeHeadingEl) activeHeadingEl.classList.remove("is-active");
    activeHeadingEl = el;
    if (activeHeadingEl) activeHeadingEl.classList.add("is-active");
  }

  function setActiveParagraph(el) {
    if (activeParagraphEl === el) return;
    if (activeParagraphEl) activeParagraphEl.classList.remove("is-current-paragraph");
    activeParagraphEl = el;
    if (activeParagraphEl) activeParagraphEl.classList.add("is-current-paragraph");
  }

  /** Scroll the outline's content area so `el` sits roughly mid-viewport.
   *  Plain scrollIntoView would also nudge the *page* (the panel sits in
   *  a parent that scrolls) — instead we scroll just the overview-content
   *  container, which keeps the options panel pinned at the top. */
  function scrollIntoOverview(el) {
    const scroller = container.querySelector(".overview-content");
    if (!scroller || !scroller.contains(el)) return;
    const elRect = el.getBoundingClientRect();
    const sRect = scroller.getBoundingClientRect();
    if (elRect.top >= sRect.top && elRect.bottom <= sRect.bottom) return;
    const offsetTop = el.offsetTop;
    scroller.scrollTop = offsetTop - scroller.clientHeight / 2 + el.offsetHeight / 2;
  }

  function destroy() {
    if (scrollHandler && state.editor) {
      state.editor.view?.scrollDOM?.removeEventListener("scroll", scrollHandler);
    }
    if (selectionHandler) {
      document.removeEventListener("selectionchange", selectionHandler);
    }
    headingEntries = [];
    paragraphEntries = [];
    activeHeadingEl = null;
    activeParagraphEl = null;
    scrollHandler = null;
    selectionHandler = null;
  }

  // Listen for content changes to auto-refresh
  const onFileOpened = () => { if (!container.classList.contains("hidden")) render(); };
  state.on("file-opened", onFileOpened);

  // Debounced live refresh as the user types — the editor fires this
  // event on every keystroke via `state.markDirty`. Throttled so heavy
  // typing doesn't churn the outline on every input.
  let contentTimer = null;
  const onContentChanged = () => {
    if (container.classList.contains("hidden")) return;
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => { renderContent(); }, 250);
  };
  state.on("doc-content-changed", onContentChanged);

  return { render, destroy, onFileOpened };
}

// ===== Helper functions =====

function scrollToOffset(state, offset) {
  if (!state.editor) return;
  const view = state.editor.view;
  // `EditorView.scrollIntoView` is the only path that works for an
  // offset below the currently-rendered viewport — `coordsAtPos`
  // returns null for unrendered positions, so the previous manual
  // scrollTop calculation silently no-op'd whenever the target sat
  // beyond CodeMirror's measure window.
  const safe = Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({
    selection: { anchor: safe },
    effects: EditorView.scrollIntoView(safe, { y: "start", yMargin: 80 }),
  });
  view.focus();
}

function tokenizeContent(text, headings, flags) {
  const fragments = [];
  const items = [
    ...headings.map(h => ({ type: "heading", offset: h.startOffset, data: h })),
    ...flags.map(f => ({ type: "flag", offset: f.startOffset, data: f })),
  ].sort((a, b) => a.offset - b.offset);

  let cursor = 0;
  for (const item of items) {
    if (item.offset > cursor) {
      const before = text.substring(cursor, item.offset);
      if (before.trim()) fragments.push({ type: "text", text: before, startOffset: cursor });
    }
    if (item.type === "heading") {
      fragments.push({ type: "heading", heading: item.data });
      // Skip to end of heading line
      const nl = text.indexOf("\n", item.offset);
      cursor = nl === -1 ? text.length : nl + 1;
    } else {
      fragments.push({ type: "flag", flag: item.data });
      // Skip past the flag syntax
      const flagPattern = /==\w+:[^=]+==|%%[^%]+%%/;
      const match = text.substring(item.offset).match(flagPattern);
      cursor = match ? item.offset + match[0].length : item.offset;
    }
  }
  if (cursor < text.length) {
    const tail = text.substring(cursor);
    if (tail.trim()) fragments.push({ type: "text", text: tail, startOffset: cursor });
  }
  return fragments;
}

function createSectionStructure(container, level) {
  let el = container;
  for (let l = 2; l <= level; l++) {
    const hierarchy = document.createElement("div");
    hierarchy.className = "overview-hierarchy-level";
    el.appendChild(hierarchy);
    el = hierarchy;
  }
  const body = document.createElement("div");
  body.className = "overview-section-body";
  el.appendChild(body);
  return body;
}

function updateCalloutWrappers(contentEl, wrappers, activeStack, newStack, sectionColors) {
  const filteredStack = newStack.filter(c => c.type !== "SUMMARY");

  let commonLen = 0;
  while (commonLen < Math.min(activeStack.length, filteredStack.length) &&
         activeStack[commonLen].type === filteredStack[commonLen].type) {
    commonLen++;
  }

  wrappers = wrappers.slice(0, commonLen);
  let container = wrappers.length > 0 ? wrappers[wrappers.length - 1] : contentEl;

  for (let i = commonLen; i < filteredStack.length; i++) {
    const callout = filteredStack[i];
    const wrapper = document.createElement("div");
    wrapper.className = "overview-callout-bg";
    const color = sectionColors[callout.type] || "#086ddd";
    const rgb = hexToRgb(color);
    wrapper.style.backgroundColor = `rgba(${rgb.r},${rgb.g},${rgb.b},0.15)`;
    container.appendChild(wrapper);
    wrappers.push(wrapper);
    container = wrapper;
  }

  return { wrappers, stack: filteredStack, container };
}

function createFlagElement(flag, settings, state) {
  const el = document.createElement("div");
  el.className = "overview-flag";
  if (settings.overviewWrapFlagText) el.classList.add("wrap-flag-text");

  // Apply color from settings (flagColors map) or fall back to defaults
  const flagColors = settings.flagColors || {};
  const color = flagColors[flag.type] || DEFAULT_FLAG_COLORS[flag.type] || "#4488ff";
  const isMissing = flag.type === "MISSING";

  if (isMissing) {
    el.style.border = `1px dashed ${color}`;
    el.style.color = color;
    el.style.background = "transparent";
  } else {
    el.style.backgroundColor = color;
    el.style.color = getFgForBg(color);
  }

  const baseMessage = flag.message.split("|")[0]?.trim() ?? flag.message;
  const messageText = isMissing
    ? (baseMessage || "Missing")
    : (baseMessage ? getFirstWords(baseMessage, 10) : flag.type);

  if (settings.overviewShowFlagTypes && flag.type !== "COMMENT") {
    const typeSpan = document.createElement("span");
    typeSpan.className = "overview-flag-type";
    typeSpan.textContent = flag.type;
    el.appendChild(typeSpan);
    el.appendChild(document.createTextNode(": "));
  }

  const msgSpan = document.createElement("span");
  msgSpan.className = "overview-flag-message";
  if (isMissing) msgSpan.style.color = color;
  msgSpan.textContent = messageText;
  el.appendChild(msgSpan);

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    scrollToOffset(state, flag.startOffset);
  });

  return el;
}

function computeNumbering(allHeadings, heading) {
  const counters = [0, 0, 0, 0, 0, 0];
  for (const h of allHeadings) {
    const idx = Math.min(Math.max(h.level, 1), 6) - 1;
    counters[idx]++;
    for (let i = idx + 1; i < 6; i++) counters[i] = 0;
    if (h === heading) {
      const parts = [];
      for (let i = 0; i <= idx; i++) {
        if (counters[i] > 0) parts.push(String(counters[i]));
      }
      return parts.join(".");
    }
  }
  return "";
}

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function getFgForBg(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? "#1a1a1a" : "#f0f0f0";
}
