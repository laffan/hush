/**
 * Project sync serialization — pack/unpack .hushproject zip files.
 *
 * .hushproject is a ZIP archive — a superset of a Markdown doc that bundles
 * every file a project pairs together so the project travels (and exports)
 * as one self-contained envelope, exactly like .hushnote does for notebooks.
 *
 *   data.json               — the project envelope (metadata + ordered child
 *                             manifest, each child pointing at a path in the zip)
 *   docs/<i>.md             — each child document's Markdown body
 *   notebooks/<i>.hushnote  — each child notebook, itself a nested .hushnote zip
 *                             (so notebook images ride along untouched)
 *   stacks/<i>.hushstack    — each child stack's JSON envelope
 *
 * The envelope:
 *   {
 *     format: "hushproject", version: 1,
 *     name, showNumbers?, flagged?, bgColor?,
 *     children: [
 *       { type: "document", name, path: "docs/0.md", useAsNote? },
 *       { type: "notebook", name, path: "notebooks/0.hushnote", gutter? },
 *       { type: "stack",    name, path: "stacks/0.hushstack" },
 *     ]
 *   }
 *
 * `gutter: true` on a notebook child marks it as the project's gutter — the
 * notebook that pairs to the joined doc buffer. At most one child carries it.
 *
 * Both pack and unpack speak a single normalized in-memory shape so the
 * caller never has to know about the zip layout:
 *   { name, showNumbers, flagged, bgColor, children: [
 *       { type, name, content, useAsNote?, gutter? } ] }
 * where `content` is the Markdown string (documents), the internal notebook
 * JSON string (notebooks — the same string the canvas reads), or the stack
 * JSON string (stacks).
 */

import JSZip from "jszip";
import { packNotebook, unpackNotebook } from "../sync/notebook-sync.js";

/** Sanitize a child name into a stable, collision-free filename stem.
 *  Names can repeat across children, so we always suffix with the index. */
function stemFor(name, i) {
  const base = (name || "Untitled").replace(/[^\w.\- ]+/g, "_").trim() || "Untitled";
  return `${i}-${base}`;
}

/**
 * Pack a normalized project descriptor into a .hushproject zip (Uint8Array).
 *
 * @param {{ name?: string, showNumbers?: boolean, flagged?: boolean,
 *           bgColor?: string,
 *           children?: Array<{ type: string, name?: string, content?: string,
 *                              useAsNote?: boolean, gutter?: boolean }> }} project
 * @returns {Promise<Uint8Array>}
 */
export async function packProject(project) {
  const zip = new JSZip();
  const children = Array.isArray(project?.children) ? project.children : [];
  const manifest = [];

  let docN = 0, nbN = 0, stN = 0;
  for (const child of children) {
    if (!child || !child.type) continue;
    const name = child.name || "Untitled";
    if (child.type === "document") {
      const path = `docs/${stemFor(name, docN++)}.md`;
      zip.file(path, child.content || "");
      const entry = { type: "document", name, path };
      if (child.useAsNote) entry.useAsNote = true;
      manifest.push(entry);
    } else if (child.type === "notebook") {
      const path = `notebooks/${stemFor(name, nbN++)}.hushnote`;
      // Nest the notebook as its own .hushnote zip so its images ride along.
      const bytes = await packNotebook(child.content || "");
      zip.file(path, bytes);
      const entry = { type: "notebook", name, path };
      if (child.gutter) entry.gutter = true;
      manifest.push(entry);
    } else if (child.type === "stack") {
      const path = `stacks/${stemFor(name, stN++)}.hushstack`;
      zip.file(path, child.content || "");
      manifest.push({ type: "stack", name, path });
    }
    // Nested folders/projects are intentionally out of scope for v1 — the
    // caller flattens or omits them before packing.
  }

  const envelope = {
    format: "hushproject",
    version: 1,
    name: project?.name || "Untitled Project",
    ...(project?.showNumbers ? { showNumbers: true } : {}),
    ...(project?.flagged ? { flagged: true } : {}),
    ...(project?.bgColor ? { bgColor: project.bgColor } : {}),
    children: manifest,
  };
  zip.file("data.json", JSON.stringify(envelope, null, 2));
  return await zip.generateAsync({ type: "uint8array" });
}

/**
 * Unpack a .hushproject zip into the normalized project descriptor.
 * Notebook children come back as the internal JSON string the canvas reads
 * (via unpackNotebook), documents/stacks as their stored text.
 *
 * @param {ArrayBuffer|Uint8Array} zipData
 * @returns {Promise<{ name: string, showNumbers: boolean, flagged: boolean,
 *                     bgColor: string|null,
 *                     children: Array<{ type: string, name: string,
 *                       content: string, useAsNote?: boolean,
 *                       gutter?: boolean }> }>}
 */
export async function unpackProject(zipData) {
  const empty = { name: "Untitled Project", showNumbers: false, flagged: false, bgColor: null, children: [] };
  const zip = await JSZip.loadAsync(zipData);
  const dataFile = zip.file("data.json");
  if (!dataFile) return empty;

  let envelope;
  try { envelope = JSON.parse(await dataFile.async("string")); }
  catch { return empty; }
  if (!envelope || typeof envelope !== "object") return empty;

  const manifest = Array.isArray(envelope.children) ? envelope.children : [];
  const children = [];
  for (const entry of manifest) {
    if (!entry || !entry.type || !entry.path) continue;
    const file = zip.file(entry.path);
    if (!file) continue;
    const name = entry.name || "Untitled";
    if (entry.type === "document") {
      children.push({
        type: "document", name,
        content: await file.async("string"),
        ...(entry.useAsNote ? { useAsNote: true } : {}),
      });
    } else if (entry.type === "notebook") {
      const bytes = await file.async("uint8array");
      children.push({
        type: "notebook", name,
        content: await unpackNotebook(bytes),
        ...(entry.gutter ? { gutter: true } : {}),
      });
    } else if (entry.type === "stack") {
      children.push({ type: "stack", name, content: await file.async("string") });
    }
  }

  return {
    name: envelope.name || "Untitled Project",
    showNumbers: !!envelope.showNumbers,
    flagged: !!envelope.flagged,
    bgColor: envelope.bgColor || null,
    children,
  };
}
