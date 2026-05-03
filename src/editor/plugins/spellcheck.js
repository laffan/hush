/**
 * Spellcheck — opt-in red-wavy underline for misspelled words.
 *
 * Uses `nspell` against the bundled `dictionary-en` Hunspell dictionaries.
 * The dictionary is loaded lazily on first activation so the cost is paid
 * by users who actually flip the toggle. Default is OFF; the command
 * palette's "Check Spelling" entry flips `state.spellcheckActive` and
 * triggers a redecorate.
 *
 * Markdown structure (URLs, code, image refs, comments) is skipped via a
 * regex strip so we don't underline filenames or `%%note%%` markers.
 *
 * Doc-only — notebooks intentionally aren't wired up.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder, Annotation } from "@codemirror/state";

export const spellcheckRedecorate = Annotation.define();

let _spellPromise = null;
let _spell = null;

/** Lazy-load nspell + dictionary-en. The first call kicks off the import
 *  and keeps the in-flight promise so concurrent callers share it. */
async function loadSpellChecker() {
  if (_spell) return _spell;
  if (_spellPromise) return _spellPromise;
  _spellPromise = (async () => {
    const [{ default: nspell }, dictMod] = await Promise.all([
      import("nspell"),
      import("dictionary-en"),
    ]);
    const dictFn = dictMod.default || dictMod;
    let dict;
    if (typeof dictFn === "function") {
      // Modern (Promise) and legacy (callback) call shapes both supported.
      dict = await new Promise((resolve, reject) => {
        const ret = dictFn((err, d) => err ? reject(err) : resolve(d));
        if (ret && typeof ret.then === "function") ret.then(resolve, reject);
      });
    } else {
      dict = dictFn;
    }
    _spell = nspell(dict);
    return _spell;
  })();
  return _spellPromise;
}

/** Strip markdown constructs that shouldn't be spellchecked, replacing each
 *  with spaces to preserve offsets so the editor positions still line up. */
function maskNonProseRegions(text) {
  // Order matters — code first, then images / links / inline code, then
  // hush-specific %% comments and == flag/highlight wrappers.
  const patterns = [
    /```[\s\S]*?```/g,                   // fenced code blocks
    /`[^`\n]*`/g,                        // inline code
    /!\[[^\]]*\]\([^)]*\)/g,             // image markdown
    /\[[^\]]*\]\([^)]*\)/g,              // link markdown
    /https?:\/\/\S+/g,                   // bare URLs
    /%%[\s\S]*?%%/g,                     // hush comment blocks
    /==[A-Za-z][A-Za-z0-9_-]*(?::[^=]*)?==/g, // hush flags / highlight markers
  ];
  let masked = text;
  for (const re of patterns) {
    masked = masked.replace(re, (m) => " ".repeat(m.length));
  }
  return masked;
}

/** Word boundary scan over masked text. Yields `{ word, from, to }` in
 *  source-text offsets. Matches letters + apostrophes / hyphens but
 *  rejects pure-numeric tokens. */
function* iterateWords(maskedText) {
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let m;
  while ((m = re.exec(maskedText)) !== null) {
    const word = m[0];
    if (/^\d+$/.test(word)) continue;
    yield { word, from: m.index, to: m.index + word.length };
  }
}

export function createSpellcheckPlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this._wasActive = !!stateRef.spellcheckActive;
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        const active = !!stateRef.spellcheckActive;
        const flipped = active !== this._wasActive;
        this._wasActive = active;
        const annot = update.transactions.some(
          (tr) => tr.annotation(spellcheckRedecorate),
        );
        if (flipped || annot || update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view) {
        if (!stateRef.spellcheckActive) return Decoration.none;
        if (!_spell) {
          // Fire-and-forget load. When it resolves we dispatch an empty
          // transaction with the redecorate annotation so this method
          // re-runs against the now-populated checker.
          loadSpellChecker().then((s) => {
            if (!s) return;
            try {
              view.dispatch({ annotations: spellcheckRedecorate.of(true) });
            } catch (_) { /* view destroyed mid-load */ }
          }).catch((e) => console.warn("Spellchecker failed to load:", e));
          return Decoration.none;
        }
        const builder = new RangeSetBuilder();
        const doc = view.state.doc.toString();
        const masked = maskNonProseRegions(doc);
        const ranges = [];
        for (const { word, from, to } of iterateWords(masked)) {
          if (_spell.correct(word)) continue;
          ranges.push({ from, to });
        }
        ranges.sort((a, b) => a.from - b.from);
        for (const r of ranges) {
          builder.add(r.from, r.to, Decoration.mark({ class: "hush-spellcheck-error" }));
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Command-palette action — flip the active flag and ask the editor to
 *  redecorate. Idempotent: a second call simply turns it back off.
 *
 *  Doc-only at the moment; notebooks aren't wired in. */
export function toggleSpellcheck(state) {
  if (state.currentNotebookFileId) return;
  state.spellcheckActive = !state.spellcheckActive;
  if (state.spellcheckActive) {
    // Warm the dictionary load so the first decorate pass has it ready.
    loadSpellChecker().catch(() => { /* surfaced on first decorate */ });
  }
  if (state.editor) {
    try {
      state.editor.view.dispatch({ annotations: spellcheckRedecorate.of(true) });
    } catch (_) { /* view not mounted */ }
  }
}
