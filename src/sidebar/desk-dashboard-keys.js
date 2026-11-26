/**
 * The Desk Dashboard from the keyboard.
 *
 * The dashboard opens with the focus on the desk you are on — its name,
 * which is a button — so keys land in the dashboard rather than in the
 * editor behind it. From there:
 *
 * - **← → ↑ ↓** move between desk cards as they sit on screen: left and
 *   right along a row, up and down to the card nearest above or below
 *   (section bars are stepped over). **←** off the left end of a row goes
 *   to the sidebar's Recent list.
 * - **Enter** goes to the desk (the name's own click); **⌘ / Ctrl Enter**
 *   opens it in a new window, where windows are available.
 * - **Tab** jumps into the card: its YOU ARE HERE marker and recent files,
 *   which **↑ ↓** step through and **Enter** opens. **Tab**, **⇧Tab** or
 *   **Escape** jumps back out to the card. ↑ from the first item does too.
 * - In Recent, **↑ ↓** step through the files, **Enter** opens one, and
 *   **→**, **Tab** or **Escape** go back to the desks.
 * - **⇧Tab** on a card goes to Search all Desks; **↓** (with no results
 *   showing) or **Tab** there comes back (desk-dashboard-search.js's
 *   `onLeave`).
 *
 * The To-do list and every text field keep their own keys.
 *
 * What pointing at a card shows (its files' icons and times, the files at
 * full strength) also shows on the card the keyboard is on, but only once
 * a key has moved it: `.kb` goes on the overlay with a key this module
 * handles and comes off at the next pointer movement, so a card that
 * merely kept the focus after a click doesn't stay lit.
 */

const CARD = ".desk-dash-card";
const NAME = ".desk-dash-name";
const ITEMS = ".desk-dash-yah, .desk-dash-file";
const RECENT = ".desk-dash-recent-file";

const isField = (el) => el instanceof HTMLElement
  && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

/**
 * Wire the keys over the dashboard `root`. `activeDeskId` is where the
 * keyboard starts. Returns `{ focusStart, focusCard, remember, destroy }`:
 * `remember()` notes where the focus is in the grid and returns a function
 * that puts it back after the grid's markup is replaced.
 */
