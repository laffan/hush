/**
 * Keep the boxes around a canvas from being scrolled.
 *
 * An `overflow: hidden` element is still a scroll container — only the
 * user can't scroll it. The browser can: focusing an editable, or typing
 * past its edge, scrolls every scroll container above the caret until the
 * caret is in view. Editing a text shape near the right edge of a notebook
 * in a floating pane ran its textarea out past the pane, and WebKit
 * scrolled the pane's content box sideways to follow the caret — the
 * whole canvas shifted over inside the pane with no way to scroll it back
 * short of closing the pane. The same can happen to any hidden-overflow
 * box between the canvas and the window, the window itself included.
 *
 * So: a scroll of any element that holds the canvas's container and
 * whose overflow on that axis is `hidden` (or `clip`) is put straight
 * back. Real scrollers (`auto` / `scroll` — a gutter's host document)
 * are left alone.
 */

const UNSCROLLABLE = new Set(["hidden", "clip"]);

export function installScrollGuard(container: HTMLElement): () => void {
  const onScroll = (e: Event) => {
    const target = e.target === document ? document.scrollingElement : e.target;
    if (!(target instanceof Element) || !target.contains(container)) return;
    const cs = getComputedStyle(target);
    if (target.scrollLeft !== 0 && UNSCROLLABLE.has(cs.overflowX)) target.scrollLeft = 0;
    if (target.scrollTop !== 0 && UNSCROLLABLE.has(cs.overflowY)) target.scrollTop = 0;
  };
  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}
