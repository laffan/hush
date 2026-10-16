/**
 * CodeMirror's default keymap, less the Option-↑ / Option-↓ line
 * commands: moving the caret's line up or down, and with Shift copying
 * it. In prose they mostly duplicated or shuffled a line by accident.
 * Outlines keep Option-↑ / ↓ — their own keymap (outline-view.js) moves
 * an item with its children, and claims nothing outside an outline.
 *
 * Both extension lists use this one (editor.js and base-extensions.js).
 */
import { defaultKeymap } from "@codemirror/commands";

const DROPPED = new Set(["Alt-ArrowUp", "Alt-ArrowDown", "Shift-Alt-ArrowUp", "Shift-Alt-ArrowDown"]);

export const hushDefaultKeymap = defaultKeymap.filter((b) => !DROPPED.has(b.key));
