/** Lightweight markdown parser for canvas text rendering.
 *  Supports: # headings (h1-h3), **bold**, *italic* / _italic_, [links](url)
 */

export interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Font size multiplier relative to base (1.0 = normal) */
  sizeScale: number;
  /** If set, this run is a link */
  link?: string;
  /** If true, render with highlight background (==text==) */
  highlight?: boolean;
  /** Uppercased flag name when this highlight is a recognised flag —
   *  e.g. `==MISSING==` or `==MISSING: foo==` → `"MISSING"`. The
   *  renderer (and shelf) resolve this against the user's flagColors
   *  setting; the field is just the tag, not the colour. */
  highlightFlag?: string;
}

export interface ParsedLine {
  runs: TextRun[];
  sizeScale: number; // heading scale for the whole line
  /** `> ...` blockquote line — renderer paints a left rule + indent. */
  blockquote?: boolean;
  /** `- [ ]` / `- [x]` task line — renderer draws a checkbox glyph in
   *  place of the list marker. `taskChecked` is the resolved state. */
  task?: boolean;
  taskChecked?: boolean;
  /** Plain markdown list line — `- foo`, `* foo`, `+ foo`, or `1. foo`.
   *  `listMarker` is the glyph the renderer should paint in the gutter
   *  for the first wrapped line of the item; on continuation lines
   *  `listMarker` is empty so only the indent reserve is preserved. */
  list?: boolean;
  listMarker?: string;
  /** Number of leading spaces preceding the marker, in fractions of a
   *  font width — lets the renderer step the indent for nested lists. */
  listDepth?: number;
}

/**
 * Parse a single line of text into styled runs.
 */
