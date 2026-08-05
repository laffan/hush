/**
 * Desk-scoped command palette entries — split out of
 * `command-palette-commands.js` to keep that file under the 700-line cap.
 *
 * `buildDeskCommands(ctx)` returns the same command descriptors
 * `buildCommands` builds inline for everything else; the caller spreads
 * them into its list in place. `ctx` carries the pieces the entries need
 * from the parent scope: the shared icon set, the platform flags, the
 * desk picker, and the "which node is open right now" resolver.
 */

import { getDeskRatchet } from "./state/state-desks.js";
import { toggleDeskRatchet } from "./state/state-modes.js";

export function buildDeskCommands({ state, icons, typeIcons, desktop, ipad, enterDeskPicker, currentFileTreeNodeId }) {
  const multiDesk = (s) => (s.settings?.desks || []).length >= 2;
  return [
    // Desk Ratchet — the timed Ratchet session's rules with no clock,
    // applied to every Doc in the desk and remembered between sessions.
    // One row whose label reads the current state rather than a pair of
    // start / stop entries, and `shared` context so it can be turned
    // off from a notebook (which the mode never touched anyway).
    { id: "desk-ratchet", icon: icons.ratchet, shortcutKey: null, ctx: "shared",
      label: getDeskRatchet(state) ? "Stop Desk ratchet mode" : "Start Desk ratchet mode",
      action: (s) => toggleDeskRatchet(s) },
    { id: "desk-switch", label: "Switch Desks", icon: icons.desk, shortcutKey: "shortcutSwitchDesks", ctx: "shared",
      hiddenIf: (s) => !multiDesk(s),
      keepOpen: true,
      action: (s, p) => enterDeskPicker(p, s) },
    // Forks Internal / Local before anything else — a local desk is
    // named by the folder it lands in, so the two branches ask for
    // different things. See sidebar/new-desk-flow.js.
    { id: "desk-new", label: "New desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { startNewDeskFlow } = await import("./sidebar/new-desk-flow.js");
        await startNewDeskFlow(s);
      } },
    { id: "desk-send", label: "Send this file to another desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !multiDesk(s) || !currentFileTreeNodeId(s),
      action: async (s) => {
        const id = currentFileTreeNodeId(s);
        if (!id) return;
        const m = await import("./sidebar/send-to-desk-modal.js");
        m.openSendToDeskModal(s, id, "send");
      } },
    { id: "desk-copy", label: "Copy this file to another desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !multiDesk(s) || !currentFileTreeNodeId(s),
      action: async (s) => {
        const id = currentFileTreeNodeId(s);
        if (!id) return;
        const m = await import("./sidebar/send-to-desk-modal.js");
        m.openSendToDeskModal(s, id, "copy");
      } },
    // Two-column planner: pick material out of every *other* desk, drop
    // it into the active desk's tree, then copy the whole batch at once.
    { id: "desk-copy-files", label: "Copy Files from other Desks", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !multiDesk(s),
      action: async (s) => {
        const m = await import("./sidebar/copy-from-desks-modal.js");
        m.openCopyFromDesksModal(s);
      } },
    // Local desks (desktop only until the iPad bookmark path lands):
    // move the active desk's folder out of app data / back in, reveal
    // it, or adopt a desk folder another install produced.
    { id: "desk-make-local", label: "Make Desk Local…", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => (!desktop && !ipad) || !s.getActiveDesk?.() || !!s.deskRoots?.[s.getActiveDesk()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk();
        if (desk) await (await import("./sync/desk-roots.js")).makeDeskLocal(s, desk.id);
      } },
    { id: "desk-make-internal", label: "Make Desk Internal", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => (!desktop && !ipad) || !s.deskRoots?.[s.getActiveDesk?.()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk();
        if (desk) await (await import("./sync/desk-roots.js")).makeDeskInternal(s, desk.id);
      } },
    { id: "desk-reveal-folder", label: "Reveal Desk Folder", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !desktop || !s.deskRoots?.[s.getActiveDesk?.()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk();
        if (desk) await (await import("./sync/desk-roots.js")).revealDeskRoot(s, desk.id);
      } },
    // Any folder, not just one that already holds a desk — a plain
    // directory is initialised in place and its files absorbed.
    { id: "desk-adopt", label: "Open Folder as Desk…", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: () => !desktop && !ipad,
      action: async (s) => (await import("./sync/desk-roots.js")).adoptDeskFolder(s) },
    { id: "desk-convert-folder", label: "Convert folder to desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: async (s, p) => (await import("./state/state-desks-ops.js")).enterConvertFolderPicker(p, s, { typeIcons, fallbackIcon: icons.desk }) },
    { id: "desk-collapse", label: "Collapse desk into folder", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => !multiDesk(s),
      action: async (s, p) => (await import("./state/state-desks-ops.js")).enterCollapseDeskPicker(p, s, { fallbackIcon: icons.desk }) },
    // Archiving replaces deleting a desk, so there has to be somewhere to
    // find what was archived — and to build a new desk back out of it.
    { id: "desk-archives", label: "View archived desks", icon: icons.desk, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const m = await import("./sidebar/desk-archive.js");
        await m.openArchivedDesksModal(s);
      } },
  ];
}
