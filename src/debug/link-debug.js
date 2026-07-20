/**
 * TEMPORARY on-screen debug logger for the Zotero-link-menu iPad issue.
 *
 * Mounts a fixed panel at the bottom of the screen with a scrolling log,
 * a Copy button (clipboard API + execCommand fallback for WKWebView),
 * and Clear / Hide. Call `dlog(...)` from anywhere to append a line.
 *
 * `initLinkDebug()` also attaches document-level capture listeners that
 * report every pointerdown / mousedown / click that lands on a rendered
 * link element, plus the modifier state at that moment — so we can see
 * exactly which events fire on iPad and what the ⌘ state is.
 *
 * Remove this module (and its call sites) once the issue is resolved.
 */

let _panel = null;
let _logEl = null;
let _lines = [];

function tstamp() {
  const d = new Date();
  return `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function safeStr(o) {
  if (typeof o === "string") return o;
  try { return JSON.stringify(o); } catch { return String(o); }
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b.style, {
    font: "12px monospace", padding: "4px 10px", background: "#2ecc71",
    color: "#000", border: "none", borderRadius: "4px", cursor: "pointer",
  });
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
  return b;
}

function ensurePanel() {
  if (_panel) return;
  _panel = document.createElement("div");
  _panel.id = "link-debug-panel";
  Object.assign(_panel.style, {
    position: "fixed", left: "0", right: "0", bottom: "0", height: "42vh",
    background: "rgba(0,0,0,0.88)", color: "#7CFC00",
    font: "12px/1.45 monospace", zIndex: "2147483647",
    display: "flex", flexDirection: "column", borderTop: "2px solid #2ecc71",
    boxSizing: "border-box",
  });

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    display: "flex", gap: "8px", padding: "6px 8px",
    background: "rgba(0,0,0,0.7)", alignItems: "center", flexShrink: "0",
  });
  const title = document.createElement("span");
  title.textContent = "🐛 Link Debug";
  Object.assign(title.style, { color: "#fff", flex: "1", fontWeight: "bold" });

  const copyBtn = mkBtn("Copy", (btn) => {
    const text = _lines.join("\n");
    const done = (label) => { btn.textContent = label; setTimeout(() => (btn.textContent = "Copy"), 1500); };
    // Selection + execCommand first — most reliable inside a WKWebView.
    let ok = false;
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      Object.assign(ta.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0" });
      _panel.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => done("Copied!")).catch(() => done(ok ? "Copied!" : "Copy failed"));
    } else {
      done(ok ? "Copied!" : "Copy failed");
    }
  });
  const clearBtn = mkBtn("Clear", () => { _lines = []; if (_logEl) _logEl.textContent = ""; });
  const hideBtn = mkBtn("Hide", () => { _panel.style.display = "none"; });

  bar.append(title, copyBtn, clearBtn, hideBtn);

  _logEl = document.createElement("div");
  Object.assign(_logEl.style, {
    flex: "1", overflow: "auto", padding: "6px 8px",
    whiteSpace: "pre-wrap", wordBreak: "break-all", webkitUserSelect: "text", userSelect: "text",
  });

  _panel.append(bar, _logEl);
  (document.body || document.documentElement).appendChild(_panel);
}

export function dlog(...args) {
  ensurePanel();
  const msg = args.map(safeStr).join(" ");
  _lines.push(`${tstamp()}  ${msg}`);
  if (_lines.length > 500) _lines.shift();
  if (_logEl) {
    _logEl.textContent = _lines.join("\n");
    _logEl.scrollTop = _logEl.scrollHeight;
  }
}

let _inited = false;

export function initLinkDebug() {
  if (_inited) return;
  _inited = true;
  ensurePanel();
  dlog("initLinkDebug — UA:", navigator.userAgent || "?");
  dlog("platform:", navigator.platform || "?", "maxTouchPoints:", navigator.maxTouchPoints);

  const report = (type, e) => {
    const link = e.target?.closest?.(".cm-link-rendered");
    if (!link) return;
    dlog(`GLOBAL ${type}`, "meta:", !!e.metaKey, "ctrl:", !!e.ctrlKey,
      "cmdHeld:", !!window.__hushCmdHeld, "url:", link.dataset.linkUrl || "?");
  };
  document.addEventListener("pointerdown", (e) => report("pointerdown", e), true);
  document.addEventListener("mousedown", (e) => report("mousedown", e), true);
  document.addEventListener("click", (e) => report("click", e), true);
  dlog("global capture listeners attached");
}
