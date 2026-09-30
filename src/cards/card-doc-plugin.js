/**
 * Cards in a Doc.
 *
 * Once a `<<<` … `>>>` chunk is recognised it leaves the editing of the
 * text: the whole span is replaced by a block widget holding the card
 * (card-element.js), registered atomic so the caret steps over it the
 * way it steps over any widget. The only ways back into the text are
 * copying the card's words out, or its insert-at-cursor button. A card
 * pulled into the margin leaves only a zero-height anchor in the text and
 * is drawn by the float layer instead (card-doc-float.js); both kinds are
 * wired to the document by the same `bindCard`.
 *
 * The card's body is edited in the card's own editor, and the two stay
 * one document the way the pinned outline and its panel do: each edit
 * is replayed onto the host at the body's offset (outside the host's
 * undo history — the card keeps its own), and whenever the host's copy
 * changes under the card (undo in the host, a sync pull, a refused
 * edit), the card takes it back as a programmatic diff. Which card a
 * widget is comes from where its DOM sits (`posAtDOM`), re-read at every
 * use, so nothing holds an offset that can go stale; a floating card's
 * entry follows its offset through every change instead.
 *
 * Three things protect the fences from the text around them:
 *
 *   - **The boundary guard.** A caret parked at a card's first or last
 *     offset would type onto the `<<<` or `>>>` line and dissolve the
 *     card; a deletion that pulls the next line up onto `>>>` would do
 *     the same. The filter pushes such text onto a line of its own
 *     instead (so Backspace at the start of the line after a card does
 *     nothing, rather than eating the fence).
 *   - **Refusing edits inside.** Nothing but the card's own replay
 *     (`cardEdit`) may change the span partway.
 *   - **The card editor's fence guard**, which refuses a `<<<` / `>>>`
 *     line inside the card.
 *
 * A card made by typing or pasting that holds more than
 * `CARD_CONFIRM_WORDS` asks first; declining takes the fence the edit
 * wrote back out, and the words stay as plain text.
 */

import { EditorView, Decoration, WidgetType, keymap } from "@codemirror/view";
import { EditorState, StateField, Transaction, Text, Facet, Prec } from "@codemirror/state";
import { insideCard, cardEdit } from "./card-facet.js";
import { createCardElement } from "./card-element.js";
import { startCardDrag } from "./card-drag.js";
import { noteHostView } from "./card-cursor.js";
import { confirmLongCard } from "./card-confirm.js";
import { CardAnchorWidget, createCardFloatLayer } from "./card-doc-float.js";
import {
  findCardsInDoc, serializeCard, cardSize, cardWordCount, isFloating,
  CARD_HEADER_HEIGHT, CARD_CONFIRM_WORDS,
} from "./card-model.ts";
import { programmaticChange } from "../editor/base-extensions.js";


/** The app state, for widgets built inside the view. */
const cardAppState = Facet.define({ combine: (v) => v[0] || null });

const EMPTY = { cards: [], deco: Decoration.none };

function buildCards(state) {
  if (state.facet(insideCard)) return EMPTY;
  const cards = findCardsInDoc(state.doc);
  if (!cards.length) return EMPTY;
  // A card in the text is a block holding it; one floating in the margin
  // leaves only a zero-height anchor (card-doc-float.js draws it).
  const deco = Decoration.set(cards.map((c) => Decoration.replace({
    widget: isFloating(c.meta) ? new CardAnchorWidget() : new CardWidget(c),
    block: true,
  }).range(c.from, c.to)));
  return { cards, deco };
}

/** Text that could start, end or re-pair a card: fences, code fences,
 *  frontmatter / metadata breaks, a metadata line. */
