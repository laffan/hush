/**
 * Inline image renderer for doc images.
 *
 * Standard markdown image syntax — `![alt](filename.png)` — is replaced by
 * an inline-block widget containing the real image. An optional caption
 * can be supplied via `![alt | caption](filename.png)` and renders below
 * the image. External URLs are left untouched so the user still sees the
 * raw markdown for them.
 *
 * Sizing is enforced with CSS — `max-width: 100%` keeps the image inside
 * the editor column, `max-height: 75vh` caps the vertical extent, and the
 * wrapper is centered so narrower images don't hug the left edge.
 *
 * Clicking the image opens the preview modal. Cmd+drag on the rendered
 * image (or on the raw syntax when the cursor is inside it) hands the
 * markdown to `pane/text-drag.js` so it can be dropped into another pane.
 */

import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder, Annotation } from "@codemirror/state";
import {
  getImageDataUrl, parseAltAndCaption, isLocalImageRef, filenameFromUrl,
  IMAGE_MD_RE, urlFromMatch,
} from "../../state/state-images.js";
import { openImagePreviewModal } from "../image-preview.js";

// Broad match — we filter to local refs inside the builder.
const IMAGE_RE = new RegExp(IMAGE_MD_RE.source, "g");
// Dispatched on files-changed to force the ViewPlugin to re-run
// buildDecorations (no doc / selection change would otherwise trigger it).
const imageTreeChanged = Annotation.define();

class ImageWidget extends WidgetType {
  constructor(alt, caption, filename, markdown) {
    super();
    this.alt = alt;
    this.caption = caption;
    this.filename = filename;
    this.markdown = markdown;
  }
  eq(other) {
    return this.alt === other.alt
      && this.caption === other.caption
      && this.filename === other.filename;
  }
  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-hush-image-wrapper";
    wrapper.dataset.hushImage = this.filename;
    wrapper.dataset.hushImageAlt = this.alt || "";
    wrapper.dataset.hushImageMarkdown = this.markdown;

    const img = document.createElement("img");
    img.className = "cm-hush-image";
    img.alt = this.alt || this.filename;
    img.loading = "lazy";
    wrapper.appendChild(img);

    if (this.caption) {
      const cap = document.createElement("span");
      cap.className = "cm-hush-image-caption";
      cap.textContent = this.caption;
      wrapper.appendChild(cap);
    }

    // Async load the data URL — toDOM must be sync.
    getImageDataUrl(this.filename).then((url) => {
      if (url) img.src = url;
      else wrapper.classList.add("cm-hush-image-missing");
    });
    return wrapper;
  }
  ignoreEvent() { return false; }
}

function buildDecorations(view, state) {
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
      const rawAlt = match[1];
      const url = urlFromMatch(match);
      if (!isLocalImageRef(state, url)) continue;
      // Leave the range as raw markdown while the cursor overlaps it so
      // the user can edit the source directly.
      const cursorInside = cursors.some(c =>
        (c.from >= from && c.from <= to) || (c.to >= from && c.to <= to) ||
        (c.from <= from && c.to >= to)
      );
      if (cursorInside) continue;
      const { alt, caption } = parseAltAndCaption(rawAlt);
      const filename = filenameFromUrl(url);
      builder.add(from, to, Decoration.replace({
        widget: new ImageWidget(alt, caption, filename, match[0]),
      }));
    }
  }
  return builder.finish();
}

function imageRefAtPos(state, doc, pos) {
  const line = doc.lineAt(pos);
  IMAGE_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_RE.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      const url = urlFromMatch(match);
      if (!isLocalImageRef(state, url)) return null;
      return {
        from, to,
        alt: match[1],
        filename: filenameFromUrl(url),
        markdown: match[0],
      };
    }
  }
  return null;
}

function findWrapperTarget(e) {
  if (!(e.target instanceof Element)) return null;
  const wrap = e.target.closest(".cm-hush-image-wrapper");
  if (!wrap) return null;
  return {
    filename: wrap.dataset.hushImage,
    alt: wrap.dataset.hushImageAlt,
    markdown: wrap.dataset.hushImageMarkdown,
    el: wrap,
  };
}

const imageEventHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    const hit = findWrapperTarget(e);
    if (hit) {
      if (e.metaKey || e.ctrlKey) return false; // let the drag handler take it
      e.preventDefault();
      openImagePreviewModal(hit.filename, hit.alt || hit.filename);
      return true;
    }
    return false;
  },
});

/**
 * Cmd+drag integration — an image widget (or raw markdown under the cursor)
 * can be dragged between panes via the existing text-drag pipeline. The
 * payload is just the markdown so the receiving editor re-decorates it.
 */
export function attachImageDrag(view, containerEl, state) {
  let unbind = null;
  (async () => {
    const { startTextDrag } = await import("../../pane/text-drag.js");
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.button !== 0) return;
      if (!(e.target instanceof Node) || !containerEl.contains(e.target)) return;
      let payload = null;
      const hit = findWrapperTarget(e);
      if (hit) {
        payload = { from: null, to: null, text: hit.markdown };
      } else {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const ref = imageRefAtPos(state, view.state.doc, pos);
        if (!ref) return;
        payload = { from: ref.from, to: ref.to, text: ref.markdown };
      }
      if (!payload) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      startTextDrag({
        text: payload.text,
        initialEvent: e,
        onDrop: (deleteSource) => {
          if (!deleteSource || payload.from == null) return;
          view.dispatch({ changes: { from: payload.from, to: payload.to, insert: "" } });
        },
      });
    };
    containerEl.addEventListener("pointerdown", handler, true);
    unbind = () => containerEl.removeEventListener("pointerdown", handler, true);
  })();
  return () => { if (unbind) unbind(); };
}

export function createImageDecoratorPlugin(state) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, state);
        // Dispatch a harmless annotation when the image tree changes —
        // the update() callback below picks it up and rebuilds the
        // decoration set, which is how previously-unresolvable refs
        // finally decorate in a pane that was open before the image was
        // dropped.
        this._refreshOnFiles = () => {
          try { view.dispatch({ annotations: imageTreeChanged.of(Date.now()) }); }
          catch (_) { /* view may be torn down */ }
        };
        state.on("files-changed", this._refreshOnFiles);
      }
      update(update) {
        const treeChanged = update.transactions.some(tr => tr.annotation(imageTreeChanged) != null);
        if (update.docChanged || update.viewportChanged || update.selectionSet || treeChanged) {
          this.decorations = buildDecorations(update.view, state);
        }
      }
      destroy() {
        if (this._refreshOnFiles) state.off("files-changed", this._refreshOnFiles);
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [plugin, imageEventHandler];
}
