/**
 * Incremental (non-destructive) push to a linked Google Doc.
 *
 * The legacy push (`tabs-sync.js`) media-uploads fresh HTML and rebuilds
 * the tab tree, replacing every body — which destroys comment anchors and
 * resets formatting across the whole document. This path instead diffs the
 * live Google Doc against the markdown at the paragraph level (see
 * `gdoc-diff.js`) and applies only the paragraphs that changed via a Docs
 * API `batchUpdate`, per tab, so untouched text keeps its comments and
 * styling.
 *
 * Tab coverage: a `batchUpdate` request can target a specific `tabId`, so
 * we match each Hush section (`---Name---` markers → `parseTabs`) to the
 * Google tab with the same path and diff their bodies independently,
 * concatenating the per-tab requests into one call. This handles the
 * common case — editing content inside an existing tab structure.
 *
 * It stays deliberately conservative and bails (caller falls back to the
 * whole-document rebuild, so we're never worse than before) on:
 *   - a *structural* tab change (a tab added, removed, renamed, or whose
 *     path no longer matches) — the rebuild path owns tab creation/deletion;
 *   - footnotes / tables / images / code (unmappable to plain indices);
 *   - a diff large enough to suggest the plain-text projection drifted.
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
  if (hasUnsupportedMarkdown(md)) return false;

  const sections = parseTabs(md);
  const tabbed = sections.some((s) => Array.isArray(s.path) && s.path.length > 0);

  let doc;
  try {
    doc = await getDocumentWithTabs(docId);
  } catch (e) {
    console.warn("[google-docs] incremental push: doc fetch failed, falling back:", e);
    return false;
  }
  const googleTabs = flattenGoogleTabs(doc.tabs || []);
  if (googleTabs.length === 0) return false;

  // Pair each Hush section with the Google tab it should update.
  const pairs = pairSectionsToTabs(sections, tabbed, googleTabs);
  if (!pairs) return false; // structural mismatch → rebuild path

  let requests = [];
  let totalChanged = 0;
  let totalParas = 0;
  for (const { documentTab, content, tabId } of pairs) {
    const g = readGoogleParagraphs(documentTab);
    if (g.unsupported) return false;
    const ops = computeParagraphOps(g.paras, projectToParagraphs(content));
    totalParas += g.paras.filter((p) => !p.empty).length;
    totalChanged += ops.filter((o) => o.type !== "keep").length;
    requests = requests.concat(buildBatchRequests(ops, tabId, g.endIndex));
  }

  // Aggregate drift guard: systematic projection drift shows up across
  // every tab, while a genuinely large edit is concentrated in one — so
  // summing keeps real edits flowing but still catches a broken projection.
  if (totalParas > 4 && totalChanged > Math.ceil(totalParas * DRIFT_FRACTION)) return false;

  if (requests.length === 0) return true; // already in sync — nothing to do

  await batchUpdate(docId, requests);
  return true;
}

/**
 * Match Hush sections to Google tabs. Returns an array of
 * `{ documentTab, content, tabId }` to diff, or null when the structures
 * don't line up (so the caller falls back to the rebuild push).
 */
export function pairSectionsToTabs(sections, tabbed, googleTabs) {
  // Untabbed markdown ↔ single-tab doc: diff the whole body against the
  // one tab.
  if (!tabbed) {
    if (googleTabs.length !== 1) return null;
    const t = googleTabs[0];
    const content = sections.map((s) => s.content || "").join("\n").trim();
    return [{ documentTab: t.documentTab, content, tabId: t.tabId }];
  }

  // Content before the first marker can't be mapped to a tab — bail.
  const root = sections.find((s) => !s.path || s.path.length === 0);
  if (root && (root.content || "").trim()) return null;

  const desired = sections.filter((s) => s.path && s.path.length > 0);
  const googleByKey = new Map(googleTabs.map((t) => [pathKey(t.path), t]));

  // Structure must match exactly — same set of tab paths, no more, no less.
  if (desired.length !== googleTabs.length) return null;
  const pairs = [];
  for (const s of desired) {
    const t = googleByKey.get(pathKey(s.path));
    if (!t) return null;
    pairs.push({ documentTab: t.documentTab, content: s.content || "", tabId: t.tabId });
  }
  return pairs;
}

/** Flatten the Google tab tree (depth-first, siblings by `index`) into
 *  `{ path, tabId, documentTab }`. Mirrors `tabs-sync.js#flattenTabs` but
 *  carries the `tabId` the batchUpdate requests need. */
export function flattenGoogleTabs(tabs, parentPath = []) {
  const out = [];
  if (!Array.isArray(tabs)) return out;
  const sorted = tabs.slice().sort(
    (a, b) => (a.tabProperties?.index ?? 0) - (b.tabProperties?.index ?? 0)
  );
  let fallback = parentPath.length + 1;
  for (const t of sorted) {
    const title = (t.tabProperties?.title || "").trim() || `Tab ${fallback++}`;
    const path = [...parentPath, title];
    out.push({ path, tabId: t.tabProperties?.tabId || null, documentTab: t.documentTab });
    if (Array.isArray(t.childTabs)) out.push(...flattenGoogleTabs(t.childTabs, path));
  }
  return out;
}

// `\x00` can't appear in a tab title, so it's a collision-free joiner
// (mirrors `tabs-sync.js#pathKey`).
function pathKey(path) {
  return path.join("\x00");
}
