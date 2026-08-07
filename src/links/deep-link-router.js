/**
 * Deep-link routing — registers the app's URL handlers and dispatches
 * each incoming URL to the right feature module:
 *
 *   file:// (or bare paths)   externally-opened .hushnote / .hushstack /
 *                             .hushproject / .md files (iPadOS open-with)
 *   hushwriter://             companion-app requests, e.g. zotero-helper's
 *                             "Send to Hush" (links/zotero-helper-import.js)
 *
 * Google OAuth does NOT come through here — it uses a loopback HTTP
 * listener (commands/google_docs.rs) surfaced as the `oauth-callback`
 * event handled in main.js.
 */

import { getCurrentWindowLabel } from "../multi-window.js";

async function handleUrl(state, url) {
  if (url.startsWith("file://") || url.startsWith("/")) {
    // Cold launches surface through getCurrent(); already-running
    // launches through onOpenUrl.
    try {
      const { importExternalFile } = await import("../editor/external-open.js");
      await importExternalFile(state, url);
    } catch (e) {
      console.warn("External file open failed:", e);
      try {
        const { showImportToast } = await import("../editor/import-toast.js");
        showImportToast(`Couldn't open ${url.split("/").pop()}: ${e?.message || e}`, "error");
      } catch (_) {}
    }
  } else if (url.startsWith("hushwriter://")) {
    // Deep-link delivery multiplies: onOpenUrl fires in EVERY open
    // window, its implementation replays getCurrent() on top of our own
    // getCurrent() call, and iPad webview reloads replay it again. Only
    // the main window acts on companion requests (the import module
    // additionally dedupes by request nonce).
    try {
      if ((await getCurrentWindowLabel()) !== "main") return;
      const { handleHushwriterUrl } = await import("./zotero-helper-import.js");
      await handleHushwriterUrl(state, url);
    } catch (e) {
      console.warn("hushwriter:// deep link failed:", e);
    }
  }
}

/** Called once from main.js during init. */
export async function setupDeepLinks(state) {
  try {
    const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
    // Cold launch: the OS hands the URL to the process before any JS
    // listener exists; getCurrent() returns those pending URLs so we
    // don't drop the open-with payload that woke the app.
    try {
      const launchUrls = await getCurrent();
      if (Array.isArray(launchUrls)) {
        for (const url of launchUrls) await handleUrl(state, url);
      }
    } catch (e) { console.warn("Deep-link getCurrent failed:", e); }
    await onOpenUrl(async (urls) => {
      for (const url of urls) await handleUrl(state, url);
    });
  } catch (e) { console.error("Deep-link setup failed:", e); }
}
