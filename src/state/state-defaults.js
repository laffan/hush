/**
 * Default `AppState.settings` shape. Mirrors the Rust `AppSettings` struct
 * (camelCase via serde). Used as the initial value for new sessions and as
 * the merge base when loading from Tauri / localStorage.
 */
export function createDefaultSettings() {
  return {
    visibility: "both",
    appearance: "auto",
    touchMode: false,
    hideSystemChrome: true,
    lightTheme: "smoothy",
    darkTheme: "dracula",
    fontSize: 16,
    lineHeight: 1.5,
    fontFamily: "iA Writer Quattro",
    normalizeHeaders: false,
    normalizeHeaderColor: false,
    underlineHeaders: false,
    headerScale: 1.0,
    defaultLightColors: {},
    defaultDarkColors: {},
    makeSpaceForPanes: true,
    makeSpaceDirection: "right",
    // Horizontal offset applied while the "Make space" layout is engaged,
    // driven by a draggable grip above the column. Persisted so the
    // chosen column position survives restarts.
    makeSpaceColumnOffset: 0,
    stickyHeaders: false,
    blockCursor: true,
    blockCursorColor: null,
    // Cursor mode picker (system / block / underline). Falls back to
    // the legacy `blockCursor` boolean when null so existing installs
    // keep their setting.
    cursorMode: null,
    // Active-line indicator for the Default style. Per-style overrides
    // live on `Style.lineIndicator`. One of "none", "left-arrow",
    // "double-arrow", "left-border", "border", "highlight". The
    // indicator colour rides per-appearance on defaultLightColors /
    // defaultDarkColors under the `lineIndicator` key.
    lineIndicator: "none",
    typewriterLineOpacity: 0.08,
    // %% comment %% opacity. Markers dim to 2/3 of this value so the
    // delimiters fade further than the body content.
    commentOpacity: 0.5,
    padding: 50,
    syncFolders: [],
    dropboxToken: null,
    alwaysOnTop: false,
    columnWidth: 800,
    // Zen mode keeps its own column width so resizing inside the
    // overlay doesn't reflow the everyday editor. Null = fall back to
    // columnWidth on first use, then persist independently.
    zenColumnWidth: null,
    sidebarPanelWidth: 300,
    notebookShelfWidth: 280,
    // App-wide saved text-style presets for notebook text shapes.
    // Each entry: { id, color, backgroundColor, fontSize }.
    notebookTextStyles: [],
    // Per-context "panes are hidden" flags. Keyed by `pane.ownerContext`
    // (`doc:<id>`, `nb:<id>`, `pj:<id>`); each present key means panes
    // owned by or pinned into that context are hidden until **Show
    // panes** is run again, and the sidebar's per-file indicator
    // collapses to a thin strip.
    panesHiddenByContext: {},
    // Notebook-only floating minimap widget. Off by default; toggled
    // via the command palette ("Show minimap" / "Hide minimap"). The
    // widget unmounts itself whenever a non-notebook is open.
    minimapVisible: false,
    // "Desks" — top-level container above all other tree nodes. The
    // top level is always one or more desk nodes, each with its own
    // namespaced Inbox/Images/Trash. Sessions started before desks
    // became always-on are wrapped under a single "Personal" desk on
    // first boot. The legacy `useDesks` flag stays in storage as a
    // deprecated boolean so older settings.json files still parse.
    useDesks: true,
    // Desk list (synced via `.hush/desks.json`). One entry per desk:
    // `{ id, name, createdAt }`. Always at least one entry.
    desks: [],
    // Per-desk synced metadata, keyed by desk id. Carries the slot of
    // settings that diverge per desk: active style, desktop slot,
    // persisted panes (panes are owned by their host desk per spec).
    // Local-only fields like lastFileId / scrollPosition stay on the
    // top-level `settings` so they per-device-per-window restore.
    desksMeta: {},
    // Active desk id for this device. Persisted as a regular setting so
    // the choice rides across restarts; intentionally NOT considered a
    // synced field — each device picks its own active desk.
    activeDeskId: null,
    // Shortcuts — General
    shortcutOpenEditor: "CmdOrCtrl+Shift+H",
    shortcutOpenFullscreen: "CmdOrCtrl+Alt+F",
    shortcutTogglePrivate: "CmdOrCtrl+Shift+P",
    shortcutToggleSidebar: "CmdOrCtrl+\\",
    shortcutToggleOutline: "CmdOrCtrl+Shift+\\",
    shortcutTypewriter: "Mod+Shift+T",
    shortcutNewFile: "Mod+N",
    shortcutToggleDry: "Mod+Shift+R",
    shortcutToggleFocus: "Mod+S",
    shortcutToggleWordCount: "Mod+Shift+W",
    shortcutZenFocus: "Mod+Shift+S",
    // Literal Ctrl on Mac (not Cmd) so it doesn't clash with Mod+Shift+D
    // (Select previous instance). Translates to Ctrl+Shift+D on every
    // platform.
    shortcutSwitchDesks: "Ctrl+Shift+D",
    zenFocusFontSize: 30,
    wordCountVisible: false,
    shortcutFind: "Mod+Shift+F",
    shortcutQuickFind: "Mod+F",

    // Shortcuts — Editing (sentence navigation)
    shortcutSelectSentence: "Mod+L",
    shortcutReduceSentence: "Alt+Shift+L",
    shortcutSelectNext: "Mod+D",
    shortcutJumpNextSentence: "Mod+ArrowRight",
    shortcutJumpPrevSentence: "Mod+ArrowLeft",
    shortcutNextSentence: "Mod+Shift+ArrowRight",
    shortcutPrevSentence: "Mod+Shift+ArrowLeft",
    shortcutMoveSentenceForward: "Alt+Mod+ArrowRight",
    shortcutMoveSentenceBack: "Alt+Mod+ArrowLeft",
    shortcutSelectPrevious: "Mod+Shift+D",
    shortcutDeleteToSentenceEnd: "Alt+Shift+Backspace",

    // Shortcuts — Formatting
    shortcutBold: "Mod+B",
    shortcutItalic: "Mod+I",
    shortcutHighlight: "Mod+=",
    shortcutComment: "Mod+/",
    shortcutStrikethrough: "Mod+`",
    shortcutInsertFootnote: "Mod+Shift+M",

    // Shortcuts — Additional editing actions
    shortcutSelectParagraph: "Mod+Shift+L",
    shortcutSelectParagraphUp: "Mod+Shift+ArrowUp",
    shortcutSelectParagraphDown: "Mod+Shift+ArrowDown",
    // Save is autosave-driven; the explicit shortcut is intentionally
    // unbound by default so it doesn't compete with Focus mode (Mod+S).
    shortcutSave: "",
    shortcutFindNext: "Mod+G",
    shortcutFindPrev: "Mod+Shift+G",
    shortcutJoinLines: "Mod+J",
    shortcutJumpNextParagraph: "Mod+ArrowDown",
    shortcutJumpPrevParagraph: "Mod+ArrowUp",
    shortcutZotero: "Mod+Shift+I",

    // D.R.Y. highlighting
    dryRange: "paragraph",
    dryStopwords: [],
    dryIgnoreProperNouns: false,
    dryIncludeBaseWords: false,

    // Footnotes
    footnoteFontSize: 100,
    footnoteFontFamily: "sans-serif",
    footnoteUseColors: true,
    footnoteBothMargins: true,
    footnoteMarginSide: "closest",

    // Styles
    styles: [],
    activeStyleId: null,
    globalStyleId: null,
    // Filenames of bundled style presets that have already been seeded
    // into `styles`. Lets new presets land on next launch without
    // re-adding ones the user has already deleted.
    seededPresetFiles: [],
    // Shader layer attached to the Default style. User styles carry
    // their own shaderLayer field on each Style object.
    shaderLayer: null,

    // Sidebar / global tooltips (controls native browser tooltips on
    // sidebar buttons, pane headers, and notebook toolbar buttons).
    showTooltips: false,

    // Outline View (right sidebar)
    longviewShowParagraphs: true,
    longviewShowNumbers: true,
    longviewShowComments: false,
    longviewShowFlags: true,
    longviewShowFlagTypes: false,
    longviewWrapFlagText: true,
    longviewBodyFontSize: 3,
    longviewHeadingFontSize: 12,
    longviewFlagFontSize: 12,
    longviewLineGap: 2,
    longviewCurrentPositionColor: "#ff0000",

    // Flags (custom flag types and colors)
    flagColors: {
      TODO: "#ffd700",
      MISSING: "#ff4444",
      COMMENT: "#888888",
      REWRITE: "#ff66aa",
      RESEARCH: "#66aaff",
    },
    customFlags: [
      { name: "REWRITE", color: "#ff66aa" },
      { name: "RESEARCH", color: "#66aaff" },
    ],

    // Ratchet
    ratchetEncourageTyping: false,

    // Zotero
    zoteroApiKey: null,
    zoteroUserId: null,
    zoteroLastUpdate: null,
    zoteroReferenceCount: 0,
    zoteroFileSize: null,
    zoteroSnapshotRenderHeight: 1500,
    zoteroSnapshotDisplayHeight: 300,
    zoteroSnapshotQuality: 90,

    // Privacy — dummy text mode
    privacyMode: "blackout", // "blackout" or "dummy"
    dummyText: "",

    // Notebook settings
    notebookAppearanceMode: "light",
    notebookThemeId: "default",
    notebookBackgroundPattern: "dot-grid",
    notebookGridSpacing: 25,
    notebookGridOpacity: 0.20,
    notebookFontFamily: "Inter",
    notebookFontSize: 16,
    // Zen Focus typewriter window — odd-only (1, 3, 5). 1 = pure
    // typewriter (cursor pinned to centre line); 3/5 widen the band so
    // the cursor can range one or two lines either side of centre before
    // the document scrolls. Symmetric so the centre line stays the
    // anchor.
    zenFocusWindow: 1,
    lastNotebookId: null,

    // Notebook shortcuts
    shortcutNbSelect: "1",
    shortcutNbText: "T",
    shortcutNbDragArea: "A",
    shortcutNbBrainstorm: "B",
    shortcutNbDelete: "Backspace",
    shortcutNbUndo: "Mod+Z",
    shortcutNbRedo: "Mod+Shift+Z",
    shortcutNbGroup: "Mod+G",
    shortcutNbUngroup: "Mod+Shift+G",
    shortcutNbResetZoom: "Mod+0",

    // Proofread mode (harper-core). The mode toggle itself isn't
    // persisted (each session starts off — see state-modes.js), but
    // the per-rule disable list is.
    proofreadDisabledRules: ["LongSentences"],

    // Spellcheck (spellbook crate, en_US Hunspell). Persisted because
    // load is ~10 ms — no cold-start penalty worth deferring.
    spellcheckMode: false,

    // Session state
    lastFileId: null,
    lastProjectId: null,
    lastStackId: null,
    // MRU of recently-opened doc/notebook fileIds, most-recent first.
    // Used to order the Cmd+O picker so the file you were just in
    // tops the list. Capped at 50; per-device, not synced.
    recentFileIds: [],
    // Sidebar Recent Files panel — when on, the panel mounts above the
    // bottom footer and lists `recentFileIds`. Height is user-resizable
    // via the panel's top border.
    showRecentFiles: false,
    recentFilesPanelHeight: 150,
    typewriterMode: false,
    dryMode: false,
    scrollPosition: null,
    // Per-doc main-editor scroll positions, keyed by fileId. Persists
    // across file switches and app restarts. FIFO-trimmed to 100 keys
    // so it can't grow without bound.
    docScrollPositions: {},
  };
}
