/**
 * Tooltips for the viewer's bottom toolbar, whose buttons are mostly
 * bare glyphs. A `title` tooltip never shows on iPad: a finger has no
 * hover, and iPadOS's web views don't draw them for a trackpad pointer
 * either. So the titles are drawn here — after a moment's hover with a
 * mouse, trackpad or pencil, and on a press-and-hold with a finger. A
 * hold that brought up its tooltip doesn't count as a tap, so asking
 * what a button does never does it.
 *
 * A button that stands for a keyboard shortcut (`data-shortcut`: a
 * settings key such as `shortcutPdfFolded`, or a fixed combo such as
 * `Mod+=`) shows the key after its text, dimmed — looked up as it
 * shows, so a rebinding in Settings is what it says.
 */

const HOVER_MS = 450;
const HOLD_MS = 450;
const HOLD_SHOWN_MS = 1600;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(ad|hone|od)/.test(navigator.platform || navigator.userAgent || "");

/** A stored shortcut ("Mod+Shift+F") as the keys read ("⌘⇧F"). */
export function shortcutText(raw) {
  if (!raw) return "";
  const names = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Backspace: "⌫", Enter: "↩", Escape: "Esc", " ": "Space",
  };
  const parts = raw.split("+").filter(Boolean);
  const out = parts.map((p) => {
    if (/^(CmdOrCtrl|Mod)$/i.test(p)) return IS_MAC ? "⌘" : "Ctrl+";
    if (/^(Cmd|Meta)$/i.test(p)) return IS_MAC ? "⌘" : "Win+";
    if (/^Ctrl$/i.test(p)) return IS_MAC ? "⌃" : "Ctrl+";
    if (/^Shift$/i.test(p)) return IS_MAC ? "⇧" : "Shift+";
    if (/^(Alt|Option)$/i.test(p)) return IS_MAC ? "⌥" : "Alt+";
    return names[p] || (p.length === 1 ? p.toUpperCase() : p);
  });
  return out.join("");
}

/** The key a `data-shortcut` names, as currently bound — none when the
 *  action has been left without one. */
function shortcutLabel(ref) {
  if (!ref) return "";
  if (/^shortcut[A-Z]/.test(ref)) return shortcutText(window.__hushState__?.settings?.[ref] || "");
  return shortcutText(ref);
}

export function attachTooltips(bar, host) {
  const tip = document.createElement("div");
  tip.className = "pdf-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.style.display = "none";
  host.appendChild(tip);

  let showTimer = 0;
  let hideTimer = 0;
  let shownFor = null;
  let held = null;
  let swallowClick = false;

  /** The element's tooltip text. Its `title` moves to `data-tip` the
   *  first time it is met (and after any later change), so the
   *  browser's own tooltip doesn't show as well where it would. */
  function textOf(el) {
    const t = el.getAttribute("title");
    if (t) {
      el.dataset.tip = t;
      el.removeAttribute("title");
      if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", t);
    }
    return el.dataset.tip || "";
  }
  const targetOf = (e) => {
    const el = e.target instanceof Element ? e.target.closest("[title], [data-tip]") : null;
    return el && bar.contains(el) ? el : null;
  };

  function show(el) {
    const text = textOf(el);
    if (!text || !el.isConnected) return;
    shownFor = el;
    tip.textContent = text;
    const keys = shortcutLabel(el.dataset.shortcut);
    if (keys) {
      const k = document.createElement("span");
      k.className = "pdf-tooltip-keys";
      k.textContent = keys;
      tip.appendChild(k);
    }
    tip.style.display = "";
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = r.left - h.left + r.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(6, Math.min(left, h.width - tip.offsetWidth - 6))}px`;
    tip.style.top = `${r.top - h.top - tip.offsetHeight - 6}px`;
  }
  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    shownFor = null;
    tip.style.display = "none";
  }

  for (const el of bar.querySelectorAll("[title]")) textOf(el);

  const onOver = (e) => {
    if (e.pointerType === "touch") return;
    const el = targetOf(e);
    if (el === shownFor) return;
    hide();
    if (el) showTimer = setTimeout(() => show(el), HOVER_MS);
  };
  const onOut = (e) => {
    if (e.pointerType === "touch") return;
    const el = targetOf(e);
    if (el && !el.contains(e.relatedTarget)) hide();
  };
  const onDown = (e) => {
    hide();
    held = null;
    if (e.pointerType !== "touch") return;
    const el = targetOf(e);
    if (!el) return;
    held = { el, x: e.clientX, y: e.clientY };
    showTimer = setTimeout(() => {
      show(el);
      swallowClick = true;
      hideTimer = setTimeout(hide, HOLD_SHOWN_MS);
    }, HOLD_MS);
  };
  const onMove = (e) => {
    if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 10) {
      held = null;
      clearTimeout(showTimer);
    }
  };
  const onUp = () => {
    held = null;
    if (!shownFor) clearTimeout(showTimer);
  };
  const onClick = (e) => {
    if (!swallowClick) { hide(); return; }
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  // A long press would otherwise bring up the system's own menu.
  const onContextMenu = (e) => { if (targetOf(e)) e.preventDefault(); };

  bar.addEventListener("pointerover", onOver);
  bar.addEventListener("pointerout", onOut);
  bar.addEventListener("pointerdown", onDown);
  bar.addEventListener("pointermove", onMove);
  bar.addEventListener("pointerup", onUp);
  bar.addEventListener("pointercancel", onUp);
  bar.addEventListener("click", onClick, true);
  bar.addEventListener("contextmenu", onContextMenu);

  return () => {
    hide();
    tip.remove();
  };
}
