/**
 * Properties editing UI — the DOM the properties plugin renders in place
 * of a doc's frontmatter block while properties are visible.
 *
 * Obsidian-style rows: type selector · key · value · remove, plus an
 * "Add property" affordance. Three value types: text, list (chips), and
 * checkbox. `# comments` inside the block are shown inert and preserved
 * verbatim on rewrite.
 *
 * Editing model: the DOM owns a local copy of the parsed entries and
 * serializes it back into the document ("commit") when the user presses
 * Enter, changes structure (add/remove row, chips, checkbox, type), or
 * moves focus out of the properties UI. Commits dispatch ordinary user
 * transactions (annotated so the plugin's edit-guard lets them through),
 * so dirty-tracking, autosave, and undo all behave normally. After a
 * commit the plugin keeps this DOM alive (see PropertiesWidget.updateDOM),
 * which is what preserves input focus while typing.
 */

import {
  findFrontmatterRange, serializeProperties, FRONTMATTER_SCAN_LIMIT,
  NUMBER_RE, DATE_RE, DATETIME_RE,
} from "../frontmatter.js";

// Focus to restore after the one rebuild we can't avoid: committing from
// the "draft" (no frontmatter yet) widget swaps the decoration kind, so
// the DOM is rebuilt from scratch.
let pendingFocus = null; // { docDom, desc: { row, field } }

const TYPE_OPTIONS = [
  ["text", "Text"],
  ["list", "List"],
  ["number", "Number"],
  ["checkbox", "Checkbox"],
  ["date", "Date"],
  ["datetime", "Date & time"],
  ["tags", "Tags"],
];

const LIST_TYPES = new Set(["list", "tags"]);

