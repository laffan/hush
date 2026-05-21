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
  const rootSection = sections[0] || { title: null, content: "" };
  const nonRoot = sections.slice(1);

  const rootHtml = wrapHtml(markdownToHtml(rootSection.content));
  await replaceDocumentContent(docId, rootHtml);

  // After the Drive upload, list the doc's tabs. With tabbed docs the
  // upload replaces only the root tab's content, so any existing
  // top-level tabs stay around — we reconcile them against the
  // markdown's non-root sections by slot.
  const tabs = await listTabs(docId);
  const rootTab = tabs.find((t) => t.nestingLevel === 0 && t.index === 0)
    || tabs[0]
    || null;
  const otherTabs = tabs
    .filter((t) => t !== rootTab && t.nestingLevel === 0)
    .sort((a, b) => a.index - b.index);

  let created = 0;
  for (let i = 0; i < nonRoot.length; i++) {
    const section = nonRoot[i];
    const slotIndex = i + 1; // root is index 0
    const existing = otherTabs[i] || null;
    let tabId = existing?.id || null;
    if (!tabId) {
      tabId = await createTab(docId, slotIndex, section.title);
      created++;
    } else if ((existing.title || "") !== section.title) {
      await renameTab(docId, tabId, section.title);
    }
    if (tabId) {
      await replaceTabPlainText(docId, tabId, section.content);
    }
  }

  let deleted = 0;
  for (let i = nonRoot.length; i < otherTabs.length; i++) {
    await deleteTab(docId, otherTabs[i].id);
    deleted++;
  }

  return {
    tabsPushed: sections.length,
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
  const sections = [];
  for (let i = 0; i < topLevel.length; i++) {
    const tab = topLevel[i];
    const html = await exportAsHtml(docId, { tabId: tab.id });
    const content = (convertHtml(html) || "").trim();
    sections.push({
      title: i === 0 ? null : (tab.title || `Tab ${i + 1}`),
      content,
    });
  }
  return joinTabs(sections);
}

// ===== Helpers =====

function wrapHtml(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}
