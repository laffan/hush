import { resolveItemName } from "./stack-spine.js";
import { typeIcons } from "../sidebar/files-panel-shared.js";

const SPINE_WIDTH = 50;
const SPINE_HEIGHT = 40;
const DEFAULT_COLUMN_WIDTH = 800;
const DEFAULT_COLUMN_HEIGHT = 600;

let _measureCtx = null;
const PILL_FONT = "600 11px system-ui, -apple-system, sans-serif";
const PILL_FONT_SIZE = 11;
const PILL_GAP = 10;

function _trimPillText(text, maxDim, vertical) {
  if (maxDim <= 0) return "";
  if (!_measureCtx) {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  _measureCtx.font = PILL_FONT;

  if (vertical) {
    const charH = PILL_FONT_SIZE * 1.25;
    const fullH = text.length * charH;
    if (fullH <= maxDim) return text;
    const avail = maxDim - charH;
    if (avail <= 0) return "…";
    const maxChars = Math.floor(avail / charH);
    return maxChars > 0 ? text.slice(0, maxChars) + "…" : "…";
  }

  if (_measureCtx.measureText(text).width <= maxDim) return text;
  const ellW = _measureCtx.measureText("…").width;
  const avail = maxDim - ellW;
  if (avail <= 0) return "…";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (_measureCtx.measureText(text.slice(0, mid)).width <= avail) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "…";
}

export function updateScrollbarPills(stack) {
  if (stack._destroyed) return;
  stack._pillContainer.innerHTML = "";

  const isVert = stack._isVertical;
  const scrollSize = isVert ? stack._scrollArea.scrollHeight : stack._scrollArea.scrollWidth;
  const viewSize = isVert ? stack._scrollArea.clientHeight : stack._scrollArea.clientWidth;

  if (scrollSize <= viewSize || viewSize <= 0) {
    stack._pillContainer.style.display = "none";
    return;
  }
  stack._pillContainer.style.display = "";

  const CIRCLE = 30;
  const entries = [];
  let acc = 0;
  for (const item of stack._items) {
    const spineSize = isVert ? SPINE_HEIGHT : SPINE_WIDTH;
    const contentSize = item.open
      ? (isVert ? (item.height || DEFAULT_COLUMN_HEIGHT) : (item.width || DEFAULT_COLUMN_WIDTH))
      : 0;
    const colSize = spineSize + contentSize;

    if (item.spineColor) {
      const pos = (acc / scrollSize) * viewSize;
      const rawSize = (colSize / scrollSize) * viewSize;
      const isCircle = !item.open;
      const pillSize = isCircle ? CIRCLE : Math.max(20, rawSize - PILL_GAP);
      const idealStart = isCircle
        ? pos + rawSize / 2 - CIRCLE / 2
        : pos + PILL_GAP / 2;
      entries.push({ item, pillSize, idealStart, isCircle, colCenter: acc + colSize / 2 });
    }
    acc += colSize;
  }

  let minNext = 0;
  for (const e of entries) {
    e.start = Math.max(e.idealStart, minNext);
    minNext = e.start + e.pillSize + PILL_GAP;
  }

  for (const e of entries) {
    const pill = document.createElement("div");
    pill.className = "stack-scrollbar-pill";
    if (isVert) pill.classList.add("stack-scrollbar-pill-vertical");
    pill.style.backgroundColor = e.item.spineColor;

    if (e.isCircle) {
      if (isVert) {
        pill.style.top = e.start + "px";
        pill.style.height = e.pillSize + "px";
        pill.style.left = "5px";
        pill.style.right = "5px";
      } else {
        pill.style.left = e.start + "px";
        pill.style.width = e.pillSize + "px";
      }
      pill.style.borderRadius = "50%";
      pill.style.padding = "0";
      const iconEl = document.createElement("span");
      iconEl.className = "stack-scrollbar-pill-icon";
      iconEl.innerHTML = typeIcons[e.item.fileType] || typeIcons.document;
      pill.appendChild(iconEl);
    } else {
      if (isVert) {
        pill.style.top = e.start + "px";
        pill.style.height = e.pillSize + "px";
      } else {
        pill.style.left = e.start + "px";
        pill.style.width = e.pillSize + "px";
      }
      const textEl = document.createElement("span");
      textEl.className = "stack-scrollbar-pill-text";
      const title = resolveItemName(e.item);
      const textPad = isVert ? 8 : 16;
      textEl.textContent = _trimPillText(title, e.pillSize - textPad, isVert);
      pill.appendChild(textEl);
    }

    const colCenter = e.colCenter;
    pill.addEventListener("click", () => {
      if (isVert) {
        stack._scrollArea.scrollTo({ top: colCenter - viewSize / 2, behavior: "smooth" });
      } else {
        stack._scrollArea.scrollTo({ left: colCenter - viewSize / 2, behavior: "smooth" });
      }
    });

    stack._pillContainer.appendChild(pill);
  }
}
