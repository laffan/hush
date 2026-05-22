/**
 * Tab-section helpers for the Outline View.
 *
 * Every tab marker (top-level or nested) renders as a flat container
 * at the outline root in source order. The header carries a Google
 * Docs glyph + the full path label (`Parent / Child`) above a
 * dashed top rule; there's no folding chrome and no pill background.
 * The hierarchy is conveyed by the label itself rather than visual
 * indentation, so nested tabs read in-line with their siblings.
 *
 * Wrappers are pre-created in source order, so a fragment routed to
 * a tab body lands AFTER any preceding tab wrapper (fixes the bug
 * where the nested-tab wrapper inserted into the parent body
 * appeared before the parent's own paragraph fragments).
 */
import { GOOGLE_DOCS_ICON_SVG } from "../google-docs/icon.js";

/**
 * Build flat tab containers and append them to `content`.
 * Returns `{ routeFor, hasMarkers }` — `routeFor(offset)` picks the
 * tab body whose `startOffset` is the closest match ≤ `offset`, and
 * `hasMarkers` is true when at least one non-root tab exists.
 *
 * @param {HTMLElement} content - the outline content scroller
 * @param {Array<{ title: string|null, path: string[], depth: number, label: string, startOffset: number, endOffset: number }>} tabs
 * @param {(offset: number) => void} onJumpTo - editor-jump callback
 */
export function buildTabContainers(content, tabs, onJumpTo) {
  const markers = (Array.isArray(tabs) ? tabs : []).filter((t) => t?.path?.length);
  const hasMarkers = markers.length > 0;
  if (!hasMarkers) {
    return { hasMarkers: false, routeFor: () => content };
  }
  const sorted = markers.slice().sort((a, b) => a.startOffset - b.startOffset);
  const tabBodies = [];
  for (const t of sorted) {
    const wrapper = document.createElement("div");
    wrapper.className = "longview-tab";
    const header = document.createElement("div");
    header.className = "longview-tab-header";
    header.dataset.offset = String(t.startOffset);
    const icon = document.createElement("span");
    icon.className = "longview-tab-icon";
    icon.innerHTML = GOOGLE_DOCS_ICON_SVG;
    header.appendChild(icon);
    const label = document.createElement("span");
    label.className = "longview-tab-label";
    label.textContent = t.label || t.title || "";
    header.appendChild(label);
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      onJumpTo(t.startOffset);
    });
    wrapper.appendChild(header);
    const body = document.createElement("div");
    body.className = "longview-tab-body";
    wrapper.appendChild(body);
    content.appendChild(wrapper);
    tabBodies.push({ tab: t, body });
  }
  function routeFor(offset) {
    for (let i = tabBodies.length - 1; i >= 0; i--) {
      if (offset >= tabBodies[i].tab.startOffset) return tabBodies[i].body;
    }
    return content;
  }
  return { hasMarkers: true, routeFor };
}