const FENCE_HINT = /<<<|>>>|```|~~~|---|%%card /;

/** Whether an edit can have changed which cards there are. Most typing
 *  can't — it touches no card and writes no fence — and then the cards
 *  are only shifted, not re-found: a scan per keystroke is a pass over
 *  every line of the document. */
function needsRescan(tr, cards) {
  let rescan = false;
  const a = tr.startState.doc;
  const b = tr.state.doc;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (rescan) return;
    for (const c of cards) {
      if (fromA <= c.to + 1 && toA >= c.from - 1) { rescan = true; return; }
    }
    if (FENCE_HINT.test(a.sliceString(a.lineAt(fromA).from, a.lineAt(toA).to))
      || FENCE_HINT.test(b.sliceString(b.lineAt(fromB).from, b.lineAt(toB).to))) rescan = true;
  });
  return rescan;
}

export const cardField = StateField.define({
  create: buildCards,
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (!value.cards.length || tr.state.facet(insideCard) || needsRescan(tr, value.cards)) return buildCards(tr.state);
    const map = (p) => tr.changes.mapPos(p);
    return {
      cards: value.cards.map((c) => ({ ...c, from: map(c.from), to: map(c.to), bodyFrom: map(c.bodyFrom), bodyTo: map(c.bodyTo) })),
      deco: value.deco.map(tr.changes),
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).deco),
  ],
});

/** The card a widget's DOM stands for, as the document holds it now. */
function locateCard(view, dom) {
  let pos;
  try { pos = view.posAtDOM(dom); } catch (_) { return null; }
  const cards = view.state.field(cardField, false)?.cards || [];
  return cards.find((c) => pos >= c.from && pos <= c.to) || null;
}

/** The span a card's removal takes: its lines plus one newline, so no
 *  blank line is left where it was. */
export function cardRemovalRange(doc, span) {
  if (span.to < doc.length) return { from: span.from, to: span.to + 1 };
  if (span.from > 0) return { from: span.from - 1, to: span.to };
  return { from: span.from, to: span.to };
}

/** Rewrite a card's metadata (colour, collapse, size). */
export function writeCardMeta(view, span, meta) {
  view.dispatch({
    changes: { from: span.from, to: span.to, insert: serializeCard(span.body, meta) },
    annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
  });
}

class CardWidget extends WidgetType {
  constructor(span) {
    super();
    this.body = span.body;
    this.meta = span.meta;
    this.metaKey = span.metaText || "";
  }

  eq(other) { return other.body === this.body && other.metaKey === this.metaKey; }

  get estimatedHeight() {
    return (this.meta.collapsed ? CARD_HEADER_HEIGHT : cardSize(this.meta).height) + 12;
  }

  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "cm-card-block";
    wrap._cardBinding = bindCard(view, wrap, this, () => locateCard(view, wrap));
    return wrap;
  }

  updateDOM(dom) {
    const b = dom._cardBinding;
    if (!b) return false;
    b.take(this);
    return true;
  }

  destroy(dom) { dom._cardBinding?.destroy(); }

  // The card holds its own editor: every event inside it is its own.
  ignoreEvent() { return true; }
}

/**
 * Wire one card element to the host editor. `host` is the element the
 * card goes in — the block widget's, or a floating card's in the float
 * layer — and `locate` finds the card's span in the document as it
 * stands now.
 */
function bindCard(view, host, widget, locate) {
  const appState = view.state.facet(cardAppState);
  let pending = null;
  let scheduled = false;
  const wrap = host;

  const flush = () => {
    scheduled = false;
    const changes = pending;
    pending = null;
    if (!changes || !wrap.isConnected) return;
    const span = locate();
    if (!span) return;
    if (span.body.length !== changes.length) { card.setBody(span.body); return; }
    const annotations = [cardEdit.of(true), Transaction.addToHistory.of(false), Transaction.userEvent.of("input.card")];
    if (span.hasBodyLine) {
      const spec = [];
      changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
        spec.push({ from: span.bodyFrom + fromA, to: span.bodyFrom + toA, insert: inserted.toString() });
      });
      view.dispatch({ changes: spec, annotations });
    } else {
      const next = changes.apply(Text.of(span.body.split("\n"))).toString();
      view.dispatch({ changes: { from: span.from, to: span.to, insert: serializeCard(next, span.meta) }, annotations });
    }
    // A host filter (ratchet, the document's word cap) may have refused
    // or trimmed the replay: the document is the truth.
    const after = locate();
    if (after && after.body !== card.getBody()) card.setBody(after.body);
  };

  const card = createCardElement({
    appState,
    body: widget.body,
    meta: widget.meta,
    surface: "doc",
    onEdit(update) {
      pending = pending ? pending.compose(update.changes) : update.changes;
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    },
    getScale: () => view.scaleX || 1,
    onEscape() {
      const span = locate();
      view.focus();
      if (span) view.dispatch({ selection: { anchor: Math.min(span.to + 1, view.state.doc.length) } });
    },
    onAction(action, _e, arg) {
      if (pending) flush();
      const span = locate();
      if (!span) return;
      if (action === "color") writeCardMeta(view, span, { ...span.meta, bgColor: arg || undefined });
      else if (action === "collapse") writeCardMeta(view, span, { ...span.meta, collapsed: !span.meta.collapsed });
      else if (action === "delete") {
        view.dispatch({
          changes: { ...cardRemovalRange(view.state.doc, span), insert: "" },
          annotations: [cardEdit.of(true), Transaction.userEvent.of("delete.card")],
        });
      } else if (action === "insert") insertCardAtCursor(view, span);
    },
    onResize(width, height) {
      const span = locate();
      if (span) writeCardMeta(view, span, { ...span.meta, width, height });
    },
    onHeaderDown(e) {
      if (pending) flush();
      const span = locate();
      if (!span) return;
      startCardDrag({
        appState,
        body: span.body,
        meta: span.meta,
        initialEvent: e,
        source: { kind: "doc", view, wrap, locate },
      });
    },
  });
  wrap.appendChild(card.el);

  return {
    take(w) {
      // Edits still on their way to the host are newer than the host's
      // copy; the replay brings the two back together.
      if (!pending) card.setBody(w.body);
      card.setMeta(w.meta);
    },
    destroy() {
      if (pending) flush();
      card.destroy();
    },
  };
}

/** Insert-at-cursor from a card in a Doc: the card's words go in at the
 *  document's caret (its last place, which a press on the card's header
 *  doesn't move), and the card itself leaves — one undo step. */
function insertCardAtCursor(view, span) {
  const head = view.state.selection.main.head;
  const body = span.body;
  if (head >= span.from && head <= span.to) {
    view.dispatch({
      changes: { from: span.from, to: span.to, insert: body },
      selection: { anchor: span.from + body.length },
      annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
    });
  } else {
    const del = cardRemovalRange(view.state.doc, span);
    const changes = view.state.changes([{ from: head, insert: body }, { ...del, insert: "" }]);
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(head, 1) },
      annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
    });
  }
  view.focus();
}

/**
 * Keep typing and deleting next to a card off its fence lines. Runs on
 * the user's own edits only; a change that would leave a fence sharing a
 * line with other text gets a newline to keep them apart, and one that
 * reaches into a card partway is refused.
 */
const boundaryGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(programmaticChange) || tr.annotation(cardEdit)) return tr;
  const cards = tr.startState.field(cardField, false)?.cards;
  if (!cards || !cards.length) return tr;
  const doc = tr.startState.doc;
  let changed = false;
  let refused = false;
  const specs = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
    let insert = inserted.toString();
    for (const c of cards) {
      if (fromA <= c.from && toA >= c.to) continue; // the whole card goes
      if ((fromA > c.from && fromA < c.to) || (toA > c.from && toA < c.to)) { refused = true; return; }
      // Text that would end up on the `<<<` line, before the fence.
      if (toA === c.from && !insert.endsWith("\n")) {
        const lineStart = doc.lineAt(fromA).from;
        if (fromA > lineStart || insert.length) { insert += "\n"; changed = true; }
      }
      // Text that would end up on the `>>>` line, after the fence.
      if (fromA === c.to && !insert.startsWith("\n")) {
        const lineEnd = doc.lineAt(toA).to;
        if (toA < lineEnd || insert.length) { insert = "\n" + insert; changed = true; }
      }
    }
    specs.push({ from: fromA, to: toA, insert });
  });
  if (refused) return [];
  if (!changed) return tr;
  const changes = tr.startState.changes(specs);
  return {
    changes,
    selection: tr.startState.selection.map(changes, 1),
    effects: tr.effects,
    userEvent: tr.annotation(Transaction.userEvent) || undefined,
    scrollIntoView: tr.scrollIntoView,
  };
});

/** Cards the user just made (by typing or pasting) — the ones whose
 *  opening line wasn't a card's before this update. */
function newlyFormed(update) {
  const before = update.startState.field(cardField, false)?.cards || [];
  const after = update.state.field(cardField, false)?.cards || [];
  if (!after.length) return [];
  const known = new Set(before.map((c) => update.changes.mapPos(c.from, 1)));
  const knownLeft = new Set(before.map((c) => update.changes.mapPos(c.from, -1)));
  return after.filter((c) => !known.has(c.from) && !knownLeft.has(c.from));
}

let confirmOpen = false;

const creationPrompt = EditorView.updateListener.of((update) => {
  if (!update.docChanged || confirmOpen) return;
  if (update.transactions.some((tr) => tr.annotation(programmaticChange) || tr.annotation(cardEdit))) return;
  if (!update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return;
  const big = newlyFormed(update).filter((c) => cardWordCount(c.body) > CARD_CONFIRM_WORDS);
  if (!big.length) return;
  const view = update.view;
  // Which fence the edit wrote: the one its changed ranges touch.
  const touched = [];
  update.changes.iterChangedRanges((_fa, _ta, fromB, toB) => touched.push([fromB, toB]));
  const card = big[0];
  const closeLine = update.state.doc.lineAt(card.to);
  const openLine = update.state.doc.lineAt(card.from);
  const hits = (line) => touched.some(([a, b]) => b >= line.from && a <= line.to);
  const fence = hits(closeLine) || !hits(openLine) ? "close" : "open";
  confirmOpen = true;
  void confirmLongCard(card.body).then((ok) => {
    confirmOpen = false;
    if (!ok) unmakeCard(view, card.body, fence);
    view.focus();
  });
});

/** Take the fence the user just wrote back out, leaving the words. */
function unmakeCard(view, body, fence) {
  const cards = view.state.field(cardField, false)?.cards || [];
  const span = cards.find((c) => c.body === body);
  if (!span) return;
  const doc = view.state.doc;
  const line = doc.lineAt(fence === "open" ? span.from : span.to);
  const range = line.to < doc.length ? { from: line.from, to: line.to + 1 } : { from: Math.max(0, line.from - 1), to: line.to };
  view.dispatch({ changes: { ...range, insert: "" }, annotations: [cardEdit.of(true), Transaction.userEvent.of("delete.card")] });
}

/**
 * The card extension for a doc surface. Rides both `editor.js`'s list and
 * `createBaseExtensions`, so a card is a card in the main editor, a pane,
 * a stack column, Zen and Courier's append editor alike.
 */
const cardFloatLayer = createCardFloatLayer({ field: cardField, bind: bindCard });

export function createCardPlugin(appState) {
  return [
    cardAppState.of(appState),
    cardField,
    cardFloatLayer,
    boundaryGuard,
    creationPrompt,
    noteHostView,
    Prec.highest(keymap.of([{ key: "Enter", run: enterBesideCard }])),
  ];
}

/** Enter with the caret against a card is a plain line break. The
 *  markdown keymap would otherwise read the `>>>` fence as a blockquote
 *  and continue it onto the new line. */
function enterBesideCard(view) {
  const sel = view.state.selection.main;
  if (!sel.empty || view.state.selection.ranges.length > 1) return false;
  const cards = view.state.field(cardField, false)?.cards || [];
  const c = cards.find((x) => x.from === sel.head || x.to === sel.head);
  if (!c) return false;
  view.dispatch({
    changes: { from: sel.head, insert: "\n" },
    selection: { anchor: sel.head + 1 },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}
