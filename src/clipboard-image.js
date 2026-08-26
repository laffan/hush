/**
 * Reading an image off the clipboard.
 *
 * Three sources, in this order, because the reliable one is the least
 * standard:
 *
 *   1. `@tauri-apps/plugin-clipboard-manager`'s `readImage()`. This is
 *      the one that actually works on macOS. WKWebView answers
 *      `navigator.clipboard.read()` with the system "Paste from …"
 *      prompt, per read — so an image paste depended on the user
 *      noticing and confirming a prompt they never asked for, which is
 *      why a paste into a Doc looked like it did nothing and a paste
 *      onto a canvas took several tries before it landed. The plugin
 *      talks to NSPasteboard directly and never raises it (the same
 *      reason the notebook already reads clipboard *text* through it).
 *      Desktop only — the plugin doesn't implement it on iOS/Android.
 *   2. `navigator.clipboard.read()` — the browser build, iPad, and any
 *      desktop where the plugin call fails.
 *   3. Nothing: the caller falls back to whatever the paste event's own
 *      `clipboardData` carried (text, usually).
 *
 * **On iOS the order is (2) alone.** The plugin has no `readImage`
 * there, so trying it first bought nothing and cost a dynamic module
 * load plus an IPC round trip — long enough to spend the paste
 * gesture's transient activation, which is precisely what step 2 needs.
 * An image paste on iPad landed only every few tries because of it.
 *
 * Everything comes back as a PNG data URL, which is what both consumers
 * want: `state.createImageFromDataUrl` writes it to the Images folder,
 * and `DrawingState.addImageShape` embeds it in the notebook envelope.
 *
 * Zero app imports — a leaf, so the lazily-loaded notebook bundle can
 * share it with the editor without dragging app state across the
 * boundary.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null;

/** iOS / iPadOS, including an iPad reporting itself as a Mac. Local copy
 *  of `settings-ui.js`'s `isIOS` — this module is a leaf on purpose (see
 *  the header) and importing app modules would drag state across the
 *  lazily-loaded notebook boundary. */
function isIOS() {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

/** Raw RGBA + dimensions → a PNG data URL, via a scratch canvas.
 *  `readImage()` hands back unpacked pixels (that is the shape Tauri's
 *  `Image` resource carries), so the encode has to happen here. */
function rgbaToPngDataUrl(rgba, width, height) {
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const bytes = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  if (bytes.length < width * height * 4) return null;
  ctx.putImageData(new ImageData(bytes, width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

async function readViaTauriPlugin() {
  if (!IS_TAURI) return null;
  try {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    const image = await readImage();
    if (!image) return null;
    const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
    return rgbaToPngDataUrl(rgba, size?.width, size?.height);
  } catch (_) {
    // No image on the clipboard, or the platform doesn't implement it.
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Failed to read clipboard image"));
    r.readAsDataURL(blob);
  });
}

async function readViaClipboardApi() {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types || []) {
        if (typeof type === "string" && type.startsWith("image/")) {
          return await blobToDataUrl(await item.getType(type));
        }
      }
    }
  } catch (_) { /* denied, unsupported, or nothing to read */ }
  return null;
}

/**
 * The clipboard's image as a data URL, or null if it holds none.
 *
 * **Call this before any other `await` in a paste handler.** The browser
 * fallback needs the paste gesture's transient activation, and awaiting
 * a clipboard *text* read first is long enough to lose it — that alone
 * made the canvas paste intermittent. Start this promise first and await
 * it after whatever else the handler needs.
 */
export async function readClipboardImageDataUrl() {
  // iOS/iPadOS goes straight to the browser API. The plugin has no
  // `readImage` there, so asking it costs a dynamic module load and an
  // IPC round trip to be told so — and spends the paste gesture's
  // transient activation on the way, which is the one thing the browser
  // fallback cannot do without. That is why an image paste on iPad took
  // several tries in a notebook and never landed in a Doc: by the time
  // `navigator.clipboard.read()` ran, the gesture it needed was gone.
  // Calling it first, in the caller's own task, is the whole fix.
  if (isIOS()) return await readViaClipboardApi();
  return (await readViaTauriPlugin()) || (await readViaClipboardApi());
}

/** Image files carried by a paste / drop event's own DataTransfer. The
 *  standard path, and the only synchronous one — when it yields
 *  anything, no clipboard read is needed at all. */
export function imageFilesFromDataTransfer(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === "file" && (it.type || "").startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length === 0 && dt.files) {
    for (const f of dt.files) {
      if (f && (f.type || "").startsWith("image/")) out.push(f);
    }
  }
  return out;
}

/** A data URL as a `File`, so the data-URL and DataTransfer paths can
 *  hand the same shape to an image-insert routine. */
export function dataUrlToFile(dataUrl, name) {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const mime = header.slice(5).split(";")[0] || "image/png";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = (mime.split("/")[1] || "png").split("+")[0];
  return new File([bytes], name || `pasted-${Date.now()}.${ext}`, { type: mime });
}
