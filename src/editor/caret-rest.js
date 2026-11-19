/**
 * The caret at rest — an editor the keyboard isn't in.
 *
 * When focus leaves an editor (another pane, the main editor, the
 * sidebar, the palette) or the app itself goes to the background, the
 * editor's caret stays where it was, greyed and faded and not blinking,
 * rather than vanishing or carrying on at full colour. It's the caret's
 * half of the two-state colouring the line indicator already has
 * (`line-indicator.js`, `hush-line-ind-muted`): every surface shows
 * where its caret sits, and only the one that will take the next key
 * shows it lit.
 *
 * The plugin marks `view.dom` with `data-caret="rest"` and editor.css
 * draws the rest. An attribute rather than a class: CodeMirror owns the
 * editor's `class` and rewrites it on every focus change. And the plugin
 * listens to the window's own focus and blur as well as the editor's:
 * CodeMirror only re-reads focus on a focus event inside the editor, so
 * its `cm-focused` can outlive the app being switched away from, which
 * would leave a lit, blinking caret behind in a window that isn't
 * taking keys.
 *
 * In both extension lists (editor.js's own and `createBaseExtensions`).
 */
import { ViewPlugin } from "@codemirror/view";

export const caretRestPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.timer = 0;
    // Read once the focus has settled: during a blur the element that
    // gains focus isn't active yet, and the document can still report
    // the focus it is losing.
    this.schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.apply(), 0);
    };
    this.win = view.dom.ownerDocument.defaultView || window;
    this.win.addEventListener("focus", this.schedule);
    this.win.addEventListener("blur", this.schedule);
    view.dom.addEventListener("focusin", this.schedule);
    view.dom.addEventListener("focusout", this.schedule);
    this.apply();
  }

  update(update) {
    if (update.focusChanged) this.schedule();
  }

  apply() {
    // `hasFocus` is the document's focus and the editor's together (with
    // CodeMirror's allowance for Safari's context menu, so opening one
    // doesn't grey the caret it was opened from).
    if (this.view.hasFocus) this.view.dom.removeAttribute("data-caret");
    else this.view.dom.setAttribute("data-caret", "rest");
  }

  destroy() {
    clearTimeout(this.timer);
    this.win.removeEventListener("focus", this.schedule);
    this.win.removeEventListener("blur", this.schedule);
    this.view.dom.removeEventListener("focusin", this.schedule);
    this.view.dom.removeEventListener("focusout", this.schedule);
  }
});