export function parseLine(line: string): ParsedLine {
  let sizeScale = 1.0;
  let workingLine = line;
  let blockquote = false;
  let task = false;
  let taskChecked = false;

  // Block quote prefix — strip a single `> ` (or `>` + nothing) and
  // mark the line so the renderer can draw the left rule.
  const bqMatch = workingLine.match(/^>+\s?(.*)$/);
  if (bqMatch) {
    blockquote = true;
    workingLine = bqMatch[1];
  }

  // Task list — `- [ ] ...` / `- [x] ...`. Strip the marker + bracket;
  // the renderer draws the checkbox glyph in its place.
  const taskMatch = workingLine.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (taskMatch) {
    task = true;
    taskChecked = taskMatch[2] !== " ";
    workingLine = taskMatch[3];
  }

  // Plain markdown list — bullet or numbered. Strip the marker; the
  // renderer paints a glyph in its place and reserves a hang-indent
  // gutter so wrapped lines align under the first character of text.
  let list = false;
  let listMarker = "";
  let listDepth = 0;
  if (!task) {
    const bulletMatch = workingLine.match(/^(\s*)([-*+])\s+(.*)$/);
    const numberMatch = !bulletMatch ? workingLine.match(/^(\s*)(\d+)[.)]\s+(.*)$/) : null;
    if (bulletMatch) {
      list = true;
      listMarker = "•";
      listDepth = Math.floor(bulletMatch[1].length / 2);
      workingLine = bulletMatch[3];
    } else if (numberMatch) {
      list = true;
      listMarker = numberMatch[2] + ".";
      listDepth = Math.floor(numberMatch[1].length / 2);
      workingLine = numberMatch[3];
    }
  }

  // Check for heading prefix
  const headingMatch = workingLine.match(/^(#{1,3})\s+(.*)$/);
  if (headingMatch) {
    const level = headingMatch[1].length; // 1, 2, or 3
    sizeScale = level === 1 ? 1.8 : level === 2 ? 1.4 : 1.15;
    workingLine = headingMatch[2];
  }

  const runs = parseInlineFormatting(workingLine, sizeScale);
  const out: ParsedLine = { runs, sizeScale };
  if (blockquote) out.blockquote = true;
  if (task) { out.task = true; out.taskChecked = taskChecked; }
  if (list) { out.list = true; out.listMarker = listMarker; out.listDepth = listDepth; }
  return out;
}

/** Match a bare flag highlight: `==NAME==`, `==NAME:==`, or
 *  `==NAME: body text==`. The colon and trailing body are optional so a
 *  bare flag still picks up its configured colour. Mirrors the Docs flag
 *  regex in `src/editor/editor.js::createFlagHighlightPlugin`. */
const FLAG_INNER_RE = /^([A-Za-z][A-Za-z0-9_-]{0,24})(?::([\s\S]*))?$/;

/**
 * Parse inline **bold**, *italic* / _italic_, [link](url), ==highlight==
 * markers into runs. Highlights re-parse their inner text so nested
 * formatting (bold / italic / links) survives inside ==..==.
 */
function parseInlineFormatting(text: string, sizeScale: number): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|\[([^\]]+)\]\(([^)]+)\)|==(.+?)==)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false, sizeScale });
    }

    if (match[2] !== undefined) {
      runs.push({ text: match[2], bold: true, italic: false, sizeScale });
    } else if (match[3] !== undefined) {
      runs.push({ text: match[3], bold: false, italic: true, sizeScale });
    } else if (match[4] !== undefined) {
      runs.push({ text: match[4], bold: false, italic: true, sizeScale });
    } else if (match[5] !== undefined) {
      runs.push({ text: match[5], bold: false, italic: false, sizeScale, link: match[6] });
    } else if (match[7] !== undefined) {
      const inner = match[7];
      // Detect flag (`==NAME==` / `==NAME: body==`) before parsing
      // nested formatting — once recognised the flag tag rides every
      // emitted run so the renderer / shelf can colour them uniformly.
      const flag = inner.match(FLAG_INNER_RE);
      const flagName = flag ? flag[1].toUpperCase() : undefined;
      const hasBody = flag !== null && flag[2] !== undefined;
      if (flagName) {
        // Render `NAME` (always). When the flag has a colon we render
        // the colon plus the nested-parsed body so `==MISSING: please
        // **fix**==` paints "MISSING:" then italic/bold inside the body.
        runs.push({ text: flag![1], bold: false, italic: false, sizeScale, highlight: true, highlightFlag: flagName });
        if (hasBody) {
          runs.push({ text: ":", bold: false, italic: false, sizeScale, highlight: true, highlightFlag: flagName });
          const bodyRuns = parseInlineFormatting(flag![2], sizeScale);
          for (const r of bodyRuns) {
            runs.push({ ...r, highlight: true, highlightFlag: flagName });
          }
        }
      } else {
        // Plain highlight — recurse so nested **bold** / *italic* /
        // [link](url) inside `==…==` survive.
        const innerRuns = parseInlineFormatting(inner, sizeScale);
        for (const r of innerRuns) {
          runs.push({ ...r, highlight: true });
        }
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex), bold: false, italic: false, sizeScale });
  }
  if (runs.length === 0) {
    runs.push({ text, bold: false, italic: false, sizeScale });
  }
  return runs;
}

/**
 * Parse a full multi-line text into an array of ParsedLines.
 * Handles wrapping within a width constraint using canvas measurement.
 * Wrapping preserves run formatting by splitting runs across lines.
 */
