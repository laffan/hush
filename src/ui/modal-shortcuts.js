/**
 * Keyboard shortcuts for the alert-style popups — the confirm, choice
 * and prompt modals (`.tree-delete-modal`, sidebar/files-panel-shared.js
 * and the flows built on it).
 *
 * Hold ⌘ while one is open and every option shows its key:
 *
 *   - **↩** for the default — the modal's confirming button, when what it
 *     does can be undone.
 *   - **⌘ + a letter** for everything else, the first letter of its label
 *     (the next free one when two options share it). A *gated* default —
 *     an action that destroys something, like Delete — is never on ↩: it
 *     takes its letter, so a stray Return can't empty a Trash.
 *   - **esc** for Cancel.
 *
 * The keys work whether or not ⌘ is being held to show them. Listening
 * on the window in the capture phase puts this ahead of the editor, which
 * otherwise still has focus under a modal that took none — Return there
 * would type a newline into the document behind it. Return in the
 * modal's own text field is left to the field.
 */

const MODAL = ".tree-delete-modal";
const GATED = /\b(delete|remove|discard|empty|erase|overwrite|permanently|replace|clear)\b/i;

let installed = false;

function topModal() {
  const all = document.querySelectorAll(MODAL);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].offsetParent !== null || all[i].getClientRects().length) return all[i];
  }
  return null;
}

function labelOf(btn) {
  const label = btn.querySelector(".tree-choice-modal-label")?.textContent || btn.textContent || "";
  return label.replace(/\s+/g, " ").trim();
}

/** Work out each option's key: `[{ btn, key, kind }]`, kind being
 *  "enter", "letter" or "escape". */
function assign(modal) {
  const options = [
    ...modal.querySelectorAll(".tree-choice-modal-option"),
    ...modal.querySelectorAll(".tree-delete-modal-btns button"),
  ].filter((b) => !b.disabled && !b.closest("[hidden]"));
  const out = [];
  const taken = new Set();
  const confirm = options.filter((b) => !b.classList.contains("tree-delete-cancel")).pop() || null;
  for (const btn of options) {
    if (btn.classList.contains("tree-delete-cancel")) { out.push({ btn, key: "Escape", kind: "escape" }); continue; }
    const label = labelOf(btn);
    if (btn === confirm && !btn.closest(".tree-choice-modal-options") && !GATED.test(label)) {
      out.push({ btn, key: "Enter", kind: "enter" });
      continue;
    }
    const letter = [...label.toLowerCase()].find((c) => /[a-z0-9]/.test(c) && !taken.has(c));
    if (!letter) continue;
    taken.add(letter);
    out.push({ btn, key: letter, kind: "letter" });
  }
  return out;
}

function hintText(entry) {
  if (entry.kind === "enter") return "↩";
  if (entry.kind === "escape") return "esc";
  return `⌘${entry.key.toUpperCase()}`;
}

function showHints(modal, on) {
  if (!modal) return;
  if (on) {
    for (const entry of assign(modal)) {
      let hint = entry.btn.querySelector(":scope > .modal-shortcut-hint, :scope > * > .modal-shortcut-hint");
      if (!hint) {
        hint = document.createElement("kbd");
        hint.className = "modal-shortcut-hint";
        (entry.btn.querySelector(".tree-choice-modal-label") || entry.btn).appendChild(hint);
      }
      hint.textContent = hintText(entry);
    }
  }
  modal.classList.toggle("modal-shortcuts-visible", on);
}

function hideAll() {
  document.querySelectorAll(`${MODAL}.modal-shortcuts-visible`).forEach((m) => m.classList.remove("modal-shortcuts-visible"));
}

function onKeyDown(e) {
  const modal = topModal();
  if (!modal) return;
  if (e.key === "Meta") { showHints(modal, true); return; }
  if (e.isComposing) return;
  const entries = assign(modal);
  const field = document.activeElement;
  const inField = !!field && modal.contains(field) && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName);
  let hit = null;
  if (e.key === "Enter" && !e.metaKey && !e.shiftKey && !e.altKey && !inField) {
    hit = entries.find((x) => x.kind === "enter");
  } else if (e.key === "Escape" && !inField) {
    hit = entries.find((x) => x.kind === "escape");
  } else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
    hit = entries.find((x) => x.kind === "letter" && x.key === e.key.toLowerCase());
  }
  // Return with no default (a gated action) still goes nowhere — not
  // into the document behind the modal.
  if (!hit && !(e.key === "Enter" && !inField)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!hit) return;
  hideAll();
  hit.btn.click();
}

export function installModalShortcuts() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", (e) => { if (e.key === "Meta") hideAll(); }, true);
  window.addEventListener("blur", hideAll);
}
