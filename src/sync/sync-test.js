/**
 * Run Sync Test — an instrumented two-device round trip.
 *
 * Sync bugs are miserable to report because the interesting part happens
 * on the *other* machine, minutes later, with nothing tying the two
 * halves together. This drives the same script on both devices and
 * stamps every line `T+<ms>`, so the two logs read side by side and the
 * latencies come straight off.
 *
 * It is a **handshake**, not two timelines running past each other. Each
 * device creates its probes, then waits until it has actually seen the
 * peer's before sending the next round — so every edit in the log is one
 * the other side confirmed receiving, and a round that didn't cross says
 * so in as many words instead of being absent. The run ends as soon as
 * the last round is confirmed, which also means the log you copy is a
 * finished one.
 *
 *   1. clears the activity log, so each device's log is exactly one run;
 *   2. optionally creates/adopts a desk first (the `newDesk` option) —
 *      the folder-identity path, which is where the worst bug lived;
 *   3. creates a Doc, a Notebook and a Stack tagged with this device;
 *   4. round 1: waits for the peer's probes, then edits its own to v2;
 *   5. round 2: waits for the peer's v2, then edits its own to v3;
 *   6. waits for the peer's v3 and prints a per-type, per-round verdict.
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
const KINDS = ["Doc", "Notebook", "Stack"];
/** Versions after the initial create — two genuine back-and-forth edits. */
const ROUNDS = [2, 3];
/** How long one round may wait for the peer before it's called a miss. */
const ROUND_TIMEOUT_MS = 60_000;
/** How long to wait for any sign of the other device at all. */
const PEER_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;
/** After the reply round, how long to let the two writes settle before
 *  reading every probe back. */
const CROSSTALK_SETTLE_MS = 20_000;
/** Probes from an *earlier* run would otherwise read as an instant
 *  arrival. Both devices start within seconds of each other, so anything
 *  claiming to be older than this is a leftover. */
const RUN_SKEW_MS = 10 * 60_000;

let _running = false;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two devices, one log format: elapsed milliseconds since this run
 *  started, so the logs align even though the clocks don't. */
function makeLog(started) {
  return (level, message, data) =>
    logActivity("synctest", level, `T+${String(Date.now() - started).padStart(6, "0")}ms  ${message}`, data);
}

/** Which machine this is. Two devices side by side are almost always one
 *  Mac and one iPad; the id suffix keeps them apart if they aren't. */
async function deviceTag() {
  const base = isIOSTauri() ? "iPad" : "Mac";
  try {
    const info = await invoke("build_info");
    const id = String(info?.deviceId || "").slice(0, 4);
    return id ? `${base}-${id}` : base;
  } catch (_) { return base; }
}

const NAME_RE = /^SyncTest (\S+) (Doc|Notebook|Stack)$/;
const probeName = (tag, kind) => `${PREFIX} ${tag} ${kind}`;

/** The marker every probe carries, whatever its file format. `label` is
 *  `v1`/`v2`/`v3` for the owner's own rounds, or `reply` for a line the
 *  *other* device appended into this file. `run` is the sender's start
 *  time — that's what tells this run's probes from a previous run's
 *  leftovers. */
const marker = (tag, label, run) => `hush-sync-test ${tag} ${label} run${run}`;
const MARK_RE = /hush-sync-test (\S+) (v\d+|reply) run(\d+)/g;

/** What each device has written into a probe: tag → { top, labels, run }.
 *  Edits **append**, so a finished probe carries the owner's whole
 *  history and the other device's reply beside it — you can open the
 *  file and read the exchange rather than infer it from a log. */
function markersByTag(content) {
  const out = new Map();
  for (const m of String(content || "").matchAll(MARK_RE)) {
    const [, tag, label, run] = m;
    const entry = out.get(tag) || { top: 0, labels: [], run: Number(run) || 0 };
    if (label.startsWith("v")) entry.top = Math.max(entry.top, Number(label.slice(1)) || 0);
    entry.labels.push(label);
    out.set(tag, entry);
  }
  return out;
}

