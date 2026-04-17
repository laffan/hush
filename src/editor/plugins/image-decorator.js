/**
 * Image reference decorator for internal doc images.
 *
 * Markdown like `![label](hush-image:xxx.png)` is rendered as an inline
 * image chip:
 *   - Hover shows the image in a tooltip.
 *   - Click opens a full-screen preview modal.
 *   - Cmd+drag grabs the markdown text so it can be dropped into another
 *     pane (or notebook), just like any other selected text.
 *
 * The chip is replaced with the raw markdown while the cursor is inside
 * the range so the reference stays editable.
 */

import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { attachImageHoverTooltip, openImagePreviewModal, hideImageTooltip } from "../image-preview.js";

// `![alt](hush-image:<fileId>)` — fileId is uuid.ext with safe chars.
const IMAGE_RE = /!\[([^\]]*)\]\(hush-image:([A-Za-z0-9._-]+)\)/g;

class ImageChipWidget extends WidgetType {
  constructor(alt, fileId, markdown) {
    super();
    this.alt = alt;
    this.fileId = fileId;
    this.markdown = markdown;
  }
  eq(other) {
    return this.alt === other.alt && this.fileId === other.fileId;
  }
  toDOM() {
    const chip = document.createElement("span");
    chip.className = "cm-hush-image-chip";
    chip.dataset.hushImage = this.fileId;
    chip.dataset.hushImageAlt = this.alt;
    chip.dataset.hushImageMarkdown = this.markdown;
    chip.innerHTML = `
      <span class="cm-hush-image-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="7" r="1.2" fill="currentColor"/><polyline points="3,12 6.5,8.5 9,11 11,9 13,12" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
      </span>
      <span class="cm-hush-image-label"></span>
    `;
    chip.querySelector(".cm-hush-image-label").textContent = this.alt || "image";
    attachImageHoverTooltip(chip, this.fileId, this.alt);
    return chip;
  }
  ignoreEvent() { return false; }
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map(r => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    IMAGE_RE.lastIndex = 0;
    let match;
    while ((match = IMAGE_RE.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      // Leave the range untouched while a cursor / selection overlaps it
      // so the user can edit the source markdown.
      const cursorInside = cursors.some(c =>
        (c.from >= from && c.from <= to) || (c.to >= from && c.to <= to) ||
        (c.from <= from && c.to >= to)
      );
      if (cursorInside) continue;
      builder.add(from, to, Decoration.replace({
        widget: new ImageChipWidget(match[1], match[2], match[0]),
      }));
    }
  }
  return builder.finish();
}

/** Find the image ref at a document position, if any. */
function imageRefAtPos(doc, pos) {
  const line = doc.lineAt(pos);
  IMAGE_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_RE.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      return { from, to, alt: match[1], fileId: match[2], markdown: match[0] };
    }
  }
  return null;
}

function findChipTarget(e) {
  if (!(e.target instanceof Element)) return null;
  const chip = e.target.closest(".cm-hush-image-chip");
  if (!chip) return null;
  return {
    fileId: chip.dataset.hushImage,
    alt: chip.dataset.hushImageAlt,
    markdown: chip.dataset.hushImageMarkdown,
    el: chip,
  };
}

const imageEventHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    const chip = findChipTarget(e);
    if (chip) {
      if (e.metaKey || e.ctrlKey) {
        // Let text-drag.js pick this up via its own capture-phase handler.
        return false;
      }
      e.preventDefault();
      hideImageTooltip();
      openImagePreviewModal(chip.fileId, chip.alt);
      return true;
    }
    // Raw markdown click (cursor currently on the ref line): Cmd+click opens preview.
    if ((e.metaKey || e.ctrlKey)) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null) {
        const ref = imageRefAtPos(view.state.doc, pos);
        if (ref) {
          e.preventDefault();
          openImagePreviewModal(ref.fileId, ref.alt);
          return true;
        }
      }
    }
    return false;
  },
  mouseleave() { hideImageTooltip(); return false; },
});

/**
 * Cmd+drag integration — when a user Cmd+drags an image chip (or the raw
 * markdown under the cursor), start a text drag with the image markdown as
 * the payload. The default text-drag handler only kicks in if the user has
 * an active selection, so we special-case images here.
 */
export function attachImageDrag(view, containerEl) {
  let unbind = null;
  (async () => {
    const { startTextDrag } = await import("../../pane/text-drag.js");
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.button !== 0) return;
      if (!(e.target instanceof Node) || !containerEl.contains(e.target)) return;
      let payload = null;
      const chip = findChipTarget(e);
      if (chip) {
        payload = { from: null, to: null, text: chip.markdown, el: chip.el };
      } else {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const ref = imageRefAtPos(view.state.doc, pos);
        if (!ref) return;
        payload = { from: ref.from, to: ref.to, text: ref.markdown, el: null };
      }
      if (!payload) return;
      // Only hijack the event if the click lands on an image. Preserve
      // normal selection-based drag for text.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideImageTooltip();
      startTextDrag({
        text: payload.text,
        initialEvent: e,
        onDrop: (deleteSource) => {
          if (!deleteSource) return;
          if (payload.from != null && payload.to != null) {
            view.dispatch({ changes: { from: payload.from, to: payload.to, insert: "" } });
          }
        },
      });
    };
    containerEl.addEventListener("pointerdown", handler, true);
    unbind = () => containerEl.removeEventListener("pointerdown", handler, true);
  })();
  return () => { if (unbind) unbind(); };
}

export function createImageDecoratorPlugin() {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [plugin, imageEventHandler];
}
