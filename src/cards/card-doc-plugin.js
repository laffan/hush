/**
 * Cards in a Doc.
 *
 * Once a `<<<` … `>>>` chunk is recognised it leaves the editing of the
 * text: the whole span is replaced by a zero-height block widget,
 * registered atomic so the caret steps over it the way it steps over any
 * widget, and the card itself is drawn beside the text by the float
 * layer (card-doc-float.js) — it never pushes the words apart. The only
 * ways back into the text are copying the card's words out, or its
 * insert-at-cursor button.
 *
 * The card's body is edited in the card's own editor, and the two stay
 * one document the way the pinned outline and its panel do: each edit
 * is replayed onto the host at the body's offset (outside the host's
 * undo history — the card keeps its own), and whenever the host's copy
 * changes under the card (undo in the host, a sync pull, a refused
 * edit), the card takes it back as a programmatic diff. The float
 * layer's entry for a card follows the card's first offset through
 * every change, so nothing holds an offset that can go stale.
 *
 * Three things protect the fences from the text around them (and the
 * first protects the card itself — only its ✕ deletes it):
 *
 *   - **The boundary guard.** A caret parked at a card's first or last
 *     offset would type onto the `<<<` or `>>>` line and dissolve the
 *     card; a deletion that pulls the next line up onto `>>>` would do
 *     the same. The filter pushes such text onto a line of its own
 *     instead — and Backspace / Delete at a card's edge go *round* it:
 *     the lines either side join and the card moves up beside the joined
 *     line, rather than the deletion eating a fence (or stopping dead).
 *   - **Refusing edits inside.** Nothing but the card's own replay
 *     (`cardEdit`) may change the span partway.
 *   - **The card editor's fence guard**, which refuses a `<<<` / `>>>`
 *     line inside the card.
 *
 * A card made by typing or pasting that holds more than
 * `CARD_CONFIRM_WORDS` asks first; declining takes the fence the edit
 * wrote back out, and the words stay as plain text.
 */

import { EditorView, Decoration, keymap } from "@codemirror/view";
import { EditorState, StateField, Transaction, Text, Facet, Prec, findClusterBreak } from "@codemirror/state";
import { insideCard, cardEdit } from "./card-facet.js";
import { createCardElement } from "./card-element.js";
import { startCardDrag, relocateCard } from "./card-drag.js";
import { noteHostView } from "./card-cursor.js";
import { confirmLongCard } from "./card-confirm.js";
import { CardAnchorWidget, createCardFloatLayer } from "./card-doc-float.js";
import { findCardsInDoc, serializeCard, cardWordCount, cardRemovalRange, cardTitle, CARD_CONFIRM_WORDS } from "./card-model.ts";
import { announceCardsChanged } from "./card-index.js";
import { cardReturnWatcher } from "./card-return.js";
import { programmaticChange } from "../editor/base-extensions.js";

/** The app state, for widgets built inside the view. */
const cardAppState = Facet.define({ combine: (v) => v[0] || null });

const EMPTY = { cards: [], deco: Decoration.none };

