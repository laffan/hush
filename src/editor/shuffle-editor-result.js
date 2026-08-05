/**
 * What a Shuffle Editor session writes back — extracted from
 * shuffle-editor.js (which sits at the repo's 700-line cap) because a
 * ratcheted desk needs a second shape of it.
 *
 * **Normally** the session is a cutting-room floor: struck sentences and
 * anything left parked in the margins are dropped, and only the column
 * survives (plus commented sentences, gathered into a `%%…%%` block).
 *
 * **Under a Desk Ratchet** nothing may be lost — the mode's whole promise
 * is that committed words stay in the file. So the two ways of saying
 * "not this one" both come back as the one revision the ratchet does
 * allow: a strikethrough. Struck sentences return wrapped in `~~…~~`,
 * and so does anything left in the margin, appended after the column in
 * margin order. The words are all still there; the shape of the passage
 * is the user's to change.
 *
 * That keeps the write-back inside `editor/ratchet.js`'s rearrangement
 * rule, which is what lets it land over committed text at all.
 */

/** Sentence text as it should appear in the result — struck nodes wear
 *  their markers when the session can't simply drop them. */
function nodeText(node, ratcheted) {
  const text = String(node.text ?? "").trim();
  if (!text) return "";
  return ratcheted && node.strike ? `~~${text}~~` : text;
}

/**
 * Assemble the text a session writes back over its source range.
 * `a` is the live session (`editorNodes`, `marginNodes`, `ratcheted`).
 */
export function buildShuffleResult(a) {
  const ratcheted = !!a.ratcheted;
  const kept = (n) => (ratcheted ? !n.comment : (!n.strike && !n.comment));
  // The column, in order — then, under a ratchet, whatever is still in
  // the margins, struck through rather than discarded.
  const flow = ratcheted ? [...a.editorNodes, ...a.marginNodes] : a.editorNodes;
  const main = flow
    .filter(kept)
    .map((n) => (ratcheted && n.where === "margin" && !n.strike ? `~~${nodeText(n, false)}~~` : nodeText(n, ratcheted)))
    .filter(Boolean)
    .join(" ");
  const commented = [...a.editorNodes, ...a.marginNodes]
    .filter((n) => (ratcheted ? n.comment : (!n.strike && n.comment)))
    .map((n) => nodeText(n, ratcheted))
    .filter(Boolean);
  let out = main;
  if (commented.length) {
    out = (out ? `${out}\n\n` : "") + `%%\n${commented.join("\n")}\n%%`;
  }
  return out;
}
