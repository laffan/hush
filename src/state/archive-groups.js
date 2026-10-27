/**
 * Archive tidying — each desk's Archive keeps what was touched in the
 * last month at its top level, files older items into month folders
 * ("09 - September"), and items older than a year into year folders
 * ("2025").
 *
 * An *item* is a top-level entry of the Archive — a document, notebook,
 * stack, folder or project — and it moves whole: nothing inside one is
 * ever rearranged. Its age is the one the Archive's rows already show:
 * a file's last edit, a container's newest file (an item with no known
 * edit time stays where it is). The group folders are ordinary folders
 * on disk, marked `archiveGroup` on the tree node ("month" / "year") so
 * only folders this module made are reshuffled, or removed once empty;
 * a folder the user made — even one called "2025" — is an item.
 *
 * Month folders carry no year: inside the last twelve months a month
 * name is unambiguous, because the current month's own items are still
 * under a month old and sit at the top level. Runs in the primary window
 * only (main.js), at boot, after an Archive action and every few hours —
 * a window holding an older tree must not move files on its say-so.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthFolderName(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")} - ${MONTHS[d.getMonth()]}`;
}

/** Where an item last edited at `secs` belongs, as of `now`:
 *  `{ kind: "top" }`, `{ kind: "month", name }` or `{ kind: "year", name }`. */
export function archivePlacement(secs, now = new Date()) {
  const edited = new Date(secs * 1000);
  const monthAgo = new Date(now);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  if (edited >= monthAgo) return { kind: "top" };
  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  if (edited >= yearAgo) return { kind: "month", name: monthFolderName(edited) };
  return { kind: "year", name: String(edited.getFullYear()) };
}

/** Newest edit time (epoch seconds) under a node, or null if none is known. */
function newestEdit(node, mtimes) {
  if (node.fileId) {
    const m = mtimes.get(node.fileId);
    return typeof m === "number" && m > 0 ? m : null;
  }
  let newest = null;
  for (const c of node.children || []) {
    const m = newestEdit(c, mtimes);
    if (m !== null && (newest === null || m > newest)) newest = m;
  }
  return newest;
}

function uniqueName(siblings, name, type) {
  const taken = new Set(siblings.filter((c) => c.type === type).map((c) => c.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}

/** Tidy one Archive node in place. Returns true when anything moved. */
export function tidyArchiveNode(archive, mtimes, now = new Date()) {
  const kids = archive.children || (archive.children = []);
  const groups = kids.filter((c) => c.type === "folder" && c.archiveGroup);
  const entries = [];
  for (const c of kids) {
    if (c.type === "folder" && c.archiveGroup) {
      for (const g of c.children || []) entries.push({ node: g, from: c });
    } else entries.push({ node: c, from: null });
  }
  let changed = false;
  const groupFor = (kind, name) => {
    let g = groups.find((x) => x.archiveGroup === kind && x.name === name);
    if (!g) {
      g = {
        id: crypto.randomUUID(), type: "folder", children: [], flagged: false,
        archiveGroup: kind, name: uniqueName(kids, name, "folder"),
        createdAt: Math.floor(Date.now() / 1000),
      };
      groups.push(g);
      kids.push(g);
    }
    return g;
  };
  for (const { node, from } of entries) {
    const secs = newestEdit(node, mtimes);
    if (secs === null) continue;
    const want = archivePlacement(secs, now);
    const target = want.kind === "top" ? null : groupFor(want.kind, want.name);
    if (target === from) continue;
    const src = from ? from.children : kids;
    src.splice(src.indexOf(node), 1);
    const dst = target ? target.children : kids;
    // Same-named siblings would share a path on disk.
    node.name = uniqueName(dst, node.name, node.type);
    dst.push(node);
    changed = true;
  }
  // Empty groups go; the rest follow the loose items, newest first:
  // months by how recent, then years descending.
  const order = (g) => {
    if (g.archiveGroup === "year") return Number(g.name.slice(0, 4)) * 100;
    const month = Number(g.name.slice(0, 2)) - 1;
    // The current month's folder holds items from a year ago (this
    // month's own are still at the top), so it is the oldest month.
    const back = (now.getMonth() - month + 12) % 12 || 12;
    return 1e7 - back;
  };
  const live = groups.filter((g) => (g.children || []).length > 0);
  if (live.length !== groups.length) changed = true;
  const loose = kids.filter((c) => !(c.type === "folder" && c.archiveGroup));
  const sorted = [...loose, ...live.sort((a, b) => order(b) - order(a))];
  if (sorted.length !== kids.length || sorted.some((c, i) => c !== kids[i])) {
    archive.children = sorted;
    changed = true;
  }
  return changed;
}

/** Tidy every desk's Archive and save the tree when anything moved. */
export async function tidyArchives(state) {
  const mtimes = new Map((state.files || []).map((f) => [f.id, f.modified]));
  let changed = false;
  for (const desk of state.fileTree || []) {
    if (desk?.type !== "desk") continue;
    const archive = (desk.children || []).find((c) => c.id === `__archive__:${desk.id}`);
    if (archive && tidyArchiveNode(archive, mtimes)) changed = true;
  }
  if (!changed) return false;
  await state.saveFileTree();
  state.emit("files-changed");
  return true;
}
