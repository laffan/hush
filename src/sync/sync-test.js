/**
 * Run Sync Test — an instrumented two-device round trip.
 *
 * Sync bugs are miserable to report because the interesting part happens
 * on the *other* machine, minutes later, with nothing tying the two
 * halves together. This drives a fixed script on both devices at once
 * and writes every step to the activity log with a `T+<ms>` stamp, so
 * the two logs can be read side by side and the gaps read off directly:
 * how long a file took to arrive, how long an edit took, which file
 * types made it and which didn't.
 *
 * Start it on both machines at roughly the same moment. It:
 *
 *   1. clears the activity log, so a copy-paste of each device's log is
 *      exactly one test run and nothing else;
 *   2. records what this device is — platform, desk, folder, build;
 *   3. creates one probe of each file type, tagged with this device;
 *   4. edits each probe twice, at T+20s and T+50s;
 *   5. watches for the *other* device's probes for three minutes,
 *      logging each arrival and each edit as it lands;
 *   6. prints a summary table of what arrived and how long it took.
 *
 * The probes are ordinary files in the desk's Inbox — delete them when
 * you're done, on either machine.
 *
 * What it does *not* cover: surfaces that are open while the far edit
 * arrives (the reload paths in desk-reload.js). Those need a human
 * watching a screen; this measures delivery.
 */

import { logActivity } from "../activity-log.js";
import { isIOSTauri } from "../command-palette-helpers.js";

const PREFIX = "SyncTest";
/** Edits land at these offsets; the watch runs to the last one + tail. */
const EDIT_AT_MS = [20_000, 50_000];
const WATCH_UNTIL_MS = 180_000;
const POLL_MS = 5_000;

let _running = false;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two devices, one log format: everything is stamped with elapsed
 *  milliseconds since this run started, so the two logs line up even
 *  though their clocks don't. */
function makeLog(started) {
  return (level, message, data) =>
    logActivity("synctest", level, `T+${String(Date.now() - started).padStart(6, "0")}ms  ${message}`, data);
}

/** Which machine this is. Two devices side by side are almost always one
 *  Mac and one iPad; the id suffix keeps the names apart if they aren't. */
async function deviceTag() {
  const base = isIOSTauri() ? "iPad" : "Mac";
  try {
    const info = await invoke("build_info");
    const id = String(info?.deviceId || "").slice(0, 4);
    return id ? `${base}-${id}` : base;
  } catch (_) { return base; }
}

/** `SyncTest Mac-a1b2 Doc` → `Mac-a1b2`; null when it isn't a probe. */
function tagOf(name) {
  const m = /^SyncTest ([^\s]+) (Doc|Notebook|Stack)$/.exec(String(name || ""));
  return m ? m[1] : null;
}
function kindOf(name) {
  const m = /^SyncTest ([^\s]+) (Doc|Notebook|Stack)$/.exec(String(name || ""));
  return m ? m[2] : null;
}

/** The marker every probe carries, whatever its file format. Version
 *  bumps are how the far side detects an edit rather than an arrival. */
const marker = (tag, version) => `hush-sync-test ${tag} v${version}`;

/** Highest version marker present in a file's content, or 0. */
function versionIn(content) {
  let best = 0;
  for (const m of String(content || "").matchAll(/hush-sync-test \S+ v(\d+)/g)) {
    best = Math.max(best, Number(m[1]) || 0);
  }
  return best;
}

// ===== Probe bodies, one per file type =====

async function docBody(tag, version) {
  return [marker(tag, version), "", "Delete this file when the test is over."].join("\n");
}

async function notebookBody(tag, version) {
  const { encodeNotebookContent } = await import("../notebook/notebook-content.ts");
  return encodeNotebookContent({
    shapes: [{
      id: `synctest-${tag}`, type: "text", x: 40, y: 40,
      text: marker(tag, version), fontSize: 18, color: "#000000",
    }],
    layers: [], flowEdges: [], bookmarks: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });
}

async function stackBody(tag, version, columnFileId) {
  const { encodeStackContent } = await import("../stack/stack-content.js");
  return encodeStackContent(
    columnFileId
      ? [{
          id: `synctest-${tag}-${version}`, fileId: columnFileId,
          fileType: "document", name: marker(tag, version),
          width: 400, height: 600, open: true,
        }]
      : [],
    0,
    { scrollY: 0, scrollDirection: "horizontal" },
  );
}

// ===== The run =====

/**
 * Drive the test on this device. Resolves when the watch window closes.
 * Refuses politely when the active desk isn't a local (folder-backed)
 * one — there'd be nothing to sync through.
 */
