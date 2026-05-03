/**
 * Proofread settings tab — checkbox-per-rule for the harper-core grammar
 * checker. Settings round-trip through `proofreadDisabledRules` (a list
 * of harper rule names that are explicitly OFF). The Rust
 * `list_grammar_rules` command returns the curated rule list at render
 * time so this tab automatically picks up rules added in a future
 * harper upgrade without a code change here.
 */
import { escAttr } from "./settings-tabs.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let _cachedRules = null;

async function fetchRules() {
  if (_cachedRules) return _cachedRules;
  if (!IS_TAURI) {
    // Browser dev — stub list so the tab still renders something.
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

export function renderProofreadTab(settings) {
  const disabled = new Set(settings.proofreadDisabledRules || []);
  const rules = _cachedRules || [];
  const rulesHtml = rules.length
    ? rules.map((rule) => `
        <div class="proofread-rule-row">
          <input type="checkbox" id="proofread-rule-${escAttr(rule)}"
                 data-rule="${escAttr(rule)}"
                 ${disabled.has(rule) ? "" : "checked"} />
          <label for="proofread-rule-${escAttr(rule)}">${rule}</label>
        </div>
      `).join("")
    : `<p class="settings-help">Loading rules…</p>`;

  return `
    <div class="settings-section">
      <h2>Proofread mode</h2>
      <p class="settings-help">
        Proofread mode is a single doc-only toggle accessed from the
        command palette. While it's on, misspellings underline in red and
        grammar issues from <code>harper-core</code> underline in green.
        Hover a green underline for a tooltip with the rule's message and
        replacement suggestions.
      </p>
    </div>
    <div class="settings-section">
      <h2>Grammar rules</h2>
      <p class="settings-help">
        Toggle individual harper rules. Unchecked rules are skipped on
        every grammar pass. <code>LongSentences</code> defaults to off
        because it tends to be noisy for longform writing.
      </p>
      <div class="proofread-rules-list">
        ${rulesHtml}
      </div>
    </div>
  `;
}

/** Bind the rule-row checkboxes. The settings-window.js caller passes
 *  a `saveSetting(key, value)` helper plus the live `settings` object;
 *  we mutate `settings.proofreadDisabledRules` and persist it. The first
 *  call also kicks off the rule-list fetch and re-renders when it
 *  arrives, so the tab populates without blocking the initial open. */
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