// ===== Probe bodies, one per file type =====
//
// Every edit appends. Three rounds leave three lines (three text shapes,
// three stack columns) and the peer's reply makes four — which is the
// point: open any probe afterwards and both machines' marks are in it.

function appendToDoc(current, line) {
  const body = String(current || "").trimEnd();
  return body ? `${body}\n${line}` : line;
}

async function appendToNotebook(current, line, tag, n) {
  const { encodeNotebookContent, decodeNotebookContent } =
    await import("../notebook/notebook-content.ts");
  const snap = (current && decodeNotebookContent(current)) || null;
  const shapes = Array.isArray(snap?.shapes) ? [...snap.shapes] : [];
  shapes.push({
    id: `synctest-${tag}-${n}`, type: "text", x: 40, y: 40 + shapes.length * 48,
    text: line, fontSize: 18, color: "#000000",
  });
  return encodeNotebookContent({
    shapes,
    layers: snap?.layers || [],
    flowEdges: snap?.flowEdges || [],
    bookmarks: snap?.bookmarks || [],
    camera: snap?.camera || { x: 0, y: 0, zoom: 1 },
  });
}

async function appendToStack(current, line, tag, n, columnFileId) {
  const { encodeStackContent, decodeStackContent } = await import("../stack/stack-content.js");
  const data = current ? decodeStackContent(current) : { items: [], scrollX: 0 };
  const items = [...(data.items || [])];
  if (columnFileId) {
    items.push({
      id: `synctest-${tag}-${n}`, fileId: columnFileId, fileType: "document",
      name: line, width: 400, height: 600, open: true,
    });
  }
  return encodeStackContent(items, data.scrollX || 0, {
    scrollY: data.scrollY || 0,
    scrollDirection: data.scrollDirection || "horizontal",
  });
}

/** Append `label`'s marker to whatever `current` holds, in that kind's
 *  own format. `current` null means "start the file". */
async function appendMarker(kind, current, tag, label, run, docFileId, n) {
  const line = marker(tag, label, run);
  if (kind === "Doc") {
    return appendToDoc(current ?? "", line)
      + (current ? "" : "\n\nDelete this file when the test is over.");
  }
  if (kind === "Notebook") return appendToNotebook(current, line, tag, n);
  return appendToStack(current, line, tag, n, docFileId);
}

/** Read a probe, append our marker, write it back. Returns false when
 *  the file couldn't be read — a result in itself. */
async function appendToProbe(fileId, kind, tag, label, run, docFileId, n) {
  let current = null;
  try {
    const file = await invoke("load_file", { id: fileId });
    current = file?.content ?? null;
  } catch (_) { return false; }
  await invoke("save_file", {
    id: fileId,
    content: await appendMarker(kind, current, tag, label, run, docFileId, n),
  });
  return true;
}

// ===== The run =====

/**
 * Drive the test on this device.
 *
 * `newDesk: true` runs the folder picker first and opens the chosen
 * folder as a desk — pick (or create) the *same* folder name on both
 * machines and the log records which device initialised it and which
 * adopted it, which is the identity handshake that used to go wrong.
 */
