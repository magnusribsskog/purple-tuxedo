// Grammar Fixer v0.1
// Standalone, conservative English text correction for rendered web prose.
// No DOM dependencies. Exposes PlaceholderProtector, GrammarFixer and its
// language packs (EnglishPack, the only one shipped).

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

/*
 * A language pack owns everything about one language: its words, its rules,
 * its guards and the names of its rules in diagnostics. The engine owns what
 * is the same in every language: protecting code, links and quotes, mapping a
 * paragraph back onto its pieces, and diffing a fix into correction records.
 *
 * English is the only pack, and the scope is English grammar. Other languages, if they ever come, arrive as packs with their
 * own corpus; the core does not grow rules for them.
 *
 * A pack provides:
 *   code         an ISO 639-1 code, matched against the language hint
 *   init()       optional, compile what the pack needs
 *   prepare(t)   optional, normalise protected text before rewriting
 *   rewrite(t, map)   the pack's rules; returns the rewritten protected text
 *   wordPattern  required, a global regex for this language's words
 *   ruleFor(before, after)   { ruleId, confidence } for one changed word,
 *                given both words exactly as written; the pack normalises
 *
 * The contract today is word-preserving: rewrite() may only replace a word
 * with another word in the same place (don't for dont, I for i, a capital).
 * The core finds corrections by pairing the words before and after, so a
 * rewrite that adds punctuation, changes spacing, splits, merges or reorders
 * words is returned by fix() but produces no correction and never reaches
 * the page. A pack that needs those must first get explicit span edits from
 * the core.
 */
