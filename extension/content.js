/*
 * Purple Tuxedo of Shame
 * ======================
 * Hides low-effort Reddit comments and highlights substantive replies.
 *
 * A comment is judged on two axes:
 *   - Length: must meet MIN_LENGTH characters.
 *   - Slop score: a weighted tally of grammar errors, slang, style issues,
 *     and punctuation problems. Higher = worse. If the score exceeds
 *     SCORE_NUKE_THRESHOLD, the comment is considered low-effort regardless
 *     of length.
 *
 * When a low-effort top-level comment has a substantive reply (a "hero"),
 * the parent gets a shame badge instead of being hidden, and the reply
 * gets a hero badge. This rewards people who bother to correct or expand
 * on lazy comments.
 *
 * Comments above UPVOTE_THRESHOLD upvotes are never hidden, on the
 * assumption that community approval outweighs style concerns. They can
 * still wear the shame badge if a hero replies: a hero saves the thread.
 *
 * The grammar fix feature rewrites visible text in place to correct missing
 * apostrophes and capitalisation. Slang is never rewritten. It is purely
 * cosmetic and does not touch voting or Reddit's data.
 *
 * Text correction is handled by grammar-fixer.js (GrammarFixer, PlaceholderProtector).
 * Slop scoring lives here.
 *
 * v1.2.2 — an initialism no longer ends a sentence: "the U.S. would" and
 *          "D.C. home" stay as written (also a.m., Ph.D.).
 * v1.2.1 — handles and identifiers keep their case at a sentence start:
 *          "gueris24" no longer becomes "Gueris24", nor do gueris_tv, v2 or
 *          iPhone change.
 * v1.2.0 — fixing grammar on other sites is now experimental and off by
 *          default. Away from Reddit it did odd things on sites that rebuild
 *          their pages their own way, and an extension that quietly edits
 *          every page you visit should be invited in. Until switched on in
 *          the panel, it does nothing off Reddit. Reddit is unchanged.
 *          With it on, "Parade the fixes" in the panel stamps every
 *          paragraph it changed; hover a stamp for each rule, before → after.
 * v1.1.2 — replies get fixed too. Tux used to accept a whole thread from
 *          Reddit, admire the top comment, and ignore everyone who answered
 *          it. Comments are now fixed when they arrive, not once you are
 *          already reading them, and text Reddit quietly puts back is fixed
 *          again.
 * v1.1.1 — the slop score judges only what the author wrote, not what they
 *          quoted.
 * v1.1.0 — the Brainrot Parade: a diagnostic mode, toggled from the panel,
 *          that hides nothing and stamps every verdict instead.
 * v1.0.0 — first public release.
 */

