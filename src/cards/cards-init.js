/**
 * Boot wiring for cards, called from main.js before the first editor
 * exists:
 *
 *   - the card element gets the pane editor factory (importing it there
 *     would close an import cycle through the shared extension list);
 *   - the notebook bundle, which doesn't import app modules, gets what
 *     its card layer needs through `window.__hushCards`.
 */
import { createPaneEditor } from "../pane/pane-editor.js";
import { setCardEditorFactory, createCardElement } from "./card-element.js";
import { startCardDrag } from "./card-drag.js";
import { watchCanvasCardDrag } from "./card-canvas-drag.js";
import { insertAtRememberedCursor } from "./card-cursor.js";
import { publishNotebookCards } from "./card-index.js";

export function initCards() {
  setCardEditorFactory(createPaneEditor);
  window.__hushCards = { createCardElement, startCardDrag, watchCanvasCardDrag, insertAtRememberedCursor, publishNotebookCards };
}