export async function runSyncTest(state, { newDesk = false } = {}) {
  if (_running) return;
  _running = true;
  const started = Date.now();
  const log = makeLog(started);
  try {
    try { await invoke("activity_log_clear"); } catch (_) {}
    const tag = await deviceTag();

    if (newDesk && !(await adoptTestDesk(state, log))) return;

    const desk = state.getActiveDesk?.();
    const root = desk ? state.deskRoots?.[desk.id] : null;
    if (!desk || !root) {
      log("error", "Sync test needs a local desk — switch to one whose folder your provider syncs, then run it again", {
        activeDesk: desk?.name || null, isLocal: !!root,
      });
      await toast("Switch to a local (folder-backed) desk first — the sync test has nothing to sync through.", "error");
      return;
    }

    let build = null;
    try { build = await invoke("build_info"); } catch (_) {}
    log("info", `Sync test started on ${tag}`, {
      tag, desk: desk.name, deskId: desk.id, folder: root,
      wallClock: new Date(started).toISOString(),
      platform: isIOSTauri() ? "ios" : "desktop",
      build: build ? `${build.version || "?"} ${build.commit || ""}`.trim() : null,
      rounds: ROUNDS.length,
    });

    // { kind, version, waitedMs }        the peer's copy arrived
    // { kind, version, missed: true }    it never did
    // { kind, version, failedToSend }    it never left *this* device
    const { probes, unsent } = await createProbes(state, tag, started, log);
    const results = [...unsent];
    const sentAt = new Map([[1, Date.now()]]);

    // Round 0 is the create; each later round waits for the peer to
    // confirm the previous one before sending its own.
    let peerTag = null;
    for (const version of [1, ...ROUNDS]) {
      if (version > 1) {
        results.push(...await editProbes(state, desk.id, tag, started, probes, version, log));
        sentAt.set(version, Date.now());
      }
      const budget = version === 1 ? PEER_TIMEOUT_MS : ROUND_TIMEOUT_MS;
      const round = await awaitPeerVersion(state, desk.id, tag, version, sentAt.get(version), budget, log);
      peerTag = round.peerTag || peerTag;
      results.push(...round.results);
      if (version === 1 && !round.results.some((r) => !r.missed)) {
        log("error", "No sign of the other device — is the test running there, on the same desk?", {
          waitedMs: Date.now() - sentAt.get(1),
        });
        break;
      }
    }

    // Both devices write into each other's files, and both read
    // everything back. Skipped when the peer never showed up.
    if (peerTag) await crosstalk(state, desk.id, tag, started, log);

    // Then the last thing anyone does with a file: throw it away.
    const trashed = peerTag
      ? await trashRound(state, desk.id, tag, probes, log)
      : [];
    results.push(...trashed);

    summarise(log, tag, peerTag, probes, results);
  } catch (e) {
    log("error", "Sync test failed", { error: String(e), stack: e?.stack || null });
  } finally {
    _running = false;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("hush-sync-test-done");
    } catch (_) {}
  }
}

async function toast(message, kind) {
  try {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(message, kind);
  } catch (_) {}
}

/** The `newDesk` option: pick a folder and open it as a desk, then run
 *  the test there. Pick the same folder name on both machines. */
async function adoptTestDesk(state, log) {
  log("info", "Choose (or create) the folder for the test desk — the same one on both machines");
  try {
    const { adoptDeskFolder } = await import("./desk-roots.js");
    const deskId = await adoptDeskFolder(state, "Folder for the sync test desk");
    if (!deskId) {
      log("error", "No folder chosen — sync test cancelled");
      return false;
    }
    const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
    log("info", `Test desk ready: "${desk?.name || deskId}"`, {
      deskId, folder: state.deskRoots?.[deskId] || null,
      files: countFiles(desk?.children),
      note: "check the [desks] line above for whether this device initialised the folder or adopted one the other device made",
    });
    return true;
  } catch (e) {
    log("error", "Couldn't open a folder as the test desk", { error: String(e) });
    return false;
  }
}

function countFiles(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    if (node?.fileId) n++;
    if (node?.children) n += countFiles(node.children);
  }
  return n;
}

/** One probe of each type, created through the app's own paths so the
 *  test exercises what a user does rather than a private shortcut. */
async function createProbes(state, tag, run, log) {
  const out = [];
  const doc = await state.newFile(null, {
    openImmediately: false,
    initialName: probeName(tag, "Doc"),
    initialContent: await appendMarker("Doc", null, tag, "v1", run, null, 1),
  });
  if (doc?.fileId) out.push({ kind: "Doc", fileId: doc.fileId, name: doc.name });

  const nb = await state.createNotebook(probeName(tag, "Notebook"), null, {
    openImmediately: false,
    initialContent: await appendMarker("Notebook", null, tag, "v1", run, null, 1),
  });
  if (nb?.fileId) out.push({ kind: "Notebook", fileId: nb.fileId, name: nb.name });

  const st = await state.createStack(probeName(tag, "Stack"), null, {
    openImmediately: false,
    initialContent: await appendMarker("Stack", null, tag, "v1", run, doc?.fileId || null, 1),
  });
  if (st?.fileId) out.push({ kind: "Stack", fileId: st.fileId, name: st.name });

  const unsent = [];
  for (const kind of KINDS) {
    const made = out.find((p) => p.kind === kind);
    if (made) { log("info", `Created ${kind} probe "${made.name}"`, { fileId: made.fileId }); continue; }
    log("error", `${kind} probe could not be created`);
    unsent.push({ kind, version: 1, failedToSend: true });
  }
  // The tree save is what places the new files into the desk folder —
  // until it runs they're in staging and there is nothing to sync.
  try {
    await state.saveFileTree();
    log("info", "Probes written to the desk folder — waiting for the other device");
  } catch (e) {
    log("error", "Tree save failed — probes may still be in staging", { error: String(e) });
  }
  return { probes: out, unsent };
}

