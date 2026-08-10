/**
 * Tiny toast for import feedback.
 *
 * iPad users don't have a console — when a `.hushnote` / `.hushstack`
 * drop or Files.app "Open With" succeeds (or fails) we surface a brief
 * banner so the action isn't silent.
 *
 * `sticky: true` holds the toast until the caller dismisses it, for work
 * whose duration isn't ours to guess — waiting on a provider to deliver
 * a file is the case it exists for.
 */

let activeToast = null;
let activeTimer = null;

function clearActive() {
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
}

export function showImportToast(message, kind = "info", { sticky = false } = {}) {
  clearActive();
  const el = document.createElement("div");
  el.className = `import-toast import-toast-${kind}`;
  if (sticky) el.classList.add("import-toast-sticky");
  el.textContent = message;
  document.body.appendChild(el);
  activeToast = el;
  if (sticky) return el;
  activeTimer = setTimeout(() => {
    el.classList.add("import-toast-leaving");
    setTimeout(() => {
      if (el.parentNode) el.remove();
      if (activeToast === el) activeToast = null;
    }, 220);
  }, kind === "error" ? 4500 : 2200);
  return el;
}

/** Dismiss a sticky toast. `only` scopes the dismissal to one element,
 *  so a caller can't tear down a toast someone else raised after it. */
export function dismissImportToast(only = null) {
  if (only && activeToast !== only) return;
  const el = activeToast;
  if (!el) return;
  activeToast = null;
  if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
  el.classList.add("import-toast-leaving");
  setTimeout(() => { if (el.parentNode) el.remove(); }, 220);
}