function el(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Serialize + write the entries back into the doc's frontmatter block.
 *  Returns the new block text ("" = block removed). */
function commitEntries(view, entries, editAnnotation) {
  const doc = view.state.doc;
  const head = doc.sliceString(0, Math.min(doc.length, FRONTMATTER_SCAN_LIMIT));
  const fm = findFrontmatterRange(head);
  const block = serializeProperties(entries);
  let to = 0;
  let insert = block;
  if (fm) {
    to = fm.to;
    // Removing the block takes its glue newline with it.
    if (!block && doc.length > fm.to) to = fm.to + 1;
  } else {
    if (!block) return "";
    insert = doc.length > 0 ? block + "\n" : block;
  }
  if (doc.sliceString(0, to) !== insert) {
    view.dispatch({
      changes: { from: 0, to, insert },
      annotations: [editAnnotation.of(true)],
    });
  }
  return block;
}

/**
 * Build the properties container element.
 *
 * @param view            The owning EditorView.
 * @param initialEntries  Parsed entries from the doc's frontmatter.
 * @param text            The exact current block text ("" for draft mode).
 * @param editAnnotation  The plugin's `propertiesEdit` annotation, used to
 *                        mark commits as UI-driven.
 */
export function buildPropertiesDOM(view, initialEntries, text, editAnnotation) {
  const entries = initialEntries.map((e) => ({
    ...e,
    value: Array.isArray(e.value) ? [...e.value] : e.value,
  }));

  const container = el("div", "cm-properties");
  container.dataset.fmText = text;
  const rowsEl = el("div", "cm-properties-rows");
  container.appendChild(rowsEl);

  const addBtn = el("button", "cm-properties-add", { type: "button" });
  addBtn.textContent = "+ Add property";
  container.appendChild(addBtn);

  const wasDraft = () => container.dataset.fmText === "";

  // Only user edits may write back — otherwise a click in and out of an
  // untouched widget would "normalize" (rewrite) the YAML for nothing.
  let dirty = false;
  container.addEventListener("input", () => { dirty = true; });

  function commit(focusDesc) {
    if (!dirty) return;
    // CodeMirror's update pass can rebuild this DOM (draft → real block
    // swaps the decoration kind) or detach/reattach the widget wrapper
    // (which silently drops input focus). When the caller wants focus
    // kept, stash the target: a rebuilt UI consumes it in
    // buildPropertiesDOM; a surviving one restores it below.
    const desc = focusDesc || null;
    if (desc) pendingFocus = { docDom: view.dom, desc };
    const block = commitEntries(view, entries, editAnnotation);
    container.dataset.fmText = block;
    dirty = false;
    if (desc) {
      // The dispatch above ran CodeMirror's DOM update synchronously, so
      // if this container survived (it usually does — updateDOM reuses
      // it) refocus right away: no dropped keystrokes between commit and
      // the next input. A rebuilt container consumed pendingFocus inside
      // buildPropertiesDOM instead and focuses itself.
      if (pendingFocus && pendingFocus.desc === desc && container.isConnected) {
        pendingFocus = null;
        focusField(desc);
      }
      // Backstop: CM's measure phase can still reattach the widget a
      // frame later, which silently drops focus again.
      requestAnimationFrame(() => {
        if (pendingFocus && pendingFocus.desc === desc && container.isConnected) {
          pendingFocus = null;
          focusField(desc);
        } else if (container.isConnected && !container.contains(document.activeElement)) {
          focusField(desc);
        }
      });
    }
  }

  function focusField(desc) {
    if (!desc) return;
    const row = rowsEl.children[desc.row];
    if (!row) { addBtn.focus(); return; }
    const target = row.querySelector(desc.field === "key" ? ".cm-property-key"
      : desc.field === "type" ? ".cm-property-type"
      : desc.field === "list" ? ".cm-property-list-input"
      : desc.field === "checkbox" ? ".cm-property-checkbox"
      : ".cm-property-value-input");
    if (target) {
      target.focus();
      if (target.tagName === "INPUT" && target.type === "text") {
        target.selectionStart = target.selectionEnd = (target.value || "").length;
      }
    }
  }

  /** The entry's value flattened to one string, for type conversions. */
  function toScalar(entry) {
    if (LIST_TYPES.has(entry.type)) return (entry.value || []).join(", ");
    if (entry.type === "checkbox") return entry.value ? "true" : "false";
    return String(entry.value ?? "");
  }

  function convertType(entry, nextType) {
    if (entry.type === nextType) return;
    if (LIST_TYPES.has(nextType)) {
      // List ↔ Tags keeps the items; scalars become a one-item list.
      if (LIST_TYPES.has(entry.type)) {
        entry.type = nextType;
        return;
      }
      const v = toScalar(entry).trim();
      entry.value = v === "" ? [] : [v];
    } else if (nextType === "checkbox") {
      entry.value = LIST_TYPES.has(entry.type)
        ? entry.value.length > 0
        : toScalar(entry).trim().toLowerCase() === "true";
    } else if (nextType === "number") {
      const m = toScalar(entry).match(/-?(\d+\.?\d*|\.\d+)/);
      entry.value = m ? m[0] : "";
    } else if (nextType === "date") {
      const m = toScalar(entry).match(/\d{4}-\d{2}-\d{2}/);
      entry.value = m ? m[0] : "";
    } else if (nextType === "datetime") {
      const s = toScalar(entry).trim().replace(" ", "T");
      entry.value = DATETIME_RE.test(s) ? s
        : DATE_RE.test(s) ? s + "T00:00"
        : "";
    } else {
      entry.value = toScalar(entry);
    }
    entry.type = nextType;
  }

  /** Keydown handler shared by the text inputs: Enter commits, Escape
   *  abandons focus back to the editor (committing what's typed). */
  function commitKeys(e, focusDesc) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(focusDesc);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(null);
      view.focus();
    }
  }

  function buildValueEl(entry, idx) {
    if (entry.type === "checkbox") {
      const wrap = el("div", "cm-property-value");
      const box = el("input", "cm-property-checkbox", { type: "checkbox" });
      box.checked = !!entry.value;
      box.addEventListener("change", () => {
        entry.value = box.checked;
        dirty = true;
        commit({ row: idx, field: "checkbox" });
      });
      wrap.appendChild(box);
      return wrap;
    }
    if (LIST_TYPES.has(entry.type)) {
      const isTags = entry.type === "tags";
      const wrap = el("div", "cm-property-value cm-property-list");
      for (let i = 0; i < entry.value.length; i++) {
        const chip = el("span", "cm-property-chip" + (isTags ? " cm-property-chip-tag" : ""));
        const label = el("span", "cm-property-chip-label");
        label.textContent = entry.value[i];
        chip.appendChild(label);
        const x = el("button", "cm-property-chip-remove", { type: "button", "aria-label": "Remove item" });
        x.textContent = "×";
        x.addEventListener("click", () => {
          entry.value.splice(i, 1);
          dirty = true;
          commit({ row: idx, field: "list" });
          renderRows({ row: idx, field: "list" });
        });
        chip.appendChild(x);
        wrap.appendChild(chip);
      }
      const input = el("input", "cm-property-list-input", {
        type: "text",
        placeholder: entry.value.length ? "" : (isTags ? "Tag…" : "List item…"),
      });
      const addChip = (refocus = true) => {
        // Tags never store the leading `#` — Obsidian keeps YAML tags bare.
        const v = (isTags ? input.value.replace(/^#+/, "") : input.value).trim();
        if (!v) return false;
        entry.value.push(v);
        input.value = "";
        commit(refocus ? { row: idx, field: "list" } : null);
        renderRows(refocus ? { row: idx, field: "list" } : null);
        return true;
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          if (!addChip()) commit({ row: idx, field: "list" });
        } else if (e.key === "Backspace" && input.value === "" && entry.value.length) {
          e.preventDefault();
          entry.value.pop();
          dirty = true;
          commit({ row: idx, field: "list" });
          renderRows({ row: idx, field: "list" });
        } else if (e.key === "Escape") {
          e.preventDefault();
          addChip(false);
          commit(null);
          view.focus();
        }
      });
      input.addEventListener("blur", () => { addChip(false); });
      wrap.appendChild(input);
      return wrap;
    }
    // Scalar types share one input element with a type-specific control:
    // plain text, a numeric spinner, or the native date / datetime picker.
    const inputType = entry.type === "number" ? "number"
      : entry.type === "date" ? "date"
      : entry.type === "datetime" ? "datetime-local"
      : "text";
    const wrap = el("div", "cm-property-value");
    const input = el("input", "cm-property-value-input", { type: inputType, placeholder: "Empty" });
    if (inputType === "number") input.setAttribute("step", "any");
    input.value = String(entry.value ?? "");
    input.addEventListener("input", () => { entry.value = input.value; });
    input.addEventListener("keydown", (e) => commitKeys(e, { row: idx, field: "value" }));
    if (inputType === "date" || inputType === "datetime-local") {
      // Picking from the native calendar fires `change` without Enter or
      // blur — commit right away so the doc tracks the picker.
      input.addEventListener("change", () => {
        entry.value = input.value;
        dirty = true;
        commit({ row: idx, field: "value" });
      });
    }
    wrap.appendChild(input);
    return wrap;
  }

  function buildRow(entry, idx) {
    if (entry.type === "comment") {
      const row = el("div", "cm-property-row cm-property-comment");
      row.textContent = entry.text.trim();
      return row;
    }
    const row = el("div", "cm-property-row");

    const type = el("select", "cm-property-type", { title: "Property type" });
    for (const [value, label] of TYPE_OPTIONS) {
      const opt = el("option", null, { value });
      opt.textContent = label;
      if (entry.type === value) opt.selected = true;
      type.appendChild(opt);
    }
    type.addEventListener("change", () => {
      convertType(entry, type.value);
      dirty = true;
      commit({ row: idx, field: "type" });
      renderRows({ row: idx, field: "type" });
    });
    row.appendChild(type);

    const key = el("input", "cm-property-key", { type: "text", placeholder: "name" });
    key.value = entry.key || "";
    key.addEventListener("input", () => { entry.key = key.value; });
    key.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit({ row: idx, field: entry.type === "list" ? "list" : "value" });
        focusField({ row: idx, field: entry.type === "list" ? "list" : "value" });
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(null);
        view.focus();
      }
    });
    row.appendChild(key);

    row.appendChild(buildValueEl(entry, idx));

    const remove = el("button", "cm-property-remove", { type: "button", "aria-label": "Remove property", title: "Remove property" });
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      entries.splice(idx, 1);
      dirty = true;
      commit(null);
      renderRows(null);
    });
    row.appendChild(remove);
    return row;
  }

  function renderRows(focusDesc) {
    rowsEl.textContent = "";
    entries.forEach((entry, idx) => rowsEl.appendChild(buildRow(entry, idx)));
    container.classList.toggle("cm-properties-empty", entries.length === 0);
    if (focusDesc) focusField(focusDesc);
  }

  function addRow() {
    entries.push({ type: "text", key: "", value: "" });
    renderRows({ row: entries.length - 1, field: "key" });
  }
  addBtn.addEventListener("click", addRow);
  container.__addPropertyRow = addRow;
  // Lets the visibility toggle flush half-typed edits before the widget
  // is torn down (element removal doesn't fire focusout reliably).
  container.__commitPending = () => commit(null);

  // Commit whatever is pending when focus leaves the properties UI
  // entirely (click into the doc body, the sidebar, another window).
  container.addEventListener("focusout", (e) => {
    if (e.relatedTarget && container.contains(e.relatedTarget)) return;
    // Blur handlers (chip adds) run before this; commit the final state.
    commit(null);
  });

  // Keep CodeMirror's drag/select machinery out of the widget.
  container.addEventListener("mousedown", (e) => e.stopPropagation());

  renderRows(null);

  // Restore focus after a draft→real rebuild. toDOM runs mid-dispatch,
  // before this container is attached — a microtask lands just after the
  // dispatch completes (ahead of the user's next keystroke), with an rAF
  // backstop in case CM's measure phase reattaches the widget.
  if (pendingFocus && pendingFocus.docDom === view.dom) {
    const desc = pendingFocus.desc;
    pendingFocus = null;
    queueMicrotask(() => focusField(desc));
    requestAnimationFrame(() => {
      if (container.isConnected && !container.contains(document.activeElement)) focusField(desc);
    });
  }

  return container;
}