const EnglishPack = {
    code: 'en',
    name: 'English',

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
        // above and was skipped whole (2026-10-14). None of these is a common
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
    // `cant` is a real noun (religious cant, thieves' cant), an engineering
    // term (railway cant, degrees of cant) and a transitive verb ("they cant
    // the track on the curve"). So it is fixed only on positive evidence of
    // can't: a bare verb follows (optionally after one adverb), or it opens
    // a question before a pronoun. A noun or engineering word in front always
    // wins. Lowercase or sentence-initial only, so CANT and a mid-sentence
    // surname stay. A larger grammar library was measured for this and rejected:
    // it rewrote "religious cant" and "railway cant".
    contextualCantRegex: new RegExp(
        String.raw`(?<!\b(?:the|a|an|this|that|such|mere|empty|pure|their|his|her|its|our|your|religious|political|pious|moral|legal|academic|sentimental|hypocritical|thieves'?|railway|rail|track|wheel|blade|camber)\s+)` +
        String.raw`(?:(?:\bcant|(?<=^\s*|[.!?]\s+)Cant)\b(?=\s+(?:(?:even|really|just|possibly|ever|still|actually|quite|totally|honestly|literally|seriously|simply|always|never)\s+)?(?:be|go|get|do|see|wait|believe|stand|sleep|find|make|take|tell|say|think|help|stop|remember|understand|imagine|afford|figure|hear|read|decide|keep|let|leave|live|stay|win|lose|play|work|eat|breathe|move|focus|explain|handle|deal|trust|agree|argue|seem|put|give|come|look|feel|know|have|use|buy|pay|change|open|close|fix|run|walk|talk|speak|write|watch|access|log|load|sign|connect|login|wrap|care|bear|face|hold|reach|catch|beat|finish|start|install|send|post|join|call|relax|function|tolerate|resist|recall|picture|describe|express|even)\b))` +
        String.raw`|(?:(?<=^\s*|[.!?]\s+)Cant\b(?=\s+(?:you|i|we|they|he|she|it|u|anyone|someone|people)\b))`,
        'g'),
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

    prepare(protectedText) {
        return joinKnownContractions(protectedText, this.dictionary);
    },

    rewrite(readableText, map) {
        if (!this.dictRegex) this.init();
        // No whole-text language gate: it skipped
        // ordinary casual English wholesale. Only the two words that are
        // genuinely ambiguous across languages keep a check of their own:
        // `im` (German) and `i` (Norwegian, Danish, Swedish "in").
        const english = this.clearlyEnglish(readableText);

        let fixed = readableText;
        fixed = fixed.replace(this.contextualImRegex, "I'm");
        this.contextualCantRegex.lastIndex = 0;
        fixed = fixed.replace(this.contextualCantRegex, m => m === 'Cant' ? "Can't" : "can't");
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
            // punctuation. A reviewer's name ("joanne alderton" on Amazon,
            // 2026-10-19) came out half-capitalised; names, tags and buttons
            // keep their first word as written. Cost: "lol same" stays
            // lowercase, and a miss is the cheaper error.
            if (offset === 0 && !/[.!?]/.test(full) && full.trim().split(/\s+/).length <= 3) return match;
            // A handle or an identifier, not a word: its case is its spelling.
            // gueris24, gueris_tv, xX_gamer_Xx, v2, iPhone (Twitch chat, seen
            // 2026-10-19 through the parade's first bug report).
            const token = p2 + (full.slice(offset + match.length).match(/^\S*/)?.[0] || '');
            if (/[\d_]/.test(token) || /[A-Z]/.test(token.slice(1))) return match;
            const before = full.substring(0, offset);
            const rawPrev = before.split(/\s+/).pop() || '';
            const prev = rawPrev.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase();
            if (this.abbreviations.has(prev)) return match;
            // An initialism's last stop is not a sentence end: U.S., D.C.,
            // a.m., Ph.D. (Facebook, 2026-10-19: "the U.S. would" became
            // "the U.S. Would"). Had the writer ended a sentence there, the
            // next word would already be capitalised and nothing changes.
            // (The match begins at the stop itself, so put it back first.)
            if (/^\(?(?:[A-Za-z]{1,2}\.){2,}$/.test(rawPrev + p1.trim())) return match;
            return p1 + p2.toUpperCase();
        });

        return fixed;
    },

    wordPattern: /[A-Za-z]+(?:[\u200B-\u200D\u2060\uFEFF]+[A-Za-z]+)*(?:'[A-Za-z]+)?/g,

    ruleFor(before, after) {
        const source = before.replace(invisibleSeam, '').toLowerCase();
        if (this.dictionary[source]) return { ruleId: `contraction.${source}`, confidence: 'high' };
        if (source === 'im' && after.toLowerCase() === "i'm") return { ruleId: 'contraction.im-contextual', confidence: 'contextual' };
        if (source === 'cant' && /^can't$/i.test(after)) return { ruleId: 'contraction.cant-contextual', confidence: 'contextual' };
        if (source === 'i' && after === 'I') return { ruleId: 'pronoun.i', confidence: 'high' };
        return { ruleId: 'capitalization.sentence-start', confidence: 'high' };
    },
};

const GrammarFixer = {
    packs: {},
    defaultPack: 'en',

    registerPack(pack) {
        if (!pack.code || !pack.rewrite || !pack.ruleFor || !(pack.wordPattern instanceof RegExp) || !pack.wordPattern.global) {
            throw new Error('A language pack needs code, rewrite, ruleFor and a global wordPattern');
        }
        this.packs[pack.code] = pack;
        if (pack.init) pack.init();
        return pack;
    },

    /*
     * `language` is an optional hint from the browser layer, which owns
     * detection (chrome.i18n) and caching; the engine stays synchronous.
     *   a code ('en', 'fr', 'nb' ...)  a reliable verdict: that language's
     *              pack, or no change at all when there is no pack for it.
     *              Not only the ambiguous words: "dont" is ordinary French.
     *   'other'    a reliable non-English verdict without a code: no change
     *   omitted    unknown: the default pack, with its own local guards
     */
    packFor(language) {
        if (language === undefined || language === null) return this.packs[this.defaultPack] || null;
        const code = String(language).toLowerCase().split(/[-_]/)[0];
        return this.packs[code] || null;
    },

    // Views onto the English pack, for callers and tests written before packs.
    get dictionary() { return this.packs.en.dictionary; },
    get abbreviations() { return this.packs.en.abbreviations; },
    get sentenceStartRegex() { return this.packs.en.sentenceStartRegex; },
    get dictRegex() { return this.packs.en.dictRegex; },
    set dictRegex(value) { this.packs.en.dictRegex = value; },
    looksLikeEnglish(text) { return this.packs.en.looksLikeEnglish(text); },
    init() { for (const pack of Object.values(this.packs)) if (pack.init) pack.init(); },

    fix(text, language) {
        const pack = this.packFor(language);
        if (!pack) return text;
        if (!text || text.length < 3) return text;

        const { text: protectedText, map } = PlaceholderProtector.replaceProtected(text);
        const readableText = pack.prepare ? pack.prepare(protectedText) : protectedText;
        return PlaceholderProtector.restore(pack.rewrite(readableText, map), map);
    },

    /*
     * Diagnostic companion to fix(). The browser's hot path keeps using the
     * string-only API; controls and tests can opt into stable correction
     * records without making DOM code understand individual grammar rules.
     */
    fixDetailed(text, language) {
        const output = this.fix(text, language);
        const corrections = [];

        if (output === text) return { text: output, corrections };

        const pack = this.packFor(language);
        const wordPattern = new RegExp(pack.wordPattern.source, pack.wordPattern.flags);
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

            const { ruleId, confidence } = pack.ruleFor(before[0], after[0]);

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
    fixSegments(parts, frozen = [], language) {
        const joined = parts.join('');
        const result = { parts: parts.slice(), corrections: [] };
        if (!joined.trim()) return result;

        const { corrections } = this.fixDetailed(joined, language);
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

GrammarFixer.registerPack(EnglishPack);

// Browser content scripts use the globals above. Node uses this guarded export
// for the dependency-free corpus runner.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GrammarFixer, PlaceholderProtector, EnglishPack };
}