/** Append round `version`'s marker to every probe, through the ordinary
 *  save path. Appending (not replacing) is what leaves a readable
 *  history in the file itself. */
async function editProbes(state, deskId, tag, run, probes, version, log) {
  // Re-find every probe first: the stack column references the doc's
  // id, so a re-key has to be picked up before anything is written.
  for (const probe of probes) {
    if (!resolveProbe(state, deskId, probe, log)) {
      log("error", `Our ${probe.kind} probe has no row in the tree`, { file: probe.name });
    }
  }
  const docFileId = probes.find((p) => p.kind === "Doc")?.fileId || null;
  const unsent = [];
  for (const probe of probes) {
    try {
      const ok = await appendToProbe(
        probe.fileId, probe.kind, tag, `v${version}`, run, docFileId, version,
      );
      if (ok) { log("info", `Sent ${probe.kind} edit v${version}`, { fileId: probe.fileId }); continue; }
      log("error", `Couldn't read our own ${probe.kind} probe to edit it`, { fileId: probe.fileId });
    } catch (e) {
      log("error", `Sending the ${probe.kind} edit v${version} failed`, { error: String(e) });
    }
    unsent.push({ kind: probe.kind, version, failedToSend: true });
  }
  return unsent;
}

/**
 * The last phase: write into the *other device's* files.
 *
 * Everything up to here has each device editing only what it owns, which
 * keeps the handshake unambiguous but never puts two writers on one
 * file — and that is the case most likely to lose someone's work.
 * So each device appends one `reply` line to each of the peer's probes,
 * and then both read every probe back and report whose marks survived.
 * Conflict policy is last-write-wins, so a lost reply here is a real
 * finding, not a bug in the test.
 */
async function crosstalk(state, deskId, ourTag, run, log) {
  const peers = peerProbes(state, deskId, ourTag);
  if (peers.length === 0) return;
  const docFileId = peers.find((p) => p.kind === "Doc")?.node.fileId || null;
  for (const { node, kind } of peers) {
    try {
      const ok = await appendToProbe(node.fileId, kind, ourTag, "reply", run, docFileId, 9);
      log(ok ? "info" : "error",
        ok ? `Replied into the peer's ${kind}` : `Couldn't read the peer's ${kind} to reply into it`,
        { file: node.name });
    } catch (e) {
      log("error", `Replying into the peer's ${kind} failed`, { file: node.name, error: String(e) });
    }
  }
  await sleep(CROSSTALK_SETTLE_MS);
  await reportProbeContents(state, deskId, ourTag, log);
}

/**
 * The trash round: move our own probes to Trash, then wait to see the
 * peer's land in *our* Trash.
 *
 * Trashing is a move within the tree — the file goes to `Trash/` on disk
 * and the row moves under the desk's Trash special. Nothing about it is
 * an add or a remove, so a file-level reconcile has nothing to say about
 * it and the far device can miss it entirely. Which makes it exactly the
 * thing to end the test on: every probe should finish in the Trash on
 * both machines.
 */