export function wireDashboardKeys(root, { activeDeskId = null } = {}) {
  const grid = root.querySelector(".desk-dash-grid");
  const side = root.querySelector(".desk-dash-recents");
  let deskId = activeDeskId; // the card the keyboard is on, across renders

  const cards = () => [...grid.querySelectorAll(CARD)];
  const cardById = (id) => cards().find((c) => c.dataset.deskId === id) || null;
  const currentCard = () => cardById(deskId) || cards()[0] || null;

  function focusCard(card) {
    if (!card) return false;
    deskId = card.dataset.deskId;
    const name = card.querySelector(NAME);
    if (!name) return false;
    name.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest" });
    return true;
  }
  function focusItem(el) {
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
    return true;
  }
  const focusStart = () => focusCard(currentCard());

  /** The card beside `cur` in its row, or null at the row's end. */
  function rowNeighbor(cur, dir) {
    const list = cards();
    const next = list[list.indexOf(cur) + dir];
    if (!next) return null;
    const a = cur.getBoundingClientRect();
    const b = next.getBoundingClientRect();
    return Math.abs(a.top - b.top) < Math.min(a.height, b.height) / 2 ? next : null;
  }
  /** The card in the nearest row above (`dir` -1) or below (+1), the one
   *  whose middle is closest to `cur`'s. Rows are read off the cards'
   *  tops, which a grid row shares however tall its cards are. */
  function columnNeighbor(cur, dir) {
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null;
    let bestTop = 0;
    let bestDx = Infinity;
    for (const c of cards()) {
      if (c === cur) continue;
      const cr = c.getBoundingClientRect();
      if (dir > 0 ? cr.top <= r.top + 1 : cr.top >= r.top - 1) continue;
      const dx = Math.abs(cr.left + cr.width / 2 - cx);
      const nearer = !best || (dir > 0 ? cr.top < bestTop - 1 : cr.top > bestTop + 1);
      const sameRow = best && Math.abs(cr.top - bestTop) <= 1;
      if (nearer || (sameRow && dx < bestDx)) { best = c; bestTop = cr.top; bestDx = dx; }
    }
    return best;
  }

  /** Keys on a card's name: moving between desks. */
  function onCardKey(e, card) {
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight") {
      const next = rowNeighbor(card, k === "ArrowLeft" ? -1 : 1);
      if (next) return focusCard(next);
      if (k === "ArrowLeft") return focusItem(side?.querySelector(RECENT)) || true;
      return true;
    }
    if (k === "ArrowUp" || k === "ArrowDown") {
      focusCard(columnNeighbor(card, k === "ArrowUp" ? -1 : 1));
      return true;
    }
    if (k === "Tab" && !e.shiftKey) {
      focusItem(card.querySelector(ITEMS));
      return true;
    }
    if (k === "Tab" && e.shiftKey) {
      root.querySelector(".desk-dash-search-input")?.focus();
      return true;
    }
    if (k === "Enter" && (e.metaKey || e.ctrlKey)) {
      card.querySelector('[data-action="new-window"]')?.click();
      return true;
    }
    return false;
  }

  /** Keys on a marker or file inside a card. */
  function onItemKey(e, card, item) {
    const k = e.key;
    const items = [...card.querySelectorAll(ITEMS)];
    const i = items.indexOf(item);
    if (k === "ArrowDown") { focusItem(items[i + 1]); return true; }
    if (k === "ArrowUp") return i > 0 ? focusItem(items[i - 1]) : focusCard(card);
    if (k === "Tab" || k === "Escape") return focusCard(card);
    if (k === "ArrowLeft" || k === "ArrowRight") {
      const next = rowNeighbor(card, k === "ArrowLeft" ? -1 : 1);
      if (next) return focusCard(next);
      if (k === "ArrowLeft") return focusItem(side?.querySelector(RECENT)) || true;
      return true;
    }
    return false;
  }

  /** Keys on a row of the sidebar's Recent list. */
  function onRecentKey(e, row) {
    const k = e.key;
    const rows = [...side.querySelectorAll(RECENT)];
    const i = rows.indexOf(row);
    if (k === "ArrowDown") { focusItem(rows[i + 1]); return true; }
    if (k === "ArrowUp") { focusItem(rows[i - 1]); return true; }
    if (k === "ArrowRight" || k === "Tab" || k === "Escape") return focusStart() || true;
    return false;
  }

  function onKey(e) {
    if (e.defaultPrevented || e.altKey) return;
    if ((e.metaKey || e.ctrlKey) && e.key !== "Enter") return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || isField(t) || t.closest(".desk-dash-todo")) return;
    let handled = false;
    const row = t.closest(RECENT);
    const card = t.closest(CARD);
    if (row && side?.contains(row)) handled = onRecentKey(e, row);
    else if (card && t.closest(NAME)) handled = onCardKey(e, card);
    else if (card && t.closest(ITEMS)) handled = onItemKey(e, card, t.closest(ITEMS));
    // Anywhere else in the dashboard (a card's icon, the close button, a
    // section's tools): the arrows and Tab pick the desks back up.
    else if (/^Arrow/.test(e.key) || e.key === "Tab") handled = card ? focusCard(card) : focusStart();
    if (!handled) return;
    e.preventDefault();
    // Escape here is "back out", not "close the dashboard".
    e.stopImmediatePropagation();
    root.classList.add("kb");
  }

  /** The focus left on <body> (a click on a card's background, say) or in
   *  the editor behind: the dashboard's keys still belong to it. Never
   *  while something is open over the dashboard. */
  function onStrayKey(e) {
    if (!/^Arrow/.test(e.key) && e.key !== "Tab") return;
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && root.contains(t)) return;
    const behind = !t || t === document.body || t === document.documentElement || !!t.closest("#app, .cm-editor");
    if (!behind || document.querySelector(".tree-delete-modal-backdrop")) return;
    if (!focusStart()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    root.classList.add("kb");
  }

  const offKb = () => root.classList.remove("kb");
  root.addEventListener("keydown", onKey);
  window.addEventListener("keydown", onStrayKey, true);
  root.addEventListener("pointermove", offKb);
  root.addEventListener("pointerdown", offKb);

  /** Note where the focus is in the grid; the returned function restores
   *  it once the grid has been rebuilt (the same card, the same row in it). */
  function remember() {
    const a = document.activeElement;
    if (!(a instanceof Element) || !grid.contains(a)) return () => {};
    const card = a.closest(CARD);
    const id = card?.dataset.deskId;
    const at = card ? [...card.querySelectorAll(ITEMS)].indexOf(a.closest(ITEMS)) : -1;
    return () => {
      const c = id ? cardById(id) : null;
      if (!c) return void focusStart();
      const items = c.querySelectorAll(ITEMS);
      if (at >= 0 && items.length) focusItem(items[Math.min(at, items.length - 1)]);
      else focusCard(c);
    };
  }

  return {
    focusStart,
    focusCard: (id) => focusCard(cardById(id) || currentCard()),
    remember,
    destroy() {
      window.removeEventListener("keydown", onStrayKey, true);
    },
  };
}