export function parseText(
  text: string,
  constraintWidth?: number,
  baseFontSize?: number,
  measureFn?: (text: string, fontSize: number) => number,
): ParsedLine[] {
  const rawLines = text.split("\n");
  const result: ParsedLine[] = [];

  for (const rawLine of rawLines) {
    const parsed = parseLine(rawLine);

    if (!constraintWidth || constraintWidth <= 0 || !baseFontSize || !measureFn) {
      result.push(parsed);
      continue;
    }

    // Word-wrap while preserving run structure
    const fontSize = baseFontSize * parsed.sizeScale;
    const wrapped = wrapRuns(parsed.runs, constraintWidth, fontSize, measureFn);
    for (let i = 0; i < wrapped.length; i++) {
      const out: ParsedLine = { runs: wrapped[i], sizeScale: parsed.sizeScale };
      // Propagate the blockquote rule to every wrapped line so the
      // continuation aligns under the same left border. The task
      // marker only renders on the first wrapped line; subsequent
      // continuation lines are flagged so the renderer can hang-indent
      // them under the original checkbox.
      if (parsed.blockquote) out.blockquote = true;
      if (parsed.task) {
        if (i === 0) { out.task = true; out.taskChecked = parsed.taskChecked; }
        else out.task = false; // continuation — indent only, no glyph
      }
      if (parsed.list) {
        out.list = true;
        out.listDepth = parsed.listDepth;
        // First wrapped line draws the bullet/number; continuation
        // lines just preserve the gutter so the wrap hangs under the
        // text rather than reading like a fresh list entry.
        out.listMarker = i === 0 ? (parsed.listMarker || "") : "";
      }
      result.push(out);
    }
  }

  return result;
}

/**
 * Word-wrap an array of TextRuns to fit within a pixel width,
 * splitting runs at word boundaries. Returns an array of line-run arrays.
 */
function wrapRuns(
  runs: TextRun[],
  maxWidth: number,
  fontSize: number,
  measureFn: (text: string, fontSize: number) => number,
): TextRun[][] {
  // Flatten runs into word tokens that remember their formatting
  interface Token { word: string; run: TextRun; trailingSpace: boolean }
  const tokens: Token[] = [];
  for (const run of runs) {
    const parts = run.text.split(/( )/);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === " ") continue; // space handled as trailing
      if (part === "") continue;
      const hasTrailingSpace = i + 1 < parts.length && parts[i + 1] === " ";
      tokens.push({ word: part, run, trailingSpace: hasTrailingSpace });
    }
  }

  if (tokens.length === 0) return [[{ text: "", bold: false, italic: false, sizeScale: runs[0]?.sizeScale ?? 1 }]];

  const lines: TextRun[][] = [];
  let currentLineTokens: Token[] = [];
  let currentWidth = 0;

  for (const token of tokens) {
    const wordW = measureFn(token.word, fontSize);
    // `addW` already includes the inter-word space for non-first tokens;
    // do NOT add a trailing space too or every interior word ends up
    // charged for both its leading and its trailing gap, over-counting
    // every interior space by one and forcing premature wraps.
    const addW = currentLineTokens.length > 0 ? measureFn(" ", fontSize) + wordW : wordW;

    if (currentWidth + addW > maxWidth && currentLineTokens.length > 0) {
      // Flush current line
      lines.push(tokensToRuns(currentLineTokens));
      currentLineTokens = [token];
      currentWidth = wordW;
    } else {
      currentLineTokens.push(token);
      currentWidth += addW;
    }
  }
  if (currentLineTokens.length > 0) {
    lines.push(tokensToRuns(currentLineTokens));
  }

  return lines.length > 0 ? lines : [[runs[0] || { text: "", bold: false, italic: false, sizeScale: 1 }]];
}

/** Merge consecutive tokens with the same formatting back into TextRuns */
function tokensToRuns(tokens: { word: string; run: TextRun; trailingSpace: boolean }[]): TextRun[] {
  const result: TextRun[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const text = (i > 0 ? " " : "") + t.word;
    const last = result[result.length - 1];
    if (last && last.bold === t.run.bold && last.italic === t.run.italic && last.link === t.run.link && last.highlight === t.run.highlight && last.highlightFlag === t.run.highlightFlag) {
      last.text += text;
    } else {
      result.push({ text, bold: t.run.bold, italic: t.run.italic, sizeScale: t.run.sizeScale, link: t.run.link, highlight: t.run.highlight, highlightFlag: t.run.highlightFlag });
    }
  }
  return result;
}
