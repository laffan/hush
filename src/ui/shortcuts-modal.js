/**
 * Show Shortcuts modal — a graphic overlay of every keyboard shortcut
 * relevant to the file the user is currently looking at.
 *
 * Opened from the command palette ("Show Shortcuts"). The list is
 * sectioned in a fixed order:
 *
 *   1. Filetype-specific (Notebook tools, PDF zoom, doc modes…)
 *   2. Editor shortcuts   (Editing + Formatting — the CodeMirror surface)
 *   3. Panes & Panels     (sidebar / outline / shelf toggles)
 *   4. App-wide           (everything global — fullscreen, find, desks…)
 *
 * Shortcut keys + labels come from `shortcutCategories` (the single
 * source of truth shared with Settings > Shortcuts) so this stays in
 * sync with what the settings panel exposes. A handful of hard-coded
 * shortcuts (Cmd+P, Cmd+,, PDF zoom) that have no settings field are
 * listed inline as non-editable rows.
 *
 * Hovering a row reveals an Edit button; clicking it opens Settings to
 * the Shortcuts tab with that shortcut pre-loaded into the search field.
 */
import { escHtml, escAttr } from "../settings/settings-tabs.js";
import {
  shortcutCategories,
  renderShortcutKeys,
  PANE_SHORTCUT_KEYS as PANE_KEYS,
  DOC_MODE_SHORTCUT_KEYS as DOC_MODE_KEYS,
} from "../settings/settings-tabs-shortcuts.js";

let _overlayEl = null;

/** Well-known shortcuts with no settings field — shown without an Edit
 *  affordance. Values use the stored "Mod+…" form so `renderShortcutKeys`
 *  paints them identically to the editable rows. */
const APP_EXTRAS = [
  { label: "Command palette", value: "Mod+P" },
  { label: "Open settings", value: "Mod+," },
  { label: "Open document, notebook, or project", value: "Mod+O" },
  { label: "Open as pane", value: "Mod+Shift+O" },
];

const PDF_EXTRAS = [
  { label: "Zoom in", value: "Mod+=" },
  { label: "Zoom out", value: "Mod+-" },
  { label: "Reset zoom (fit)", value: "Mod+0" },
];

function catShortcuts(name) {
  return shortcutCategories.find((c) => c.name === name)?.shortcuts || [];
}

/** Map a settings category into editable row items, optionally filtered to
 *  (or excluding) a set of keys while preserving the category's order. */
function catItems(name, { only, except } = {}) {
  let defs = catShortcuts(name);
  if (only) defs = defs.filter((d) => only.includes(d.key));
  if (except) defs = defs.filter((d) => !except.includes(d.key));
  return defs.map((d) => ({ key: d.key, label: d.label, editable: true }));
}

/** Non-editable rows from a {label, value} list. */
function staticItems(list) {
  return list.map((x) => ({ label: x.label, value: x.value, editable: false }));
}

/** Detect the filetype of the active main-view surface. Notebook / stack /
 *  PDF win over a plain doc; a project reads as a document for shortcut
 *  purposes (its columns are doc editors). */
function activeFiletype(state) {
  if (state.currentNotebookFileId) return "notebook";
  if (state.currentStackFileId) return "stack";
  if (state.currentPdfFileId) return "pdf";
  if (state.currentProjectId) return "project";
  return "document";
}

const FILETYPE_LABELS = {
  notebook: "Notebook",
  stack: "Stack",
  pdf: "PDF",
  project: "Project",
  document: "Document",
};

/** Build the ordered section list for the given filetype. Empty sections
 *  are dropped so a surface with no editor (PDF) doesn't show a blank
 *  "Editor" heading. */
function buildSections(state) {
  const filetype = activeFiletype(state);
  const editor = [...catItems("Editing"), ...catItems("Formatting")];
  const panes = catItems("General", { only: PANE_KEYS });
  const appWide = [
    ...catItems("General", { except: [...PANE_KEYS, ...DOC_MODE_KEYS] }),
    ...staticItems(APP_EXTRAS),
  ];

  const sections = [];
  if (filetype === "notebook") {
    sections.push({ title: "Notebook", items: catItems("Notebooks") });
    sections.push({ title: "Editor (text shapes)", items: editor });
  } else if (filetype === "pdf") {
    sections.push({ title: "PDF", items: staticItems(PDF_EXTRAS) });
  } else if (filetype === "stack") {
    // Columns are full doc/notebook editors — surface the editor set.
    sections.push({ title: "Editor (columns)", items: editor });
  } else {
    // document / project
    sections.push({ title: "Document", items: catItems("General", { only: DOC_MODE_KEYS }) });
    sections.push({ title: "Editor", items: editor });
  }
  sections.push({ title: "Panes & Panels", items: panes });
  sections.push({ title: "App-wide", items: appWide });

  return {
    filetypeLabel: FILETYPE_LABELS[filetype] || "Document",
    sections: sections.filter((s) => s.items && s.items.length),
  };
}

function renderRow(state, item) {
  const value = item.editable ? state.settings[item.key] : item.value;
  const keys = renderShortcutKeys(value);
  const edit = item.editable
    ? `<button class="shortcuts-modal-edit" type="button" data-edit-label="${escAttr(item.label)}">Edit</button>`
    : "";
  return `<div class="shortcuts-modal-row${item.editable ? "" : " is-static"}">
    <span class="shortcuts-modal-row-label">${escHtml(item.label)}</span>
    <span class="shortcuts-modal-row-keys">${keys}</span>
    ${edit}
  </div>`;
}

function renderSection(state, section) {
  const rows = section.items.map((it) => renderRow(state, it)).join("");
  return `<section class="shortcuts-modal-section">
    <h3 class="shortcuts-modal-section-title">${escHtml(section.title)}</h3>
    <div class="shortcuts-modal-grid">${rows}</div>
  </section>`;
}

export function openShortcutsModal(state) {
  closeModal();

  const { filetypeLabel, sections } = buildSections(state);
  const body = sections.map((s) => renderSection(state, s)).join("");

  const overlay = document.createElement("div");
  overlay.className = "shortcuts-modal-overlay";
  overlay.innerHTML = `
    <div class="shortcuts-modal" role="dialog" aria-label="Keyboard shortcuts">
      <div class="shortcuts-modal-header">
        <div class="shortcuts-modal-title">Keyboard Shortcuts<span class="shortcuts-modal-filetype">${escHtml(filetypeLabel)}</span></div>
        <button class="shortcuts-modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="shortcuts-modal-body">${body}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  _overlayEl = overlay;

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector(".shortcuts-modal-close").addEventListener("click", closeModal);

  overlay.querySelectorAll(".shortcuts-modal-edit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const label = btn.dataset.editLabel || "";
      closeModal();
      const { openSettingsWindow } = await import("../settings/settings-ui.js");
      openSettingsWindow(state, { tab: "shortcuts", shortcutSearch: label });
    });
  });

  document.addEventListener("keydown", onKey, true);
}

function onKey(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeModal();
  }
}

function closeModal() {
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
  document.removeEventListener("keydown", onKey, true);
}
