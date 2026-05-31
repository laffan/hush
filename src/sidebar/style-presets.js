/**
 * Bundled style presets — read at build time from
 * `src/assets/style-presets/*.json` via `import.meta.glob` and seeded
 * into the user's style list on first run. After seeding each preset
 * is just a regular style: the user can edit, duplicate, delete, or
 * rename it, and Hush won't re-add it.
 *
 * Dropping a new JSON file into the presets folder makes it appear in
 * everyone's library on the next launch — even on installs that have
 * already been started — because seeding tracks each preset by its
 * filename in `settings.seededPresetFiles`.
 */

const presetModules = import.meta.glob("../assets/style-presets/*.json", { eager: true });

/** Resolve every bundled preset as `{ filename, data }` pairs. */
function loadPresets() {
  return Object.entries(presetModules).map(([path, mod]) => {
    const data = mod && mod.default ? mod.default : mod;
    const filename = (path.split("/").pop() || "").replace(/\.json$/i, "");
    return { filename, data };
  });
}

/** Seed every preset that hasn't been added yet. Called once during
 *  app startup, right after settings load. Idempotent — already-seeded
 *  presets are skipped via `settings.seededPresetFiles`. */
export async function seedStylePresets(state) {
  if (!state || !state.settings) return;
  const presets = loadPresets();
  if (presets.length === 0) return;

  const seeded = new Set(state.settings.seededPresetFiles || []);
  const existingNames = new Set((state.settings.styles || []).map((s) => s.name));
  const added = [];
  const newlySeeded = [];

  for (const { filename, data } of presets) {
    if (seeded.has(filename)) continue;
    if (!data || typeof data !== "object") continue;
    // Auto-suffix if a user already happens to own a style by the same
    // name (mirrors the Import styles… collision handling).
    let nm = data.name || filename;
    const base = nm;
    let i = 2;
    while (existingNames.has(nm)) nm = `${base} (${i++})`;
    existingNames.add(nm);
    added.push({
      ...data,
      id: "preset_" + filename + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
      name: nm,
    });
    newlySeeded.push(filename);
  }

  if (added.length === 0) return;
  const styles = [...(state.settings.styles || []), ...added];
  const seededPresetFiles = [...(state.settings.seededPresetFiles || []), ...newlySeeded];
  await state.updateSettings({ styles, seededPresetFiles });
}
