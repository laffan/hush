/**
 * The "I clicked it and nothing happened, so I clicked it again" path.
 *
 * Opening a file out of a provider-synced desk folder is not the instant
 * local read the rest of the app assumes. Two things happen instead, and
 * until this module existed both looked identical from the outside — the
 * editor kept showing the *previous* file:
 *
 *  - **The read is slow.** macOS materialises a dataless file on
 *    `open()`, so the read blocks until iCloud delivers it. `load_file`
 *    is async, so nothing freezes — the old document just sits there for
 *    a few seconds with no indication that anything is happening.
 *  - **The read fails.** iOS doesn't materialise on `open()` at all: an
 *    evicted file is a `.<name>.icloud` placeholder and plain `std::fs`
 *    reads through to ENOENT. The open was then reported as content
 *    *loss* — a toast telling the user to run the repair tool over a
 *    file that was in perfectly good health, just elsewhere. Clicking
 *    again worked because the failure had meanwhile kicked a download.
 *
 * So: say what's happening, ask the provider for the file, and finish
 * the open when it lands. Only a file that stays unavailable after that
 * is reported as unopenable.
 */

import { logActivity } from "../activity-log.js";
import { reportUnopenableFile } from "./unopenable-file.js";
import { isIOSTauri } from "../command-palette-helpers.js";

/** Rust's marker for "the provider has this, we don't yet" —
 *  `desk_store::AWAITING_DOWNLOAD`. The absolute path follows it. */
const AWAITING = "awaiting-download";

/** How long an open may take before it earns an on-screen explanation.
 *  Long enough that a normal local read never shows one; short enough
 *  that "nothing happened" never gets a chance to be the impression. */
const SLOW_OPEN_MS = 350;

/** Retry backoff for a file the provider hasn't delivered. The iOS
 *  coordinated read already blocks until the bytes land, so the first
 *  retry almost always wins; the rest cover a download that needs longer
 *  than one request. ~6s total before giving up. */
const RETRY_MS = [400, 800, 1600, 3200];

/** Bumped by every open. A download that finishes after the user has
 *  moved on must not yank the editor to a file they left behind. */
let _seq = 0;
/** The file the newest open is for. Supersession is about the user
 *  changing their mind, so it takes BOTH a newer open and a different
 *  file: two opens racing for the same one (a tap the panel delivered
 *  twice, a restore landing on the file the user just clicked) are the
 *  same intent, and abandoning the first left the caller holding null —
 *  which, before `openFile` was reordered to load first, blanked the
 *  editor and turned one tap into two. */
let _latestId = null;

/** True when a newer open for a DIFFERENT file has started. */
function superseded(mine, id) {
  return _seq !== mine && _latestId !== id;
}

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** iOS: ask iCloud for the file. The plugin's coordinated read runs
 *  `startDownloadingUbiquitousItem` and waits for the bytes — the only
 *  thing in the app that can make an evicted file appear, since the desk
 *  store is plain `std::fs` throughout. Desktop needs no equivalent:
 *  the failing read there is rare, and the retry re-reads anyway. */
