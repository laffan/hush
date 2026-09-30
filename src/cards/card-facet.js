/**
 * The CodeMirror primitives the card modules share.
 *
 * `insideCard` marks the editor inside a card. A card's text is edited in a real
 * CodeMirror editor built from the shared extension list (so a card
 * holds the same markdown a Doc does), and that list carries the card
 * plugin too — this facet is how the plugin knows it is running inside
 * a card and has nothing to find. Kept in its own module so the plugin
 * and the card element can both import it without importing each other.
 */
import { Annotation, Facet } from "@codemirror/state";

export const insideCard = Facet.define({ combine: (v) => v.some(Boolean) });

/** Marks a dispatch that is the card machinery's own: a body replay, a
 *  metadata write, a move, a delivery. The Doc plugin's boundary guard
 *  and its creation prompt both stand aside for it. */
export const cardEdit = Annotation.define();
