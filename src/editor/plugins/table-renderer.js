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
 * Cells render the inline formatting the extended-syntax guide allows in
 * tables — `code`, links, emphasis — plus Hush's ~~strike~~ and
 * ==highlight==; `&#124;` shows a literal pipe. Links paint as link-
 * coloured text only for now (following them, and a cell/row/column
 * editing UI, come later — today you edit by clicking into the source).
 */
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";

// A GFM delimiter row: pipe-separated cells of `:?-+:?`, with optional
// surrounding whitespace and optional leading / trailing pipes. Requiring
// a pipe (checked separately) keeps a bare `---` thematic break out.
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function hasUnescapedPipe(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && text[i - 1] !== "\\") return true;
  }
  return false;
}

// Split a table row into trimmed cell strings: drop a single leading and
// trailing unescaped pipe, then split on the remaining unescaped pipes
// (an escaped `\|` becomes a literal pipe inside the cell).
function splitCells(text) {
  let t = text.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && t[t.length - 2] !== "\\") t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Per-column alignment from the delimiter row's `:` markers.
function parseAligns(delimText) {
  return splitCells(delimText).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

// Locate every pipe-table block in the document: a header line containing
// a pipe, immediately followed by a delimiter row, then any run of
// pipe-bearing body lines. Returns spans in document order.
function findTables(doc) {
  const tables = [];
  let i = 1;
  while (i <= doc.lines) {
    const header = doc.line(i);
    const isHeader = hasUnescapedPipe(header.text)
      && !DELIM_RE.test(header.text)
      && i + 1 <= doc.lines;
    if (isHeader) {
      const delim = doc.line(i + 1);
      if (hasUnescapedPipe(delim.text) && DELIM_RE.test(delim.text)) {
        let last = i + 1;
        for (let j = i + 2; j <= doc.lines; j++) {
          const body = doc.line(j);
          if (body.text.trim() === "" || !hasUnescapedPipe(body.text)) break;
          last = j;
        }
        const bodyTexts = [];
        for (let k = i + 2; k <= last; k++) bodyTexts.push(doc.line(k).text);
        tables.push({
          from: header.from,
          to: doc.line(last).to,
          headerText: header.text,
          delimText: delim.text,
          bodyTexts,
        });
        i = last + 1;
        continue;
      }
    }
    i++;
  }
  return tables;
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Basic inline markdown inside a cell. Everything is HTML-escaped first;
// code spans are stashed so their contents dodge the emphasis passes, and
// links resolve before emphasis so a URL's underscores can't italicise.
function inlineCellHtml(raw) {
  let s = escHtml(raw.replace(/&#124;/g, "|"));
  const stash = [];
  const put = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  s = s.replace(/`([^`]+)`/g, (_, c) => put(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, `<span class="cm-md-table-link">$1</span>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

class TableWidget extends WidgetType {
  constructor(headerCells, aligns, bodyRows, from) {
    super();
    this.headerCells = headerCells;
    this.aligns = aligns;
    this.bodyRows = bodyRows;
    this.from = from;
    this._key = JSON.stringify([headerCells, aligns, bodyRows]);
  }

  eq(other) {
    return this.from === other.from && this._key === other._key;
  }

  toDOM() {
    const cols = this.headerCells.length;
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.dataset.tableFrom = String(this.from);

    const table = document.createElement("table");
    table.className = "cm-md-table";

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    this.headerCells.forEach((text, idx) => {
      const th = document.createElement("th");
      th.innerHTML = inlineCellHtml(text);
      if (this.aligns[idx]) th.style.textAlign = this.aligns[idx];
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
    const bodyRows = t.bodyTexts.map(splitCells);
    builder.add(
      t.from,
      t.to,
      Decoration.replace({
        widget: new TableWidget(headerCells, aligns, bodyRows, t.from),
        block: true,
      }),
    );
  }
  return builder.finish();
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

  // Click a rendered table → drop the caret at its start, which reveals
  // the raw source (the span now overlaps the selection) for editing.
  const clickHandler = EditorView.domEventHandlers({
    mousedown(e, view) {
      const wrap = e.target?.closest?.(".cm-md-table-wrap");
      if (!wrap) return false;
      const from = parseInt(wrap.dataset.tableFrom, 10);
      if (!Number.isFinite(from)) return false;
      e.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(from, view.state.doc.length) } });
      return true;
    },
  });

  return [field, clickHandler];
}
