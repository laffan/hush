/**
 * Boot wiring for cards, called from main.js before the first editor
 * exists:
 *
 *   - the card element gets the pane editor factory (importing it there
 *     would close an import cycle through the shared extension list);
 *   - the notebook bundle, which doesn't import app modules, gets what
 *     its card layer needs through `window.__hushCards`;
 *   - a CARDS notebook left with no cards but other content is kept in
 *     the Inbox (card-home-rescue.js).
 */
import { createPaneEditor } from "../pane/pane-editor.js";
import { setCardEditorFactory, createCardElement } from "./card-element.js";
import { startCardDrag } from "./card-drag.js";
import { watchCanvasCardDrag } from "./card-canvas-drag.js";
import { insertAtRememberedCursor } from "./card-cursor.js";
import { canvasReturn } from "./card-return.js";
import { publishNotebookCards } from "./card-index.js";
import { watchEmptiedCardsHomes } from "./card-home-rescue.js";

export function initCards() {
  setCardEditorFactory(createPaneEditor);
  window.__hushCards = { createCardElement, startCardDrag, watchCanvasCardDrag, insertAtRememberedCursor, canvasReturn, publishNotebookCards };
  // A CARDS notebook losing its last card while it holds more than cards.
  watchEmptiedCardsHomes();
}
