/**
 * Folding a library's changes into the files a full download wrote —
 * the "Update Data" half of Settings → Zotero (zotero-download.js).
 * Pure: the changed and deleted items come in as the Web API sends them
 * (`?since=<version>` and `/deleted?since=<version>`), and new arrays
 * and objects go out; nothing is fetched or saved here.
 */
import { isReferenceItem, toAttachment, toReference } from "./api.js";

/**
 * The references file with `changedTop` (top-level items changed since
 * the last download), `changedAtts` (attachments changed since) and
 * `deletedKeys` applied. An existing reference keeps its place and its
 * attachments; a new one is added at the end. Returns
 * `{ references, added, updated, removed }`.
 */
export function mergeReferences(refs, changedTop, changedAtts, deletedKeys) {
  const deleted = new Set(deletedKeys || []);
  const byKey = new Map();
  let removed = 0;
  for (const r of refs || []) {
    if (deleted.has(r.key)) { removed++; continue; }
    byKey.set(r.key, r);
  }
  let added = 0, updated = 0;
  for (const item of changedTop || []) {
    if (!isReferenceItem(item) || deleted.has(item.key)) continue;
    const prev = byKey.get(item.key);
    if (prev) updated++; else added++;
    byKey.set(item.key, toReference(item, prev?.attachments || []));
  }
  // An attachment is taken off every reference before it is filed under
  // its parent again: it may have been edited, moved, or deleted.
  const dropAtt = new Set(deleted);
  for (const att of changedAtts || []) dropAtt.add(att.key);
  if (dropAtt.size) {
    for (const [key, r] of byKey) {
      if (r.attachments?.some((a) => dropAtt.has(a.key))) {
        byKey.set(key, { ...r, attachments: r.attachments.filter((a) => !dropAtt.has(a.key)) });
      }
    }
  }
  for (const att of changedAtts || []) {
    if (deleted.has(att.key) || !att.data) continue;
    const parent = byKey.get(att.data.parentItem);
    if (!parent) continue;
    byKey.set(parent.key, { ...parent, attachments: [...(parent.attachments || []), toAttachment(att)] });
  }
  return { references: [...byKey.values()], added, updated, removed };
}

/**
 * The highlights file (`{ attKey: [raw annotation items] }`) with the
 * annotations changed since the last download put in place, and every
 * deleted annotation — or deleted attachment's list — taken out.
 * Returns `{ byAttachment, count, added, updated, removed }`.
 */
export function mergeHighlights(byAttachment, changed, deletedKeys) {
  const deleted = new Set(deletedKeys || []);
  const changedByKey = new Map((changed || []).map((a) => [a.key, a]));
  const next = {};
  let removed = 0, updated = 0, added = 0;
  for (const [attKey, list] of Object.entries(byAttachment || {})) {
    if (deleted.has(attKey)) { removed += Array.isArray(list) ? list.length : 0; continue; }
    const kept = [];
    for (const a of Array.isArray(list) ? list : []) {
      if (deleted.has(a?.key)) { removed++; continue; }
      const fresh = changedByKey.get(a?.key);
      if (fresh && fresh.data?.parentItem === attKey) {
        kept.push(fresh);
        changedByKey.delete(a.key);
        updated++;
      } else if (!fresh) {
        kept.push(a);
      }
    }
    if (kept.length) next[attKey] = kept;
  }
  for (const a of changedByKey.values()) {
    const parent = a?.data?.parentItem;
    if (!parent || deleted.has(a.key) || deleted.has(parent)) continue;
    (next[parent] ||= []).push(a);
    added++;
  }
  let count = 0;
  for (const list of Object.values(next)) count += list.length;
  return { byAttachment: next, count, added, updated, removed };
}
