/**
 * One sticky, one window.
 *
 * A sticky note is scoped to a file / project / desk / the app — never
 * to a window — so every window that had the matching scope open drew
 * its own copy of the same note. With two windows on one desk that is
 * the same reminder twice on screen, and editing either copy raced the
 * other through the settings-backed list.
 *
 * The rule the app follows instead: **the window already showing a note
 * keeps it.** A window opened later, onto a scope that would qualify,
 * leaves that note alone.
 *
 * The mechanism is the registry's window *number*. Numbers are minted
 * in window-creation order and never reused (`multi_window.rs`), so
 * "opened earlier" is just "numbered lower" — no clocks, no arbitration
 * round trip, and every window computes the same answer from the same
 * facts. Each window publishes the set of note ids it *could* show
 * (`publishClaims`); a note belongs to the lowest-numbered window that
 * claimed it, and `claimedElsewhere()` tells the sticky module to hide
 * the rest.
 *
 * Two details keep it honest:
 *
 *  - **Boot deference.** A window that starts next to a lower-numbered
 *    sibling hasn't heard that sibling's claims yet, so for a moment it
 *    would think it owns everything and flash a duplicate on screen.
 *    Until every such sibling has reported — or `SETTLE_MS` passes, in
 *    case one is wedged or suspended — it shows nothing. Its own claim
 *    broadcast is what prompts the replies, so in practice this lasts
 *    one event round trip.
 *  - **Pruning.** Claims are dropped when their window leaves the
 *    registry (`windows-updated`), which is what hands a note back the
 *    moment the window holding it closes.
 *
 * Single-window and browser-dev runs never see any of this: with no
 * siblings there is nothing to defer to and nothing to publish.
 */
import { getCurrentWindowLabel, fetchWindowList } from "../multi-window.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** How long a booting window waits for a lower-numbered sibling to
 *  report before assuming it isn't going to. Long enough for an event
 *  round trip, short enough that a suspended sibling can't keep this
 *  window's stickies off screen for any noticeable time. */
const SETTLE_MS = 1500;

/** Rank a window broadcasts before the registry has told it its own
 *  number — `initStickyNotes` runs well before `setupMultiWindow`
 *  registers, so every window spends its first moments here. It is
 *  deliberately the *weakest* rank there is (and the largest a `u32`
 *  will carry): a window that doesn't yet know where it stands must
 *  never be able to take a note off one that does. Getting this
 *  backwards made a booting window announce as rank 0, which outranks
 *  everything — the older window stood down, the new one was still
 *  deferring to it, and the note vanished from both. */
const UNRANKED = 0xFFFFFFFF;

/** label → { number, ids: Set<string> }, for every window but this one. */
const remote = new Map();
/** Labels of live windows that could outrank us and haven't reported
 *  yet. Non-empty (before `settled`) means "show nothing". */
let pending = new Set();
let settled = false;
let settleTimer = 0;

let myLabel = null;
/** This window's registry number, or null until the registry knows us.
 *  `initStickyNotes` runs well before `setupMultiWindow` registers, so
 *  an unresolved number is the normal state for the first moments of a
 *  launch — and it reads as "assume every sibling outranks us", which
 *  is the safe direction. */
let myNumber = null;
let myIds = new Set();
let lastPublished = null;
let onChanged = () => {};
let started = false;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/** Could the window `entry` describes take a note off us? */
function outranksUs(entry) {
  return entry.number < (myNumber ?? UNRANKED);
}

/** Does another window own `noteId`? */
export function claimedElsewhere(noteId) {
  for (const [, entry] of remote) {
    if (outranksUs(entry) && entry.ids.has(noteId)) return true;
  }
  return !settled && pending.size > 0;
}

/** Tell the other windows which notes this one could show. Cheap to
 *  call on every visibility refresh: it broadcasts only when the set
 *  actually changed. */
export function publishClaims(eligibleIds) {
  myIds = new Set(eligibleIds);
  if (!started) return;
  const key = [...myIds].sort().join(",");
  if (key === lastPublished) return;
  lastPublished = key;
  void send();
}

async function send() {
  if (!IS_TAURI || !myLabel) return;
  lastPublished = [...myIds].sort().join(",");
  try {
    await invoke("broadcast_sticky_claims", {
      label: myLabel, number: myNumber ?? UNRANKED, ids: [...myIds],
    });
  } catch (e) {
    console.warn("broadcast_sticky_claims failed:", e);
  }
}

function finishSettle() {
  if (settled) return;
  settled = true;
  pending = new Set();
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
  onChanged();
}

/** Recompute who we're still waiting on. Only meaningful during the
 *  boot deference — once settled, a window that appears later is by
 *  definition higher-numbered and can't take anything off us. */
function recomputePending(list) {
  if (settled) return;
  const next = new Set();
  for (const w of list || []) {
    if (!w || !w.label || w.label === myLabel) continue;
    if (remote.has(w.label)) continue;
    if ((w.number ?? UNRANKED) < (myNumber ?? UNRANKED)) next.add(w.label);
  }
  pending = next;
  if (!pending.size) finishSettle();
}

function onWindowList(list) {
  const me = (list || []).find((w) => w && w.label === myLabel);
  const learned = me && me.number !== myNumber;
  if (me) myNumber = me.number;
  // Drop claims for windows the registry no longer lists — this is what
  // returns a note to a survivor when the window holding it closes.
  const alive = new Set((list || []).map((w) => w && w.label).filter(Boolean));
  let changed = false;
  for (const label of [...remote.keys()]) {
    if (alive.has(label)) continue;
    remote.delete(label);
    changed = true;
  }
  recomputePending(list);
  // Our first broadcast went out unranked (see UNRANKED). Now that we
  // know our number, say so — the siblings are holding a claim from us
  // that can't outrank anything, and nothing else would correct it.
  if (learned) void send();
  if (changed || learned) onChanged();
}

/**
 * Start participating. `hooks.refresh` is called whenever ownership may
 * have changed (a sibling reported, a window went away, our own number
 * arrived) so the sticky module can re-run its visibility pass.
 *
 * Safe in a single-window or browser run — it resolves to a participant
 * that never defers.
 */
export async function initStickyClaims(hooks) {
  onChanged = typeof hooks?.refresh === "function" ? hooks.refresh : () => {};
  if (!IS_TAURI) { started = true; settled = true; return; }
  try {
    myLabel = await getCurrentWindowLabel();

    // Listen before asking: the reply to our own announcement below has
    // to arrive through a pipe that is already open.
    const { listen } = await import("@tauri-apps/api/event");
    await listen("cross-window-sticky-claims", (event) => {
      const { label, number, ids } = event.payload || {};
      if (!label || label === myLabel) return;
      const known = remote.has(label);
      const rank = Number.isFinite(number) ? Number(number) : UNRANKED;
      remote.set(label, { number: rank, ids: new Set(ids || []) });
      pending.delete(label);
      if (!settled && !pending.size) finishSettle();
      // A window we hadn't heard from is either new or just caught up;
      // either way it needs our set and has no other way to ask.
      // Bounded: our reply comes from a label it now knows, so it won't
      // bounce back again.
      if (!known) void send();
      onChanged();
    });
    await listen("windows-updated", (event) => onWindowList(event.payload));

    started = true;
    onWindowList(await fetchWindowList());
    if (!settled) settleTimer = window.setTimeout(finishSettle, SETTLE_MS);
    // Announce ourselves — this is also what prompts the siblings to
    // reply with their own sets.
    await send();
    onChanged();
  } catch (e) {
    console.warn("sticky window claims unavailable:", e);
    started = true;
    finishSettle();
  }
}
