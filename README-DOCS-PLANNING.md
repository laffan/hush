# Hush docs site: planning

Planning notes for a GitHub Pages documentation site for Hush. This file
decides *what* the docs cover and *where the effort goes*. It does not design
the site or set up Pages.

Sources read: `README.md`, `README_DETAIL.md` (the full feature list),
`README-TECHNICAL.md`, `README-NOTEBOOK.md`, `README-SYNC.md`,
`README-DRAWING.md`, `widgets/README-WIDGETS.md`, the v0.2.0 release notes,
the commit history since late October 2026, and the existing `gh-pages`
branch (a one-page landing site from May 2026).

Baseline for "standard": what iA Writer, Ulysses, Typora, Bear, Scrivener,
FocusWriter, Obsidian and Zettlr offer. Sentence focus, typewriter scrolling,
full-screen writing, themes, word goals, folder sync and Zotero citations all
exist somewhere in that set, so they are treated as genre features here even
where Hush does them well.

---

## 1. Pitch

> Hush is a writing app for macOS and iPad that treats a long piece of writing
> as something you plan, draft, constrain, research and revise, not just type.
> Under a plain Markdown editor sit infinite-canvas notebooks you can cut open
> and push apart, margin cards that move freely between documents and
> canvases, forward-only and word-capped writing modes, a Zotero-aware PDF
> reader, and one-keystroke capture from anywhere in the app. Everything is
> plain files in folders you choose.

Shorter, for the site header: *Plan, draft and revise long Markdown writing,
on the page and on the canvas.* (The current landing page uses "Plan and write
long markdown documents.")

---

## 2. Distinctive features, ranked

Ranked by how far each sets Hush apart from a typical text editor. Each entry
gives what it is, why it is unusual, and what its doc page needs.

Media key: **S** screenshot, **G** short GIF or looping video, **V** longer
video (over ~15 s, or anything with smooth animation where GIF banding would
hurt; use MP4/WebM).

### 2.1 Revising on a canvas: Splits, Grabs and Proofread notebooks

- **What:** A Split cuts the whole canvas in two; drag either line and
  everything on that side moves, so you can push a page apart and write in
  the gap. A Grab lifts a band, closes the gap, and lets you drop it
  elsewhere. *Create Proofread Notebook* renders a PDF's pages (with its
  Zotero highlights and bookmarks) onto a locked layer of a notebook, so a
  printed-style proof can be marked up with ink, split open between
  paragraphs, and rearranged. A live page rail shows the proof as it now
  stands, and on iPad a weighted scroll wheel travels long proofs.
- **Why unusual:** Canvas apps (Freeform, Excalidraw, Obsidian Canvas) place
  objects; none lets you cut the canvas itself and open space in it. Turning
  a PDF into an editable proof surface inside a writing app has no common
  equivalent.
- **Page needs:** V of a split opening a gap and collapsing it; G of a grab
  moving a section; V of PDF → proof → split between paragraphs → ink; S of
  the page rail after splits; G of the iPad scroll wheel (spin, stop, zoom
  cap). A diagram of "what moves when you drag the top vs bottom line".

### 2.2 Cards

- **What:** Short Markdown cards (100-word cap) written with `<<<` / `>>>` or
  `⌘⇧,`. In a Doc they sit in the margin beside a line and never reflow the
  text; on a canvas they are ordinary objects. They can be dragged between
  Docs, canvases, panes and sidebar rows, dropped back in as text with ⌘, or
  copied with ⌘⇧ (keep a draft while trying a revision). Each Inbox or project
  gets a CARDS notebook. On disk a card is still plain Markdown with a
  `%%card {...}%%` comment.
- **Why unusual:** Margin comments exist (Word, Google Docs, Scrivener's
  inspector) but they annotate text; Hush cards are content that moves
  between two kinds of surface and back into the prose. Marked experimental.
- **Page needs:** G making a card from a selection and from `⌘⇧.`; G
  dragging a card Doc → canvas → back as text; S of a Doc margin with stacked
  cards; S of the CARDS notebook grid and sidebar card rows; a short "the file
  format" box showing the Markdown.

### 2.3 Writing under constraints: Ratchet, Desk Ratchet, word cap

