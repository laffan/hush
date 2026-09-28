/**
 * `hush-pin://<notebookFileId>/<pinId>` — the link format for proofread
 * pins (see pins.ts). Dependency-free so the app side (link routing,
 * cmd-drag into a Doc) can read and write links without pulling the
 * canvas modules into its chunk.
 */

export const PIN_SCHEME = "hush-pin://";

export function pinUrl(fileId: string, pinId: string): string {
  return `${PIN_SCHEME}${fileId}/${pinId}`;
}

export function parsePinUrl(url: string): { fileId: string; pinId: string } | null {
  const m = /^hush-pin:\/\/([^/]+)\/([^/?#\s]+)$/.exec((url || "").trim());
  return m ? { fileId: m[1], pinId: m[2] } : null;
}

/** `[Name](hush-pin://…)` — what a copied pin pastes into a Doc as. The
 *  name is the pin's first line, brackets stripped. */
export function pinMarkdownLink(fileId: string, pin: { id: string; text: string }): string {
  const name = (pin.text.split("\n")[0] || "").replace(/[[\]]/g, "").trim() || "Pin";
  return `[${name}](${pinUrl(fileId, pin.id)})`;
}
