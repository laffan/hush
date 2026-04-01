/**
 * Footnotes UI — overlay, marginalia, and drag/click handlers.
 * Extracted from footnotes.js to stay under the 700-line limit.
 */

// Shared UI state
const ui = { activeOverlay: null, editingOverlay: false };

export function isEditing() { return ui.editingOverlay; }
export function setEditing(val) { ui.editingOverlay = val; }
export function getActiveOverlay() { return ui.activeOverlay; }

export function closeOverlay() {
  if (ui.activeOverlay) {
    ui.activeOverlay.remove();
    ui.activeOverlay = null;
    ui.editingOverlay = false;
  }
}

export function getFootnoteSettings(stateRef) {
  const s = stateRef.settings || {};
  return {
    fontSize: s.footnoteFontSize || 100,
    fontFamily: s.footnoteFontFamily || "sans-serif",
    useColors: s.footnoteUseColors !== false,
  };
}

export function resolveFootnoteFont(fontFamily) {
  if (fontFamily === "match") return "var(--font-family)";
  if (fontFamily === "serif") return "'Georgia', 'Times New Roman', serif";
  return "system-ui, -apple-system, sans-serif";
}

export function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    fg: style.getPropertyValue("--fg").trim() || "#e0e0e0",
    bg: style.getPropertyValue("--bg").trim() || "#1a1a1a",
  };
}

// Dependency holder for findDefinitionRange (set from footnotes.js)
let _findDefRange = null;
export function setFindDefRange(fn) { _findDefRange = fn; }

export function syncFootnoteText(view, id, newText) {
  const doc = view.state.doc;
  const range = _findDefRange ? _findDefRange(doc, id) : null;
  if (range) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: newText }, scrollIntoView: false });
  } else {
    view.dispatch({ changes: { from: doc.length, insert: `\n[^${id}]: ${newText}` }, scrollIntoView: false });
  }
}

export function createEditableContent(id, defText, view, stateRef) {
  const fsettings = getFootnoteSettings(stateRef);
  const content = document.createElement("div");
  content.className = "footnote-overlay-content";
  content.contentEditable = "true";
  content.spellcheck = false;
  content.textContent = defText || "";
  content.style.fontFamily = resolveFootnoteFont(fsettings.fontFamily);
  content.dataset.footnoteId = id;
  content.addEventListener("mousedown", (e) => { e.stopPropagation(); ui.editingOverlay = true; });
  content.addEventListener("focus", () => { ui.editingOverlay = true; });
  content.addEventListener("blur", () => { ui.editingOverlay = false; });
  content.addEventListener("keydown", (e) => {
    // Cmd+Shift+M inside the overlay → save and close, return focus to editor
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "m") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
      view.focus();
      return;
    }
    e.stopPropagation();
  });
  content.addEventListener("keypress", (e) => e.stopPropagation());
  content.addEventListener("input", () => syncFootnoteText(view, id, content.textContent));
  return content;
}

function createMarginaliaText(id, defText, view) {
  const text = document.createElement("span");
  text.className = "footnote-marginalia-text";
  text.contentEditable = "true";
  text.spellcheck = false;
  text.textContent = defText;
  text.addEventListener("mousedown", (e) => { e.stopPropagation(); ui.editingOverlay = true; });
  text.addEventListener("keydown", (e) => e.stopPropagation());
  text.addEventListener("keypress", (e) => e.stopPropagation());
  text.addEventListener("focus", () => { ui.editingOverlay = true; });
  text.addEventListener("blur", () => { ui.editingOverlay = false; });
  text.addEventListener("input", () => { ui.editingOverlay = true; syncFootnoteText(view, id, text.textContent); });
  return text;
}

function resolveOverlaps(entries) {
  entries.sort((a, b) => a.naturalTop - b.naturalTop);
  const EST_HEIGHT = 24;
  for (let i = 0; i < entries.length; i++) {
    const prev = i > 0 ? entries[i - 1] : null;
    const desired = entries[i].naturalTop;
    entries[i].top = (prev && desired < prev.top + EST_HEIGHT + 20)
      ? prev.top + EST_HEIGHT + 20
      : desired;
  }
}