function buildCards(state) {
  if (state.facet(insideCard)) return EMPTY;
  const cards = findCardsInDoc(state.doc);
  if (!cards.length) return EMPTY;
  // In the text a card is only a zero-height anchor; the float layer
  // draws it beside the words.
  const anchor = new CardAnchorWidget();
  const deco = Decoration.set(cards.map((c) => Decoration.replace({ widget: anchor, block: true }).range(c.from, c.to)));
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

/** Rewrite a card's metadata (colour, collapse, width, place). */
export function writeCardMeta(view, span, meta) {
  view.dispatch({
    changes: { from: span.from, to: span.to, insert: serializeCard(span.body, meta) },
    annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
  });
}

/**
 * Wire one card element to the host editor. `host` is the card's element
 * in the float layer, and `locate` finds the card's span in the document
 * as it stands now.
 */
// A card about to be written that should take the keyboard once it is
// drawn (an empty card from ⌘⇧,): its view → the card's first offset.
const focusOnBind = new WeakMap();

/** Focus the card that will start at `from` in `view` when it binds. */
export function focusCardWhenBound(view, from) {
  focusOnBind.set(view, from);
}

function bindCard(view, host, span0, locate) {
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
    body: span0.body,
    meta: span0.meta,
    surface: "doc",
    onEdit(update) {
      pending = pending ? pending.compose(update.changes) : update.changes;
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    },
    getScale: () => view.scaleX || 1,
    // Insert-at-cursor puts the words at this document's caret.
    insertPoint: () => ({ view, pos: view.state.selection.main.head }),
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
      else if (action === "pin") togglePin(view, host, span);
    },
    onResize(width) {
      const span = locate();
      if (span) writeCardMeta(view, span, { ...span.meta, width });
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
  if (focusOnBind.get(view) === span0.from) {
    focusOnBind.delete(view);
    requestAnimationFrame(() => card.focus());
  }
  wrap.appendChild(card.el);

  return {
    take(span) {
      // Edits still on their way to the host are newer than the host's
      // copy; the replay brings the two back together.
      if (!pending) card.setBody(span.body);
      card.setMeta(span.meta);
    },
    destroy() {
      if (pending) flush();
      card.destroy();
    },
  };
}

/** Pin a card where it is on screen — it stops scrolling with the text —
 *  or unpin it: it stays where it now sits, beside the line it is level
 *  with, rather than going back to where it was pinned from. */
function togglePin(view, host, span) {
  const top = (host.firstElementChild || host).getBoundingClientRect().top;
  if (!span.meta.pinned) {
    const visTop = view.scrollDOM.getBoundingClientRect().top;
    writeCardMeta(view, span, { ...span.meta, pinned: true, pinY: Math.max(0, Math.round(top - visTop)) });
    return;
  }
  const h = Math.max(0, top - view.documentTop);
  const block = view.lineBlockAtHeight(h);
  relocateCard(view, span, block.from, { ...span.meta, pinned: undefined, pinY: undefined, yPos: Math.round(h - block.top) });
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

/** The run of cards `c` belongs to: cards stacked with nothing but a
 *  line break between them are passed over as one. */
function cardBlock(cards, c) {
  let from = c.from;
  let to = c.to;
  for (let grew = true; grew;) {
    grew = false;
    for (const k of cards) {
      if (k.to === from - 1) { from = k.from; grew = true; }
      if (k.from === to + 1) { to = k.to; grew = true; }
    }
  }
  return { from, to };
}

/** One character (cluster) before `pos`, or the line break before it at
 *  a line's start; null at the top of the document. */
function charBefore(doc, pos) {
  if (pos <= 0) return null;
  const line = doc.lineAt(pos);
  if (pos === line.from) return { from: pos - 1, to: pos };
  return { from: line.from + findClusterBreak(line.text, pos - line.from, false), to: pos };
}

/** One character (cluster) after `pos`, or the line break after it at a
 *  line's end; null at the end of the document. */
function charAfter(doc, pos) {
  if (pos >= doc.length) return null;
  const line = doc.lineAt(pos);
  if (pos === line.to) return { from: pos, to: pos + 1 };
  return { from: pos, to: line.from + findClusterBreak(line.text, pos - line.from, true) };
}

/**
 * Backspace and Delete at a card's edge go round the card.
 *
 * In the text a card is a zero-height block between the line above it
 * and its anchor line, the one it sits beside — so with the caret at the
 * start of the anchor line, the character Backspace means is the end of
 * the line *above the card*. Deleting the real line break there would
 * put text on a fence line, which the guard below refuses, and the
 * deletion simply stopped at every card. Instead the two lines join as
 * if the card weren't there, and the card's markdown moves up to sit
 * before the joined line, so it stays beside the words it was beside;
 * Delete at the end of the line above does the same from the other side.
 * The caret positions on the card itself count as the nearer of those two
 * lines' edges. Stacked cards are passed over together. Returns null when
 * the transaction isn't a lone Backspace / Delete against a card.
 */
function deleteAroundCard(tr, cards) {
  const back = tr.isUserEvent("delete.backward");
  if (!back && !tr.isUserEvent("delete.forward")) return null;
  const sel = tr.startState.selection;
  if (sel.ranges.length > 1 || !sel.main.empty) return null;
  let one = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => { count++; one = { fromA, toA, empty: !inserted.length }; });
  if (count !== 1 || !one.empty) return null;
  const doc = tr.startState.doc;
  const head = sel.main.head;
  const { fromA, toA } = one;

  // Which card, and which side of it the key is pressed on: "after"
  // (Backspace from the anchor line or the card's far edge) or "before"
  // (Delete from the line above or the card's near edge) go round it;
  // Backspace on the near edge and Delete on the far edge are ordinary
  // deletions in the line beyond.
  let card = null;
  let side = null;
  for (const c of cards) {
    if (back && fromA === c.to && toA === c.to + 1) { card = c; side = "around"; }
    else if (back && fromA === c.from && toA === c.to) { card = c; side = head === c.to ? "around" : "before-line"; }
    else if (back && toA === c.from && head === c.from) { card = c; side = "before-line"; }
    else if (!back && fromA === c.from - 1 && toA === c.from) { card = c; side = "around"; }
    else if (!back && fromA === c.from && toA === c.to) { card = c; side = head === c.from ? "around" : "after-line"; }
    else if (!back && fromA === c.to && head === c.to) { card = c; side = "after-line"; }
    if (card) break;
  }
  if (!card) return null;
  const block = cardBlock(cards, card);
  const hasAbove = block.from > 0;
  const hasBelow = block.to < doc.length;
  const userEvent = tr.annotation(Transaction.userEvent);

  // No line on the far side to join: delete in the line there is.
  if (side === "around" && back && !hasAbove) return [];
  if (side === "around" && !back && !hasBelow) return [];
  if (side === "around" && back && !hasBelow) side = "before-line";
  if (side === "around" && !back && !hasAbove) side = "after-line";

  if (side === "before-line") {
    const r = hasAbove ? charBefore(doc, block.from - 1) : null;
    if (!r) return [];
    return { changes: r, selection: { anchor: r.from }, userEvent, scrollIntoView: true };
  }
  if (side === "after-line") {
    const r = hasBelow ? charAfter(doc, block.to + 1) : null;
    if (!r) return [];
    return { changes: r, selection: { anchor: r.from }, userEvent, scrollIntoView: true };
  }

  // Join the line above and the anchor line; the cards move up to sit
  // before the joined line.
  const above = doc.lineAt(block.from - 1);
  const below = doc.lineAt(block.to + 1);
  const cardText = doc.sliceString(block.from, block.to);
  const insert = cardText + "\n" + above.text + below.text;
  return {
    changes: { from: above.from, to: below.to, insert },
    selection: { anchor: above.from + cardText.length + 1 + above.text.length },
    userEvent,
    scrollIntoView: true,
  };
}

/**
 * Keep typing and deleting next to a card off its fence lines. Runs on
 * the user's own edits only; a change that would leave a fence sharing a
 * line with other text gets a newline to keep them apart, and one that
 * reaches into a card partway is refused.
 *
 * **A keystroke never takes a whole card either.** In the text a card is
 * one atomic range, so Backspace with the caret just after it (or Delete
 * just before) removed the entire span — the card vanished from a key
 * pressed in what looks like empty space. A card leaves a Doc through its
 * own ✕ (or a drag, or Send to Inbox — all `cardEdit`) and nothing else:
 * an `input` / `delete` edit that covers whole cards is carved around
 * them, so a selection deleted across a card takes the text and leaves
 * the card, and typing over one lands the text before it. A lone
 * Backspace or Delete against a card never gets this far: it goes round
 * the card (`deleteAroundCard`, above).
 * Undo, redo and app-driven rewrites (no user event — Zen's write-back,
 * a sync pull) still carry whole cards, as do moves.
 */
const boundaryGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(programmaticChange) || tr.annotation(cardEdit)) return tr;
  const cards = tr.startState.field(cardField, false)?.cards;
  if (!cards || !cards.length) return tr;
  const around = deleteAroundCard(tr, cards);
  if (around) return around;
  const doc = tr.startState.doc;
  const protect = tr.isUserEvent("input") || tr.isUserEvent("delete");
  let changed = false;
  let carved = false;
  let refused = false;
  let caret = null; // where the edit's own text ends, once carved
  const stepped = [];
  const specs = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
    // Whole cards inside a typed / deleted range stay where they are.
    let pieces = [[fromA, toA]];
    if (protect && toA > fromA) {
      const covered = cards.filter((c) => fromA <= c.from && toA >= c.to);
      if (covered.length) {
        carved = changed = true;
        stepped.push(...covered);
        pieces = [];
        let at = fromA;
        for (const c of covered) { pieces.push([at, c.from]); at = c.to; }
        pieces.push([at, toA]);
      }
    }
    pieces.forEach(([from, to], i) => {
      const typed = i === 0 ? inserted.toString() : "";
      let insert = typed;
      if (from === to && !insert) return;
      for (const c of cards) {
        if (from <= c.from && to >= c.to) continue; // the whole card goes (undo, a move)
        if ((from > c.from && from < c.to) || (to > c.from && to < c.to)) { refused = true; return; }
        // Text that would end up on the `<<<` line, before the fence.
        if (to === c.from && !insert.endsWith("\n")) {
          const lineStart = doc.lineAt(from).from;
          if (from > lineStart || insert.length) { insert += "\n"; changed = true; }
        }
        // Text that would end up on the `>>>` line, after the fence.
        if (from === c.to && !insert.startsWith("\n")) {
          const lineEnd = doc.lineAt(to).to;
          if (to < lineEnd || insert.length) { insert = "\n" + insert; changed = true; }
        }
      }
      if (i === 0 && caret == null) caret = { from, end: insert.indexOf(typed) + typed.length };
      specs.push({ from, to, insert });
    });
  });
  if (refused) return [];
  if (!changed) return tr;
  if (!specs.length) {
    // Nothing left once the cards are kept — a deletion of only cards
    // that `deleteAroundCard` didn't take (one with no direction, say a
    // sentence delete). Step over the card, the way the caret does.
    const sel = tr.startState.selection.main;
    if (!sel.empty || !stepped.length) return [];
    const c = stepped[0];
    const pos = tr.isUserEvent("delete.forward") ? c.to : c.from;
    return { selection: { anchor: pos }, scrollIntoView: true };
  }
  const changes = tr.startState.changes(specs);
  return {
    changes,
    // Carved, the old selection maps across the card it was meant to
    // remove; the caret goes where the edit's text ends instead.
    selection: carved && caret
      ? { anchor: changes.mapPos(caret.from, -1) + caret.end }
      : tr.startState.selection.map(changes, 1),
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

/** What the sidebar shows of a surface's cards: their names and colours. */
function rowsKey(value) {
  return (value?.cards || []).map((c) => `${cardTitle(c.body)}\u0000${c.meta.bgColor || ""}`).join("\n");
}

/** The sidebar lists a Doc's cards (sidebar/files-panel-cards.js), read
 *  from whichever surface shows the Doc: tell it when what it would show
 *  changes — a card made, moved away, renamed by its first line. */
const cardRowsWatcher = EditorView.updateListener.of((u) => {
  if (!u.docChanged || u.state.facet(insideCard)) return;
  const a = u.startState.field(cardField, false);
  const b = u.state.field(cardField, false);
  if (a !== b && rowsKey(a) !== rowsKey(b)) announceCardsChanged();
});

/**
 * Copying (and cutting) text leaves the cards out. A selection that runs
 * across a card takes in its markdown — the card is invisible in the
 * text, so the fences, words and metadata would arrive wherever the copy
 * is pasted as a card nobody chose to copy. Each whole card in the copied
 * text goes, with one line break, so no blank line is left in its place.
 * (A cut removes the text around a card and leaves the card where it
 * was: the boundary guard above.)
 */
const cardCopyFilter = EditorView.clipboardOutputFilter.of((text, state) => {
  const cards = state.field(cardField, false)?.cards;
  if (!cards?.length || text.indexOf(">>>") < 0) return text;
  const doc = state.doc;
  let out = text;
  for (const r of state.selection.ranges) {
    for (const c of cards) {
      // A caret's linewise copy takes its line, never a card's.
      if (r.empty || c.from < r.from || c.to > r.to) continue;
      const raw = doc.sliceString(c.from, c.to);
      for (const piece of [`${raw}\n`, `\n${raw}`, raw]) {
        const at = out.indexOf(piece);
        if (at >= 0) { out = out.slice(0, at) + out.slice(at + piece.length); break; }
      }
    }
  }
  return out;
});

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
    cardRowsWatcher,
    cardCopyFilter,
    cardReturnWatcher,
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
