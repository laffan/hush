/**
 * Spellcheck side of Proofread mode.
 *
 * Uses `nspell` against the bundled `dictionary-en` Hunspell dictionaries.
 * The `aff` and `dic` files are copied out of `node_modules/dictionary-en`
 * into `src/assets/dictionaries/` by `scripts/copy-dictionaries.mjs`
 * (wired into `npm postinstall`) so we can `?url`-import them through
 * Vite without fighting the package's strict `exports` map. The
 * dictionary-en JS entry point itself is a non-starter in the webview —
 * it uses `node:fs/promises` and would silently no-op.
 *
 * The dictionary is loaded lazily on first activation; misspellings are
 * underlined with `.hush-spellcheck-error` (red wavy). Markdown structure
 * (URLs, code, image refs, %%comments%%, ==flags==) is masked out before
 * checking so filenames and editorial markers aren't flagged. Doc-only —
 * the toggle short-circuits when a notebook is open.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder, Annotation } from "@codemirror/state";

import affUrl from "../../assets/dictionaries/en.aff?url";
import dicUrl from "../../assets/dictionaries/en.dic?url";

export const spellcheckRedecorate = Annotation.define();

let _spellPromise = null;
let _spell = null;
let _spellLoadError = null;

export function isSpellLoaded() { return !!_spell; }
export function getSpellLoadError() { return _spellLoadError; }

/** Lazy-load nspell + the bundled Hunspell dictionary. The first call
 *  kicks off the import and keeps the in-flight promise so concurrent
 *  callers share it. Errors are surfaced via console.warn AND stored on
 *  `_spellLoadError` so the UI can flag a bad install. */
export async function loadSpellChecker() {
  if (_spell) return _spell;
  if (_spellPromise) return _spellPromise;
  _spellPromise = (async () => {
    try {
      const [nspellMod, affResp, dicResp] = await Promise.all([
        import("nspell"),
        fetch(affUrl),
        fetch(dicUrl),
      ]);
      const nspell = nspellMod.default || nspellMod;
      if (!affResp.ok) throw new Error(`failed to fetch aff: ${affResp.status}`);
      if (!dicResp.ok) throw new Error(`failed to fetch dic: ${dicResp.status}`);
      const [aff, dic] = await Promise.all([affResp.text(), dicResp.text()]);
      _spell = nspell(aff, dic);
      return _spell;
    } catch (e) {
      _spellLoadError = e;
      console.warn("Hush spellcheck: dictionary load failed", e);
      throw e;
    }
  })();
  return _spellPromise;
}

/** Strip markdown constructs that shouldn't be spellchecked, replacing
 *  each match with same-length spaces so the resulting text shares
 *  offsets with the original buffer (the editor's word ranges line up
 *  with `view.state.doc` 1:1). */
function maskNonProseRegions(text) {
  const patterns = [
    /```[\s\S]*?```/g,
    /`[^`\n]*`/g,
    /!\[[^\]]*\]\([^)]*\)/g,
    /\[[^\]]*\]\([^)]*\)/g,
    /https?:\/\/\S+/g,
    /%%[\s\S]*?%%/g,
    /==[A-Za-z][A-Za-z0-9_-]*(?::[^=]*)?==/g,
  ];
  let masked = text;
  for (const re of patterns) {
    masked = masked.replace(re, (m) => " ".repeat(m.length));
  }
  return masked;
}

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
        this._wasActive = !!stateRef.proofreadMode;
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        const active = !!stateRef.proofreadMode;
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
        if (!stateRef.proofreadMode) return Decoration.none;
        if (!_spell) {
          // Fire-and-forget load. When it resolves we dispatch an empty
          // transaction with the redecorate annotation so this method
          // re-runs against the now-populated checker.
          loadSpellChecker().then((s) => {
            if (!s) return;
            try {
              view.dispatch({ annotations: spellcheckRedecorate.of(true) });
            } catch (_) { /* view destroyed mid-load */ }
          }).catch(() => { /* already logged inside loadSpellChecker */ });
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
