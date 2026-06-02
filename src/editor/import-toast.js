/**
 * Tiny toast for import feedback.
 *
 * iPad users don't have a console — when a `.hushnote` / `.hushstack`
 * drop or Files.app "Open With" succeeds (or fails) we surface a brief
 * banner so the action isn't silent.
 */

let activeToast = null;
let activeTimer = null;

export function showImportToast(message, kind = "info") {
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  const el = document.createElement("div");
  el.className = `import-toast import-toast-${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  activeToast = el;
  activeTimer = setTimeout(() => {
    el.classList.add("import-toast-leaving");
    setTimeout(() => {
      if (el.parentNode) el.remove();
      if (activeToast === el) activeToast = null;
    }, 220);
  }, kind === "error" ? 4500 : 2200);
}
