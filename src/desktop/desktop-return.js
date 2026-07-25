/**
 * "Back to <Project> Desktop" — the return crumb.
 *
 * A Desktop *replaces* whatever was open, so opening a file from one is
 * a one-way trip: the Desktop is gone and there's no obvious way back to
 * the arrangement you were reading. This is that way back — a small
 * fixed bar in the upper left carrying the Desktop's project name, plus
 * an `×` for users who'd rather it weren't there.
 *
 * It's strictly a *navigation* crumb, not a history stack: it shows only
 * when the current surface was reached from a Desktop, and only ever
 * points one hop back. Drilling A → B → doc leaves "Back to B", not a
 * trail — B's own Desktop is where the doc came from.
 *
 * The mechanism is arm-then-consume. Every Desktop-initiated open calls
 * `armDesktopReturn` immediately before it opens anything; the next
 * surface-change event adopts the armed target and shows the bar. A
 * surface change with nothing armed means the user navigated some other
 * way (sidebar, palette, wikilink), so the crumb clears itself — which
 * is what keeps it from following you around the app.
 */

import { findDesktopContainer } from "./desktop-files.js";

let _state = null;
let _pending = null;  // armed for the next open: { containerId, name }
let _target = null;   // what the visible bar points at
let _bar = null;
let _backBtn = null;
let _wired = false;

function nameFor(state, containerId) {
  return findDesktopContainer(state, containerId)?.name || "Project";
}

function ensureBar() {
  if (_bar) return _bar;
  _bar = document.createElement("div");
  _bar.className = "desktop-return hidden";

  _backBtn = document.createElement("button");
  _backBtn.type = "button";
  _backBtn.className = "desktop-return-back";
  _backBtn.addEventListener("click", () => {
    const target = _target;
    hide();
    if (!target) return;
    // Not armed — going *back* to a Desktop shouldn't leave a crumb
    // pointing at the Desktop you just left.
    import("./desktop-view.js").then((m) => m.openDesktop(_state, target.containerId));
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "desktop-return-close";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.addEventListener("click", hide);

  _bar.append(_backBtn, dismiss);
  document.getElementById("app")?.appendChild(_bar);
  return _bar;
}

function show(target) {
  _target = target;
  ensureBar();
  _backBtn.textContent = `Back to ${target.name} Desktop`;
  _bar.classList.remove("hidden");
}

function hide() {
  _target = null;
  _bar?.classList.add("hidden");
}

/** Every surface change either consumes the armed crumb or clears the
 *  one on screen — a navigation that didn't come from a Desktop is
 *  exactly the signal that the crumb no longer applies. */
function onSurfaceChange() {
  const armed = _pending;
  _pending = null;
  if (armed) show(armed);
  else hide();
}

/**
 * Arm the crumb for the open that's about to happen. Call immediately
 * before any `state.open*` / `openDesktop` initiated from a Desktop —
 * a thumbnail double-click, an outline row, a hover action, or the same
 * gestures inside a Desktop pane.
 */
export function armDesktopReturn(state, containerId) {
  if (!state || !containerId) return;
  _state = state;
  _pending = { containerId, name: nameFor(state, containerId) };
  if (_wired) return;
  _wired = true;
  for (const ev of ["file-opened", "notebook-open", "pdf-open", "stack-open", "desktop-opened"]) {
    state.on(ev, onSurfaceChange);
  }
  // The crumb is a promise to get you back somewhere. If that project is
  // deleted the promise can't be kept, so drop it rather than offer a
  // dead link.
  state.on("files-changed", () => {
    if (_target && !findDesktopContainer(_state, _target.containerId)) hide();
  });
}
