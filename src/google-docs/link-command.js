/**
 * Command-palette flows for the Google Docs integration.
 *
 *   - importFromGoogleDoc(state)       Phase 2a: opens the picker, pulls a
 *                                      GDoc, and creates an UNLINKED Hush doc
 *                                      from its content. No link bar; the
 *                                      new doc is just a one-shot import.
 *   - linkCurrentDocument(state)       Phase 2b: opens the picker (with
 *                                      "Create new" option), then runs the
 *                                      source-of-truth modal, performs the
 *                                      initial push or pull, and stores the
 *                                      link so the link bar appears next
 *                                      time the doc is opened.
 *   - unlinkCurrentDocument(state)     Phase 2b: forgets the link. Both
 *                                      documents are left untouched.
 *   - pushToGoogleDoc(state, link)     Used by the link bar's Push button.
 *   - pullFromGoogleDoc(state, link)   Used by the link bar's Pull button.
 *
 * Hush's existing markdown ↔ HTML converters from Phase 1 are reused on
 * both sides of the wire — push runs `markdownToHtml`, pull runs
 * `htmlToMarkdown`. That keeps Phase 1's syntax handling (==highlight==
 * → <mark>, %%comments%% strip, lists with `aria-level` depth) exactly
 * the same for the API path.
 */
import {
  listDocuments,
  createDocumentFromHtml,
  getDocumentMeta,
} from "./api.js";
import { hasTokensAsync } from "./auth.js";
import { openGoogleDocPicker } from "./picker.js";
import { openSourceOfTruthModal } from "./source-of-truth-modal.js";
import { setLink, clearLink, appendLog, getLink } from "./link-store.js";
import { htmlToMarkdown } from "../editor/google-docs/html-to-markdown.js";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { pushMarkdownWithTabs, pullMarkdownWithTabs } from "./tabs-sync.js";
import {
  fetchAndWeaveComments, resolveMarkedComments, extractCommentMarkers,
  stripResolvedComments,
} from "./comments-sync.js";
import { tryIncrementalPush } from "./incremental-push.js";

// "drive.file" reference: listDocuments suppressed unused import warning.
void listDocuments;

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function requireConnection() {
  // Async because this may run in a window whose auth.js module-local
  // cache hasn't been primed from settings yet (Settings vs. main editor
  // each get their own module instance).
  if (!(await hasTokensAsync())) {
    throw new Error("Connect Google Docs in Settings > Sync > Google Sync first.");
  }
}

function currentDocFileId(state) {
  if (state.currentNotebookFileId) return null;
  if (state.currentProjectId) return null;
  return state.currentFileId || null;
}

function currentDocName(state) {
  const fileId = currentDocFileId(state);
  if (!fileId) return "Untitled";
  const node = findNodeByFileId(state.fileTree, fileId);
  return node?.name || "Untitled";
}

// Google Docs's HTML export can render the document title more than once
// at the very top (the styled title paragraph plus a heading carrying the
// same text), and a prior destructive push can leave extra copies behind —
// so on each pull/push cycle a title could accumulate. Collapse *every*
// consecutive copy of the first content line down to one. Skips a leading
// `---Tab---` marker so the first tab's title is handled too.
function dropDuplicateLeadingTitle(md) {
  if (typeof md !== "string" || !md) return md || "";
  const norm = (s) => s.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^---.+---$/.test(lines[i].trim())) {
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
  }
  if (i >= lines.length) return md;
  const first = norm(lines[i]);
  if (!first) return md;
  for (;;) {
    let k = i + 1;
    while (k < lines.length && lines[k].trim() === "") k++;
    if (k < lines.length && norm(lines[k]) === first) lines.splice(i + 1, k - i);
    else break;
  }
  return lines.join("\n");
}

// ===== Phase 2a: Import =====