- **What:** *Ratchet Mode* locks out deletion and navigation for a set time
  (or untimed until you end it). *Desk Ratchet* applies to a whole desk with no
  clock: text can be rearranged but never rewritten. *Set word count limit*
  makes a document refuse new words at a number (pastes trimmed, edits still
  allowed).
- **Why unusual:** Forward-only writing exists only in single-purpose apps
  (The Most Dangerous Writing App's Hardcore Mode, Write or Die). Mainstream
  editors offer word *goals*, not caps. A per-desk, clock-free ratchet and a
  hard per-document cap inside a full editor are rare.
- **Page needs:** G of a refused delete (the red ring flash); S of the word
  count pill at `320 / 500` and at the limit; S of the desk ratchet badge.
  A short "why you'd use this" section, since the value is the idea.

### 2.4 Capture from anywhere: Courier, Write Now, the to-do list

- **What:** Triple-tap ⇧ opens *Courier*, a sheet that leaves a sticky, an
  appended paragraph or a card in any document or desk without leaving what
  you are doing. Triple-tap ⌥ is *Write Now*: full screen, Midnight mode,
  Zen, a new timestamped document on a chosen desk, caret ready. Double-tap ⌘
  opens the *to-do list*: to-dos per desk, linked to files, with four states
  (inactive, primed, active, complete) and a timer from titles ending in
  `30m` or `1h`. All gestures are rebindable.
- **Why unusual:** Quick capture usually means a separate inbox app or a
  global hotkey that opens one fixed note. Courier targets any destination
  and remembers it; Write Now sets up the whole writing environment in one
  gesture; modifier-tap gestures are uncommon on the Mac.
- **Page needs:** V of each gesture from a busy screen; S of Courier's three
  modes; S of the to-do list with primed/active items and the Start timer
  button; a table of default gestures.

### 2.5 Atmosphere: Campfire Cursor, Edge Lights, Midnight, style layers

- **What:** *Campfire Cursor* fades every word but those near the caret, as
  if lit by it. *Edge Lights* animates light (Polar, Scuba, Thrum, Thrum
  Dark), blur, snow or hyperspace round the window edges, with presets.
  *Midnight mode* paints everything black with grey text and switches itself
  off at 8am. *Styles* stack background layers (images, animated gradients,
  WebGL, caret effects like sparks) and post-processing (vignette, scan lines,
  glow, window translucency), plus a custom caret with idle animation and
  glow.
- **Why unusual:** Writing apps stop at themes, fonts and perhaps a
  background image (FocusWriter, OmmWriter). Shader-driven layers, a caret
  that acts as a light source, and a self-expiring night mode are not genre
  features. Campfire and Edge Lights are marked experimental.
- **Page needs:** This is the most media-heavy section. V for each Edge
  Lights type; G of Campfire with the caret moving; S before/after of
  Midnight; a gallery of styles (the two bundled presets in
  `src/assets/style-presets/` plus a few made for the site); G of a caret
  effect. Consider a `prefers-reduced-motion` fallback to stills.

### 2.6 Private Mode

- **What:** `⌘⇧P` paints bars over every word on screen (or swaps letters
  for plausible fake ones) so you can write in public, without reflowing the
  page, across panes, stacks and Zen.
- **Why unusual:** Dimming (iA Writer) and blurring (FocusWriter) exist for
  focus; obscuring text against onlookers while you keep typing is not a
  standard editor feature.
- **Page needs:** S of the same page in normal, bars and dummy-text modes.
  Short page; could be combined with 2.3 or 2.5 under "modes".

### 2.7 Prose-aware editing

- **What:** Sentence-level keys from code editing applied to prose: ⌘L
  selects the innermost parenthetical, quotation or comma/dash stretch, then
  the sentence; ⌘⌫ deletes a sentence; ⌘⇧⌫ deletes to sentence start;
  ⌥↑/↓ move lines (and cards with them). *The Shuffle Editor* explodes a
  selection into draggable sentences to reorder, merge, strike or comment,
  then diff against the original. *Selection Focus* edits a passage alone.
  Heading folds nest. Formatting shortcuts trim whitespace so `**word**`
  always parses. Tables keep resized column widths in the dash counts Pandoc
  reads.
- **Why unusual:** Most editors work in characters, words and lines. Clause
  and sentence as units, and a sentence-shuffling revision view, are rare.
- **Page needs:** G per gesture (⌘L growing, ⌘⌫, Shuffle Editor reorder and
  compare); a keyboard reference table. Lower media cost than 2.1–2.5.

### 2.8 Project Desktop

- **What:** A project's board: each document as a stack of pages (one per
  500 words) beside its heading outline; hover a heading to lift its page,
  click to open it in a pane at that place. Placeholders let you plan a
  document not yet written as an outline, then *Create* writes it with those
  headings. Per-document notes, nested projects, supporting material below.
