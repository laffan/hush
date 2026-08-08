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
 *
 * Companion URLs are handled in the main window only, so one request
 * imports once. A secondary window that receives one forwards it there
 * (`FORWARD_EVENT`) — and if iPadOS created that window purely to carry
 * the link, it closes itself again. tauri-plugin-scene-reuse should
 * stop such a window being created in the first place; this is the
 * belt-and-braces half.
 */

import { fetchWindowList, getCurrentWindowLabel } from "../multi-window.js";

const FORWARD_EVENT = "hushwriter-url";

async function importHushwriter(state, url) {
  const { handleHushwriterUrl } = await import("./zotero-helper-import.js");
  await handleHushwriterUrl(state, url);
}

/** True when a window labelled "main" is registered right now. */
async function mainWindowExists() {
  try {
    const windows = await fetchWindowList();
    return windows.some((w) => (w?.label ?? w) === "main");
  } catch (_) {
    return false;
  }
}

async function closeThisWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch (e) {
    console.warn("Couldn't close the carrier window:", e);
  }
}

/** @param coldConnect true when the URL arrived through getCurrent() —
 *  i.e. it was already waiting when this window booted, which is how a
 *  window that iPadOS spawned *for* the link receives it. */
async function handleUrl(state, url, coldConnect = false) {
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
    try {
      if ((await getCurrentWindowLabel()) === "main") {
        await importHushwriter(state, url);
        return;
      }
      // Secondary window. Hand the request to main when there is one;
      // otherwise this window is the only one who can do the work.
      if (!(await mainWindowExists())) {
        await importHushwriter(state, url);
        return;
      }
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo("main", FORWARD_EVENT, url);
      if (coldConnect) await closeThisWindow();
    } catch (e) {
      console.warn("hushwriter:// deep link failed:", e);
    }
  }
}

/** Called once from main.js during init. */
export async function setupDeepLinks(state) {
  try {
    // Main window: also accept requests relayed by a secondary window.
    // The import module dedupes by nonce, so a relay that races the
    // system's own delivery can't import twice.
    if ((await getCurrentWindowLabel()) === "main") {
      const { listen } = await import("@tauri-apps/api/event");
      await listen(FORWARD_EVENT, async (event) => {
        const url = event?.payload;
        if (typeof url === "string") {
          try {
            await importHushwriter(state, url);
          } catch (e) {
            console.warn("Relayed hushwriter:// deep link failed:", e);
          }
        }
      });
    }

    const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
    // Cold launch: the OS hands the URL to the process before any JS
    // listener exists; getCurrent() returns those pending URLs so we
    // don't drop the open-with payload that woke the app.
    try {
      const launchUrls = await getCurrent();
      if (Array.isArray(launchUrls)) {
        for (const url of launchUrls) await handleUrl(state, url, true);
      }
    } catch (e) { console.warn("Deep-link getCurrent failed:", e); }
    await onOpenUrl(async (urls) => {
      for (const url of urls) await handleUrl(state, url);
    });
  } catch (e) { console.error("Deep-link setup failed:", e); }
}