async function trashRound(state, deskId, ourTag, probes, log) {
  const results = [];
  for (const probe of probes) {
    const node = resolveProbe(state, deskId, probe, log);
    if (!node) {
      log("error", `Couldn't find the ${probe.kind} probe's row to trash it`, {
        file: probe.name, fileId: probe.fileId,
      });
      results.push({ kind: probe.kind, version: "trash", failedToSend: true });
      continue;
    }
    try {
      await state.deleteTreeNode(node.id);
      log("info", `Moved our ${probe.kind} to Trash`, { file: probe.name });
      continue;
    } catch (e) {
      log("error", `Trashing our ${probe.kind} failed`, { file: probe.name, error: String(e) });
    }
    results.push({ kind: probe.kind, version: "trash", failedToSend: true });
  }
  const outstanding = new Set(KINDS);
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  const sentAt = Date.now();
  while (outstanding.size > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    for (const { node, kind } of peerProbes(state, deskId, ourTag)) {
      if (!outstanding.has(kind) || !inTrash(state, deskId, node.id)) continue;
      outstanding.delete(kind);
      const waitedMs = Date.now() - sentAt;
      results.push({ kind, version: "trash", waitedMs });
      log("info", `✓ Peer ${kind} reached the Trash`, { file: node.name, waitedMs });
    }
  }
  for (const kind of outstanding) {
    results.push({ kind, version: "trash", missed: true });
    log("error", `✗ Peer ${kind} never reached the Trash (waited ${Math.round(ROUND_TIMEOUT_MS / 1000)}s)`);
  }
  return results;
}

/** The first row under this desk matching `pred`. */
function findNode(state, deskId, pred) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  let found = null;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (found) return;
      if (pred(n)) { found = n; return; }
      if (n?.children) walk(n.children);
    }
  };
  walk(desk?.children);
  return found;
}

/**
 * Re-find a probe by **name** and refresh the fileId we hold for it.
 *
 * A fileId is not a constant across two devices. When both mint an id
 * for the same arriving file, the loser's rows get re-keyed to the id
 * the folder's index publishes — legitimately, and behind the test's
 * back. A test holding the id it was handed at creation then edits and
 * trashes a file that no longer exists ("couldn't find the row"), and
 * every write goes to per-device staging where it syncs to nobody.
 *
 * The name is the stable handle: it's ours, it's unique per device, and
 * it survives a re-key. Resolve through it every round, and say so when
 * the id moves — that swap is the single most useful line in the log.
 */
function resolveProbe(state, deskId, probe, log) {
  const node = findNode(state, deskId, (n) => n?.name === probe.name && n?.fileId);
  if (!node) return null;
  if (node.fileId !== probe.fileId) {
    log("warn", `Our ${probe.kind} probe was re-keyed — following it`, {
      file: probe.name, was: probe.fileId, now: node.fileId,
    });
    probe.fileId = node.fileId;
  }
  return node;
}

/** Is `nodeId` under this desk's Trash special? */
function inTrash(state, deskId, nodeId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  const trash = (desk?.children || []).find((n) => n?.id === `__trash__:${deskId}`);
  const walk = (nodes) => (nodes || []).some((n) => n?.id === nodeId || walk(n?.children));
  return walk(trash?.children);
}

/** Read every probe in the desk and say who is written into it. This is
 *  the "at least three lines, from both machines" check, made explicit. */
async function reportProbeContents(state, deskId, ourTag, log) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  const rows = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (NAME_RE.test(String(n?.name || "")) && n.fileId) rows.push(n);
      if (n?.children) walk(n.children);
    }
  };
  walk(desk?.children);
  for (const node of rows) {
    try {
      const file = await invoke("load_file", { id: node.fileId });
      const marks = markersByTag(file?.content);
      const summary = [...marks.entries()]
        .map(([tag, e]) => `${tag}: ${e.labels.join(" ")}`)
        .sort();
      const both = marks.size >= 2;
      log(both ? "info" : "warn",
        `${both ? "✓" : "!"} "${node.name}" carries marks from ${marks.size} device(s)`,
        { marks: summary, lines: [...marks.values()].reduce((n, e) => n + e.labels.length, 0) });
    } catch (e) {
      log("error", `Couldn't read "${node.name}" to check its contents`, { error: String(e) });
    }
  }
}

/**
 * Block until the peer's probes reach `version` — the handshake. Logs
 * each type as it lands, and the ones that never do.
 */