(function () {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    //
    // These are the values you actually want to tune. Everything below this
    // block is machinery. You can change any value here and reload the page.

    const CONFIG = {

        // --- Scoring weights -------------------------------------------------
        // These four must add up to 1.0. They control how much each type of
        // badness contributes to the final slop score.
        WEIGHT_GRAMMAR:     0.6,   // Missing apostrophes, lowercase "i", etc.
        WEIGHT_SLANG:       0.3,   // "ur", "rn", "idk", "wanna", etc.
        WEIGHT_STYLE:       0.1,   // No sentence capitalisation, all-lowercase walls of text.
        WEIGHT_PUNCTUATION: 0.0,   // No terminal punctuation, excessive emoji density.

        // --- Nuke thresholds -------------------------------------------------
        // A comment must fail at least one of these to be considered for hiding.
        MIN_LENGTH:           200,  // Minimum character count to survive on length alone.
        SCORE_NUKE_THRESHOLD: 15,   // Slop score at or above this = low-effort regardless of length.
        ENABLE_NUKE_BY_SCORE: true, // Set false to only nuke by length, ignoring the score.

        // --- Hero detection --------------------------------------------------
        // A reply must clear both of these to rescue its lazy parent from being
        // hidden (turning a nuke into a shame badge + hero badge instead).
        CHILD_MIN_LENGTH: 200,  // Minimum characters in a reply to be considered a hero.
        CHILD_MIN_WORDS:   35,  // Minimum word count in a reply to be considered a hero.

        // --- Upvote immunity -------------------------------------------------
        // Comments at or above this upvote count are never hidden, however
        // weak. They can still wear the tuxedo if a hero replies.
        USE_UPVOTE_IMMUNITY: true,
        UPVOTE_THRESHOLD:    800,

        // --- Display ---------------------------------------------------------
        ENABLE_SCORE_DISPLAY: false, // Show a coloured "SLOP N" badge on every comment (useful for tuning).
        SHOW_PLACEHOLDERS:    false, // Replace hidden comments with a visible "[hidden]" marker.
        WEIGHT_EMOJI:         1.0,   // Reserved for future emoji scoring; not yet wired into computeScore().

        // --- Style penalties -------------------------------------------------
        // These feed into the style component of the slop score.
        ALL_LOWER_PENALTY:       2.0, // Points added per 100 words when entire comment is lowercase.
        ALL_LOWER_MIN_LEN:       150, // Only apply the all-lowercase penalty above this character count.
        EMOJI_DENSITY_THRESHOLD: 20,  // Emoji per 100 words above this triggers the emoji penalty.
        EMOJI_PENALTY:           3,   // Points added to punctuation score when emoji density is too high.

        // --- Grammar fixing --------------------------------------------------
        ENABLE_GRAMMAR_FIXES: true, // Rewrite visible text nodes in-place to fix apostrophes, caps, slang.

        // --- Visual badges ---------------------------------------------------
        SHAME_EMOJI: "🤵‍♂️",
        SHAME_LABEL: " ",
        HERO_EMOJI:  "⭐",
        HERO_LABEL:  " ",
    };


    // =========================================================================
    // UTILITIES
    // =========================================================================

    function getElementText(el) {
        return el?.innerText || el?.textContent || '';
    }

    // What the author wrote, without what they quoted. The score judges the
    // debater, so the opponent's words in a blockquote (and code, which isn't
    // prose) don't count against them. The fixer already leaves those alone
    // (FIX_SKIP_BLOCK). Each outermost quote's own innerText is cut from the
    // element's innerText in document order, so line breaks survive. A comment
    // that is nothing but a quote keeps its full text: there is nothing of the
    // author's to judge, and an empty result would read as "Collapsed".
    const NOT_THE_AUTHORS = 'blockquote, pre, code';
    function authorText(el) {
        const full = getElementText(el);
        const quoted = [...(el?.querySelectorAll?.(NOT_THE_AUTHORS) || [])]
            .filter(q => {                     // outermost only: a quote inside a quote is cut with it
                const outer = q.parentElement?.closest(NOT_THE_AUTHORS);
                return !outer || !el.contains(outer);
            });
        if (!quoted.length) return full;
        let own = '', from = 0;
        for (const q of quoted) {
            const t = getElementText(q).trim();
            if (!t) continue;
            const at = full.indexOf(t, from);
            if (at < 0) continue;              // not found in order: keep the text rather than guess
            own += full.slice(from, at);
            from = at + t.length;
        }
        own += full.slice(from);
        return own.trim() ? own : full;
    }


    // =========================================================================
    // COMMENT TEXT EXTRACTION
    // =========================================================================
    //
    // Reddit's "Shreddit" rewrite (2023-) uses Web Components, which means the
    // comment text is often hidden inside a Shadow DOM — a separate, encapsulated
    // DOM tree attached to a custom element. Normal querySelector() calls cannot
    // see inside shadow roots, so we need to check there explicitly first.
    //
    // The function tries three strategies in order, returning as soon as it finds
    // a non-empty result from a known element. Strategy 3 is only reached when
    // no known element can be found at all.
    //
    //   1. Shadow DOM: access comment.shadowRoot and look for known elements inside it.
    //   2. Light DOM: look for the same elements as direct children of the comment
    //      element, which is how older Reddit markup works.
    //   3. Nuclear fallback: manually walk every text node in the entire comment
    //      element and concatenate them, skipping nodes inside code blocks, links,
    //      and blockquotes to avoid picking up noise.

    function extractCommentText(comment) {
        if (!comment) return '';

        // --- Strategy 1: Shadow DOM ---
        if (comment.shadowRoot) {
            const shadow = comment.shadowRoot;
            const candidates = [
                shadow.querySelector('shreddit-text'),
                shadow.querySelector('.RichTextJSON-root'),
                shadow.querySelector('faceplate-formatted-text'),
                shadow.querySelector('[slot="text"]'),
                shadow.querySelector('div[data-slot="comment"]'),
                shadow.querySelector('div[id$="-post-rtjson-content"]'),
            ].filter(Boolean);

            for (const el of candidates) {
                const txt = authorText(el).trim();
                if (txt.length > 0) return txt;
            }
        }

        // --- Strategy 2: Light DOM ---
        const lightSelectors = [
            'shreddit-text',
            '.RichTextJSON-root',
            'faceplate-formatted-text',
            '[slot="text"]',
            'div[id$="-post-rtjson-content"]',
            'div.text-14',
            '.comment-body',
        ];

        for (const sel of lightSelectors) {
            const el = comment.querySelector(sel);
            if (el) {
                const txt = authorText(el).trim();
                if (txt.length > 0) return txt;
            }
        }

        // --- Strategy 3: Text node walker ---
        const uiChromePattern = /^(reply|share|more replies|save|report|follow|•|\d+)$/i;

        let text = '';
        const walker = document.createTreeWalker(comment, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const node   = walker.currentNode;
            const parent = node.parentElement;

            if (parent && parent.closest('shreddit-comment') !== comment) continue;
            if (parent && parent.closest('blockquote, pre, code, a[href^="http"], [class*="code"]')) continue;

            const val = node.textContent.trim();
            if (!val || uiChromePattern.test(val)) continue;

            text += val + ' ';
        }
        return text.trim();
    }

    // =========================================================================
    // PARAGRAPH-LEVEL FIXING
    // =========================================================================
    //
    // The fixer reads a whole paragraph, not one text node: a browser splits a
    // paragraph into several nodes around links and emphasis. These helpers
    // find a comment's own text and group its nodes into paragraphs. The same
    // approach as the bundled grammar fixer (everywhere/content.js).

    const BODY_SELECTORS = [
        'shreddit-text', '.RichTextJSON-root', 'faceplate-formatted-text',
        '[slot="text"]', 'div[data-slot="comment"]', 'div[id$="-post-rtjson-content"]',
        'div.text-14', '.comment-body',
    ];
    // Read for context, never written.
    const FIX_FROZEN = 'a, code, kbd, samp, img, faceplate-number, [contenteditable], textarea, input';
    // Not prose at all: quoted text belongs to someone else, code is code.
    const FIX_SKIP_BLOCK = 'pre, blockquote, textarea, [contenteditable], button, label, script, style';
    const INLINE_TAGS = new Set([
        'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM',
        'FONT', 'I', 'INS', 'DEL', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL',
        'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'SLOT',
    ]);

    // The comment's own text element, or null. Only an element that belongs to
    // this comment (not a nested reply) and actually holds text. With no such
    // element the comment is left unfixed rather than walking Reddit's buttons.
    function commentBody(comment) {
        const roots = comment.shadowRoot ? [comment.shadowRoot, comment] : [comment];
        for (const root of roots) {
            for (const sel of BODY_SELECTORS) {
                const el = root.querySelector(sel);
                if (!el) continue;
                if (root === comment && el.closest('shreddit-comment') !== comment) continue;
                if (getElementText(el).trim()) return el;
            }
        }
        return null;
    }

    // Reddit's custom elements are often laid out inline inside a sentence.
    function isInline(el) {
        if (INLINE_TAGS.has(el.tagName)) return true;
        if (!el.tagName.includes('-')) return false;
        return /^(inline|contents)/.test(getComputedStyle(el).display);
    }

    // The nearest non-inline ancestor of a text node, never above the body.
    function blockOf(node, limit) {
        let el = node.parentElement;
        while (el && el !== limit && isInline(el)) el = el.parentElement;
        return el || limit;
    }

    // A paragraph's text pieces in order. A line break or a nested block ends
    // the sentence run; nested blocks are fixed as paragraphs of their own.
    function collectSegments(block) {
        const segments = [];
        const walk = parent => {
            for (const child of parent.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    if (!child.nodeValue) continue;
                    const frozen = !!child.parentElement?.closest(FIX_FROZEN);
                    segments.push({ node: child, text: child.nodeValue, frozen });
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.tagName === 'BR' || !isInline(child)) {
                        segments.push({ node: null, text: '\n', frozen: true });
                    } else {
                        walk(child);
                    }
                }
            }
        };
        walk(block);
        return segments;
    }


    // =========================================================================
    // GRAMMAR SERVICE
    // =========================================================================
    //
    // Responsible for two things:
    //   1. Deciding whether a comment is English (skip scoring on other languages).
    //   2. Analysing text and returning a slop score.
    //
    // Text correction (fixing "dont" → "don't", etc.) is handled by GrammarFixer
    // in grammar-fixer.js. GrammarService.analyze() uses GrammarFixer.dictionary
    // and GrammarFixer's compiled regexes as its source of truth for what counts
    // as a grammar or slang error.

    // What counts as slop is Tux's judgement, not the fixer's. The fixer
    // (grammar-fixer.js) only repairs grammar and never rewrites slang,
    // because "idk" and "rn" carry tone. Slang still counts against the score.
    const DEFAULT_SLOP_WEIGHTS = {
        // Missing apostrophes, lowercase "i"
        arent: ['grammar', 4], cant: ['grammar', 4], couldnt: ['grammar', 2],
        didnt: ['grammar', 5], dont: ['grammar', 6], havent: ['grammar', 2],
        hes: ['grammar', 5], isnt: ['grammar', 5], shes: ['grammar', 4],
        shouldnt: ['grammar', 2], theyre: ['grammar', 5], wont: ['grammar', 4],
        wouldnt: ['grammar', 2], youre: ['grammar', 6], i: ['grammar', 4],
        // Slang: scored, never rewritten
        cuz: ['slang', 4], idc: ['slang', 2], idk: ['slang', 1], ikr: ['slang', 4],
        imo: ['slang', 1], kinda: ['slang', 1], rn: ['slang', 6], tbh: ['slang', 1],
        ur: ['slang', 5], wanna: ['slang', 2],
    };
    // Case-insensitive ("Dont" at a sentence start is still missing its
    // apostrophe), except that a correct capital "I" is not an error: counting
    // it would punish careful first-person writing.
    // Editable from the panel (tuxSettings.slopWeights); words are escaped,
    // so a stray symbol in one cannot break the pattern.
    let SLOP_WEIGHTS, SLOP_REGEX;
    function setSlopWeights(table) {
        SLOP_WEIGHTS = {};
        for (const [w, v] of Object.entries(table || {})) {
            const word = String(w).toLowerCase().trim();
            if (!word || !Array.isArray(v) || !['grammar', 'slang'].includes(v[0]) || !(Number(v[1]) >= 0)) continue;
            SLOP_WEIGHTS[word] = [v[0], Number(v[1])];
        }
        const keys = Object.keys(SLOP_WEIGHTS).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        SLOP_REGEX = keys.length ? new RegExp(`\\b(${keys.join('|')})\\b`, 'gi') : /(?!)/g;
    }
    setSlopWeights(DEFAULT_SLOP_WEIGHTS);

    // Common in English, rare in Norwegian and German.
    const COMMON_ENGLISH = /\b(the|and|that|this|with|from|you|are|have|for|not|but|is|it|of|to|a|my|was|they|what|just|like|would|people|because)\b/gi;

    const GrammarService = {

        // Is this comment English? Judged per comment, never once per thread:
        // a single unlucky comment would otherwise switch scoring off for all.
        // Short comments carry too little evidence and count as English.
        detectLanguage(text) {
            if (text.length <= 150) return true;
            const { text: shielded } = PlaceholderProtector.replaceProtected(text);
            const hits = shielded.match(COMMON_ENGLISH) || [];
            return new Set(hits.map(m => m.toLowerCase())).size >= 3;
        },

        analyze(rawText) {
            const clean     = rawText.replace(/\s+/g, ' ').trim();
            const words     = clean.split(/\s+/).filter(w => w.length > 0);
            const wordCount = words.length || 1;

            if (clean.length < 50 || !this.detectLanguage(clean)) {
                return { grammarPoints: 0, slangPoints: 0, stylePoints: 0, punctuationPoints: 0, wordCount };
            }

            const { text: protectedText } = PlaceholderProtector.replaceProtected(clean);

            let grammarPoints = 0, slangPoints = 0, stylePoints = 0, punctuationPoints = 0;

            let match;
            SLOP_REGEX.lastIndex = 0;
            while ((match = SLOP_REGEX.exec(protectedText)) !== null) {
                if (match[1] === 'I') continue;
                const entry = SLOP_WEIGHTS[match[1].toLowerCase()];
                if (!entry) continue;
                const [category, points] = entry;
                if (category === 'grammar') grammarPoints += points;
                else slangPoints += points;
            }

            GrammarFixer.sentenceStartRegex.lastIndex = 0;
            while ((match = GrammarFixer.sentenceStartRegex.exec(protectedText)) !== null) {
                const before  = protectedText.substring(0, match.index);
                let prevWord  = before.split(/\s+/).pop()?.replace(/[.,!?;:"'()[\]]+$/, '').toLowerCase() || '';
                if (!GrammarFixer.abbreviations.has(prevWord)) {
                    stylePoints += 4;
                }
            }

            if (clean === clean.toLowerCase() && clean.length > CONFIG.ALL_LOWER_MIN_LEN) {
                stylePoints += CONFIG.ALL_LOWER_PENALTY * (wordCount / 100);
            }

            if (!/[.!?]$/.test(clean)) {
                punctuationPoints += 8;
            }

            const emojiCount   = (clean.match(/\p{Emoji_Presentation}/gu) || []).length;
            const emojiDensity = (emojiCount / wordCount) * 100;
            if (emojiDensity > CONFIG.EMOJI_DENSITY_THRESHOLD) {
                punctuationPoints += CONFIG.EMOJI_PENALTY;
            }

            return { grammarPoints, slangPoints, stylePoints, punctuationPoints, wordCount };
        },

        computeScore(analysis) {
            const { grammarPoints, slangPoints, stylePoints, punctuationPoints, wordCount } = analysis;

            const grammarDensity     = (grammarPoints     / wordCount) * 100;
            const slangDensity       = (slangPoints       / wordCount) * 100;
            const styleDensity       = (stylePoints       / wordCount) * 100;
            const punctuationDensity = (punctuationPoints / wordCount) * 100 * 0.5;

            return grammarDensity     * CONFIG.WEIGHT_GRAMMAR     +
                   slangDensity       * CONFIG.WEIGHT_SLANG       +
                   styleDensity       * CONFIG.WEIGHT_STYLE       +
                   punctuationDensity * CONFIG.WEIGHT_PUNCTUATION;
        },

        attachScoreBadge(comment, score) {
            if (!CONFIG.ENABLE_SCORE_DISPLAY) return;
            if (comment.querySelector('.grammar-score')) return;

            const hue   = Math.max(0, Math.min(120 - score * 6, 120));
            const color = `hsl(${hue}, 90%, 45%)`;
            const badge = document.createElement('span');
            badge.className   = 'grammar-score';
            badge.textContent = `SLOP ${Math.round(score)}`;
            badge.style.cssText = `
                display: inline-block !important; background: ${color} !important;
                color: white !important; font-size: 10px !important; font-weight: 900 !important;
                padding: 1px 6px !important; border-radius: 4px !important;
                margin-right: 8px !important; vertical-align: middle !important;
                font-family: sans-serif !important;
            `;

            const header = comment.querySelector('div[id^="comment-header"], shreddit-comment > div:first-child') || comment;
            header.insertAdjacentElement('afterbegin', badge);
        }
    };


    // =========================================================================
    // NUKER ENGINE
    // =========================================================================

    // =========================================================================
    // SETTINGS AND DIAGNOSTICS
    // =========================================================================
    //
    // The toolbar panel (popup.html) edits these keys in chrome.storage.local;
    // everything else in CONFIG stays code-only. Without chrome.storage,
    // CONFIG's defaults simply apply.

    const TUNABLE = [
        'MIN_LENGTH', 'SCORE_NUKE_THRESHOLD', 'ENABLE_NUKE_BY_SCORE',
        'CHILD_MIN_LENGTH', 'CHILD_MIN_WORDS', 'USE_UPVOTE_IMMUNITY',
        'UPVOTE_THRESHOLD', 'ENABLE_GRAMMAR_FIXES', 'ENABLE_SCORE_DISPLAY',
        'SHOW_PLACEHOLDERS', 'WEIGHT_GRAMMAR', 'WEIGHT_SLANG', 'WEIGHT_STYLE',
    ];
    const DEFAULTS = Object.fromEntries(TUNABLE.map(k => [k, CONFIG[k]]));
    const hasStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;

    function loadSettings() {
        if (!hasStorage) return Promise.resolve();
        return chrome.storage.local.get('tuxSettings').then(({ tuxSettings }) => {
            for (const k of TUNABLE) if (tuxSettings && k in tuxSettings) CONFIG[k] = tuxSettings[k];
            if (tuxSettings?.slopWeights) setSlopWeights(tuxSettings.slopWeights);
        }).catch(() => {});
    }

    // What happened on this page, for the panel. The lookup failures are the
    // early warning: each counts a comment Tux could not read and so left
    // alone. A rising number means Reddit changed shape again.
    function freshStats() {
        return {
            judged: 0, hidden: { Short: 0, Slop: 0, Collapsed: 0 },
            tuxedos: 0, heroes: 0, sparedByUpvotes: 0, paragraphsFixed: 0,
            failures: { noBody: 0, noScore: 0, noThingId: 0, noText: 0, thrown: 0 },
        };
    }
    let STATS = freshStats();

    // The author's words as first seen. A re-evaluation after a settings
    // change must judge these, not the text the fixer has since cleaned up.
    const rawTextOf = new WeakMap();

    // =========================================================================
    // REFIX: TEXT THAT CHANGES AFTER IT WAS FIXED
    // =========================================================================
    //
    // A processed mark records an encounter, not completion. Reddit hydrates: a comment can be fixed and
    // then have its server text put back, or its body replaced, after Tux has
    // read it. The comment observer below only hears new shreddit-comments, so
    // those rewrites went unfixed (intermittent: a reply
    // left with "i dont" and "im"). This watches text inside comments already
    // processed, light DOM and open shadow roots, and fixes them again at once:
    // the observer already batches, and a frame callback would never run in a
    // background tab. Our own writes come back in a later batch and are
    // skipped; the fixer is idempotent, so a pass over fixed text writes nothing.
    const Refix = {
        produced: new WeakMap(),               // text node -> the value we wrote
        known: new WeakSet(),                  // comments the fixer has met
        roots: new WeakSet(),
        observer: null,

        watch(root) {
            if (!root || this.roots.has(root)) return;
            this.roots.add(root);
            this.observer ||= new MutationObserver(m => this.heard(m));
            this.observer.observe(root, { childList: true, subtree: true, characterData: true });
        },

        heard(mutations) {
            const pending = new Set();
            for (const m of mutations) {
                if (m.type === 'characterData' && this.produced.get(m.target) === m.target.nodeValue) continue;
                const node = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
                if (!node) continue;
                const root = node.getRootNode();
                const comment = node.closest('shreddit-comment') ||
                    (root instanceof ShadowRoot ? root.host.closest('shreddit-comment') : null);
                if (!comment || !this.known.has(comment)) continue;
                const body = commentBody(comment);       // the body, or what replaced it
                if (body && (body.contains(node) || node.contains(body))) pending.add(comment);
            }
            for (const c of pending) guarded('refix', c, () => NukerEngine.applyFixesToTextNodes(c));
        },
    };

    // One comment's failure must never cost its neighbours. Every per-comment
    // step runs through here: an exception is counted and logged with the
    // comment's id, and the loop goes on. Before this, a throw inside a
    // mutation batch silently dropped every comment after it in that batch:
    // never fixed, never judged. Errors are shown in the panel, not swallowed.
    function guarded(step, comment, fn) {
        try { return fn(); }
        catch (e) {
            STATS.failures.thrown++;
            console.warn(`Purple Tuxedo: ${step} failed on ${comment?.getAttribute?.('thingid') || 'a comment'}`, e);
        }
    }

    // A comment with no text yet is usually still hydrating. Wait a little for
    // it before judging it "Collapsed"; one Reddit marks collapsed is judged at
    // once, as before.
    const TEXT_WAIT_MS = 250, TEXT_WAIT_TRIES = 8;
    const textWaits = new WeakMap();

    // The Brainrot Parade (parade.js) is optional: without it, Tux runs as
    // ever. Its stamps name the verdict in a few loud words.
    const paradeOn = () => typeof Parade !== 'undefined' && Parade.active;
    function stampText(reason) {
        const [kind, detail = ''] = reason.split(' ');
        if (kind === 'Slop')  return `SLOP ${Math.round(parseFloat(detail.slice(1)))}`;
        if (kind === 'Short') return `TOO SHORT · ${parseInt(detail.slice(1), 10)}`;
        return 'COLLAPSED';
    }

    const NukerEngine = {

        hideComment(comment, reason = '') {
            STATS.hidden[reason.split(' ')[0]] = (STATS.hidden[reason.split(' ')[0]] || 0) + 1;
            console.log(`[Nuker] Hiding: ${reason}`.trim());
            comment.classList.add('nuked-comment');
            if (CONFIG.SHOW_PLACEHOLDERS) {
                const ph = document.createElement('div');
                ph.className   = 'nuker-placeholder';
                ph.textContent = '[Comment hidden by Purple Tuxedo]';
                comment.parentNode?.insertBefore(ph, comment);
            }
        },

        getCommentScore(comment) {
            if (!CONFIG.USE_UPVOTE_IMMUNITY) return null;

            // The comment states its own score. Searching for a number inside
            // it finds the reply or award count on current Reddit; the
            // selectors below are only a fallback for older markup.
            const own = parseInt(comment.getAttribute('score'), 10);
            if (!isNaN(own)) return own;
            STATS.failures.noScore++;

            const selectors = [
                'faceplate-number[number]',
                '[data-testid="comment-score"]',
                '.score',
                'faceplate-number',
                '[aria-label*="upvotes"]',
                '[aria-label*="points"]',
            ];

            for (const sel of selectors) {
                const el = comment.querySelector(sel);
                if (!el) continue;

                let val = (
                    el.getAttribute('number') ||
                    el.textContent             ||
                    el.getAttribute('aria-label') ||
                    ''
                ).replace(/[^0-9kKmM.-]/g, '').trim().toLowerCase();

                if      (val.endsWith('k')) val = parseFloat(val) * 1000;
                else if (val.endsWith('m')) val = parseFloat(val) * 1000000;

                const num = parseInt(val, 10);
                if (!isNaN(num)) return num;
            }
            return null;
        },

        hasUpvoteImmunity(comment) {
            const score = this.getCommentScore(comment);
            return score !== null && score >= CONFIG.UPVOTE_THRESHOLD;
        },

        applyShameBadge(comment) {
            if (comment.querySelector('.shame-badge')) return;
            STATS.tuxedos++;
            const badge = document.createElement('span');
            badge.className = 'shame-badge';
            badge.innerHTML = `${CONFIG.SHAME_EMOJI} ${CONFIG.SHAME_LABEL}`;
            badge.style.cssText = `
                display: inline-block !important; background: #9b4d96 !important; color: white !important;
                font-size: 0.7em !important; font-weight: bold !important; padding: 2px 8px !important;
                border-radius: 12px !important; margin-right: 8px !important; margin-bottom: 4px !important;
                letter-spacing: 0.5px !important; text-transform: uppercase !important;
                border: 1px solid rgba(255,255,255,0.3) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
            `;
            comment.insertBefore(badge, comment.firstChild);
        },

        applyHeroBadge(comment) {
            if (comment.querySelector('.hero-badge')) return;
            STATS.heroes++;
            const badge = document.createElement('span');
            badge.className = 'hero-badge';
            badge.innerHTML = `${CONFIG.HERO_EMOJI}${CONFIG.HERO_LABEL}`;
            badge.style.cssText = `
                display: inline-block !important; background: #b8860b !important; color: white !important;
                font-size: 0.7em !important; font-weight: bold !important; padding: 2px 8px !important;
                border-radius: 12px !important; margin-right: 8px !important; margin-bottom: 4px !important;
                letter-spacing: 0.5px !important; text-transform: uppercase !important;
                border: 1px solid rgba(255,255,255,0.3) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
            `;
            comment.insertBefore(badge, comment.firstChild);
            comment.classList.add('hero-reply');
        },

        isStrongReply(replyElement) {
            const text  = extractCommentText(replyElement).replace(/\s+/g, ' ').trim();
            const words = text.split(/\s+/).filter(w => w.length > 0);

            if (text.length < CONFIG.CHILD_MIN_LENGTH) return false;
            if (words.length < CONFIG.CHILD_MIN_WORDS)  return false;

            if (text === text.toUpperCase() && text.length > 10) return false;

            const nonText = (text.match(/[^\p{L}\p{N}\s]/gu) || []).length;
            if (text.length > 0 && (nonText / text.length) > 0.6) return false;

            const sentenceCount = (text.match(/[.!?]/g) || []).length;
            if (text.length > 200 && sentenceCount < 2) return false;

            return true;
        },

        // Replies by what they are, not where they sit: each reply names its
        // parent in parentid. Reddit nests replies several elements deep
        // (<details> > div > div), so position is not a reliable signal.
        getDirectChildren(comment) {
            const id = comment.getAttribute('thingid');
            if (!id) { STATS.failures.noThingId++; return []; }
            return Array.from(comment.querySelectorAll(`shreddit-comment[parentid="${CSS.escape(id)}"]`));
        },

        // Fixes a comment's own text a paragraph at a time. Fixed one text node
        // at a time, the word after a link would look like a sentence start
        // ("her" -> "Her") and short pieces would be too small to judge. The
        // paragraph is read as one text and every change goes back into the
        // node it came from (GrammarFixer.fixSegments). Link and
        // code text is read for context, never written.
        // Fixing is eager, judging is lazy. A comment is fixed the moment it is
        // found, so it is usually right before it is seen; only the verdict
        // waits for the IntersectionObserver. Fixing used to wait for it too,
        // which made "fixed before it renders" a race against scrolling, and
        // left any comment it never reported unfixed for good, such as the
        // comments Reddit loads after the page has started.
        fixComment(comment) {
            Refix.known.add(comment);
            Refix.watch(comment.shadowRoot);
            this.applyFixesToTextNodes(comment);
        },

        applyFixesToTextNodes(comment) {
            if (!CONFIG.ENABLE_GRAMMAR_FIXES) return;
            const body = commentBody(comment);
            if (!body) { STATS.failures.noBody++; return; }

            const blocks = new Set();
            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (!node.nodeValue.trim()) continue;
                if (node.parentElement?.closest(FIX_SKIP_BLOCK)) continue;
                blocks.add(blockOf(node, body));
            }

            for (const block of blocks) {
                const segments = collectSegments(block);
                const texts = segments.map(s => s.text);
                if (texts.join('').trim().length < 3) continue;
                const frozen = segments.map(s => s.frozen || !s.node);
                const { parts, corrections } = GrammarFixer.fixSegments(texts, frozen);
                if (corrections.length) STATS.paragraphsFixed++;
                parts.forEach((text, k) => {
                    if (segments[k].node && text !== texts[k]) {
                        Refix.produced.set(segments[k].node, text);
                        segments[k].node.nodeValue = text;
                    }
                });
            }
        },

        processComment(comment) {
            if (comment.hasAttribute('data-processed')) return;

            // Raw text first: the score judges what the author wrote, not
            // what the fixer made of it. An empty read is never cached: it is
            // a comment still hydrating far more often than a final answer.
            if (!rawTextOf.has(comment)) {
                const txt = extractCommentText(comment);
                if (txt.trim()) rawTextOf.set(comment, txt);
            }
            const rawText   = rawTextOf.get(comment) || '';
            const cleanText = rawText.replace(/\s+/g, ' ').trim();

            if (!cleanText && !comment.hasAttribute('collapsed')) {
                const tries = textWaits.get(comment) || 0;
                if (tries < TEXT_WAIT_TRIES) {
                    textWaits.set(comment, tries + 1);
                    setTimeout(() => guarded('judge', comment, () => this.processComment(comment)), TEXT_WAIT_MS);
                    return;
                }
                STATS.failures.noText++;
            }

            // Grammar fixes run before the hide decision — intentionally.
            // Do not move this after isTooShort/isTooSloppy to "skip work" on
            // comments that will be hidden. This was attempted and produces a
            // race condition: the comment is already rendered when processComment
            // runs, so there is a visible window between render and hide where
            // the comment appears unfixed. The saving is negligible; the artifact
            // is not. Every comment is fixed, replies included.
            // A comment is fixed when it is found (fixComment); this pass is
            // the safety net, and finds nothing left to do.
            this.fixComment(comment);

            const isTopLevel = !comment.parentElement?.closest('shreddit-comment');
            if (!isTopLevel) {
                comment.setAttribute('data-processed', 'true');
                return;
            }

            // Weak: collapsed (Reddit drops the text of very short comments, and
            // the collapse is itself the signal), too short, or too sloppy.
            STATS.judged++;
            const collapsed = !cleanText || cleanText.length < 3;
            let reason = collapsed ? 'Collapsed' : null;
            let score = 0;
            if (!collapsed) {
                score = GrammarService.computeScore(GrammarService.analyze(rawText));
                GrammarService.attachScoreBadge(comment, score);
                if (CONFIG.ENABLE_NUKE_BY_SCORE && score >= CONFIG.SCORE_NUKE_THRESHOLD) {
                    reason = `Slop (${score.toFixed(1)})`;
                } else if (cleanText.length < CONFIG.MIN_LENGTH) {
                    reason = `Short (${cleanText.length} chars)`;
                }
            }

            // A hero saves the thread, however awful the comment above it and
            // however popular. Upvote immunity only stops the hiding: a weak
            // comment over the threshold with no hero stays, unbadged; with a
            // hero it stays and wears the tuxedo.
            if (reason) {
                const strongReply = this.getDirectChildren(comment).find(c => this.isStrongReply(c));
                if (strongReply) {
                    this.applyShameBadge(comment);
                    this.applyHeroBadge(strongReply);
                    if (paradeOn()) Parade.saved(comment);
                } else if (this.hasUpvoteImmunity(comment)) {
                    STATS.sparedByUpvotes++;
                    if (paradeOn()) Parade.spared(comment, stampText(reason));
                } else if (paradeOn()) {
                    // The parade shows the verdict instead of carrying it out.
                    STATS.hidden[reason.split(' ')[0]]++;
                    Parade.hit(comment, stampText(reason));
                } else {
                    this.hideComment(comment, reason);
                }
            } else if (paradeOn()) {
                // Passed. Within a quarter of either line, it barely did.
                const nearLength = cleanText.length < CONFIG.MIN_LENGTH * 1.25;
                const nearSlop   = CONFIG.ENABLE_NUKE_BY_SCORE && score >= CONFIG.SCORE_NUKE_THRESHOLD * 0.75;
                if (nearSlop)        Parade.near(comment, `SLOP ${Math.round(score)}`);
                else if (nearLength) Parade.near(comment, `${cleanText.length} CHARS`);
                else                 Parade.dim(comment);
            }

            comment.setAttribute('data-processed', 'true');
        }
    };


    // =========================================================================
    // COMMENT PROCESSOR
    // =========================================================================

    class CommentProcessor {
        constructor() {
            this.observer = new MutationObserver(this.handleMutations.bind(this));

            this.intersectionObserver = new IntersectionObserver(
                entries => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            this.intersectionObserver.unobserve(entry.target);
                            guarded('judge', entry.target, () => NukerEngine.processComment(entry.target));
                        }
                    });
                },
                { rootMargin: '200px' }
            );
        }

        start() {
            const target = document.querySelector('shreddit-app') || document.body;
            this.observer.observe(target, { childList: true, subtree: true });
            Refix.watch(target);

            document.querySelectorAll('shreddit-comment').forEach(el => guarded('fix', el, () => NukerEngine.fixComment(el)));
            document.querySelectorAll('shreddit-comment:not([data-processed])').forEach(el => {
                this.intersectionObserver.observe(el);
            });

            console.log(`Purple Tuxedo of Shame v1.2.2 active`);
            console.log(` Nuke: <${CONFIG.MIN_LENGTH} chars | Save: ${CONFIG.CHILD_MIN_LENGTH} chars / ${CONFIG.CHILD_MIN_WORDS} words`);
            console.log(` Score threshold: ${CONFIG.SCORE_NUKE_THRESHOLD} | Upvote immunity: ${CONFIG.USE_UPVOTE_IMMUNITY ? `>=${CONFIG.UPVOTE_THRESHOLD}` : 'OFF'}`);
        }

        handleMutations(mutations) {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    // The node and everything inside it. "Load more" inserts a
                    // whole thread as one node: a comment with its replies
                    // already in it. Taking only the node left every reply
                    // unseen, never fixed and never judged.
                    const found = [...(node.matches?.('shreddit-comment') ? [node] : []),
                                   ...(node.querySelectorAll?.('shreddit-comment') || [])];
                    for (const el of found) {
                        this.intersectionObserver.observe(el);   // first: a failed fix is still judged
                        guarded('fix', el, () => NukerEngine.fixComment(el));   // now, not when it scrolls near
                    }
                }
            }
        }
    }


    // =========================================================================
    // CSS
    // =========================================================================

    const style = document.createElement('style');
    style.textContent = `
        .nuked-comment { display: none !important; }

        .nuker-placeholder {
            color: #aaa; font-size: 0.85em; font-style: italic; padding: 6px 12px;
            margin: 4px 0; background: rgba(80,80,80,0.15);
            border-left: 2px solid #666; border-radius: 4px;
        }

        .hero-reply {
            border-left: 3px solid #ffd700 !important;
            background: rgba(255,215,0,0.03) !important;
        }
    `;
    document.head.appendChild(style);


    // =========================================================================
    // LAUNCH
    // =========================================================================

    // Undo every verdict and judge the page again with the current CONFIG.
    // Grammar fixes are left in place; scores still read rawTextOf.
    function reevaluate() {
        document.querySelectorAll('.shame-badge, .hero-badge, .grammar-score, .nuker-placeholder')
            .forEach(el => el.remove());
        document.querySelectorAll('.nuked-comment, .hero-reply').forEach(el =>
            el.classList.remove('nuked-comment', 'hero-reply'));
        if (typeof Parade !== 'undefined') Parade.clear();
        STATS = freshStats();
        document.querySelectorAll('shreddit-comment[data-processed]').forEach(el => {
            el.removeAttribute('data-processed');
            NukerEngine.processComment(el);
        });
    }

    if (typeof Parade !== 'undefined') Parade.setHooks({ onChange: () => reevaluate() });

    const processor = new CommentProcessor();
    loadSettings().then(() => processor.start());

    if (hasStorage) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.tuxSettings) return;
            const next = changes.tuxSettings.newValue || {};
            for (const k of TUNABLE) CONFIG[k] = k in next ? next[k] : DEFAULTS[k];
            setSlopWeights(next.slopWeights || DEFAULT_SLOP_WEIGHTS);
            reevaluate();
        });
        chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
            if (msg?.type === 'tux-parade' && typeof Parade !== 'undefined') {
                reply(Parade.toggle());   // onChange re-judges the thread
                return;
            }
            if (msg?.type !== 'tux-stats') return;
            reply({ parade: typeof Parade !== 'undefined' ? Parade.state : null, version: '1.2.2', stats: STATS, config: Object.fromEntries(TUNABLE.map(k => [k, CONFIG[k]])),
                    defaults: { ...DEFAULTS, slopWeights: DEFAULT_SLOP_WEIGHTS }, slopWeights: SLOP_WEIGHTS, comments: document.querySelectorAll('shreddit-comment').length });
        });
    }

})();
