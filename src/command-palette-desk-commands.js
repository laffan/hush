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
    { id: "desk-ratchet", section: "Desks", icon: icons.ratchet, shortcutKey: null, ctx: "shared",
      label: getDeskRatchet(state) ? "Stop Desk ratchet mode" : "Start Desk ratchet mode",
      action: (s) => toggleDeskRatchet(s) },
    { id: "desk-switch", section: "Desks", label: "Switch Desks", icon: icons.desk, shortcutKey: "shortcutSwitchDesks", ctx: "shared",
      hiddenIf: (s) => !multiDesk(s),
      keepOpen: true,
      action: (s, p) => enterDeskPicker(p, s) },
    // Forks Internal / Local before anything else — a local desk is
    // named by the folder it lands in, so the two branches ask for
    // different things. See sidebar/new-desk-flow.js.
    { id: "desk-new", section: "Desks", label: "New desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { startNewDeskFlow } = await import("./sidebar/new-desk-flow.js");
        await startNewDeskFlow(s);
      } },
    { id: "desk-send", section: "Desks", label: "Send this file to another desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !multiDesk(s) || !currentFileTreeNodeId(s),
      action: async (s) => {
        const id = currentFileTreeNodeId(s);
        if (!id) return;
        const m = await import("./sidebar/send-to-desk-modal.js");
        m.openSendToDeskModal(s, id, "send");
      } },
    { id: "desk-copy", section: "Desks", label: "Copy this file to another desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !multiDesk(s) || !currentFileTreeNodeId(s),
      action: async (s) => {
        const id = currentFileTreeNodeId(s);
        if (!id) return;
        const m = await import("./sidebar/send-to-desk-modal.js");
        m.openSendToDeskModal(s, id, "copy");
      } },
    // Two-column planner: pick material out of every *other* desk, drop
    // it into the active desk's tree, then copy the whole batch at once.
    { id: "desk-copy-files", section: "Desks", label: "Copy Files from other Desks", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !multiDesk(s),
      action: async (s) => {
        const m = await import("./sidebar/copy-from-desks-modal.js");
        m.openCopyFromDesksModal(s);
      } },
    // Local desks (desktop only until the iPad bookmark path lands):
    // move the active desk's folder out of app data / back in, reveal
    // it, or adopt a desk folder another install produced.
    { id: "desk-make-local", section: "Desks", label: "Make Desk Local…", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => (!desktop && !ipad) || !s.getActiveDesk?.() || !!s.deskRoots?.[s.getActiveDesk()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk();
        if (desk) await (await import("./sync/desk-roots.js")).makeDeskLocal(s, desk.id);
      } },
    { id: "desk-make-internal", section: "Desks", label: "Make Desk Internal", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => (!desktop && !ipad) || !s.deskRoots?.[s.getActiveDesk?.()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk();
        if (desk) await (await import("./sync/desk-roots.js")).makeDeskInternal(s, desk.id);
      } },
    // A local desk is named by its folder, so renaming one renames the
    // folder. Desktop only: renaming a folder writes to its parent
    // directory, which iOS's security scope over the folder itself does
    // not cover — Move Local Folder is the iPad's answer.
    { id: "desk-rename-local", section: "Desks", label: "Rename Desk and Folder…", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keywords: "rename local desk folder typo name",
      hiddenIf: (s) => !desktop || !s.deskRoots?.[s.getActiveDesk?.()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk?.();
        if (!desk) return;
        const { showPromptModal } = await import("./sidebar/files-panel-shared.js");
        showPromptModal({
          title: "Rename desk and its folder",
          note: "This desk lives in a folder on disk; the folder is renamed to match.",
          label: "Name",
          initialValue: desk.name || "",
          confirmLabel: "Rename",
          onConfirm: async (name) => {
            try { await s.renameDesk(desk.id, name); }
            catch (e) { window.alert(String(e?.message || e)); }
          },
        });
      } },
    // Saving the folder in the wrong place used to be unfixable from
    // inside Hush; this is the way out. The files are censused before
    // and after, and a move that loses one is rolled back.
    { id: "desk-move-folder", section: "Desks", label: "Move Local Folder…", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keywords: "move local desk folder relocate elsewhere location",
      hiddenIf: (s) => (!desktop && !ipad) || !s.deskRoots?.[s.getActiveDesk?.()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk?.();
        if (desk) await (await import("./sync/desk-relocate.js")).moveLocalDeskFolder(s, desk.id);
      } },
    { id: "desk-reveal-folder", section: "Desks", label: "Reveal Desk Folder", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !desktop || !s.deskRoots?.[s.getActiveDesk?.()?.id],
      action: async (s) => {
        const desk = s.getActiveDesk();
        if (desk) await (await import("./sync/desk-roots.js")).revealDeskRoot(s, desk.id);
      } },
    // Any folder, not just one that already holds a desk: a plain
    // directory is initialised in place and its files absorbed, and a
    // folder another device already keeps a desk in is *joined* — same
    // desk, same identity, files and history intact. Named for that
    // second job as well as the first, since it's the one people go
    // looking for; `keywords` keeps the old wording finding it.
    { id: "desk-adopt", section: "Desks", label: "Use Local Folder as Desk…", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keywords: "open folder as desk adopt existing icloud dropbox syncthing sync between devices local",
      hiddenIf: () => !desktop && !ipad,
      action: async (s) => (await import("./sync/desk-roots.js")).adoptDeskFolder(s) },
    { id: "desk-convert-folder", section: "Desks", label: "Convert folder to desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: async (s, p) => (await import("./state/state-desks-ops.js")).enterConvertFolderPicker(p, s, { typeIcons, fallbackIcon: icons.desk }) },
    { id: "desk-collapse", section: "Desks", label: "Collapse desk into folder", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => !multiDesk(s),
      action: async (s, p) => (await import("./state/state-desks-ops.js")).enterCollapseDeskPicker(p, s, { fallbackIcon: icons.desk }) },
    // Archiving replaces deleting a desk, so there has to be somewhere to
    // find what was archived — and to build a new desk back out of it.
    { id: "desk-archives", section: "Desks", label: "View archived desks", icon: icons.desk, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const m = await import("./sidebar/desk-archive.js");
        await m.openArchivedDesksModal(s);
      } },
  ];
}