export function updateMarginalia(view, stateRef, deps) {
  const { FOOTNOTE_REF_RE, FOOTNOTE_DEF_RE, parseDefinitions, getColorForId, isWideMargin } = deps;
  document.querySelectorAll(".footnote-marginalia").forEach(el => el.remove());
  if (stateRef.privateMode || !isWideMargin()) return;

  const fsettings = getFootnoteSettings(stateRef);
  const doc = view.state.doc;
  const defs = parseDefinitions(doc);
  const scroller = view.scrollDOM;
  const scrollerRect = scroller.getBoundingClientRect();
  const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
  const paddingRight = parseInt(scroller.style.paddingRight) || 50;
  const colRight = scrollerRect.width - paddingRight;
  const fontCss = resolveFootnoteFont(fsettings.fontFamily);
  // "closest" = nearest side, "split" = alternate L/R, "left"/"right" = single side
  // Backwards compat: "both" maps to "closest"
  let marginSide = stateRef.settings.footnoteMarginSide || "closest";
  if (marginSide === "both") marginSide = "closest";

  const entries = [];
  let splitIndex = 0; // counter for "split" mode alternation

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (FOOTNOTE_DEF_RE.test(line.text)) continue;
    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(line.text)) !== null) {
      const id = match[1];
      const defText = defs.get(id);
      if (defText == null) continue;
      const from = line.from + match.index;
      const coords = view.coordsAtPos(from);
      if (!coords) continue;
      const refX = coords.left - scrollerRect.left;
      let placeLeft;
      if (marginSide === "left") placeLeft = true;
      else if (marginSide === "right") placeLeft = false;
      else if (marginSide === "split") { placeLeft = splitIndex % 2 === 0; splitIndex++; }
      else placeLeft = refX <= scrollerRect.width - refX; // "closest"
      entries.push({ id, defText, placeLeft, naturalTop: coords.top - scrollerRect.top + scroller.scrollTop });
    }
  }

  resolveOverlaps(entries.filter(e => e.placeLeft));
  resolveOverlaps(entries.filter(e => !e.placeLeft));

  for (const entry of entries) {
    const color = getColorForId(entry.id);
    const marg = document.createElement("div");
    marg.className = "footnote-marginalia";
    marg.dataset.footnoteId = entry.id;
    marg.style.fontFamily = fontCss;
    marg.style.fontSize = (12 * fsettings.fontSize / 100) + "px";

    const label = document.createElement("span");
    label.className = "footnote-marginalia-label";
    label.textContent = entry.id;
    if (fsettings.useColors) { label.style.backgroundColor = color; label.style.color = "#fff"; }
    else { const c = getThemeColors(); label.style.backgroundColor = c.fg; label.style.color = c.bg; }

    marg.appendChild(label);
    marg.appendChild(createMarginaliaText(entry.id, entry.defText, view));

    const margWidth = Math.min(200, (entry.placeLeft ? paddingLeft : paddingRight) - 40);
    marg.style.position = "absolute";
    marg.style.width = margWidth + "px";
    marg.style.top = entry.top + "px";
    marg.style.left = entry.placeLeft
      ? (paddingLeft - margWidth - 30) + "px"
      : (colRight + 30) + "px";

    scroller.appendChild(marg);
  }
}

let marginaliaTimeout = null;
export function debouncedUpdateMarginalia(view, stateRef, deps) {
  clearTimeout(marginaliaTimeout);
  marginaliaTimeout = setTimeout(() => updateMarginalia(view, stateRef, deps), 100);
}

export function showOverlayAt(el, id, view, stateRef, deps) {
  const { parseDefinitions } = deps;
  if (ui.activeOverlay && ui.activeOverlay.dataset.footnoteId === id) { closeOverlay(); return; }
  closeOverlay();

  const scroller = view.scrollDOM;
  const defs = parseDefinitions(view.state.doc);
  const defText = defs.get(id) || "";
  const elRect = el.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
  const paddingRight = parseInt(scroller.style.paddingRight) || 50;
  const top = elRect.bottom - scrollerRect.top + scroller.scrollTop + 4;

  _mountOverlay(id, defText, view, stateRef, scroller, scrollerRect, paddingLeft, paddingRight, top);
}

export function openFootnoteOverlayByPos(docPos, id, view, stateRef, deps) {
  const { parseDefinitions } = deps;
  if (ui.activeOverlay && ui.activeOverlay.dataset.footnoteId === id) { closeOverlay(); return; }
  closeOverlay();

  const scroller = view.scrollDOM;
  const defs = parseDefinitions(view.state.doc);
  const defText = defs.get(id) || "";
  const scrollerRect = scroller.getBoundingClientRect();
  const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
  const paddingRight = parseInt(scroller.style.paddingRight) || 50;
  const coords = view.coordsAtPos(docPos);
  const top = coords ? (coords.bottom - scrollerRect.top + scroller.scrollTop + 4) : 100;

  _mountOverlay(id, defText, view, stateRef, scroller, scrollerRect, paddingLeft, paddingRight, top);
}

