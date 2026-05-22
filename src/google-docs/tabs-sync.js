/**
 * Tab-aware push/pull for the Google Docs link.
 *
 * Markdown markers round-trip to real Google Doc tabs (including
 * nested tabs):
 *
 *   ---Top---                                top-level
 *   ---Parent---/---Child---                 nested
 *   ---A---/---B---/---C---                  arbitrary depth
 *
 * Push:
 *   1. Drive media-upload the first section's content (formatted HTML
 *      via Phase 1's markdownToHtml). Drive's media upload resets a
 *      tabbed Google Doc back to a single default tab — we accept
 *      that and rebuild the entire tab tree from scratch via the
 *      Docs API in step 2.
 *   2. Walk every other section in source order: resolve the parent
 *      tabId from the section's path (parents are processed before
 *      children because the markdown writes them that way), add the
 *      new tab via `addDocumentTab`, then insert the section's
 *      content via `insertText`. Non-root tab content is plain text
 *      — structured insertion into a specific `tabId` isn't a Drive
 *      primitive.
 *
 * Pull:
 *   - Fetch `documents.get?includeTabsContent=true`, flatten the
 *     `tabs[]` + `childTabs[]` tree into a depth-first list of
 *     `{ path, documentTab }`, convert each tab's body via the
 *     docs-walker, and rejoin with `joinTabs`.
 *   - Single-tab and untabbed docs still ride Drive's HTML export
 *     for richer formatting fidelity.
 */
import {
  exportAsHtml,
  replaceDocumentContent,
  listTabs,
  createTab,
  renameTab,
  deleteTab,
  replaceTabPlainText,
  getDocumentWithTabs,
} from "./api.js";
import { parseTabs, joinTabs } from "../editor/tabs.js";
import { markdownToHtml } from "../editor/google-docs/markdown-to-html.js";
import { htmlToMarkdown } from "../editor/google-docs/html-to-markdown.js";
import { documentTabToMarkdown } from "./docs-walker.js";

// ===== Push =====

/**
 * Replace the linked Google Doc's content from a Hush markdown string,
 * mirroring tab structure (including nesting).
 *
 * @param {string} docId
 * @param {string} md
 */
export async function pushMarkdownWithTabs(docId, md) {
  const sections = parseTabs(md);
  // If the markdown leads with a tab marker, `parseTabs` returns an
  // empty implicit root in slot 0. Drop it so the first emitted tab
  // is what lands as the doc's root tab.
  let queue = sections.slice();
  const head = queue[0];
  if (head && (!head.path || head.path.length === 0)
      && !(head.content || "").trim()) {
    queue = queue.slice(1);
  }
  if (queue.length === 0) {
    queue = [{ path: [], content: "" }];
  }

  // First section becomes the root tab. If it's nested (path.length > 1)
  // we collapse the path to its top-level head — Drive media upload
  // can only target the root tab, and we don't have a way to promote
  // an auto-created tab into someone else's child. This is an unusual
  // shape; most docs lead with a top-level marker or implicit root.
  const firstSection = queue[0];
  const restSections = queue.slice(1);

  // 1. Drive media upload — replaces the root tab with the first
  //    section's formatted HTML. On tabbed docs this resets the
  //    whole tab structure to a single default tab.
  const rootHtml = wrapHtml(markdownToHtml(firstSection.content || ""));
  await replaceDocumentContent(docId, rootHtml);

  // 2. List the post-upload tabs (should be one default tab) and
  //    rename it to the first section's leaf name.
  const tabs = await listTabs(docId);
  const firstTab = tabs.find((t) => t.nestingLevel === 0) || tabs[0] || null;
  if (!firstTab) return { tabsPushed: 0, tabsCreated: 0, tabsDeleted: 0 };

  const firstPath = (firstSection.path && firstSection.path.length)
    ? firstSection.path
    : ["Untitled"];
  const firstTitle = firstPath[firstPath.length - 1] || "Untitled";
  if ((firstTab.title || "") !== firstTitle) {
    await renameTab(docId, firstTab.id, firstTitle);
  }

  // 3. Walk the remaining sections, building a path → tabId map as
  //    we create them. Indices are tracked per-parent so siblings
  //    land in source order.
  const pathToTabId = new Map();
  pathToTabId.set(pathKey(firstPath), firstTab.id);
  const nextIndex = new Map();
  nextIndex.set("_root_", 1); // root tab already at index 0

  let created = 0;
  for (const section of restSections) {
    const path = section.path || [];
    if (path.length === 0) continue; // orphan content between markers — skip
    const leaf = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    let parentTabId = null;
    if (parentPath.length > 0) {
      parentTabId = pathToTabId.get(pathKey(parentPath));
      if (!parentTabId) {
        // Marker references a parent we haven't seen — likely a typo
        // in the markdown. Skip rather than silently create the
        // wrong shape; the user's pull will round-trip the marker
        // back so they can fix it.
        console.warn("[google-docs] tab marker has unresolved parent:", path);
        continue;
      }
    }
    const parentKey = parentTabId || "_root_";
    const idx = nextIndex.get(parentKey) || 0;
    nextIndex.set(parentKey, idx + 1);
    const newTabId = await createTab(docId, idx, leaf, parentTabId);
    if (!newTabId) continue;
    pathToTabId.set(pathKey(path), newTabId);
    const content = (section.content || "").trim();
    if (content) {
      await replaceTabPlainText(docId, newTabId, content);
    }
    created++;
  }

  return {
    tabsPushed: queue.length,
    tabsCreated: created,
    tabsDeleted: 0,
  };
}

// ===== Pull =====

export async function pullMarkdownWithTabs(docId, convertHtml) {
  const doc = await getDocumentWithTabs(docId);
  const flat = flattenTabs(doc.tabs || []);
  if (flat.length === 0) {
    const html = await exportAsHtml(docId);
    return (convertHtml(html) || "").trim();
  }
  if (flat.length === 1) {
    // Single tab — Drive HTML export keeps the most formatting
    // fidelity (the Docs API walker is intentionally narrow). A
    // single tab also doesn't need a marker — emitting one would
    // be noise the user has to delete.
    const html = await exportAsHtml(docId);
    return (convertHtml(html) || "").trim();
  }
  const sections = [];
  for (const { path, documentTab } of flat) {
    sections.push({ path, content: documentTabToMarkdown(documentTab) });
  }
  return joinTabs(sections);
}

// ===== Helpers =====

function pathKey(path) {
  // \x00 is unusable as a tab title so it's a safe joiner that won't
  // collide with `["a/b"]` vs `["a", "b"]` (which join differently
  // when joined with `/`).
  return path.join("\x00");
}

function flattenTabs(tabs, parentPath = []) {
  const out = [];
  if (!Array.isArray(tabs)) return out;
  // Sort siblings by `index` so source order matches Google's tab
  // order — without the sort, parent order could end up mismatched
  // depending on the API's response shape.
  const sorted = tabs.slice().sort((a, b) => {
    const ai = a.tabProperties?.index ?? 0;
    const bi = b.tabProperties?.index ?? 0;
    return ai - bi;
  });
  let fallbackCounter = parentPath.length + 1;
  for (const t of sorted) {
    const rawTitle = (t.tabProperties?.title || "").trim();
    const title = rawTitle || `Tab ${fallbackCounter++}`;
    const path = [...parentPath, title];
    out.push({ path, documentTab: t.documentTab });
    if (Array.isArray(t.childTabs)) {
      out.push(...flattenTabs(t.childTabs, path));
    }
  }
  return out;
}

function wrapHtml(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}
