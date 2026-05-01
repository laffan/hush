/**
 * Default `AppState.settings` shape. Mirrors the Rust `AppSettings` struct
 * (camelCase via serde). Used as the initial value for new sessions and as
 * the merge base when loading from Tauri / localStorage.
 */
export function createDefaultSettings() {
  return {
    visibility: "menubar",
    appearance: "dark",
    lightTheme: "ayuLight",
    darkTheme: "dracula",
    fontSize: 20,
    lineHeight: 1.6,
    fontFamily: "Source Sans Pro",
    normalizeHeaders: false,
    normalizeHeaderColor: false,
    underlineHeaders: false,
    headerScale: 1.0,
    defaultLightColors: {},
    defaultDarkColors: {},
    makeSpaceForPanes: true,
    makeSpaceDirection: "right",
    stickyHeaders: false,
    blockCursor: false,
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
    // "Desk" — pinned doc or notebook fileId surfaced as a thumbnail at
    // the bottom of the files panel. Synced via `.hush/desk.json`. Null
    // when no desk is assigned.
    deskFileId: null,
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
    notebookGridOpacity: 0.15,
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

    // Session state
    lastFileId: null,
    lastProjectId: null,
    typewriterMode: false,
    dryMode: false,
    scrollPosition: null,
  };
}
