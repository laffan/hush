/**
 * Markdown table renderer — renders a GitHub-flavoured pipe table as an
 * actual HTML `<table>` while the cursor is outside it, and reveals the
 * raw `| … |` source (pipes dimmed by the Lezer Table highlight) the
 * moment a cursor or selection lands inside, so the table stays editable
 * as plain text. Mirrors the cursor-aware reveal used by
 * checkbox-list.js / link-decorator.js.
 *
 * The decoration set lives in a StateField, NOT a ViewPlugin: the widget
 * is a block-level replace, and CodeMirror hard-errors on block
 * decorations sourced from plugins ("Block decorations may not be
 * specified via plugins"), which corrupts the whole view. The field
 * recomputes on doc or selection changes — same triggers the plugin
 * version used, minus viewportChanged (a state field can't see the
 * viewport, and the line scan is cheap).
 *
 * Siblings: table-model.js (finding tables, the delimiter row and the
 * widths it carries), table-cells.js (what a cell shows — formatting and
 * links), table-resize.js (dragging a column border).
 *
 * Widths: a table whose delimiter row carries none is laid out by its
 * content — the browser's auto table layout, which gives a column of
 * years its four digits and the prose columns the rest. It used to be
 * the long URLs that wrecked it: one unbreakable word as wide as itself,
 * so the table overflowed sideways. Cells now draw a bare URL as a short
 * capped label (table-cells.js). A table that carries widths is laid out
 * at them, across the whole text column.
 *
 * Links in cells open on ⌘-click (Ctrl elsewhere), as links in the text
 * do; a plain click goes into the source, as it does for the rest of
 * the table.
 */
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import {
  findTables, tableAtLine, splitCells, parseAligns, parseWidths, cellOffset,
} from "./table-model.js";
import { inlineCellHtml } from "./table-cells.js";
import { attachColumnResize, applyColumnWidths } from "./table-resize.js";
import { openUrl, hasModifier } from "./link-decorator.js";

/** ⌘-click on a link in a cell opens it. On `pointerdown`, like the
 *  editor's own link widgets: the gesture's first event, ahead of the
 *  caret placement that would swap the table for its source. */
function openCellLink(e) {
  const link = e.target.closest?.("[data-link-url], [data-wikilink]");
  if (!link || !hasModifier(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (link.dataset.wikilink) {
    window.__hushOpenWikilink?.(link.dataset.wikilink);
    return;
  }
  const r = link.getBoundingClientRect();
  openUrl(link.dataset.linkUrl, { left: r.left, top: r.top, bottom: r.bottom });
}

class TableWidget extends WidgetType {
  constructor(headerCells, aligns, widths, bodyRows, from) {
    super();
    this.headerCells = headerCells;
    this.aligns = aligns;
    this.widths = widths;
    this.bodyRows = bodyRows;
    this.from = from;
    this._key = JSON.stringify([headerCells, aligns, widths, bodyRows]);
  }

  eq(other) {
    return this.from === other.from && this._key === other._key;
  }

  toDOM(view) {
    const cols = this.headerCells.length;
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.dataset.tableFrom = String(this.from);

    const table = document.createElement("table");
    table.className = "cm-md-table";
    const colgroup = document.createElement("colgroup");
    for (let idx = 0; idx < cols; idx++) colgroup.appendChild(document.createElement("col"));
    table.appendChild(colgroup);

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    this.headerCells.forEach((text, idx) => {
      const th = document.createElement("th");
      th.innerHTML = inlineCellHtml(text);
      if (this.aligns[idx]) th.style.textAlign = this.aligns[idx];
      if (idx < cols - 1) {
        const grip = document.createElement("span");
        grip.className = "cm-md-table-resizer";
        grip.dataset.col = String(idx);
        grip.title = "Drag to resize · press twice to fit to content";
        th.appendChild(grip);
      }
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.bodyRows) {
      const tr = document.createElement("tr");
      for (let idx = 0; idx < cols; idx++) {
        const td = document.createElement("td");
        td.innerHTML = inlineCellHtml(row[idx] ?? "");
        if (this.aligns[idx]) td.style.textAlign = this.aligns[idx];
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    applyColumnWidths(table, this.widths);
    wrap.addEventListener("pointerdown", openCellLink);
    if (cols > 1) attachColumnResize(view, wrap, table, this.widths);
    return wrap;
  }

  ignoreEvent() { return false; }
}

function buildDecorations(state) {
  const builder = new RangeSetBuilder();
  const doc = state.doc;
  const sel = state.selection.ranges.map((r) => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));
  for (const t of findTables(doc)) {
    // Leave the raw source visible while a cursor / selection overlaps the
    // table so it can be edited directly — same idiom as the checkbox and
    // link decorators.
    const inside = sel.some((c) => c.from <= t.to && c.to >= t.from);
    if (inside) continue;
    const headerCells = splitCells(t.headerText);
    const aligns = parseAligns(t.delimText);
    const widths = parseWidths(t.delimText, headerCells.length);
    const bodyRows = t.bodyTexts.map(splitCells);
    builder.add(
      t.from,
      t.to,
      Decoration.replace({
        widget: new TableWidget(headerCells, aligns, widths, bodyRows, t.from),
        block: true,
      }),
    );
  }
  return builder.finish();
}

/** Where in the source a click on `target` should put the caret: the
 *  start of the clicked cell's text, or the table's start. */
function clickedCellPos(doc, from, target) {
  const start = Math.min(from, doc.length);
  const cell = target.closest?.("td, th");
  if (!cell) return start;
  const t = tableAtLine(doc, doc.lineAt(start).number);
  if (!t || t.from !== start) return start;
  const tr = cell.parentElement;
  const row = tr.parentElement.tagName === "THEAD" ? 0 : tr.sectionRowIndex + 2;
  const line = doc.line(doc.lineAt(start).number + row);
  if (line.to > t.to) return start;
  return line.from + cellOffset(line.text, cell.cellIndex);
}

export function createTableRendererPlugin() {
  const field = StateField.define({
    create: buildDecorations,
    update(deco, tr) {
      if (tr.docChanged || tr.selection) return buildDecorations(tr.state);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Click a rendered table → drop the caret into the source of the cell
  // that was clicked (the table's start, off a cell), which reveals the
  // raw source (the span now overlaps the selection) for editing.
  const clickHandler = EditorView.domEventHandlers({
    mousedown(e, view) {
      const wrap = e.target?.closest?.(".cm-md-table-wrap");
      if (!wrap) return false;
      // A column grip's press is the resize's (table-resize.js).
      if (e.target.closest(".cm-md-table-resizer")) return true;
      const from = parseInt(wrap.dataset.tableFrom, 10);
      if (!Number.isFinite(from)) return false;
      e.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: clickedCellPos(view.state.doc, from, e.target) } });
      return true;
    },
  });

  return [field, clickHandler];
}