- **Why unusual:** Scrivener's corkboard and outliner are the nearest
  equivalent; drawing documents as page stacks and turning a planned outline
  into a real document in place goes further. Projects also edit as one
  joined buffer across many files.
- **Page needs:** S of a full Desktop; G of hover-to-lift and click-to-pane;
  G of placeholder → Create.

### 2.9 Research: Zotero library, PDF reader, bookmarks as links

- **What:** Zotero search and `[@` citations, a local library cache with
  incremental *Update Data*, a highlights browser that works offline, PDF
  import three ways. The PDF viewer paints Zotero highlights into pages and
  has a *folded view* (only annotated regions), a *reading crop* (hold ⌘,
  drag margins), clips and coloured bookmarks that become `hush-nb://` deep
  links in your notes, NOTES.md from Zotero in the shelf, and annotation
  extraction from Preview/Acrobat PDFs. PDF export goes through Typst with a
  real bibliography. Companion `hushwriter://` links let the separate
  zotero-helper app file PDFs into a desk.
- **Why unusual:** Zettlr and Obsidian plugins cover citations and annotation
  import. A built-in reader with folded and cropped views, and bookmarks that
  are shared between PDFs, notebooks and Docs, is less common. The current
  landing page leads with this ("Zotero first").
- **Page needs:** S of the folded view; G of reading crop; G of ⌘-dragging a
  bookmark into a Doc and the ribbon icon appearing; S of the highlights
  browser; a step-by-step "connect Zotero" setup page (credentials,
  downloads).

### 2.10 Time and progress: Timer, Clock, Progress

- **What:** A timer with a warmup and scheduled breaks drawn as a timeline
  before you start, living in the sidebar or as a draggable ring. A clock
  whose minute marks are clickable alarms. *Progress* shows words *added* per
  day by document and section, read back out of version history, so nothing
  had to be tracked in advance.
- **Why unusual:** Pomodoro timers and word stats are common (Ulysses,
  FocusWriter); counting added rather than net words, backfilled from
  history, is not.
- **Page needs:** S of the timer sheet timeline; G of the ring through a
  break; S of the clock with an alarm set; S of Progress calendar and graph.

### 2.11 Desks, Dashboard, YOU ARE HERE

- **What:** Desks as top-level workspaces, each with Inbox, Archive, Trash,
  style and to-dos, grouped into sections; the Desk Dashboard grid with
  recent files and search across every desk; Inbox rows that go red after a
  week and preview where you left off; an Archive that files itself by month
  and year; a `YOUAREHERE: note.` marker that pins a resume row.
- **Why unusual:** Workspaces/vaults are standard (Obsidian, Ulysses
  libraries). The self-ageing Inbox, the resume marker with a note, and
  previews that reopen at the old caret are the distinctive parts; the
  model itself is mostly standard and should be explained briefly.
- **Page needs:** S of the Dashboard; S of the Inbox expanded view; G of
  YOUAREHERE.

### 2.12 Outlines and flowcharts

- **What:** `outline: true` turns nested checklists into framed outlines
  pinned to the bottom of the window, with drag grips and their own editor.
  On a canvas, flowcharts fold into an outline shape and back.
- **Why unusual:** Outliners and checklists are standard; a checklist docked
  under the prose while you write, and chart ⇄ outline conversion, are not.
- **Page needs:** S of a Doc with a pinned outline; G of flowchart → outline.

### 2.13 Google Docs link

- **What:** Per-document push/pull with a Google Doc that keeps comments and
  suggestions on untouched text, maps Google Docs tabs to `---Tab---`, and
  shows pulled comments and suggestions inline with Accept/Reject.
- **Why unusual:** Markdown editors import or export to Google Docs; a
  two-way link that round-trips review comments is uncommon.
- **Page needs:** a setup page (per-install OAuth client in Settings → Sync →
  Google Sync, redirect `http://127.0.0.1`); S of an inline suggestion card.

