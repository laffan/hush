/**
 * The PDF viewer's keyboard.
 *
 * **Which viewer a key is for.** Several viewers can be mounted at once
 * (the main one, panes, stack columns), so a key goes to one of them:
 * the viewer holding the focus (its pages take it on a click, its bar's
 * buttons on a press, the main viewer's pages when a PDF opens), else —
 * nothing focused — the viewer last pressed or scrolled in, else the
 * main viewer. Never while text is being typed (a doc, a text field, the
 * find bar), and never while something else holds the focus: a notebook
 * canvas's tool keys are bare letters too.
 *
 * **What.** ⌘+ / ⌘- / ⌘0 zoom (Ctrl elsewhere), ⌘F finds in the PDF, and
 * the settings' rebindable `shortcutPdf*` keys (Settings → Shortcuts →
 * PDF) work the view: each mode command presses its toolbar button, so
 * the keys and the bar can never disagree. The next / previous page keys
 * step through the pages — a whole set in the paged view, fold to fold
 * in the folded view — and ↓ / ↑ do the same as → / ←.
 *
 * The listener runs at window capture, ahead of the app's window-level
 * shortcuts: ⌘F there would open the find bar of the hidden document
 * editor behind a PDF. It only claims a key it acts on.
 *
 * **Steps count from the page last asked for**, not the one a smooth
 * scroll has reached so far, so pressing quickly while a page turn is
 * under way doesn't lose steps; the paged view's wheel uses the same
 * stepper. Fold steps centre the next fold (a fold opened to its page
 * goes to its top). "Open the fold" takes the fold under the pointer,
 * or the one at the centre of the view when the pointer isn't over one.
 */
import { matchesDomEvent } from "../shortcuts.js";

const viewers = new Set();
let lastActive = null;

const isEditable = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
  || el.tagName === "SELECT" || el.isContentEditable);
const usable = (v) => v.root.isConnected && v.root.offsetParent !== null && !v.isSuspended();

/** The viewer a keystroke is for, or null. */
function keyOwner() {
  const active = document.activeElement;
  if (isEditable(active)) return null;
  const live = [...viewers].filter(usable);
  if (active && active !== document.body && active !== document.documentElement) {
    const inside = live.find((v) => v.root.contains(active));
    if (inside) return inside;
    // Focus on a pane's frame: the PDF in it, if that is what it shows.
    // Anything else focused (a notebook canvas, a sidebar row) keeps its
    // keys — a notebook's tool keys are bare letters too.
    return live.find((v) => active.contains(v.root)) || null;
  }
  if (lastActive && live.includes(lastActive)) return lastActive;
  return live.find((v) => v.root.closest("#pdf-container")) || null;
}

const settings = () => window.__hushState__?.settings || {};

/** The view commands, by settings key. */
const COMMANDS = [
  ["shortcutPdfThumbnails", "thumbnails"],
  ["shortcutPdfOutline", "outline"],
  ["shortcutPdfFolded", "folded"],
  ["shortcutPdfFoldFilters", "foldFilters"],
  ["shortcutPdfExpandFold", "expandFold"],
  ["shortcutPdfHorizontal", "horizontal"],
  ["shortcutPdfVertical", "vertical"],
  ["shortcutPdfFit1", "fit1"],
  ["shortcutPdfFit2", "fit2"],
  ["shortcutPdfFit3", "fit3"],
  ["shortcutPdfPaged", "paged"],
  ["shortcutPdfContinuous", "continuous"],
  ["shortcutPdfNextPage", "next"],
  ["shortcutPdfPrevPage", "prev"],
];

/** The command a keydown names, or null. */
function commandFor(e) {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  if (plain && e.key === "ArrowDown") return "next";
  if (plain && e.key === "ArrowUp") return "prev";
  const s = settings();
  for (const [key, cmd] of COMMANDS) if (s[key] && matchesDomEvent(e, s[key])) return cmd;
  if (s.shortcutQuickFind && matchesDomEvent(e, s.shortcutQuickFind)) return "find";
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
    if (e.key === "=" || e.key === "+") return "zoomIn";
    if (e.key === "-") return "zoomOut";
    if (e.key === "0") return "zoomReset";
  }
  return null;
}

function onKeydown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const cmd = commandFor(e);
  if (!cmd) return;
  const v = keyOwner();
  if (!v) return;
  e.preventDefault();
  e.stopPropagation();
  v.run(cmd);
}

/**
 * Register a viewer for the keyboard.
 * @param {object} v
 * @param {HTMLElement} v.root       The viewer's root
 * @param {HTMLElement} v.scrollArea Its pages (fold steps, the pointer)
 * @param {object} v.tb              Its toolbar record (pdf-toolbar-build.js)
 * @param {function} v.isSuspended   () => boolean
 * @param {function} v.isFolded      () => boolean
 * @param {function} v.foldElements  () => HTMLElement[] — the folds, in order
 * @param {function} v.stepZoom      (dir) => void
 * @param {function} v.resetZoom     () => void — ⌘0, back to the default layout
 * @param {function} v.pageCount     () => number
 * @param {function} v.stepSize      () => number — the set's size in the paged view, else one
 * @param {function} v.currentPage   () => number
 * @param {function} v.goToPage      (n) => void
 * @param {function} v.openFind      () => void
 * @returns {{ stepPage: (dir) => void, detach: () => void }}
 */
