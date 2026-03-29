/**
 * LongView — right sidebar minimap for document navigation.
 * Ported from obsidian-long-view for Hush.
 *
 * Renders a minimap with headings, condensed text, flags, and callout tinting.
 * Clicking headings/flags navigates the editor. The current heading is highlighted.
 */
import {
  parseDocument,
  computeHeadingCalloutStacks,
  sanitizeLine,
  getFirstWords,
} from "./longview-parser.js";
import { CALLOUT_COLORS, getCalloutColor } from "./callouts.js";

/** Default LongView settings */
export const LONGVIEW_DEFAULTS = {
  longviewShowParagraphs: true,
  longviewShowNumbers: true,
  longviewShowComments: false,
  longviewShowFlags: true,
  longviewShowFlagTypes: false,
  longviewWrapFlagText: true,
  longviewBodyFontSize: 3,
  longviewHeadingFontSize: 12,
  longviewFlagFontSize: 12,
  longviewLineGap: 2,
  longviewCurrentPositionColor: "#ff0000",
};

/**
 * Create and manage the LongView panel inside the right panel overlay.
 * @param {HTMLElement} container - The #right-panel-overlay element
 * @param {object} state - AppState instance
 */
export function createLongView(container, state) {
  let headingEntries = []; // { offset, element }
  let activeHeadingEl = null;
  let scrollHandler = null;

  function getSettings() {
    return { ...LONGVIEW_DEFAULTS, ...state.settings };
  }

  function render() {
    const s = getSettings();
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "longview-container";

    // Header with refresh button
    const header = document.createElement("div");
    header.className = "longview-header";
    const title = document.createElement("span");
    title.className = "longview-title";
    title.textContent = "Long View";
    header.appendChild(title);

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "longview-refresh-btn";
    refreshBtn.textContent = "↻";
    refreshBtn.title = "Refresh minimap";
    refreshBtn.addEventListener("click", render);
    header.appendChild(refreshBtn);
    wrapper.appendChild(header);

    // Filter bar
    const filters = document.createElement("div");
    filters.className = "longview-filters";
    filters.appendChild(makeToggle("Text", s.longviewShowParagraphs, "longviewShowParagraphs"));
    filters.appendChild(makeToggle("Numbers", s.longviewShowNumbers, "longviewShowNumbers"));
    filters.appendChild(makeToggle("Comments", s.longviewShowComments, "longviewShowComments"));
    filters.appendChild(makeToggle("Flags", s.longviewShowFlags, "longviewShowFlags"));
    wrapper.appendChild(filters);

    // Get content from editor
    const text = state.editor ? state.editor.getContent() : "";
    const { headings, flags, callouts } = parseDocument(text);

    // Compute callout stacks for each heading
    const sectionColors = { ...CALLOUT_COLORS, ...(s.longviewSectionColors || {}) };
    const calloutStacks = computeHeadingCalloutStacks(headings, sectionColors);

    // Build minimap content
    const content = document.createElement("div");
    content.className = "longview-content";
    content.style.setProperty("--lv-body-font", s.longviewBodyFontSize + "px");
    content.style.setProperty("--lv-heading-font", s.longviewHeadingFontSize + "px");
    content.style.setProperty("--lv-flag-font", s.longviewFlagFontSize + "px");
    content.style.setProperty("--lv-line-gap", s.longviewLineGap + "px");
    content.style.setProperty("--lv-position-color", s.longviewCurrentPositionColor);

    headingEntries = [];
    let currentLevel = 0;
    let flowEl = null;

    // Tokenize text into fragments
    const fragments = tokenizeContent(text, headings, flags);

    let openCalloutWrappers = [];
    let activeCalloutStack = [];

    for (const frag of fragments) {
      if (frag.type === "heading") {
        const h = frag.heading;
        const stack = calloutStacks.get(h.startOffset) || [];

        // Update callout wrappers
        const result = updateCalloutWrappers(content, openCalloutWrappers, activeCalloutStack, stack, sectionColors);
        openCalloutWrappers = result.wrappers;
        activeCalloutStack = result.stack;
        const parentEl = result.container;

        currentLevel = h.level;
        flowEl = createSectionStructure(parentEl, currentLevel);

        // Heading numbering
        const numbering = s.longviewShowNumbers ? computeNumbering(headings, h) : "";
        const headingEl = document.createElement("div");
        headingEl.className = "longview-heading";
        headingEl.dataset.offset = String(h.startOffset);
        headingEl.dataset.level = String(h.level);
        headingEl.textContent = numbering ? `${numbering} ${h.text}` : h.text;
        headingEl.addEventListener("click", (e) => {
          e.stopPropagation();
          scrollToOffset(state, h.startOffset);
        });
        flowEl.appendChild(headingEl);
        headingEntries.push({ offset: h.startOffset, element: headingEl });

        // Callout title
        if (h.callout) {
          const calloutTitle = document.createElement("div");
          calloutTitle.className = "longview-callout-title";
          const showType = s.longviewShowFlagTypes && h.callout.type !== "SUMMARY";
          if (showType) {
            const typeSpan = document.createElement("span");
            typeSpan.className = "longview-flag-type";
            typeSpan.textContent = h.callout.type;
            calloutTitle.appendChild(typeSpan);
            if (h.callout.title) {
              calloutTitle.appendChild(document.createTextNode(" — " + h.callout.title));
            }
          } else {
            calloutTitle.textContent = h.callout.title || "";
          }
          if (calloutTitle.textContent) flowEl.appendChild(calloutTitle);
        }
      } else if (frag.type === "text") {
        if (!flowEl) {
          const result = updateCalloutWrappers(content, openCalloutWrappers, activeCalloutStack, activeCalloutStack, sectionColors);
          openCalloutWrappers = result.wrappers;
          flowEl = createSectionStructure(result.container, currentLevel);
        }
        if (s.longviewShowParagraphs) {
          const lines = tokenizeLines(frag.text);
          for (const line of lines) {
            const p = document.createElement("p");
            p.className = "longview-line";
            p.textContent = line;
            flowEl.appendChild(p);
          }
        }
      } else if (frag.type === "flag") {
        if (!s.longviewShowFlags) continue;
        if (!s.longviewShowComments && frag.flag.type === "COMMENT") continue;
        if (!flowEl) {
          const result = updateCalloutWrappers(content, openCalloutWrappers, activeCalloutStack, activeCalloutStack, sectionColors);
          openCalloutWrappers = result.wrappers;
          flowEl = createSectionStructure(result.container, currentLevel);
        }
        const flagEl = createFlagElement(frag.flag, s, state);
        flowEl.appendChild(flagEl);
      }
    }

    wrapper.appendChild(content);
    container.appendChild(wrapper);

    // Set up scroll tracking
    setupScrollTracking(state);
  }

  function makeToggle(label, value, key) {
    const btn = document.createElement("button");
    btn.className = "longview-filter-btn" + (value ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      state.settings[key] = !state.settings[key];
      state.updateSettings({ [key]: state.settings[key] });
      render();
    });
    return btn;
  }

  function setupScrollTracking(state) {
    if (scrollHandler) {
      state.editor?.view?.scrollDOM?.removeEventListener("scroll", scrollHandler);
    }
    scrollHandler = () => {
      if (!state.editor) return;
      const view = state.editor.view;
      const scrollTop = view.scrollDOM.scrollTop;
      const visibleTop = scrollTop + 50; // small offset from top
      // Find the offset at the visible top position
      const pos = view.posAtCoords({ x: 0, y: visibleTop });
      if (pos != null) {
        highlightHeadingForOffset(pos);
      }
    };
    state.editor?.view?.scrollDOM?.addEventListener("scroll", scrollHandler);
    // Initial highlight
    if (state.editor) {
      const pos = state.editor.view.state.selection.main.head;
      highlightHeadingForOffset(pos);
    }
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

  function setActiveHeading(el) {
    if (activeHeadingEl === el) return;
    if (activeHeadingEl) activeHeadingEl.classList.remove("is-active");
    activeHeadingEl = el;
    if (activeHeadingEl) activeHeadingEl.classList.add("is-active");
  }

  function destroy() {
    if (scrollHandler && state.editor) {
      state.editor.view?.scrollDOM?.removeEventListener("scroll", scrollHandler);
    }
    headingEntries = [];
    activeHeadingEl = null;
    scrollHandler = null;
  }

  // Listen for content changes to auto-refresh
  const onFileOpened = () => { if (!container.classList.contains("hidden")) render(); };
  state.on("file-opened", onFileOpened);

  return { render, destroy, onFileOpened };
}