function _mountOverlay(id, defText, view, stateRef, scroller, scrollerRect, paddingLeft, paddingRight, top) {
  const overlay = document.createElement("div");
  overlay.className = "footnote-overlay";
  overlay.dataset.footnoteId = id;

  const closeBtn = document.createElement("button");
  closeBtn.className = "footnote-overlay-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); closeOverlay(); });

  overlay.appendChild(closeBtn);
  overlay.appendChild(createEditableContent(id, defText, view, stateRef));

  overlay.style.position = "absolute";
  overlay.style.left = paddingLeft + "px";
  overlay.style.width = (scrollerRect.width - paddingLeft - paddingRight) + "px";
  overlay.style.top = top + "px";

  scroller.appendChild(overlay);
  ui.activeOverlay = overlay;

  // Focus the editable and place cursor at end for immediate keyboard editing
  const editable = overlay.querySelector(".footnote-overlay-content");
  if (editable) {
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Set up document-level event handlers for footnotes.
 */
export function setupFootnoteHandlers(stateRef, getCurrentView, deps, insertFootnote) {
  const { isWideMargin } = deps;

  document.addEventListener("mousedown", (e) => {
    if (ui.activeOverlay && !ui.activeOverlay.contains(e.target) &&
        !e.target.classList.contains("footnote-dot") && !ui.editingOverlay) {
      closeOverlay();
    }
    if (ui.editingOverlay) setTimeout(() => { ui.editingOverlay = false; }, 0);
  });

  // Underline footnote click/drag
  document.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".footnote-underline");
    if (!el) return;
    const id = el.dataset.footnoteId;
    const cv = getCurrentView();
    if (!id || !cv) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    let isDragging = false, ghost = null;
    const docText = cv.state.doc.toString();
    const refPattern = `[^${id}]`;
    const refFrom = docText.indexOf(refPattern);
    const refTo = refFrom >= 0 ? refFrom + refPattern.length : -1;

    function onMove(e2) {
      if (!isDragging && Math.abs(e2.clientX - startX) + Math.abs(e2.clientY - startY) > 6) {
        isDragging = true;
        closeOverlay();
        ghost = document.createElement("span");
        ghost.className = "footnote-dot footnote-drag-ghost";
        ghost.textContent = id;
        ghost.style.cssText = "position:fixed;pointer-events:none;opacity:0.7;z-index:10000;transform:scale(1.1);padding:2px 6px;border-radius:4px;font-size:12px;background:var(--fg);color:var(--bg);";
        document.body.appendChild(ghost);
      }
      if (ghost) { ghost.style.left = (e2.clientX - 8) + "px"; ghost.style.top = (e2.clientY - 8) + "px"; }
    }
    function onUp(e2) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      if (isDragging && refFrom >= 0) {
        const dropPos = cv.posAtCoords({ x: e2.clientX, y: e2.clientY });
        if (dropPos != null) {
          let insertAt = dropPos;
          if (insertAt > refFrom) insertAt -= (refTo - refFrom);
          cv.dispatch({ changes: [{ from: refFrom, to: refTo }, { from: insertAt, insert: refPattern }] });
        }
      } else {
        showOverlayAt(el, id, cv, stateRef, deps);
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  window.addEventListener("resize", () => {
    closeOverlay();
    const v = getCurrentView();
    if (v) debouncedUpdateMarginalia(v, stateRef, deps);
  });

  stateRef.on("layout-changed", () => {
    const v = getCurrentView();
    if (v) debouncedUpdateMarginalia(v, stateRef, deps);
  });

  document.addEventListener("dblclick", (e) => {
    const cv = getCurrentView();
    if (!cv || !isWideMargin()) return;
    if (stateRef.privateMode) return;
    if (e.target.closest(".footnote-marginalia, .footnote-overlay")) return;
    const scroller = cv.scrollDOM;
    const sr = scroller.getBoundingClientRect();
    const pl = parseInt(scroller.style.paddingLeft) || 50;
    const pr = parseInt(scroller.style.paddingRight) || 50;
    const relX = e.clientX - sr.left;
    if (relX >= pl - 10 && relX <= sr.width - pr + 10) return;

    // Find the nearest position in the text column at the click's Y coordinate
    // Use the edge of the text column closest to the click
    const textX = relX < pl ? pl + 5 + sr.left : sr.width - pr - 5 + sr.left;
    const pos = cv.posAtCoords({ x: textX, y: e.clientY });
    if (pos == null) return;

    // Walk forward to the end of the current word to insert after it
    const doc = cv.state.doc;
    const line = doc.lineAt(pos);
    const lineText = line.text;
    const offsetInLine = pos - line.from;
    let insertOffset = offsetInLine;
    // Advance past the current word (non-whitespace characters)
    while (insertOffset < lineText.length && /\S/.test(lineText[insertOffset])) insertOffset++;

    cv.dispatch({ selection: { anchor: line.from + insertOffset } });
    insertFootnote(cv);
  });
}