---

## 3. Standard features: brief mention only

These get a line or two on an overview page, with a link to the shortcut
reference, not pages of their own. Where Hush adds a twist, the twist is the
one sentence worth writing.

| Feature | One-line twist, if any |
| --- | --- |
| Markdown with inline rendering, footnotes, callouts, YAML, `[[wikilinks]]` | none needed |
| Themes and fonts | covered by Styles (2.5) |
| Focus Mode (sentence dimming) | fades the UI with the text |
| Typewriter Mode | draggable typewriter line |
| Zen Focus full screen | frosted blur toward the edges; titles locked |
| Word count | none needed |
| Find and replace with regex, desk-wide find | none needed |
| Spellcheck and grammar (Harper), on device | none needed |
| Multiple cursors | none needed |
| Folders, flags, colour tints, multi-select | none needed |
| Custom icons for desks and folders | uses the tiny-icons set |
| Versions with diff and restore | starred major versions kept for good |
| Floating panes, docked panes, Stacks | the keyboard follows the pointer between panes |
| Export to PDF, Markdown, RTF | Typst pipeline (mention under Research) |
| Command palette, rebindable shortcuts | Active Modes pinned at the top |
| Folder-based sync via iCloud/Dropbox/Syncthing | three-way merge on overlapping edits; never drops undelivered files |
| Hourly desk backups to a chosen folder | none needed |
| Multi-window, menu-bar app, iPad and iPhone layouts | none needed |
| Home-screen widgets | opt-in build |

---

## 4. Proposed site structure

```
/                       Home: pitch, 6 feature tiles (2.1–2.6), download
/start/                 Getting started
  install               DMG, the xattr step, build from source
  first-desk            desks, Inbox, the command palette, ⌘P
  files                 where data lives, plain files, local desks
/features/              One page per distinctive feature, in rank order
  canvas-revision       2.1 Splits, Grabs, Proofread notebooks
  cards                 2.2
  constraints           2.3 Ratchet, Desk Ratchet, word cap
  capture               2.4 Courier, Write Now, to-dos
  atmosphere            2.5 Campfire, Edge Lights, Midnight, Styles
  private-mode          2.6 (or folded into constraints/atmosphere)
  prose-editing         2.7
  project-desktop       2.8
  research              2.9 (with a Zotero setup subpage)
  time                  2.10 Timer, Clock, Progress
  desks                 2.11
  outlines              2.12
  google-docs           2.13 (with setup)
/basics/                One page listing the standard features (section 3)
/sync/                  Sync, conflicts, backups, recovery
/reference/
  shortcuts             every default shortcut and triple tap
  palette               command palette entries by area
  file-formats          .md, .hushnote, .hushstack, card comments
/changelog/             release notes, starting with v0.2.0
```

Roughly 25 pages. Sections 2.1–2.6 carry most of the media budget.

---

## 5. Open questions for Nate

1. **The existing `gh-pages` landing page** (May 2026, "Zotero first",
   dark theme): keep it as the home page and add docs under it, or replace
   it with the new site?
2. **Audience:** writers in general, or academics first? It decides whether
   Research (2.9) moves up the order and onto the home page.
3. **Experimental features** (Cards, Edge Lights, Campfire Cursor): document
   them fully with an "experimental" badge, or hold them back?
4. **Platforms:** releases ship macOS DMGs only, but the docs describe iPad
   and iPhone throughout. Should iPad/iPhone features be documented as
   available, or as build-from-source?
5. **Screenshots and video:** these have to be captured on a Mac running
   Hush, which this environment can't do. Will you capture them, or should
   the pages ship first with placeholders and a shot list?
6. **Site tooling:** plain HTML like the current landing page, Jekyll
   (GitHub Pages builds it from a branch with no workflow file), or a
   generator that needs a GitHub Actions workflow? Workflow files can't be
   added from this session, so the first two are simpler.
7. **One source of truth:** `README_DETAIL.md` is very thorough. Should the
   site be written from it and `README_DETAIL.md` then trimmed to point at
   the site, or should both be kept?
8. **To verify:** `README_DETAIL.md` gives the data folder as
   `~/Library/Application Support/com.hush.app/`, but the bundle identifier is
   `com.hushwriter.app`. Which is right? The getting-started page will repeat
   it.