// ===== Helper functions =====

function scrollToOffset(state, offset) {
  if (!state.editor) return;
  const view = state.editor.view;
  view.dispatch({
    selection: { anchor: offset },
    scrollIntoView: true,
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

function tokenizeLines(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"))
    .map(l => sanitizeLine(l))
    .filter(l => l.length > 0);
}

function createSectionStructure(container, level) {
  let el = container;
  for (let l = 2; l <= level; l++) {
    const hierarchy = document.createElement("div");
    hierarchy.className = "longview-hierarchy-level";
    el.appendChild(hierarchy);
    el = hierarchy;
  }
  const body = document.createElement("div");
  body.className = "longview-section-body";
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
    wrapper.className = "longview-callout-bg";
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
  el.className = "longview-flag";
  const typeLower = flag.type.toLowerCase();
  el.classList.add(`longview-flag-type-${typeLower}`);
  if (flag.type === "MISSING") el.classList.add("is-missing-flag");
  if (settings.longviewWrapFlagText) el.classList.add("wrap-flag-text");

  const baseMessage = flag.message.split("|")[0]?.trim() ?? flag.message;
  const messageText = flag.type === "MISSING"
    ? (baseMessage || "Missing")
    : getFirstWords(baseMessage, 10);

  if (settings.longviewShowFlagTypes && flag.type !== "COMMENT") {
    const typeSpan = document.createElement("span");
    typeSpan.className = "longview-flag-type";
    typeSpan.textContent = flag.type;
    el.appendChild(typeSpan);
    el.appendChild(document.createTextNode(": "));
  }

  const msgSpan = document.createElement("span");
  msgSpan.className = "longview-flag-message";
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