export async function importFromGoogleDoc(state) {
  await requireConnection();
  const picked = await openGoogleDocPicker({ allowCreate: false });
  if (!picked) return;
  // Tab-aware pull so the imported doc keeps `---Tab name---` markers
  // for every Google Doc tab; falls back to a flat single-tab export
  // when the doc has no tabs.
  let md = await pullMarkdownWithTabs(picked.id, htmlToMarkdownSafe);
  md = dropDuplicateLeadingTitle(md);
  // Recover the inline comment-marker positions, then weave comments in at
  // the exact instance Google anchored them to.
  const { clean, positions } = extractCommentMarkers(md);
  md = await fetchAndWeaveComments(picked.id, clean, positions);
  // Create the file but don't open it yet — we need the link stored
  // before the editor switches so the link bar paints in one pass on
  // `file-opened`, instead of waiting for a follow-up settings-changed
  // pulse the user can briefly see as "no link" first.
  const created = await state.newFile(null, {
    initialContent: md,
    initialName: picked.name || "Untitled",
    openImmediately: false,
  });
  if (!created?.fileId) return created;
  await setLink(state, created.fileId, {
    docId: picked.id,
    title: picked.name || "Untitled",
  });
  await state.openFile(created.fileId);
  appendLog(state, `Imported and linked "${picked.name}"`);
  return created;
}

// ===== Phase 2b: Link / Unlink / Push / Pull =====

export async function linkCurrentDocument(state) {
  await requireConnection();
  const fileId = currentDocFileId(state);
  if (!fileId) {
    throw new Error("Open a Hush document first to link it to a Google Doc.");
  }
  const existing = getLink(state, fileId);
  if (existing) {
    throw new Error(`This document is already linked to "${existing.title}". Unlink it first.`);
  }
  const hushTitle = currentDocName(state);
  const picked = await openGoogleDocPicker({
    allowCreate: true,
    defaultTitle: hushTitle,
  });
  if (!picked) return;

  // Branch A: user chose "Create new". Push current Hush content to a
  // fresh GDoc — there's no source-of-truth question because the GDoc
  // doesn't exist yet. Create the doc empty, then run the tab-aware
  // push so any `---Tab name---` markers in the markdown land as real
  // Google Doc tabs from the start.
  if (picked.create) {
    const md = state.editor?.view?.state?.doc?.toString() || "";
    const created = await createDocumentFromHtml(picked.title || hushTitle, "");
    await setLink(state, fileId, { docId: created.id, title: created.name || picked.title });
    await pushMarkdownWithTabs(created.id, md);
    appendLog(state, `Created and linked new Google Doc "${created.name}"`);
    return;
  }

  // Branch B: user picked an existing GDoc. Ask which side wins, then do
  // the matching one-shot push or pull.
  const choice = await openSourceOfTruthModal({
    hushTitle,
    gdocTitle: picked.name,
  });
  if (!choice) return; // cancelled — link not established
  await setLink(state, fileId, { docId: picked.id, title: picked.name });
  if (choice === "hush") {
    await pushToGoogleDoc(state, { docId: picked.id, title: picked.name });
    appendLog(state, `Linked to "${picked.name}" and pushed Hush content`);
  } else {
    await pullFromGoogleDoc(state, { docId: picked.id, title: picked.name });
    appendLog(state, `Linked to "${picked.name}" and pulled GDoc content`);
  }
}

/** One-shot "Create Google Doc from current" — pushes the current
 *  Hush doc's content into a brand-new Google Doc named after the
 *  Hush file, then stores the link so the editor's link bar appears
 *  on next render. Mirrors the "Create new" branch of
 *  `linkCurrentDocument` without prompting through the picker. */
