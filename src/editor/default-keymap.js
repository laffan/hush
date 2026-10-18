/**
 * CodeMirror's default keymap, with Hush's own Option-↑ / Option-↓ in
 * place of CodeMirror's: they move the caret's line (or the selected
 * lines) up or down as in a code editor, but step over cards rather than
 * into them (editor/move-line.js). Shift-Option-↑ / ↓, which copy the
 * line, stay out — in prose they mostly duplicated a line by accident.
 * Outlines keep their own Option-↑ / ↓ (outline-view.js, `Prec.high`),
 * which moves an item with its children and claims nothing outside an
 * outline.
 *
 * Both extension lists use this one (editor.js and base-extensions.js).
 */
import { defaultKeymap } from "@codemirror/commands";
import { moveLineKeymap } from "./move-line.js";

const DROPPED = new Set(["Alt-ArrowUp", "Alt-ArrowDown", "Shift-Alt-ArrowUp", "Shift-Alt-ArrowDown"]);

export const hushDefaultKeymap = [...moveLineKeymap, ...defaultKeymap.filter((b) => !DROPPED.has(b.key))];
