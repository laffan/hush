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
    lightTheme: "ayuLight",
    darkTheme: "dracula",
    fontSize: 18,
    lineHeight: 1.6,
    fontFamily: "iA Writer Quattro",
    normalizeHeaders: false,
    normalizeHeaderColor: false,
    underlineHeaders: false,
    headerScale: 1.0,
    defaultLightColors: {},
    defaultDarkColors: {},
    makeSpaceForPanes: true,
    makeSpaceDirection: "right",
    stickyHeaders: false,
    blockCursor: true,
    blockCursorColor: null,
    typewriterLineOpacity: 0.08,
    padding: 50,
    syncFolders: [],
    dropboxToken: null,
    alwaysOnTop: false,
    columnWidth: 600,
    sidebarPanelWidth: 300,
    notebookShelfWidth: 280,
    // App-wide saved text-style presets for notebook text shapes.
    // Each entry: { id, color, backgroundColor, fontSize }.
    notebookTextStyles: [],
    // "Desktop" — pinned doc or notebook fileId surfaced as a thumbnail
    // at the bottom of the files panel. Synced via `.hush/desktop.json`.
    // Null when no desktop is assigned.
    desktopFileId: null,
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
    shortcutOpenFullscreen: "CmdOrCtrl+Shift+F",
    shortcutTogglePrivate: "CmdOrCtrl+Shift+P",
    shortcutToggleSidebar: "CmdOrCtrl+\\",
    shortcutToggleOutline: "CmdOrCtrl+Shift+\\",
    shortcutTypewriter: "Mod+Shift+T",
    shortcutNewFile: "Mod+N",
    shortcutToggleDry: "Mod+Shift+R",
    shortcutToggleFocus: "Mod+Shift+Y",
    shortcutToggleWordCount: "Mod+Shift+W",
    shortcutZenFocus: "Mod+Shift+S",
    zenFocusFontSize: 30,
    wordCountVisible: false,
    shortcutFind: "Mod+F",
    shortcutFindAll: "Alt+Shift+F",

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
    shortcutSave: "Mod+S",
    shortcutFindNext: "Ctrl+R",
    shortcutFindPrev: "Ctrl+Shift+R",
    shortcutJoinLines: "Mod+J",
    shortcutJumpNextParagraph: "Mod+ArrowDown",
    shortcutJumpPrevParagraph: "Mod+ArrowUp",
    shortcutZotero: "Mod+Shift+I",

    // Shortcuts — Styles
    shortcutStyleDefault: "Mod+1",
    shortcutStyle1: "Mod+2",
    shortcutStyle2: "Mod+3",
    shortcutStyle3: "Mod+4",
    shortcutStyle4: "Mod+5",

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
    notebookGridOpacity: 0.40,
    notebookFontFamily: "Inter",
    notebookFontSize: 18,
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

    // Proofread mode (harper-core). The mode toggle itself isn't
    // persisted (each session starts off — see state-modes.js), but
    // the per-rule disable list is.
    proofreadDisabledRules: ["LongSentences"],

    // Session state
    lastFileId: null,
    lastProjectId: null,
    typewriterMode: false,
    dryMode: false,
    scrollPosition: null,
  };
}