export async function createGoogleDocFromCurrent(state) {
  await requireConnection();
  const fileId = currentDocFileId(state);
  if (!fileId) {
    throw new Error("Open a Hush document first to create a Google Doc from it.");
  }
  const existing = getLink(state, fileId);
  if (existing) {
    throw new Error(`This document is already linked to "${existing.title}". Unlink it first.`);
  }
  const hushTitle = currentDocName(state);
  const md = state.editor?.view?.state?.doc?.toString() || "";
  const created = await createDocumentFromHtml(hushTitle, "");
  await setLink(state, fileId, { docId: created.id, title: created.name || hushTitle });
  // Run the tab-aware push so `---Tab name---` markers in the markdown
  // land as real Google Doc tabs from the start.
  await pushMarkdownWithTabs(created.id, md);
  appendLog(state, `Created and linked new Google Doc "${created.name || hushTitle}"`);
  return created;
}

export async function unlinkCurrentDocument(state) {
  const fileId = currentDocFileId(state);
  if (!fileId) return;
  const link = getLink(state, fileId);
  if (!link) return;
  await clearLink(state, fileId);
  appendLog(state, `Unlinked "${link.title}"`);
}

export async function pushToGoogleDoc(state, link) {
  await requireConnection();
  if (!link?.docId) throw new Error("No Google Doc linked to this document.");
  const md = state.editor?.view?.state?.doc?.toString() || "";
  // Apply any locally-resolved comments to Google before we strip the
  // comment scaffolding from the pushed body. Surface the outcome so a
  // failure (e.g. a permissions issue) is visible in the sync log rather
  // than silently swallowed.
  const res = await resolveMarkedComments(link.docId, md);
  if (res.resolved) appendLog(state, `Resolved ${res.resolved} comment${res.resolved === 1 ? "" : "s"} in Google`);
  if (res.failed) appendLog(state, `Failed to resolve ${res.failed} comment${res.failed === 1 ? "" : "s"} (see console)`);
  if (res.noId) appendLog(state, `${res.noId} resolved comment${res.noId === 1 ? "" : "s"} have no Google id — pull the doc again to enable resolving`);
  // Prefer an incremental, non-destructive push (paragraph-level diff via
  // batchUpdate) so existing comments and formatting survive. It returns
  // false for cases it can't safely handle (multi-tab, footnotes, etc.),
  // in which case we fall back to the whole-document push. A thrown error
  // means the incremental apply already partially landed, so we must NOT
  // fall back to an overwrite on top of it — let it propagate.
  const applied = await tryIncrementalPush(link.docId, md);
  if (!applied) {
    // Tab-aware push: parses `---Tab name---` markers, mirrors them to
    // real Google Doc tabs, and pushes the root section's HTML via Drive
    // media upload (Drive's upload only touches the root tab on tabbed
    // docs, so other tabs survive and are reconciled via the Docs API).
    await pushMarkdownWithTabs(link.docId, md);
  }
  // The push succeeded, so any locally-resolved comments are now resolved
  // in Google (or queued for the next pull if the API call failed). Drop
  // them from the editor immediately rather than waiting for a pull —
  // resolved comments stay resolved.
  const cleaned = stripResolvedComments(md);
  if (cleaned !== md && state.editor?.setContent) {
    state.editor.setContent(cleaned);
    state.markDirty?.();
    await state.saveCurrentFile?.();
  }
  // Read the post-push title for the link cache so a stale title from
  // the link object doesn't shadow what Drive currently shows.
  const meta = await getDocumentMeta(link.docId).catch(() => null);
  if (meta?.name && meta.name !== link.title) {
    await setLink(state, currentDocFileId(state), {
      docId: link.docId,
      title: meta.name,
    });
  }
  appendLog(state, `Pushed Hush content to "${meta?.name || link.title}"`);
}

