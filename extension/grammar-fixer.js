// Grammar Fixer v0.1
// Standalone, conservative English text correction for rendered web prose.
// No DOM dependencies. Exposes PlaceholderProtector and GrammarFixer.

const PlaceholderProtector = {
    getDefaultPatterns() {
        return [
            { regex: /```[\s\S]*?```/g,           prefix: 'CODEBLOCK' },
            { regex: /^>.*$/gm,                   prefix: 'BLOCK'     },
            { regex: /`[^`]*`/g,                  prefix: 'CODE'      },
            { regex: /"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, prefix: 'QUOTE' },
            { regex: /\[([^\]]+)\]\([^\)]+\)/g, prefix: 'LINK'      },
            { regex: /https?:\/\/[^\s]+/g,        prefix: 'URL'       },
            { regex: /(?<![\w/])\/?[ru]\/[A-Za-z0-9_-]+/g, prefix: 'HANDLE' },
            { regex: /\bwww\.[^\s]+/g,            prefix: 'URL'       },
            { regex: /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, prefix: 'PATH' },
            { regex: /\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b/g, prefix: 'EMAIL' },
            { regex: /\b(?:[\w-]+\.)+[A-Za-z]{2,}\b/g, prefix: 'HOST' },
            { regex: /\b(?:e\.g|i\.e)\./gi,       prefix: 'ABBREV'    },
            { regex: /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, prefix: 'MATH' },
        ];
    },

    replaceProtected(text, patterns = this.getDefaultPatterns()) {
        const map = new Map();
        let counter = 0;
        let result = text;
        for (const { regex, prefix } of patterns) {
            // Some regexes are global and stateful. replace() normally handles this,
            // but explicitly reset to keep repeated calls deterministic.
            regex.lastIndex = 0;
            result = result.replace(regex, match => {
                const id = `<<<${prefix}_${counter++}>>>`;
                map.set(id, match);
                return id;
            });
        }
        return { text: result, map };
    },

    restore(text, map) {
        let result = text;
        for (const [id, original] of map) {
            // A replacement function preserves literal dollar signs. Passing the
            // string directly would interpret `$$` as replacement syntax.
            result = result.replace(
                new RegExp(escapeRegex(id), 'g'),
                () => original
            );
        }
        return result;
    }
};

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An invisible seam can split a familiar contraction into two regex words.
// Join it only when the joined ASCII letters name a repair we already make;
// an arbitrary zero-width boundary may be intentional and stays untouched.
const invisibleSeam = /[\u200B-\u200D\u2060\uFEFF]/g;
const seamedWord = /[A-Za-z]+(?:[\u200B-\u200D\u2060\uFEFF]+[A-Za-z]+)+/g;
function joinKnownContractions(text, dictionary) {
    seamedWord.lastIndex = 0;
    return text.replace(seamedWord, word => {
        const joined = word.replace(invisibleSeam, '');
        return dictionary[joined.toLowerCase()] ? joined : word;
    });
}

const GrammarFixer = {
    // Global mode deliberately contains grammar repairs only. Slang expansion is
    // omitted because changing meaning on arbitrary sites is worse than leaving
    // informal prose alone.
    dictionary: {
        "arent":     { fix: "aren't" },
        "couldnt":   { fix: "couldn't" },
        "didnt":     { fix: "didn't" },
        "doesnt":    { fix: "doesn't" },
        "dont":      { fix: "don't" },
        "hadnt":     { fix: "hadn't" },
        "hasnt":     { fix: "hasn't" },
        "havent":    { fix: "haven't" },
        "hes":       { fix: "he's" },
        "isnt":      { fix: "isn't" },
        "ive":       { fix: "I've" },
        "shes":      { fix: "she's" },
        "shouldnt":  { fix: "shouldn't" },
        "thats":     { fix: "that's" },
        "theyre":    { fix: "they're" },
        "wasnt":     { fix: "wasn't" },
        "werent":    { fix: "weren't" },
        "whats":     { fix: "what's" },
        "wouldnt":   { fix: "wouldn't" },
        "youre":     { fix: "you're" },
        "youve":     { fix: "you've" },
    },

    // Short, high-frequency English stopwords. Avoid words shared heavily with
    // Norwegian/German where possible.
    tier1Stopwords: new Set([
        "the", "and", "you", "your", "are", "was", "were", "have", "has",
        "they", "them", "their", "this", "that", "with", "from", "not",
        "but", "what", "when", "where", "would", "could", "should", "been",
        "will", "there", "then", "than", "because",
        // Casual English. A 56-word Reddit comment scored 4 hits on the list
        // above and was skipped whole . None of these is a common
        // Norwegian or German word.
        "a", "of", "to", "it", "is", "my", "just", "like", "about", "really",
        "some", "any", "do", "does", "did", "get", "got", "can", "how", "why",
        "who", "its", "me", "our", "if", "or", "so", "on", "at", "lot"
    ]),

    langDetectMinWords: 6,
    langDetectThreshold: 0.08,

    abbreviations: new Set([
        'vs', 'etc', 'vol', 'al', 'mr', 'mrs', 'ms', 'dr', 'prof', 'capt',
        'gen', 'sen', 'rep', 'st', 'ave', 'blvd', 'jan', 'feb', 'mar', 'apr',
        'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
        // Units and timestamps ("21 hr. ago"), and company/name suffixes.
        'hr', 'hrs', 'min', 'mins', 'sec', 'secs', 'wk', 'wks', 'mo', 'mos',
        'yr', 'yrs', 'approx', 'est', 'dept', 'inc', 'ltd', 'jr', 'sr'
    ]),

    dictRegex: null,
    // `^\s*`: rendered text arrives indented ("\n      as a girl…"), and
    // a bare `^` never reached the first word of any Reddit comment.
    sentenceStartRegex: /(^\s*|[.!?]\s+)([a-z])/g,

    // `im` is a common German preposition. Without a page-level language
    // decision, repair it only beside a small set of strongly English cues.
    contextualImRegex: /\bim\b(?=\s+(?:actually|already|also|back|certain|currently|done|fine|glad|going|happy|here|just|not|okay|only|probably|quite|ready|really|sorry|still|sure|there|trying|very)\b)/gi,

    // With a whole English paragraph in view, `im` is I'm. German `im` is
    // followed by its noun, capitalised, directly or after a lowercase
    // adjective ("im Haus", "im alten Haus"). A capital in
    // either of the next two words, other than English I, leaves `im` alone:
    // "im with Sarah" stays unrepaired, and a miss is the cheaper error.
    generalImRegex: /\b[Ii]m\b(?!\s+(?:[A-ZÄÖÜ]|[a-zäöüß]+\s+(?!I\b)[A-ZÄÖÜ]))/g,

    // Stricter than looksLikeEnglish: it never passes a short fragment.
    clearlyEnglish(text) {
        const cleanText = text.replace(/<<<[A-Z]+_\d+>>>/g, '');
        const words = cleanText.toLowerCase().match(/\b[a-z]+\b/g);
        if (!words || words.length < this.langDetectMinWords) return false;
        if (/(?=[^\x00-\x7F])\p{L}/u.test(cleanText)) return false;
        const hits = words.filter(w => this.tier1Stopwords.has(w)).length;
        return hits >= 2 && hits / words.length >= this.langDetectThreshold;
    },

    init() {
        const keys = Object.keys(this.dictionary)
            .sort((a, b) => b.length - a.length)
            .map(escapeRegex)
            .join('|');
        this.dictRegex = new RegExp(`\\b(${keys})\\b`, 'gi');
    },

    looksLikeEnglish(text) {
        const cleanText = text.replace(/<<<[A-Z]+_\d+>>>/g, '');
        const words = cleanText.toLowerCase().match(/\b[a-z]+\b/g);
        if (!words || words.length < this.langDetectMinWords) return true;
        const hits = words.filter(w => this.tier1Stopwords.has(w)).length;
        if (words.length <= 20) return hits >= 1;
        return hits / words.length >= this.langDetectThreshold;
    },

    fix(text) {
        if (!text || text.length < 3) return text;
        if (!this.dictRegex) this.init();

        const { text: protectedText, map } = PlaceholderProtector.replaceProtected(text);
        const readableText = joinKnownContractions(protectedText, this.dictionary);
        // No whole-text language gate : it skipped
        // ordinary casual English wholesale. Only the two words that are
        // genuinely ambiguous across languages keep a check of their own:
        // `im` (German) and `i` (Norwegian, Danish, Swedish "in").
        const english = this.clearlyEnglish(readableText);

        let fixed = readableText;
        fixed = fixed.replace(this.contextualImRegex, "I'm");
        if (english) {
            this.generalImRegex.lastIndex = 0;
            fixed = fixed.replace(this.generalImRegex, "I'm");
        }
        this.dictRegex.lastIndex = 0;
        fixed = fixed.replace(this.dictRegex, match => {
            const entry = this.dictionary[match.toLowerCase()];
            if (!entry) return match;

            if (match === match.toUpperCase()) {
                return entry.fix.toUpperCase();
            }

            // Preserve ordinary title-case input, except contractions whose correct
            // form inherently contains a capital I.
            if (entry.fix.startsWith('I')) return entry.fix;
            if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
                return entry.fix.charAt(0).toUpperCase() + entry.fix.slice(1);
            }
            return entry.fix;
        });

        // Standalone pronoun i. Restrict to prose-sized ASCII-ish strings to avoid
        // changing symbols in short technical fragments.
        const pronounSource = PlaceholderProtector.restore(readableText, map);
        const words = pronounSource.trim().split(/\s+/);
        // Curly apostrophes and emoji are not a language signal; letters
        // outside ASCII (æ, ø, ü …) are.
        if (words.length >= 6 && this.looksLikeEnglish(readableText) &&
            !/(?=[^\x00-\x7F])\p{L}/u.test(pronounSource)) {
            // "i." and "i)" open roman-numeral lists ("*i. You must be…").
            fixed = fixed.replace(/\bi\b(?![.)])/g, 'I');
        }

        // Sentence-start capitalization. This is intentionally modest: only after
        // clear sentence punctuation or at the beginning of this text node.
        this.sentenceStartRegex.lastIndex = 0;
        fixed = fixed.replace(this.sentenceStartRegex, (match, p1, p2, offset, full) => {
            // These are valid words in English or another supported page
            // context. Do not alter a bare fragment merely for casing.
            if (offset === 0 && /^\s*(?:cant|im|wont)\b/i.test(full)) return match;
            // A label, not a sentence: three words or fewer and no sentence
            // punctuation. Names, tags and buttons keep their first word as
            // written (a reviewer's "joanne alderton" was half-capitalised).
            // Cost: "lol same" stays lowercase, and a miss is the cheaper error.
            if (offset === 0 && !/[.!?]/.test(full) && full.trim().split(/\s+/).length <= 3) return match;
            // A handle or an identifier, not a word: its case is its spelling
            // (gueris24, gueris_tv, xX_gamer_Xx, v2, iPhone).
            const token = p2 + (full.slice(offset + match.length).match(/^\S*/)?.[0] || '');
            if (/[\d_]/.test(token) || /[A-Z]/.test(token.slice(1))) return match;
            const before = full.substring(0, offset);
            const rawPrev = before.split(/\s+/).pop() || '';
            const prev = rawPrev.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase();
            if (this.abbreviations.has(prev)) return match;
            // An initialism's last stop is not a sentence end: U.S., D.C.,
            // a.m., Ph.D. Had the writer ended a sentence there, the next word
            // would already be capitalised and nothing changes.
            // (The match begins at the stop itself, so put it back first.)
            if (/^\(?(?:[A-Za-z]{1,2}\.){2,}$/.test(rawPrev + p1.trim())) return match;
            return p1 + p2.toUpperCase();
        });

        return PlaceholderProtector.restore(fixed, map);
    },

    /*
     * Diagnostic companion to fix(). The browser's hot path keeps using the
     * string-only API; controls and tests can opt into stable correction
     * records without making DOM code understand individual grammar rules.
     */
    fixDetailed(text) {
        const output = this.fix(text);
        const corrections = [];

        if (output === text) return { text: output, corrections };

        const wordPattern = /[A-Za-z]+(?:[\u200B-\u200D\u2060\uFEFF]+[A-Za-z]+)*(?:'[A-Za-z]+)?/g;
        const originalWords = [...text.matchAll(wordPattern)];
        const outputWords = [...output.matchAll(wordPattern)];

        // Current rules only alter characters inside existing words. If a
        // future rule changes word count, return the safe string result but no
        // misleading diagnostics until that rule supplies its own metadata.
        if (originalWords.length !== outputWords.length) {
            return { text: output, corrections };
        }

        for (let index = 0; index < originalWords.length; index++) {
            const before = originalWords[index];
            const after = outputWords[index];

            if (before[0] === after[0]) continue;

            const source = before[0].replace(invisibleSeam, '').toLowerCase();
            const dictionaryEntry = this.dictionary[source];
            let ruleId = 'capitalization.sentence-start';
            let confidence = 'high';

            if (dictionaryEntry) {
                ruleId = `contraction.${source}`;
            } else if (source === 'im' && after[0].toLowerCase() === "i'm") {
                ruleId = 'contraction.im-contextual';
                confidence = 'contextual';
            } else if (source === 'i' && after[0] === 'I') {
                ruleId = 'pronoun.i';
            }

            corrections.push({
                ruleId,
                original: before[0],
                replacement: after[0],
                originalSpan: {
                    start: before.index,
                    end: before.index + before[0].length,
                },
                outputSpan: {
                    start: after.index,
                    end: after.index + after[0].length,
                },
                confidence,
            });
        }

        return { text: output, corrections };
    },

    /*
     * Paragraph-level entry point. A rendered paragraph arrives as several
     * pieces (text nodes split by links, emphasis, line breaks). Fixing each
     * piece alone loses the sentence: a fragment after a link looks like a
     * sentence start, and a short fragment is too small to read as English.
     *
     * Join the pieces, fix the whole, and hand each correction back to the
     * piece it falls in. A correction that would cross a piece boundary, or
     * land in a frozen piece (link text, code), is dropped: the paragraph is
     * read as a whole, but only unfrozen pieces are ever written.
     *
     * Returns { parts, corrections }: parts has the same length as the input,
     * and each correction carries the index of the piece it changed.
     */
    fixSegments(parts, frozen = []) {
        const joined = parts.join('');
        const result = { parts: parts.slice(), corrections: [] };
        if (!joined.trim()) return result;

        const { corrections } = this.fixDetailed(joined);
        if (!corrections.length) return result;

        const starts = [];
        let offset = 0;
        for (const part of parts) { starts.push(offset); offset += part.length; }

        const edits = parts.map(() => []);
        for (const c of corrections) {
            const { start, end } = c.originalSpan;
            let k = starts.length - 1;
            while (k > 0 && starts[k] > start) k--;
            if (frozen[k]) continue;
            if (end > starts[k] + parts[k].length) continue;
            edits[k].push({ start: start - starts[k], end: end - starts[k], c });
        }

        edits.forEach((list, k) => {
            if (!list.length) return;
            let text = parts[k];
            for (const e of list.sort((a, b) => b.start - a.start)) {
                text = text.slice(0, e.start) + e.c.replacement + text.slice(e.end);
                result.corrections.push({ ...e.c, segment: k });
            }
            result.parts[k] = text;
        });
        return result;
    }
};

GrammarFixer.init();

// Browser content scripts use the globals above. Node uses this guarded export
// for the dependency-free corpus runner.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GrammarFixer, PlaceholderProtector };
}