async function requestDownload(path) {
  if (!isIOSTauri() || !path) return;
  try { await invoke("plugin:icloud-folder|read_file", { path }); }
  catch (_) { /* still coming, or offline — the retry loop decides */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Path out of an `awaiting-download: /abs/path` error, or null when the
 *  error is something else entirely. Matched with the colon so a file
 *  that merely *contains* the word can't be mistaken for the marker. */
function undeliveredPath(error) {
  const text = String(error?.message ?? error ?? "");
  const at = text.indexOf(`${AWAITING}:`);
  if (at < 0) return null;
  return text.slice(at + AWAITING.length + 1).trim();
}

/**
 * Load a file for opening, with feedback and a download retry.
 *
 * Resolves to the `FileEntry`, or to null when the file could not be
 * produced — in which case the caller leaves the editor as it was and
 * `reportUnopenableFile` has already said so. Also resolves to null if
 * the user opened something else while this was waiting.
 */
export function loadFileForOpen(state, id, node) {
  // The read *is* the attempt: a doc's content is wanted either way, so
  // there's nothing to gain from probing first.
  return waitForDelivery(state, id, node, () => invoke("load_file", { id }));
}

/**
 * Wait until a file's bytes are on the device, without reading them.
 *
 * For the surfaces whose own mount does the loading — notebooks and
 * stacks — where reading the file here just to check would mean
 * inflating a multi-megabyte envelope twice. `file_availability` is a
 * stat. Resolves true when the file is ready to open.
 *
 * PDFs don't use this: their binaries are a per-device cache rebuilt
 * from Zotero, never in the desk folder, so a provider never has one to
 * deliver.
 */
export function ensureFileAvailable(state, id, node) {
  return waitForDelivery(state, id, node, async () => {
    const a = await invoke("file_availability", { id });
    if (a?.state === "ready") return true;
    // Re-shaped as the same error the read path throws, so one loop
    // handles both.
    throw new Error(a?.state === AWAITING
      ? `${AWAITING}: ${a.path || ""}`
      : `file not found: ${id}`);
  }).then((ok) => !!ok);
}

/** The shared wait: run `attempt` until it yields, explaining itself on
 *  screen if it takes a moment and asking the provider for the file when
 *  the failure says the provider is why. */
async function waitForDelivery(state, id, node, attempt) {
  const mine = ++_seq;
  _latestId = id;
  const name = node?.name || "this file";
  const started = Date.now();
  let toast = null;
  let done = false;
  // Set once we know *why* the wait is happening. The vague message is
  // on a timer and the specific one isn't, so on a slow download the
  // timer would otherwise fire second and replace "Downloading X from
  // iCloud" with "Opening X" — trading the answer for the question.
  let explained = false;
  const say = async (message, { specific = false } = {}) => {
    const m = await import("../editor/import-toast.js");
    // Re-checked *after* the import: the wait can finish while this is
    // in flight, and a sticky toast raised past the end never gets
    // dismissed.
    if (done || superseded(mine, id)) return;
    if (explained && !specific) return;
    if (specific) explained = true;
    toast = m.showImportToast(message, "info", { sticky: true });
  };
  const hush = async () => {
    if (!toast) return;
    const m = await import("../editor/import-toast.js");
    m.dismissImportToast(toast);
    toast = null;
  };
  // A read that returns promptly should never flash a banner, so the
  // "this is taking a moment" message is armed on a timer rather than
  // shown up front.
  const slow = setTimeout(() => { void say(`Opening “${name}”…`); }, SLOW_OPEN_MS);

  try {
    let error = null;
    for (let round = 0; round <= RETRY_MS.length; round++) {
      try {
        const result = await attempt();
        if (superseded(mine, id)) {
          logActivity("files", "info", `Abandoned the open of "${name}" — moved on`, { fileId: id });
          return null; // the user moved on
        }
        const took = Date.now() - started;
        if (took >= SLOW_OPEN_MS) {
          logActivity("files", "info", `Opened "${name}" after waiting for the provider`, {
            fileId: id, waitedMs: took, attempts: round + 1,
          });
        }
        return result;
      } catch (e) {
        error = e;
        const path = undeliveredPath(e);
        if (path === null) break; // a real failure, not a slow provider
        if (round === 0) {
          logActivity("files", "warn", `Waiting for "${name}" to download`, {
            fileId: id, path, platform: isIOSTauri() ? "ios" : "desktop",
          });
          await say(`Downloading “${name}” from iCloud…`, { specific: true });
        }
        if (round === RETRY_MS.length) break;
        await requestDownload(path);
        if (superseded(mine, id)) return null;
        await sleep(RETRY_MS[round]);
        if (superseded(mine, id)) return null;
      }
    }
    if (superseded(mine, id)) return null;
    await hush();
    // Out of retries, or an error that was never about downloading.
    if (undeliveredPath(error) !== null) {
      logActivity("files", "error", `"${name}" never finished downloading`, {
        fileId: id, waitedMs: Date.now() - started,
      });
      const m = await import("../editor/import-toast.js");
      m.showImportToast(
        `“${name}” hasn't downloaded yet — check your connection, or open it once in the Files app.`,
        "error",
      );
    } else {
      await reportUnopenableFile(state, id, node, error);
    }
    return null;
  } finally {
    done = true;
    clearTimeout(slow);
    if (!superseded(mine, id)) await hush();
  }
}
