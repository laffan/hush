/**
 * Incremental (non-destructive) push to a linked Google Doc.
 *
 * The legacy push (`tabs-sync.js` → `replaceDocumentContent`) media-uploads
 * fresh HTML, replacing the entire body — which destroys every comment
 * anchor and resets all formatting. This path instead diffs the live
 * Google Doc against the markdown at the paragraph level (see
 * `gdoc-diff.js`) and applies only the paragraphs that changed via a Docs
 * API `batchUpdate`, so untouched text keeps its comments and styling.
 *
 * It's deliberately conservative: it only handles the single-tab,
 * prose/heading/list/quote case and bails (returns false → caller falls
 * back to the legacy whole-document push) the moment anything is unusual —
 * multiple tabs, tab markers, footnotes/tables/images, or a diff so large
 * it suggests the plain-text projection drifted from Google's text. The
 * fallback means we're never worse than before; the fast path is a strict
 * improvement when it applies.
 */
import { getDocumentWithTabs, batchUpdate } from "./api.js";
import { parseTabs } from "../editor/tabs.js";
import {
  hasUnsupportedMarkdown,
  projectToParagraphs,
  readGoogleParagraphs,
  computeParagraphOps,
  buildBatchRequests,
} from "./gdoc-diff.js";

// If more than this fraction of a non-trivial document's paragraphs would
// change, assume the projection drifted (rather than a real edit) and bail
// to the whole-document push rather than scribble over the doc.
const DRIFT_FRACTION = 0.6;

/**
 * Attempt an incremental push. Returns true when the doc was reconciled
 * (including the no-op "already in sync" case), false when the caller
 * should fall back to the whole-document push. Throws only if the
 * `batchUpdate` itself fails — by then nothing should fall back, since a
 * partial apply must not be followed by a full overwrite.
 *
 * @param {string} docId
 * @param {string} md   current Hush markdown for the linked doc
 */
export async function tryIncrementalPush(docId, md) {
  // Tabbed content (markers in the markdown) uses the rebuild path.
  const sections = parseTabs(md);
  if (sections.some((s) => Array.isArray(s.path) && s.path.length > 0)) return false;
  if (hasUnsupportedMarkdown(md)) return false;

  let doc;
  try {
    doc = await getDocumentWithTabs(docId);
  } catch (e) {
    console.warn("[google-docs] incremental push: doc fetch failed, falling back:", e);
    return false;
  }
  const tabs = doc.tabs || [];
  if (tabs.length !== 1) return false; // multi-tab → rebuild path

  const tab = tabs[0];
  const tabId = tab.tabProperties?.tabId || null;
  const g = readGoogleParagraphs(tab.documentTab);
  if (g.unsupported) return false;

  const desired = projectToParagraphs(md);
  const ops = computeParagraphOps(g.paras, desired);

  const total = g.paras.filter((p) => !p.empty).length;
  const changed = ops.filter((o) => o.type !== "keep").length;
  if (total > 4 && changed > Math.ceil(total * DRIFT_FRACTION)) return false;

  const requests = buildBatchRequests(ops, tabId, g.endIndex);
  if (requests.length === 0) return true; // already in sync — nothing to do

  await batchUpdate(docId, requests);
  return true;
}
