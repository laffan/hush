/**
 * What a paste was carrying, and where it was aimed — for the Activity
 * Log (Settings → Debug, source `paste`).
 *
 * An image paste that goes nowhere looks identical from the outside
 * whatever went wrong: an empty `clipboardData`, a clipboard read the
 * platform refused, focus sitting on a surface whose handler declined
 * the event. These two describers are what tell those apart after the
 * fact, on a device with no console attached — which is the only way
 * an iPad reports anything.
 *
 * A leaf, like `clipboard-image.js`: no app imports, so the lazily
 * loaded notebook bundle and the editor can share it.
 */

/** A paste event's payload, flattened for one log line. Every read is
 *  guarded — a `DataTransfer` outside its event can throw on access,
 *  and a diagnostic must never be the thing that breaks the paste. */
export function describeClipboard(cd) {
  if (!cd) return { clipboardData: null };
  const guard = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const text = guard(() => cd.getData("text/plain") || "", "");
  const html = guard(() => cd.getData("text/html") || "", "");
  return {
    types: guard(() => Array.from(cd.types || []), []),
    items: guard(() => Array.from(cd.items || []).map((i) => `${i.kind}:${i.type}`), []),
    files: guard(() => (cd.files ? cd.files.length : 0), 0),
    textLen: text.length,
    htmlLen: html.length,
    // Enough of the HTML to see whether it is a real rich payload or an
    // `<img>` wrapper around bytes the event didn't hand over.
    htmlHead: html.slice(0, 200),
  };
}

/** The focused element, named the way the paste gates test it. Which
 *  surface holds focus decides which paste path may run at all, so a
 *  trail without it can't explain a paste that went nowhere. */
export function describeActiveElement() {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  if (!el) return "none";
  const cls = typeof el.className === "string" && el.className
    ? "." + el.className.trim().split(/\s+/).join(".") : "";
  const flags = [
    el.isContentEditable ? "contentEditable" : "",
    el.closest?.(".floating-pane") ? "inPane" : "",
  ].filter(Boolean);
  return `${el.tagName.toLowerCase()}${cls}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}