export async function runSyncTest(state) {
  if (_running) return;
  const desk = state.getActiveDesk?.();
  const root = desk ? state.deskRoots?.[desk.id] : null;
  if (!desk || !root) {
    logActivity("synctest", "error", "Sync test needs a local desk — switch to one whose folder your provider syncs, then run it again", {
      activeDesk: desk?.name || null, isLocal: !!root,
    });
    try {
      const { showImportToast } = await import("../editor/import-toast.js");
      showImportToast("Switch to a local (folder-backed) desk first — the sync test has nothing to sync through.", "error");
    } catch (_) {}
    return;
  }
  _running = true;
  try {
    try { await invoke("activity_log_clear"); } catch (_) {}
    const started = Date.now();
    const log = makeLog(started);
    const tag = await deviceTag();
    let build = null;
    try { build = await invoke("build_info"); } catch (_) {}

    log("info", `Sync test started on ${tag}`, {
      tag, desk: desk.name, deskId: desk.id, folder: root,
      wallClock: new Date(started).toISOString(),
      platform: isIOSTauri() ? "ios" : "desktop",
      build: build ? `${build.version || "?"} ${build.commit || ""}`.trim() : null,
    });

    const probes = await createProbes(state, tag, log);
    const seen = new Map(); // peer file name → highest version logged
    const arrivals = [];

    let nextEdit = 0;
    const deadline = started + WATCH_UNTIL_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const now = Date.now() - started;
      if (nextEdit < EDIT_AT_MS.length && now >= EDIT_AT_MS[nextEdit]) {
        nextEdit++;
        await editProbes(state, tag, probes, nextEdit + 1, log);
      }
      await pollPeers(state, desk.id, tag, seen, arrivals, started, log);
    }

    log("info", "Sync test finished", {
      sent: probes.map((p) => `${p.kind} (${p.name})`),
      peersSeen: [...new Set(arrivals.map((a) => a.tag))],
      arrivals: arrivals.map((a) => `${a.tag} ${a.kind} v${a.version} at T+${a.at}ms`),
      nothingArrived: arrivals.length === 0 || undefined,
    });
  } finally {
    _running = false;
  }
}

/** One probe of each type, created through the app's own paths so the
 *  test exercises what a user does rather than a private shortcut. */
async function createProbes(state, tag, log) {
  const out = [];
  const doc = await state.newFile(null, {
    openImmediately: false,
    initialName: `${PREFIX} ${tag} Doc`,
    initialContent: await docBody(tag, 1),
  });
  if (doc?.fileId) {
    out.push({ kind: "Doc", fileId: doc.fileId, name: doc.name });
    log("info", `Created Doc probe "${doc.name}"`, { fileId: doc.fileId });
  } else log("error", "Doc probe could not be created");

  const nb = await state.createNotebook(`${PREFIX} ${tag} Notebook`, null, {
    openImmediately: false,
    initialContent: await notebookBody(tag, 1),
  });
  if (nb?.fileId) {
    out.push({ kind: "Notebook", fileId: nb.fileId, name: nb.name });
    log("info", `Created Notebook probe "${nb.name}"`, { fileId: nb.fileId });
  } else log("error", "Notebook probe could not be created");

  const st = await state.createStack(`${PREFIX} ${tag} Stack`, null, {
    openImmediately: false,
    initialContent: await stackBody(tag, 1, doc?.fileId || null),
  });
  if (st?.fileId) {
    out.push({ kind: "Stack", fileId: st.fileId, name: st.name });
    log("info", `Created Stack probe "${st.name}"`, { fileId: st.fileId });
  } else log("error", "Stack probe could not be created");

  // The tree save is what places the new files into the desk folder —
  // until it runs they're in staging and there is nothing to sync.
  try {
    await state.saveFileTree();
    log("info", "Probes written to the desk folder", { folderWriteOk: true });
  } catch (e) {
    log("error", "Tree save failed — probes may still be in staging", { error: String(e) });
  }
  return out;
}

/** Bump every probe to `version`, through the ordinary save path. */
async function editProbes(state, tag, probes, version, log) {
  for (const probe of probes) {
    try {
      const content = probe.kind === "Doc" ? await docBody(tag, version)
        : probe.kind === "Notebook" ? await notebookBody(tag, version)
        : await stackBody(tag, version, probes.find((p) => p.kind === "Doc")?.fileId || null);
      await invoke("save_file", { id: probe.fileId, content });
      log("info", `Edited ${probe.kind} probe to v${version}`, { fileId: probe.fileId });
    } catch (e) {
      log("error", `Editing the ${probe.kind} probe failed`, { error: String(e) });
    }
  }
}

/** Look for the other device's probes in the desk, and report each
 *  arrival and each edit exactly once. */
async function pollPeers(state, deskId, ourTag, seen, arrivals, started, log) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;
  const found = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const tag = tagOf(n?.name);
      if (tag && tag !== ourTag && n.fileId) found.push({ node: n, tag });
      if (n?.children) walk(n.children);
    }
  };
  walk(desk.children);

  for (const { node, tag } of found) {
    let version = 0;
    try {
      const file = await invoke("load_file", { id: node.fileId });
      version = versionIn(file?.content);
    } catch (e) {
      // Present in the tree but not readable yet is itself a result
      // worth having — it's the undelivered-file case.
      if (!seen.has(node.name)) {
        seen.set(node.name, 0);
        log("warn", `Peer ${kindOf(node.name)} "${node.name}" is in the tree but not readable yet`, { error: String(e) });
      }
      continue;
    }
    const best = seen.get(node.name) ?? -1;
    if (version > best) {
      seen.set(node.name, version);
      const at = Date.now() - started;
      arrivals.push({ tag, kind: kindOf(node.name), version, at });
      log("info",
        best < 0
          ? `Peer ${kindOf(node.name)} arrived: "${node.name}" at v${version}`
          : `Peer ${kindOf(node.name)} "${node.name}" updated to v${version}`,
        { fromDevice: tag, version, elapsedMs: at });
    }
  }
}