export function attachViewerKeys(v) {
  const { root, scrollArea, tb } = v;
  let pointer = null;
  const onPointerMove = (e) => { pointer = { x: e.clientX, y: e.clientY }; };
  const onPointerLeave = () => { pointer = null; };
  const claim = () => { lastActive = entry; };
  scrollArea.addEventListener("pointermove", onPointerMove);
  scrollArea.addEventListener("pointerleave", onPointerLeave);
  root.addEventListener("pointerdown", claim, true);
  root.addEventListener("wheel", claim, { passive: true, capture: true });
  root.addEventListener("focusin", claim);

  let pageTarget = null;
  function stepPage(dir) {
    const count = v.pageCount();
    if (!count) return;
    const recent = pageTarget && performance.now() - pageTarget.at < 700;
    const from = recent ? pageTarget.page : v.currentPage();
    const page = Math.max(1, Math.min(count, from + dir * v.stepSize()));
    pageTarget = { page, at: performance.now() };
    v.goToPage(page);
  }

  /** The fold across the middle of the view, else the nearest. */
  function centreFold(list) {
    const mid = scrollArea.scrollTop + scrollArea.clientHeight / 2;
    let best = -1;
    let bestD = Infinity;
    list.forEach((f, i) => {
      const d = f.offsetTop > mid ? f.offsetTop - mid : Math.max(0, mid - (f.offsetTop + f.offsetHeight));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  let foldTarget = null;
  function stepFold(dir) {
    const list = v.foldElements();
    if (!list.length) return;
    const recent = foldTarget && performance.now() - foldTarget.at < 700;
    const from = recent ? foldTarget.idx : centreFold(list);
    const idx = Math.max(0, Math.min(list.length - 1, from + dir));
    foldTarget = { idx, at: performance.now() };
    const f = list[idx];
    // A strip is centred; a fold opened to its page starts at the top.
    const tall = f.offsetHeight > scrollArea.clientHeight * 0.8;
    const top = tall ? f.offsetTop - 12 : f.offsetTop + f.offsetHeight / 2 - scrollArea.clientHeight / 2;
    scrollArea.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function expandFold() {
    if (!v.isFolded()) return;
    const under = pointer ? document.elementFromPoint(pointer.x, pointer.y)?.closest(".pdf-fold-wrapper") : null;
    const list = v.foldElements();
    const fold = under || list[centreFold(list)];
    fold?.querySelector(".pdf-fold-toggle")?.click();
  }

  const shown = (el) => el.style.display !== "none";
  /** The fit buttons show only where they apply (vertical scroll, or
   *  the paged view); from horizontal scroll, pressing one goes vertical. */
  function fit(btn) {
    if (!shown(tb.fitToggleWrap)) tb.scrollVBtn.click();
    btn.click();
  }

  const entry = {
    root,
    isSuspended: v.isSuspended,
    run(cmd) {
      switch (cmd) {
        case "thumbnails": return tb.thumbnailBtn.click();
        case "outline": return shown(tb.outlineBtn) && tb.outlineBtn.click();
        case "horizontal": return tb.scrollHBtn.click();
        case "vertical": return tb.scrollVBtn.click();
        case "fit1": return fit(tb.fitOneBtn);
        case "fit2": return fit(tb.fitTwoBtn);
        case "fit3": return fit(tb.fitThreeBtn);
        case "paged": return tb.pagedBtn.click();
        case "continuous": return tb.continuousBtn.click();
        case "folded": return tb.foldBtn.click();
        case "foldFilters":
          if (!v.isFolded()) tb.foldBtn.click();
          return tb.foldFilterBtn.click();
        case "expandFold": return expandFold();
        case "next":
        case "prev":
          return v.isFolded() ? stepFold(cmd === "next" ? 1 : -1) : stepPage(cmd === "next" ? 1 : -1);
        case "find": return v.openFind();
        case "zoomIn": return v.stepZoom(1);
        case "zoomOut": return v.stepZoom(-1);
        case "zoomReset": return v.resetZoom();
      }
    },
  };
  if (!viewers.size) window.addEventListener("keydown", onKeydown, true);
  viewers.add(entry);

  return {
    stepPage,
    detach() {
      viewers.delete(entry);
      if (lastActive === entry) lastActive = null;
      scrollArea.removeEventListener("pointermove", onPointerMove);
      scrollArea.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("pointerdown", claim, true);
      root.removeEventListener("wheel", claim, { capture: true });
      root.removeEventListener("focusin", claim);
      if (!viewers.size) window.removeEventListener("keydown", onKeydown, true);
    },
  };
}
