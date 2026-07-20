/**
 * TEMPORARY on-screen debug logger (round 2) for the "annotation text in
 * the citation popup" issue. Panel with Copy/Clear/Hide, plus document
 * capture listeners that report, for every pointerdown/mousedown/click,
 * the target element AND its `title` attribute + text, walking a few
 * ancestors — so a native-tooltip source (or whatever renders the
 * annotation text) is visible. `dumpMenu()` logs a mounted popup's text.
 *
 * Remove this module + its call sites once resolved.
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
  Object.assign(b.style, { font: "12px monospace", padding: "4px 10px", background: "#2ecc71", color: "#000", border: "none", borderRadius: "4px" });
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
  return b;
}
function ensurePanel() {
  if (_panel) return;
  _panel = document.createElement("div");
  Object.assign(_panel.style, {
    position: "fixed", left: "0", right: "0", bottom: "0", height: "42vh",
    background: "rgba(0,0,0,0.88)", color: "#7CFC00", font: "12px/1.45 monospace",
    zIndex: "2147483647", display: "flex", flexDirection: "column", borderTop: "2px solid #2ecc71", boxSizing: "border-box",
  });
  const bar = document.createElement("div");
  Object.assign(bar.style, { display: "flex", gap: "8px", padding: "6px 8px", background: "rgba(0,0,0,0.7)", alignItems: "center", flexShrink: "0" });
  const title = document.createElement("span");
  title.textContent = "🐛 Link Debug"; Object.assign(title.style, { color: "#fff", flex: "1", fontWeight: "bold" });
  const copyBtn = mkBtn("Copy", (btn) => {
    const text = _lines.join("\n");
    let ok = false;
    try {
      const ta = document.createElement("textarea"); ta.value = text;
      Object.assign(ta.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0" });
      _panel.appendChild(ta); ta.focus(); ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy"); ta.remove();
    } catch { ok = false; }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => { btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy", 1500); }).catch(() => { btn.textContent = ok ? "Copied!" : "Fail"; setTimeout(() => btn.textContent = "Copy", 1500); });
    else { btn.textContent = ok ? "Copied!" : "Fail"; setTimeout(() => btn.textContent = "Copy", 1500); }
  });
  const clearBtn = mkBtn("Clear", () => { _lines = []; if (_logEl) _logEl.textContent = ""; });
  const hideBtn = mkBtn("Hide", () => { _panel.style.display = "none"; });
  bar.append(title, copyBtn, clearBtn, hideBtn);
  _logEl = document.createElement("div");
  Object.assign(_logEl.style, { flex: "1", overflow: "auto", padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-all", userSelect: "text" });
  _panel.append(bar, _logEl);
  (document.body || document.documentElement).appendChild(_panel);
}
export function dlog(...args) {
  ensurePanel();
  _lines.push(`${tstamp()}  ${args.map(safeStr).join(" ")}`);
  if (_lines.length > 500) _lines.shift();
  if (_logEl) { _logEl.textContent = _lines.join("\n"); _logEl.scrollTop = _logEl.scrollHeight; }
}

/** Dump a just-mounted popup's rendered text + button count. */
export function dumpMenu(label, el) {
  if (!el) { dlog(label, "el=null"); return; }
  const btns = el.querySelectorAll("button").length;
  const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
  dlog(label, "buttons:", btns, "text:", `"${txt}"`);
}

let _inited = false;
export function initLinkDebug() {
  if (_inited) return;
  _inited = true;
  ensurePanel();
  dlog("initLinkDebug — UA:", navigator.userAgent || "?");

  const describe = (el) => {
    const tag = el?.tagName || "?";
    let cls = "";
    try { cls = (typeof el?.className === "string" ? el.className : el?.getAttribute?.("class")) || ""; } catch { cls = "?"; }
    const ttl = el?.getAttribute?.("title");
    const dtt = el?.getAttribute?.("data-tooltip");
    return `${tag}.${String(cls).slice(0, 40)}${ttl ? ` title="${ttl.slice(0, 60)}"` : ""}${dtt ? ` dtt="${dtt.slice(0, 40)}"` : ""}`;
  };
  const report = (type, e) => {
    const raw = e.target;
    let el = raw && raw.nodeType === 3 ? raw.parentElement : raw;
    // Walk up a few levels, reporting any title/tooltip found.
    const chain = [];
    let n = el, hops = 0;
    while (n && hops < 4) { chain.push(describe(n)); n = n.parentElement; hops++; }
    dlog(`${type} cite:${!!el?.closest?.(".cm-citation-rendered")} link:${!!el?.closest?.(".cm-link-rendered")} meta:${!!e.metaKey} cmdHeld:${!!window.__hushCmdHeld}`);
    dlog("   chain:", chain.join("  ‹  "));
  };
  document.addEventListener("pointerdown", (e) => report("pointerdown", e), true);
  document.addEventListener("mousedown", (e) => report("mousedown", e), true);
  document.addEventListener("click", (e) => report("click", e), true);
  dlog("listeners attached — Clear, then Cmd+click the citation");
}
