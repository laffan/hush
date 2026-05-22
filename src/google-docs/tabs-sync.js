/**
 * Tab-aware push/pull for the Google Docs link.
 *
 * Markdown `---Tab name---` markers round-trip to real Google Doc tabs:
 *
 *   Push: split the markdown into ordered sections via parseTabs.
 *     1. Drive media-upload the root section's HTML — Drive's upload
 *        only touches the first/root tab when the doc carries tabs,
 *        so existing non-root tabs survive this step.
 *     2. List the doc's tabs via the Docs API.
 *     3. For each non-root markdown section, ensure a top-level tab
 *        exists at the matching slot with the right title, then
 *        replace its content via insertText (plain text — non-root
 *        tab formatting is a future enhancement).
 *     4. Delete any leftover non-root tabs beyond what the markdown
 *        carries so push behaves as a full replace.
 *
 *   Pull: list tabs via the Docs API, export each tab's HTML in
 *     isolation via Drive (`tabIds=<id>`), convert each to markdown,
 *     and rejoin with `---Tab name---` separators via joinTabs.
 */
import {
  exportAsHtml,
  replaceDocumentContent,
  listTabs,
  createTab,
  renameTab,
  deleteTab,
  replaceTabPlainText,
} from "./api.js";
import { parseTabs, joinTabs } from "../editor/tabs.js";
import { markdownToHtml } from "../editor/google-docs/markdown-to-html.js";
import { htmlToMarkdown } from "../editor/google-docs/html-to-markdown.js";

// ===== Push =====

/**
 * Replace the linked Google Doc's content from a Hush markdown string,
 * mirroring tab structure.
 *
 * @param {string} docId
 * @param {string} md
 * @returns {Promise<{ tabsPushed: number, tabsCreated: number, tabsDeleted: number }>}
 */
export async function pushMarkdownWithTabs(docId, md) {
  const sections = parseTabs(md);
  // If the markdown starts with a tab marker, `parseTabs` returns an
  // empty root section in slot 0. Promote the next titled section
  // into the first-tab slot so Google doesn't end up with an extra
  // blank tab nobody asked for. Symmetric with the pull path, which
  // emits a marker for every tab including the first.
  let firstSection = sections[0] || { title: null, content: "" };
  let restSections = sections.slice(1);
  const rootIsBlank = !firstSection.title && !(firstSection.content || "").trim();
  if (rootIsBlank && restSections.length > 0) {
    firstSection = restSections[0];
    restSections = restSections.slice(1);
  }

  const rootHtml = wrapHtml(markdownToHtml(firstSection.content || ""));
  await replaceDocumentContent(docId, rootHtml);

  // After the Drive upload, list the doc's tabs. With tabbed docs the
  // upload replaces only the root tab's content, so any existing
  // top-level tabs stay around — we reconcile them against the
  // markdown's non-root sections by slot.
  const tabs = await listTabs(docId);
  const topLevel = tabs.filter((t) => t.nestingLevel === 0).sort((a, b) => a.index - b.index);
  const firstTab = topLevel[0] || null;
  const otherTabs = topLevel.slice(1);

  if (firstTab && firstSection.title && (firstTab.title || "") !== firstSection.title) {
    await renameTab(docId, firstTab.id, firstSection.title);
  }

  let created = 0;
  for (let i = 0; i < restSections.length; i++) {
    const section = restSections[i];
    const slotIndex = i + 1; // root tab is index 0
    const existing = otherTabs[i] || null;
    let tabId = existing?.id || null;
    const sectionTitle = section.title || `Tab ${slotIndex + 1}`;
    if (!tabId) {
      tabId = await createTab(docId, slotIndex, sectionTitle);
      created++;
    } else if ((existing.title || "") !== sectionTitle) {
      await renameTab(docId, tabId, sectionTitle);
    }
    if (tabId) {
      await replaceTabPlainText(docId, tabId, section.content || "");
    }
  }

  let deleted = 0;
  for (let i = restSections.length; i < otherTabs.length; i++) {
    await deleteTab(docId, otherTabs[i].id);
    deleted++;
  }

  return {
    tabsPushed: restSections.length + 1,
    tabsCreated: created,
    tabsDeleted: deleted,
  };
}

// ===== Pull =====

/**
 * Pull the linked Google Doc's content as a single markdown string,
 * with tab structure encoded via `---Tab name---` markers.
 *
 * @param {string} docId
 * @param {(html: string) => string} convertHtml — caller-supplied HTML
 *   → markdown converter so the same Drive-export inlining the existing
 *   pull path uses (see `link-command.js#htmlToMarkdownSafe`) is
 *   reused without duplicating its CSS class inliner here.
 * @returns {Promise<string>}
 */
export async function pullMarkdownWithTabs(docId, convertHtml) {
  const tabs = await listTabs(docId);
  if (!tabs.length) {
    // No tabs structure — fall back to a single Drive export.
    const html = await exportAsHtml(docId);
    return (convertHtml(html) || "").trim();
  }
  const topLevel = tabs.filter((t) => t.nestingLevel === 0).sort((a, b) => a.index - b.index);
  if (topLevel.length === 1) {
    // Single-tab docs don't need a marker — emitting `---Tab 1---`
    // for a regular doc would just be noise the user has to delete.
    const html = await exportAsHtml(docId, { tabId: topLevel[0].id });
    return (convertHtml(html) || "").trim();
  }
  // Multi-tab — emit a marker for every tab, including the first, so
  // the outline + files-sidebar list every tab by name. `joinTabs`
  // skips the marker when `title` is falsy, so the per-tab fallback
  // name keeps the first tab from disappearing on degenerate input.
  const sections = [];
  for (let i = 0; i < topLevel.length; i++) {
    const tab = topLevel[i];
    const html = await exportAsHtml(docId, { tabId: tab.id });
    const content = (convertHtml(html) || "").trim();
    sections.push({
      title: (tab.title || "").trim() || `Tab ${i + 1}`,
      content,
    });
  }
  return joinTabs(sections);
}

// ===== Helpers =====

function wrapHtml(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}
