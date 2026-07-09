/**
 * Multi-select for Local Folder rows. Selection state is keyed by the
 * row id (`folderId:relPath`) and covers *file* rows only — directories
 * are excluded so a batch drag never carries an ancestor of another
 * selected entry. Mirrors the main tree's Finder-style semantics:
 * shift-click ranges over the visible row order, cmd/ctrl-click
 * toggles, Esc or a plain click clears, and dragging any selected row
 * carries the whole batch (see files-panel-local-sync.js).
 *
 * Kept separate from `state.selectedDocIds` — that pipeline (and the
 * multi-select editor view) is fileId-based, and Local Folder files
 * have no fileId. The two selections clear each other at the click
 * sites so only one is ever visible.
 */

// key → { folderId, relPath, name }
const _selected = new Map();
let _escWired = false;

export function localSelectionKey(folderId, relPath) {
  return `${folderId}:${relPath}`;
}

export function isLocalSelected(key) {
  return _selected.has(key);
}

export function localSelectionSize() {
  return _selected.size;
}

/** Entries in the current selection (files only). */
export function getLocalSelection() {
  return [..._selected.values()];
}

export function clearLocalSelection(container = null) {
  if (_selected.size === 0) return;
  _selected.clear();
  applyLocalSelectionClasses(container || document);
}

function wireEscClear() {
  if (_escWired) return;
  _escWired = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _selected.size) clearLocalSelection();
  });
}

/** Re-stamp `.multi-selected` on every local file row under `root`. */
export function applyLocalSelectionClasses(root) {
  (root || document).querySelectorAll(".local-sync-file").forEach((li) => {
    li.classList.toggle("multi-selected", _selected.has(li.dataset.id || ""));
  });
}

/** Visible local file rows in render order — the reference order for
 *  shift-range expansion. Walks the DOM (the section already painted
 *  them) rather than re-reading directories. */
function visibleLocalFileRows(container) {
  const root = container?.closest?.(".local-sync-root") || container || document;
  return [...root.querySelectorAll(".local-sync-file")].map((li) => li.dataset.id).filter(Boolean);
}

/**
 * Handle a modifier click (shift or cmd/ctrl) on a local file row.
 * `entry` is `{ folderId, relPath, name }`; `container` any element
 * inside the Local Folders section (used to walk visible rows).
 */
export function handleLocalMultiClick(entry, event, container) {
  wireEscClear();
  const key = localSelectionKey(entry.folderId, entry.relPath);
  if (event.shiftKey) {
    const ids = visibleLocalFileRows(container);
    const keys = [..._selected.keys()];
    const anchor = keys[keys.length - 1] || null;
    const a = anchor ? ids.indexOf(anchor) : -1;
    const b = ids.indexOf(key);
    if (a < 0 || b < 0) {
      _selected.clear();
      _selected.set(key, entry);
    } else {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      // Range replaces, but keeps the anchor's entry map fresh — rebuild
      // entries from the row ids (folderId:relPath; name = basename).
      _selected.clear();
      for (const id of ids.slice(lo, hi + 1)) {
        const c = id.indexOf(":");
        if (c < 0) continue;
        const relPath = id.slice(c + 1);
        _selected.set(id, {
          folderId: id.slice(0, c),
          relPath,
          name: relPath.split("/").pop() || relPath,
        });
      }
    }
  } else {
    // Cmd / Ctrl — toggle membership.
    if (_selected.has(key)) _selected.delete(key);
    else _selected.set(key, entry);
  }
  applyLocalSelectionClasses(document);
}

/**
 * Resolve the batch a drag gesture carries: the whole selection when
 * the dragged row is part of it, else just the dragged entry. Always
 * returns at least one entry, dragged first.
 */
export function resolveLocalDragBatch(folderId, relPath, descriptor) {
  const dragged = { folderId, relPath, name: descriptor.name, isDir: !!descriptor.isDir };
  const key = localSelectionKey(folderId, relPath);
  if (!descriptor.isDir && _selected.size > 1 && _selected.has(key)) {
    const rest = getLocalSelection()
      .filter((e) => localSelectionKey(e.folderId, e.relPath) !== key)
      .map((e) => ({ ...e, isDir: false }));
    return [dragged, ...rest];
  }
  return [dragged];
}
