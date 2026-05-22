/**
 * Tab-section helpers for the Outline View.
 *
 * Renders each `---Tab name---` marker as a foldable container at the
 * outline root and hands back a routing function that picks the right
 * container for a given source offset. The main `buildContent` loop in
 * `longview.js` calls `routeFor(offset)` for every fragment so headings,
 * paragraphs, and flags land inside the correct tab body.
 */

/**
 * Build a foldable container per parsed tab and append them to
 * `content`. Returns `{ routeFor, hasMarkers }` — `routeFor(offset)`
 * picks the deepest tab body whose `startOffset` ≤ `offset`, and
 * `hasMarkers` is true when there's at least one non-root tab.
 *
 * @param {HTMLElement} content - the outline content scroller
 * @param {Array<{title: string|null, startOffset: number, endOffset: number}>} tabs
 * @param {(offset: number) => void} onJumpTo - editor-jump callback for dblclick
 */
export function buildTabContainers(content, tabs, onJumpTo) {
  const hasMarkers = Array.isArray(tabs) && tabs.length > 1;
  if (!hasMarkers) {
    return { hasMarkers: false, routeFor: () => content };
  }
  const tabBodies = [];
  for (const t of tabs) {
    const wrapper = document.createElement("div");
    wrapper.className = "longview-tab";
    if (t.title) {
      const header = document.createElement("div");
      header.className = "longview-tab-header";
      header.dataset.offset = String(t.startOffset);
      // Chevron — folds the body. Lives inside the header so the
      // single-click-to-jump rule below can ignore clicks that
      // originate from this element.
      const chev = document.createElement("span");
      chev.className = "longview-tab-chevron";
      chev.textContent = "▾"; // ▾
      chev.setAttribute("aria-label", "Toggle section");
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        wrapper.classList.toggle("collapsed");
      });
      header.appendChild(chev);
      const label = document.createElement("span");
      label.className = "longview-tab-label";
      label.textContent = t.title;
      header.appendChild(label);
      // Single-click anywhere else on the header jumps the editor to
      // the marker. The chevron's stopPropagation keeps folding from
      // also scrolling.
      header.addEventListener("click", (e) => {
        if (e.target.closest(".longview-tab-chevron")) return;
        e.stopPropagation();
        onJumpTo(t.startOffset);
      });
      wrapper.appendChild(header);
    }
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
    return tabBodies[0].body;
  }
  return { hasMarkers: true, routeFor };
}