export async function pullFromGoogleDoc(state, link) {
  await requireConnection();
  if (!link?.docId) throw new Error("No Google Doc linked to this document.");
  // Fetch the meta first so a deleted / inaccessible doc is reported
  // cleanly before we touch the editor buffer.
  const meta = await getDocumentMeta(link.docId);
  if (meta?.trashed) {
    throw new Error("The linked Google Doc is in Trash. Restore it or unlink.");
  }
  // Tab-aware pull: walks every top-level tab, exports each in
  // isolation, converts each to markdown, and rejoins them with
  // `---Tab name---` separators.
  let md = await pullMarkdownWithTabs(link.docId, htmlToMarkdownSafe);
  md = dropDuplicateLeadingTitle(md);
  // Recover the inline comment-marker positions, then weave comments in at
  // the exact instance Google anchored them to.
  const { clean, positions } = extractCommentMarkers(md);
  md = await fetchAndWeaveComments(link.docId, clean, positions);
  // Replace the editor buffer; existing autosave + snapshot pipeline
  // captures this transition for free, so the user can recover via
  // Versions if the pull was a mistake.
  if (state.editor?.setContent) {
    state.editor.setContent(md);
    state.markDirty?.();
    await state.saveCurrentFile?.();
  }
  // Refresh the cached title in the link if Drive has a newer one.
  const fileId = currentDocFileId(state);
  if (fileId && meta?.name && meta.name !== link.title) {
    await setLink(state, fileId, { docId: link.docId, title: meta.name });
  }
  appendLog(state, `Pulled "${meta?.name || link.title}" from Google Docs`);
}

// ===== Conversion shims =====

// Drive's HTML *export* differs from Google Docs's *clipboard* HTML:
// instead of inline-styled spans, paragraphs and runs carry CSS classes
// defined in a `<style>` block at the top of the document. Our Phase 1
// `htmlToMarkdown` reads inline `style=""` attributes only, so before
// running it we inline the relevant CSS rules onto the elements they
// apply to. The conversion is intentionally narrow: only the four
// properties we care about (`font-weight`, `font-style`,
// `text-decoration`, `background-color`).
function htmlToMarkdownSafe(html) {
  if (!html) return "";
  const inlined = inlineGoogleExportStyles(html);
  // `commentMarkers: true` keeps each inline comment marker as a position
  // sentinel so the comment weaver can anchor to the right text instance.
  const md = htmlToMarkdown(inlined, { commentMarkers: true });
  if (md == null) return "";
  return md;
}

const RELEVANT_CSS_PROPS = ["font-weight", "font-style", "text-decoration", "background-color"];

function inlineGoogleExportStyles(html) {
  if (!html.includes("<style") || typeof DOMParser === "undefined") return html;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch (_) { return html; }
  const styleEls = doc.querySelectorAll("style");
  if (!styleEls.length) return html;

  // Build a class → declarations map. Drive's exported stylesheet uses
  // very simple selectors (`.c1 { … }`, `.c2 .c3 { … }`); we only need
  // the single-class case to capture the runs.
  const classMap = new Map();
  for (const styleEl of styleEls) {
    const css = styleEl.textContent || "";
    const re = /\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const cls = m[1];
      const decls = m[2];
      const buf = classMap.get(cls) || [];
      for (const prop of RELEVANT_CSS_PROPS) {
        const re2 = new RegExp(`(^|;|\\s)${prop}\\s*:\\s*([^;]+?)(?=;|$)`, "i");
        const dm = re2.exec(decls);
        if (dm) buf.push(`${prop}: ${dm[2].trim()}`);
      }
      classMap.set(cls, buf);
    }
  }
  if (!classMap.size) return html;

  // Walk every element with a class attribute and append the matched
  // declarations to its inline style. Existing inline styles win — we
  // prepend, not overwrite.
  const all = doc.querySelectorAll("[class]");
  for (const el of all) {
    const classes = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const decls = [];
    for (const c of classes) {
      const buf = classMap.get(c);
      if (buf) decls.push(...buf);
    }
    if (decls.length) {
      const existing = el.getAttribute("style") || "";
      const merged = decls.join("; ") + (existing ? "; " + existing : "");
      el.setAttribute("style", merged);
    }
  }
  return doc.documentElement.outerHTML;
}

// Suppress unused-warning for IS_TAURI in environments that import this
// without using the tokens guard (web / dev preview). Kept available
// for future flows that might branch on Tauri presence.
void IS_TAURI;
