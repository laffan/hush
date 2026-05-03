/**
 * Proofread settings tab — checkbox-per-rule for the harper-core grammar
 * checker. Settings round-trip through `proofreadDisabledRules` (a list
 * of harper rule names that are explicitly OFF). The Rust
 * `list_grammar_rules` command returns the curated rule list at render
 * time so this tab automatically picks up rules added in a future
 * harper upgrade without a code change here.
 */
import { escAttr, escHtml } from "./settings-tabs.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let _cachedRules = null;

async function fetchRules() {
  if (_cachedRules) return _cachedRules;
  if (!IS_TAURI) {
    _cachedRules = [
      "SpellCheck", "LongSentences", "RepeatedWords",
      "SentenceCapitalization", "OxfordComma",
    ];
    return _cachedRules;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _cachedRules = await invoke("list_grammar_rules");
  } catch (e) {
    console.warn("list_grammar_rules failed:", e);
    _cachedRules = [];
  }
  return _cachedRules;
}

/** Split a CamelCase identifier into space-separated words. Handles
 *  consecutive capitals (`AnA` → "An A", `WhomSubjectOfVerb` →
 *  "Whom Subject Of Verb") and acronyms-followed-by-words. */
function humanizeRuleName(name) {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

/** Per-rule descriptions for the curated set in `commands/grammar.rs`.
 *  Kept short (one sentence) — the rule name itself + checkbox is the
 *  primary signal, the description is the "what does this catch?"
 *  hint underneath. Anything not in this map falls back to the
 *  humanized rule name so a future harper bump doesn't crash the UI. */
const RULE_DESCRIPTIONS = {
  SpellCheck: "Underline words harper doesn't recognize.",
  LongSentences: "Flag sentences longer than ~40 words.",
  RepeatedWords: "Catch accidentally duplicated words like “the the”.",
  SentenceCapitalization: "Flag sentences that don't start with a capital letter.",
  OxfordComma: "Suggest adding the comma before the final “and” / “or” in a list.",
  NoOxfordComma: "Suggest removing the comma before the final “and” / “or” in a list.",
  ThatWhich: "Distinguish restrictive “that” from non-restrictive “which”.",
  ThenThan: "Catch “then” (sequence) vs “than” (comparison) mixups.",
  ToTwoToo: "Catch confusion between “to”, “two”, and “too”.",
  TheyreConfusions: "Catch confusion between “they're”, “their”, and “there”.",
  ItsContraction: "Flag “its” used where “it's” (it is) is meant.",
  ItsPossessive: "Flag “it's” used where “its” (possessive) is meant.",
  BoringWords: "Flag overused, generic words like “good”, “nice”, “thing”.",
  FillerWords: "Flag fillers like “just”, “really”, “very” that weaken prose.",
  Hedging: "Flag hedging language like “I think”, “sort of”, “kind of”.",
  MoreBetter: "Catch double comparatives like “more better”.",
  LessWorse: "Catch redundant comparisons like “less worse”.",
  VeryUnique: "Flag absolutes paired with intensifiers (e.g. “very unique”).",
  AnA: "Catch incorrect “a” / “an” before vowel sounds.",
  WhomSubjectOfVerb: "Catch “whom” used where “who” (subject) is correct.",
  CompoundNouns: "Suggest spelling compound nouns as one word, two words, or hyphenated.",
  PronounContraction: "Catch missing or incorrect pronoun contractions.",
  PossessiveYour: "Flag “your” used where “you're” (you are) is meant.",
  WereWhere: "Catch confusion between “were” (verb) and “where” (location).",
  Spaces: "Flag inconsistent or extra whitespace.",
  Dashes: "Suggest the right dash variant (hyphen / en / em) for context.",
  EllipsisLength: "Flag ellipses with more or fewer than three dots.",
  QuoteSpacing: "Flag missing or extra whitespace around quotation marks.",
  UnclosedQuotes: "Flag opening quotes without a matching closing quote.",
  CommaFixes: "Suggest comma additions or removals based on common patterns.",
};

function descriptionFor(rule) {
  return RULE_DESCRIPTIONS[rule] || humanizeRuleName(rule);
}

export function renderProofreadTab(settings) {
  const disabled = new Set(settings.proofreadDisabledRules || []);
  const rules = _cachedRules || [];
  const rulesHtml = rules.length
    ? rules.map((rule) => `
        <div class="proofread-rule-row">
          <input type="checkbox" id="proofread-rule-${escAttr(rule)}"
                 data-rule="${escAttr(rule)}"
                 ${disabled.has(rule) ? "" : "checked"} />
          <label for="proofread-rule-${escAttr(rule)}">${escHtml(humanizeRuleName(rule))}</label>
          <div class="proofread-rule-description">${escHtml(descriptionFor(rule))}</div>
        </div>
      `).join("")
    : `<p class="settings-help">Loading rules…</p>`;

  return `
    <div class="settings-section">
      <h2>Proofread mode</h2>
      <p class="settings-help">
        Proofread mode is a single doc-only toggle accessed from the
        command palette. While it's on, harper-core underlines spelling
        and grammar issues. Hover an underline for a tooltip with the
        rule's message and replacement suggestions.
      </p>
    </div>
    <div class="settings-section">
      <h2>Grammar rules</h2>
      <p class="settings-help">
        Toggle individual harper rules. Unchecked rules are skipped on
        every grammar pass. <em>Long Sentences</em> defaults to off
        because it tends to be noisy for longform writing.
      </p>
      <div class="proofread-rules-list">
        ${rulesHtml}
      </div>
    </div>
  `;
}

export async function bindProofreadTab(saveSetting, settings, rerender) {
  if (!_cachedRules) {
    await fetchRules();
    rerender();
    return;
  }
  document.querySelectorAll('.proofread-rule-row input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const rule = cb.dataset.rule;
      const list = new Set(settings.proofreadDisabledRules || []);
      if (cb.checked) list.delete(rule);
      else list.add(rule);
      const next = Array.from(list).sort();
      settings.proofreadDisabledRules = next;
      saveSetting("proofreadDisabledRules", next);
    });
  });
}
