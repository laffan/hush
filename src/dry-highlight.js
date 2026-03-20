/**
 * D.R.Y. (Don't Repeat Yourself) — CodeMirror 6 ViewPlugin that highlights
 * repeated words/phrases within a configurable range (paragraph, two paragraphs,
 * or full document). Ported from obsidian-dry.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export const DEFAULT_STOPWORDS = [
  // Articles
  "a", "an", "the",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "from", "by", "about", "as",
  "into", "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "against", "among", "upon", "without", "within",
  // Conjunctions
  "and", "or", "but", "nor", "yet", "so", "if", "because", "while", "although",
  "though", "unless", "until", "when", "where", "whether",
  // Pronouns
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "hers", "ours",
  "theirs", "this", "that", "these", "those", "who", "whom", "whose", "which",
  "what", "whoever", "whatever", "whichever",
  // Common verbs
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "should", "could", "may", "might",
  "must", "can", "shall",
  // Other common words
  "not", "no", "yes", "all", "any", "some", "more", "most", "much", "many",
  "such", "very", "too", "also", "just", "only", "even", "still", "again",
  "here", "there", "now", "then", "than", "how", "why", "well", "up", "down",
  "out", "off", "own", "same", "other", "another", "each", "every", "both",
  "few", "several", "either", "neither",
];

// ===== Stemming =====
function stemWord(word) {
  if (word.length <= 3) return word;
  const suffixes = [
    { suffix: "ies", replacement: "y", minLength: 4 },
    { suffix: "ied", replacement: "y", minLength: 4 },
    { suffix: "ying", replacement: "y", minLength: 5 },
    { suffix: "sses", replacement: "ss", minLength: 5 },
    { suffix: "xes", replacement: "x", minLength: 4 },
    { suffix: "zes", replacement: "ze", minLength: 4 },
    { suffix: "ches", replacement: "ch", minLength: 5 },
    { suffix: "shes", replacement: "sh", minLength: 5 },
    { suffix: "ing", replacement: "", minLength: 4 },
    { suffix: "ed", replacement: "", minLength: 3 },
    { suffix: "es", replacement: "", minLength: 3 },
    { suffix: "s", replacement: "", minLength: 2 },
    { suffix: "ment", replacement: "", minLength: 5 },
    { suffix: "ness", replacement: "", minLength: 5 },
    { suffix: "tion", replacement: "", minLength: 5 },
    { suffix: "ation", replacement: "", minLength: 6 },
    { suffix: "er", replacement: "", minLength: 3 },
    { suffix: "est", replacement: "", minLength: 4 },
    { suffix: "ly", replacement: "", minLength: 4 },
  ];
  for (const { suffix, replacement, minLength } of suffixes) {
    if (word.endsWith(suffix) && word.length >= minLength + suffix.length) {
      const stem = word.slice(0, -suffix.length) + replacement;
      if (stem.length >= 2) return stem;
    }
  }
  return word;
}

// ===== Proper noun detection =====
function isProperNoun(word, position, text) {
  if (word[0] !== word[0].toUpperCase()) return false;
  if (position === 0) return false;
  let i = position - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return false;
  const prevChar = text[i];
  if (prevChar === "." || prevChar === "!" || prevChar === "?") return false;
  if (prevChar === "\n") return false;
  return true;
}

// ===== Paragraph extraction =====
function getCurrentParagraph(doc, cursorPos) {
  let start = cursorPos;
  let end = cursorPos;
  while (start > 0 && doc[start - 1] !== "\n") start--;
  if (start > 0 && doc[start - 1] === "\n") {
    while (start > 0 && doc[start - 1] === "\n") start--;
    if (start < doc.length) start++;
  }
  while (end < doc.length && doc[end] !== "\n") end++;
  while (end < doc.length && doc[end] === "\n") end++;
  return { text: doc.substring(start, end), offset: start };
}

function getCurrentAndPreviousParagraph(doc, cursorPos) {
  const current = getCurrentParagraph(doc, cursorPos);
  if (current.offset === 0) return current;
  let prevStart = current.offset - 1;
  while (prevStart > 0 && doc[prevStart] === "\n") prevStart--;
  const previous = getCurrentParagraph(doc, prevStart);
  return {
    text: doc.substring(previous.offset, current.offset + current.text.length),
    offset: previous.offset,
  };
}

// ===== Token extraction =====
function extractAllTokens(text, offset, stopwords, ignoreProperNouns) {
  const tokens = [];
  const wordPattern = /\b[\w'-]+\b/g;
  let match;
  while ((match = wordPattern.exec(text)) !== null) {
    const word = match[0];
    const wordLower = word.toLowerCase();
    if (/^\d+$/.test(word)) continue;
    if (ignoreProperNouns && isProperNoun(word, match.index, text)) continue;
    tokens.push({
      word: wordLower,
      stem: stemWord(wordLower),
      from: offset + match.index,
      to: offset + match.index + word.length,
      isStopword: stopwords.includes(wordLower),
    });
  }
  return tokens;
}

// ===== Find repeated phrases =====
function findRepeatedPhrases(tokens, includeBaseWords) {
  if (tokens.length === 0) return [];
  const getKey = (t) => (includeBaseWords ? t.stem : t.word);
  const tokenOccurrences = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].isStopword) {
      const key = getKey(tokens[i]);
      if (!tokenOccurrences.has(key)) tokenOccurrences.set(key, []);
      tokenOccurrences.get(key).push(i);
    }
  }
  const coveredByPhrase = new Set();
  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].isStopword || coveredByPhrase.has(i)) continue;
    const key = getKey(tokens[i]);
    const occurrences = tokenOccurrences.get(key);
    if (!occurrences || occurrences.length < 2) continue;
    let bestPhraseLength = 1;
    let bestPhraseMatches = occurrences.filter((idx) => idx !== i);
    for (let phraseLen = 2; phraseLen <= tokens.length - i; phraseLen++) {
      const phraseKeys = [];
      for (let j = 0; j < phraseLen; j++) phraseKeys.push(getKey(tokens[i + j]));
      const phraseMatches = [];
      for (const startIdx of occurrences) {
        if (startIdx === i || startIdx + phraseLen > tokens.length) continue;
        let matches = true;
        for (let j = 0; j < phraseLen; j++) {
          if (getKey(tokens[startIdx + j]) !== phraseKeys[j]) { matches = false; break; }
        }
        if (matches) phraseMatches.push(startIdx);
      }
      if (phraseMatches.length > 0) {
        bestPhraseLength = phraseLen;
        bestPhraseMatches = phraseMatches;
      } else break;
    }
    const allOccurrences = [i, ...bestPhraseMatches];
    for (const startIdx of allOccurrences) {
      for (let j = 0; j < bestPhraseLength; j++) coveredByPhrase.add(startIdx + j);
      const startToken = tokens[startIdx];
      const endToken = tokens[startIdx + bestPhraseLength - 1];
      const phraseWords = [];
      const phraseStems = [];
      for (let j = 0; j < bestPhraseLength; j++) {
        phraseWords.push(tokens[startIdx + j].word);
        phraseStems.push(tokens[startIdx + j].stem);
      }
      results.push({
        word: phraseWords.join("|"),
        stem: phraseStems.join("|"),
        from: startToken.from,
        to: endToken.to,
      });
    }
  }
  return results;
}

// ===== Main entry: find repeated words in a given range =====
function findRepeatedWords(doc, cursorPos, settings) {
  let textToAnalyze, startOffset;
  if (settings.dryRange === "paragraph") {
    const p = getCurrentParagraph(doc, cursorPos);
    textToAnalyze = p.text;
    startOffset = p.offset;
  } else if (settings.dryRange === "two-paragraphs") {
    const p = getCurrentAndPreviousParagraph(doc, cursorPos);
    textToAnalyze = p.text;
    startOffset = p.offset;
  } else {
    textToAnalyze = doc;
    startOffset = 0;
  }
  const stopwords = settings.dryStopwords || DEFAULT_STOPWORDS;
  const tokens = extractAllTokens(
    textToAnalyze, startOffset, stopwords, settings.dryIgnoreProperNouns
  );
  return findRepeatedPhrases(tokens, settings.dryIncludeBaseWords);
}

// ===== CM6 ViewPlugin =====
export function createDryHighlightPlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view) {
        if (!stateRef.dryMode) return Decoration.none;
        const doc = view.state.doc.toString();
        const cursorPos = view.state.selection.main.head;
        const repeats = findRepeatedWords(doc, cursorPos, stateRef.settings);

        // Group by word key
        const wordGroups = new Map();
        for (const pos of repeats) {
          const key = stateRef.settings.dryIncludeBaseWords
            ? pos.stem : pos.word.toLowerCase();
          if (!wordGroups.has(key)) wordGroups.set(key, []);
          wordGroups.get(key).push(pos);
        }

        // Collect decorations
        const decorationsToAdd = [];
        let colorIndex = 0;
        for (const [, positions] of wordGroups) {
          if (positions.length > 1) {
            const className = `dry-repeat-${(colorIndex % 10) + 1}`;
            for (const pos of positions) {
              decorationsToAdd.push({
                from: pos.from,
                to: pos.to,
                decoration: Decoration.mark({ class: className }),
              });
            }
            colorIndex++;
          }
        }
        decorationsToAdd.sort((a, b) => a.from - b.from);

        const builder = new RangeSetBuilder();
        for (const dec of decorationsToAdd) {
          builder.add(dec.from, dec.to, dec.decoration);
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
