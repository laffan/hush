/**
 * iPhone keyboard behaviour for doc surfaces.
 *
 * CodeMirror writes `autocorrect="off"`, `autocapitalize="off"` and
 * `writingsuggestions="false"` onto every content element by default.
 * On iOS those are what drive the keyboard's QuickType bar — the row of
 * word predictions above the keys — so an iPhone writing in Hush got no
 * suggestions, no autocorrect and no capital at the start of a sentence:
 * a keyboard that felt broken next to every other text field on the
 * phone. On a phone the on-screen keyboard is the only one there is, so
 * the editor gives those back. `spellcheck` stays off: Hush has its own
 * Spellcheck mode, and two sets of red underlines would fight.
 *
 * Phone only. On the Mac `autocorrect` reaches the system's automatic
 * spelling correction, and an iPad is mostly typed on with a hardware
 * keyboard, where the bar is a strip along the bottom edge nobody asked
 * for.
 *
 * In both extension lists (editor.js and base-extensions.js) — the main
 * editor and every pane, stack column and overlay — per the rule in
 * README-TECHNICAL ("Every doc surface has to carry what the shared
 * extension list carries").
 */
import { EditorView } from "@codemirror/view";
import { isPhone } from "../settings/settings-ui.js";

export function phoneTextInputAttributes() {
  if (!isPhone()) return [];
  return EditorView.contentAttributes.of({
    autocorrect: "on",
    autocapitalize: "sentences",
    writingsuggestions: "true",
  });
}