async function awaitPeerVersion(state, deskId, ourTag, version, sinceMs, budget, log) {
  const outstanding = new Set(KINDS);
  const results = [];
  let peerTag = null;
  const deadline = Date.now() + budget;
  // A row whose file won't read is worth saying — once. Polling said it
  // every three seconds for the whole window, which buried the run in a
  // hundred identical lines.
  const complained = new Set();

  while (outstanding.size > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    for (const { node, tag, kind } of peerProbes(state, deskId, ourTag)) {
      if (!outstanding.has(kind)) continue;
      peerTag = peerTag || tag;
      let marks = null;
      try {
        const file = await invoke("load_file", { id: node.fileId });
        marks = markersByTag(file?.content);
      } catch (e) {
        // In the tree but not readable is itself a result — that's the
        // undelivered-file case, and worth seeing rather than waiting out.
        if (complained.has(node.fileId)) continue;
        complained.add(node.fileId);
        log("warn", `Peer ${kind} "${node.name}" is in the tree but its content won't load`, {
          fileId: node.fileId, error: String(e),
          note: "an id the far index doesn't publish, or a file the provider hasn't delivered",
        });
        continue;
      }
      // The *peer's* own marks, not the reply we may have written in.
      const mark = marks.get(tag);
      if (!mark) continue;
      if (mark.run && Math.abs(mark.run - sinceMs) > RUN_SKEW_MS) continue; // leftover from an older run
      if (mark.top < version) continue;
      outstanding.delete(kind);
      const waitedMs = Date.now() - sinceMs;
      results.push({ kind, version, waitedMs, peerTag: tag });
      log("info",
        version === 1
          ? `✓ Peer ${kind} arrived — "${node.name}"`
          : `✓ Peer ${kind} edit v${version} arrived`,
        { fromDevice: tag, waitedMs });
    }
  }
  for (const kind of outstanding) {
    results.push({ kind, version, missed: true });
    log("error",
      version === 1
        ? `✗ Peer ${kind} never arrived (waited ${Math.round(budget / 1000)}s)`
        : `✗ Peer ${kind} edit v${version} never arrived (waited ${Math.round(budget / 1000)}s)`);
  }
  return { results, peerTag };
}

/** The other device's probes, as they stand in this desk's tree. */
function peerProbes(state, deskId, ourTag) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const m = NAME_RE.exec(String(n?.name || ""));
      if (m && m[1] !== ourTag && n.fileId) out.push({ node: n, tag: m[1], kind: m[2] });
      if (n?.children) walk(n.children);
    }
  };
  walk(desk?.children);
  return out;
}

/** One line per file type per round, so the verdict is readable without
 *  reconstructing it from the timeline. */
function summarise(log, ourTag, peerTag, probes, results) {
  const rows = [];
  for (const kind of KINDS) {
    const parts = [];
    for (const version of [1, ...ROUNDS, "trash"]) {
      const at = (f) => results.find((x) => x.kind === kind && x.version === version && f(x));
      const label = version === 1 ? "create"
        : version === "trash" ? "to Trash"
        : `edit v${version}`;
      const r = at((x) => !x.failedToSend);
      // Our own failure to send comes first: "MISSED" would blame the
      // provider for something that never left this machine.
      if (at((x) => x.failedToSend)) parts.push(`${label}: NOT SENT`);
      else if (!r) parts.push(`${label}: not reached`);
      else if (r.missed) parts.push(`${label}: MISSED`);
      else parts.push(`${label}: ${(r.waitedMs / 1000).toFixed(1)}s`);
    }
    rows.push(`${kind} — ${parts.join(", ")}`);
  }
  const unsent = results.filter((r) => r.failedToSend);
  const missed = results.filter((r) => r.missed);
  const bad = unsent.length + missed.length;
  log(bad ? "error" : "info",
    bad
      ? `RESULT: ${bad} of ${results.length} transfers failed`
        + (unsent.length ? ` (${unsent.length} never left this device)` : "")
      : "RESULT: every probe and every edit crossed in both directions",
    {
      thisDevice: ourTag,
      otherDevice: peerTag || "never seen",
      sent: probes.map((p) => p.name),
      perType: rows,
    });
}
