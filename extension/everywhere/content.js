/*
 * Grammar Fixer v0.1 — site-agnostic reading aid.
 *
 * Design invariants:
 *   - Correct rendered prose only; never edit user input or submitted content.
 *   - Observe for the lifetime of the document. Throttling must never mean "stop".
 *   - Process text nodes, not containers, so dynamic DOMs can be revisited safely.
 *   - Avoid self-trigger loops by remembering the exact value we last produced.
 *   - Stay local. No network requests, telemetry, or external services.
 */

(() => {
    'use strict';

    const CONFIG = {
        BATCH_DELAY_MS: 80,
        MAX_NODES_PER_FLUSH: 700,
        BUSY_WINDOW_MS: 10_000,
        BUSY_CORRECTION_THRESHOLD: 20,
        CONTROL_VISIBLE_MS: 15_000,
        SITE_KEY_PREFIX: 'grammarFixer.site.',
        MAX_DIAGNOSTIC_EVENTS: 200,
        MAX_DIAGNOSTIC_TEXT: 1_000,
    };

    const SKIP_SELECTOR = [
        'script', 'style', 'noscript', 'template',
        'textarea', 'input', 'select', 'option', 'button',
        'pre', 'code', 'kbd', 'samp',
        'a',
        '[contenteditable]',
        '[role="textbox"]',
        '[aria-hidden="true"]',
        '[data-grammar-fixer-ui]'
    ].join(',');

    const state = {
        enabled: true,
        pausedUntil: 0,
        eligibilityGeneration: 0,
        queue: new Set(),
        flushTimer: null,
        lastProduced: new WeakMap(),
        lastBlock: new WeakMap(),
        observedRoots: new WeakSet(),
        correctionTimes: [],
        totalCorrections: 0,
        control: null,
        controlHideTimer: null,
        diagnosticEvents: [],
        metrics: {
            mutations: 0,
            processedNodes: 0,
            changedNodes: 0,
            queuePeak: 0,
            observedRoots: 0,
            languageSkips: 0,
        },
    };
    // Language evidence from Chrome's built-in detector (chrome.i18n, CLD3),
    // owned here so the engine stays synchronous. It is only trustworthy
    // when it says so: short text comes back unreliable and often absurd
    // (measured 2026-10-20). The rule:
    //   paragraph reliably detected -> its language code; the engine runs that
    //                                  language's pack, or changes nothing if
    //                                  it has none (English is the only pack)
    //   paragraph unreliable        -> the page's code, if the page is reliably
    //                                  not English; otherwise unknown (the
    //                                  default pack and its own guards)
    // The page verdict needs long main text, is corroborated by <html lang>
    // where present, and is recomputed per route. It is English only when
    // <html lang> and the text both say so.
    const Lang = {
        verdicts: new WeakMap(),
        page: null,
        pageUrl: null,
        detect(text) {
            try {
                return Promise.resolve(chrome.i18n.detectLanguage(text)).catch(() => null);
            } catch (_) {
                return Promise.resolve(null);   // no i18n here (tests, old browsers)
            }
        },
        english(r) { return r.languages?.[0]?.language === 'en'; },
        pageHint() {
            if (this.page && this.pageUrl === location.href) return this.page;
            this.pageUrl = location.href;
            const root = document.querySelector('main, article, [role="main"]') || document.body;
            const sample = (root?.innerText || '').slice(0, 5000);
            // Too little text to judge yet: say nothing, and ask again later.
            if (sample.split(/\s+/).length < 60) { this.page = null; return Promise.resolve(undefined); }
            this.page = (async () => {
                const r = await this.detect(sample);
                if (!r || !r.isReliable) return undefined;
                const declared = (document.documentElement.lang || '').toLowerCase();
                // English only when the page says so twice, in its lang
                // attribute and in its text. That verdict lets the engine fix
                // a short "i love this".
                if (this.english(r)) return declared.startsWith('en') ? 'en' : undefined;
                if (declared.startsWith('en')) return undefined;   // the page and its text disagree
                return r.languages[0].language;
            })();
            return this.page;
        },
        async hintFor(block, text) {
            const cached = this.verdicts.get(block);
            if (cached && cached.text === text) return cached.hint;
            const r = await this.detect(text);
            let hint;
            if (r && r.isReliable && r.languages?.[0]) hint = r.languages[0].language;
            else hint = await this.pageHint();
            this.verdicts.set(block, { text, hint });
            return hint;
        },
    };

    function siteStorageKey() {
        return CONFIG.SITE_KEY_PREFIX + location.hostname;
    }

    function isPaused() {
        return !state.enabled || Date.now() < state.pausedUntil;
    }

    function isEditable(element) {
        return document.designMode.toLowerCase() === 'on' ||
            !!element?.isContentEditable ||
            !!element?.closest('[contenteditable]');
    }

    function shouldSkipTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return true;
        if (!node.nodeValue || !node.nodeValue.trim()) return true;

        const parent = node.parentElement;
        if (!parent) return true;
        if (isEditable(parent)) return true;
        if (parent.closest(SKIP_SELECTOR)) return true;

        // Do not touch invisible layout fragments.
        if (parent.closest('[hidden]')) return true;

        return false;
    }

    const RLO = /\u202E/;

    // True when the glyphs of this text node are laid out in reverse
    // logical order: a U+202E override in the text, or CSS
    // unicode-bidi: bidi-override / isolate-override with direction: rtl on
    // an inline ancestor or on the block that contains it.
    function displayIsReversed(node) {
        if (RLO.test(node.nodeValue)) return true;
        for (let el = node.parentElement; el; el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (/override/.test(cs.unicodeBidi) && cs.direction === 'rtl') return true;
            if (cs.display !== 'inline' && cs.display !== 'contents') break;
        }
        return false;
    }

    /*
     * The unit of correction is the paragraph, not the text node. A browser
     * splits one paragraph into several text nodes around links, emphasis and
     * line breaks; fixed one at a time, the piece after a link looks like a
     * sentence start ("her" -> "Her") and a short piece is too small to judge.
     * Text nodes are queued by the block that contains them, and the block is
     * fixed as one text (GrammarFixer.fixSegments), each change written back
     * into the node it came from.
     */
    const INLINE_TAGS = new Set([
        'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM',
        'FONT', 'I', 'INS', 'DEL', 'KBD', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S',
        'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR',
        'WBR', 'LABEL', 'SLOT',
    ]);
    // Not part of the sentence at all.
    const EXCLUDE_SELECTOR = [
        'script', 'style', 'noscript', 'template', 'textarea', 'input',
        'select', 'option', 'button', '[hidden]', '[aria-hidden="true"]',
        '[data-grammar-fixer-ui]',
    ].join(',');
    const MAX_BLOCK_CHARS = 20_000;
    // Interface text, not prose: a short label and a short reply look alike
    // as strings ("restart on page load" / "i dont know man"), so the element
    // decides. An extension panel's labels were once capitalised this way.
    const LABEL_SELECTOR = [
        'label', 'legend', 'th', 'dt', 'summary', 'option', 'optgroup',
        '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
        '[role="columnheader"]', '[role="switch"]', '[role="checkbox"]',
    ].join(',');

    // Custom elements (Reddit's <faceplate-*>, <shreddit-*>) are often laid
    // out inline inside a sentence; ask the browser rather than guess.
    function isInline(el) {
        if (INLINE_TAGS.has(el.tagName)) return true;
        if (!el.tagName.includes('-')) return false;
        return /^(inline|contents)/.test(getComputedStyle(el).display);
    }

    function blockOf(node) {
        let el = node.parentElement;
        while (el && isInline(el)) {
            if (!el.parentElement) return el.parentNode || el;
            el = el.parentElement;
        }
        return el || node.parentNode;
    }

    function collectSegments(block) {
        const segments = [];
        const walk = parent => {
            for (const child of parent.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    if (!child.nodeValue) continue;
                    // processBlock has already refused blocks inside anything on
                    // the skip list, so a match here is inside the block: a
                    // link, code, or an editable span. Read, never written.
                    const frozen = isEditable(child.parentElement) ||
                        !!child.parentElement?.closest(SKIP_SELECTOR);
                    segments.push({ node: child, text: child.nodeValue, frozen });
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.tagName === 'BR' || !isInline(child)) {
                        // A line break or a nested block ends the sentence run.
                        // Nested blocks are corrected as blocks of their own.
                        segments.push({ node: null, text: '\n', frozen: true });
                        continue;
                    }
                    if (child.matches(EXCLUDE_SELECTOR)) {
                        segments.push({ node: null, text: ' ', frozen: true });
                        continue;
                    }
                    walk(child);
                }
            }
        };
        walk(block);
        return segments;
    }

    function enqueueBlockOf(node) {
        const block = blockOf(node);
        if (block) state.queue.add(block);
    }

    function enqueueNode(node) {
        if (isPaused()) return;
        if (shouldSkipTextNode(node)) return;
        enqueueBlockOf(node);
        state.metrics.queuePeak = Math.max(
            state.metrics.queuePeak,
            state.queue.size
        );
        scheduleFlush();
    }

    function enqueueTree(root) {
        if (!root) return;
        if (isPaused()) {
            discoverAndObserveShadowRoots(root);
            return;
        }

        if (root.nodeType === Node.TEXT_NODE) {
            enqueueNode(root);
            return;
        }
        if (
            root.nodeType !== Node.ELEMENT_NODE &&
            root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
        ) return;

        if (
            root.nodeType === Node.ELEMENT_NODE &&
            root.matches?.(SKIP_SELECTOR)
        ) return;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return shouldSkipTextNode(node)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while ((node = walker.nextNode())) {
            enqueueBlockOf(node);
        }

        state.metrics.queuePeak = Math.max(
            state.metrics.queuePeak,
            state.queue.size
        );

        discoverAndObserveShadowRoots(root);
        scheduleFlush();
    }

    function scheduleFlush() {
        if (state.flushTimer !== null) return;
        state.flushTimer = setTimeout(
            flushQueue,
            CONFIG.BATCH_DELAY_MS
        );
    }

    function flushQueue() {
        state.flushTimer = null;

        if (isPaused()) {
            state.queue.clear();
            return;
        }

        let processed = 0;

        for (const block of state.queue) {
            state.queue.delete(block);
            processBlock(block).catch(err => console.warn('[Grammar Fixer] block failed', err));

            processed++;

            if (processed >= CONFIG.MAX_NODES_PER_FLUSH) {
                break;
            }
        }

        if (state.queue.size) {
            scheduleFlush();
        }
    }

    // A label is short. A whole card that happens to be clickable is not:
    // review sites wrap each review in role="button", and the label rule
    // skipped the reviews themselves. So the nearest label-ish ancestor only
    // counts while its own text is label-sized.
    const MAX_LABEL_CHARS = 120;
    function insideLabel(block) {
        const label = block.closest(LABEL_SELECTOR);
        return !!label && (label.textContent || '').trim().length <= MAX_LABEL_CHARS;
    }

    async function processBlock(block) {
        if (!block || !block.isConnected || isPaused() ||
            isEditable(block.nodeType === Node.ELEMENT_NODE ? block : block.parentElement)) return;
        const generation = state.eligibilityGeneration;
        // A block that is itself a link, code, input or editable region is
        // outside the correction surface as a whole.
        if (block.nodeType === Node.ELEMENT_NODE &&
            (block.closest(SKIP_SELECTOR) || block.closest('[hidden]') ||
             insideLabel(block))) return;

        const segments = collectSegments(block);
        const texts = segments.map(seg => seg.text);
        const joined = texts.join('');
        if (joined.trim().length < 3 || joined.length > MAX_BLOCK_CHARS) return;

        state.metrics.processedNodes++;

        // Our own last write: acknowledge and stop. If the page later writes
        // something else into any node of the block, this no longer matches.
        if (state.lastBlock.get(block) === joined) return;

        // The first correction waits for the language verdict: an edit cannot
        // safely be taken back after learning the paragraph is not English.
        const language = await Lang.hintFor(block, joined);
        // The page may have rewritten the block while we waited; if so, its
        // own mutation has queued it again.
        if (!block.isConnected || isPaused() ||
            generation !== state.eligibilityGeneration ||
            isEditable(block.nodeType === Node.ELEMENT_NODE ? block : block.parentElement) ||
            collectSegments(block).map(seg => seg.text).join('') !== joined) return;
        // A language without a pack is left alone entirely.
        if (language && !GrammarFixer.packFor(language)) { state.metrics.languageSkips++; return; }

        const frozen = segments.map(seg => seg.frozen || !seg.node);
        const result = GrammarFixer.fixSegments(texts, frozen, language);
        if (!result.corrections.length) {
            state.lastBlock.delete(block);
            return;
        }

        let changed = 0;
        result.parts.forEach((text, k) => {
            const node = segments[k].node;
            if (!node || text === texts[k]) return;
            if (shouldSkipTextNode(node)) return;
            // Under a right-to-left override the reader is not reading these
            // characters in this order; leave that node alone.
            if (displayIsReversed(node)) return;
            state.lastProduced.set(node, text);
            node.nodeValue = text;
            changed++;
        });
        if (!changed) return;

        const after = collectSegments(block).map(seg => seg.text).join('');
        state.lastBlock.set(block, after);
        state.metrics.changedNodes += changed;
        recordDiagnostic(joined, after, result.corrections);
        noteFix(block, result.corrections, joined, after);
        recordCorrection();
    }

    function processTextNode(node) {
        if (!node.isConnected || shouldSkipTextNode(node)) return;

        state.metrics.processedNodes++;

        const current = node.nodeValue;

        if (!current || current.trim().length < 3) return;

        /*
         * Mutation caused by our own previous write:
         * acknowledge it and stop.
         *
         * Crucially, if Reddit later writes some OTHER value into
         * the same node, it will no longer equal lastProduced and
         * will therefore be processed again.
         */
        if (state.lastProduced.get(node) === current) return;

        const diagnostic = GrammarFixer.fixDetailed(current);
        const fixed = diagnostic.text;

        if (fixed === current) {
            /*
             * Do not permanently mark unchanged external content.
             * Reddit may replace it later.
             */
            state.lastProduced.delete(node);
            return;
        }

        /*
         * The reader may not be reading these characters in this order.
         * Under a right-to-left override, "dont" is displayed as "tnod",
         * and writing "don't" would put "t'nod" on the screen: an edit
         * to a word nobody read. Checked only here, when we are about to
         * write, so the style lookups cost nothing on text we leave alone.
         */
        if (displayIsReversed(node)) return;

        state.lastProduced.set(node, fixed);
        node.nodeValue = fixed;

        state.metrics.changedNodes++;
        recordDiagnostic(current, fixed, diagnostic.corrections);
        noteFix(node.parentElement, diagnostic.corrections, current, fixed);

        recordCorrection();
    }

    // The parade, off Reddit (2026-10-18): every paragraph the fixer
    // changed wears a stamp on the page, so an odd fix is seen where it
    // happened instead of dug out of the diagnostic report. Remembered while
    // the parade is off, so switching it on shows what was already done.
    // element → { list: its corrections, oldest first; before: the text as the
    // page first wrote it; after: the text as we last left it }
    const fixedBlocks = new Map();
    const MAX_FIXED_BLOCKS = 500;

    function noteFix(el, corrections, before, after) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE || !corrections?.length) return;
        const prev = fixedBlocks.get(el);
        const rec = {
            list: (prev ? prev.list : []).concat(corrections).slice(-20),
            before: prev ? prev.before : before,
            after,
        };
        fixedBlocks.delete(el);   // re-insert: Map order is least recently fixed first
        fixedBlocks.set(el, rec);
        if (fixedBlocks.size > MAX_FIXED_BLOCKS) fixedBlocks.delete(fixedBlocks.keys().next().value);
        if (typeof Parade !== 'undefined' && Parade.active) paradeMark(el, rec.list);
    }

    function openFinding(el, e) {
        const rec = fixedBlocks.get(el);
        if (!rec || typeof Report === 'undefined') return;
        Report.open(el, { kind: 'fixed', before: rec.before, after: rec.after, corrections: rec.list },
                    e?.clientX, e?.clientY);
    }

    // A fix the fixer never made has no stamp to click: alt-click the
    // paragraph instead, while the parade runs.
    function onAltClick(e) {
        if (!e.altKey || typeof Parade === 'undefined' || !Parade.active || typeof Report === 'undefined') return;
        const target = e.composedPath()[0];
        if (!target || target.nodeType !== Node.ELEMENT_NODE || target.closest('[data-grammar-fixer-ui]')) return;
        const block = isInline(target) ? blockOf(target.firstChild || target) : target;
        if (!block || block.nodeType !== Node.ELEMENT_NODE) return;
        e.preventDefault();
        e.stopPropagation();
        if (fixedBlocks.has(block)) return openFinding(block, e);
        const text = collectSegments(block).map(seg => seg.text).join('').trim();
        if (!text) return;
        Report.open(block, { kind: 'missed', before: text, after: text, corrections: [] }, e.clientX, e.clientY);
    }

    function paradeMark(el, list) {
        if (!el.isConnected) return;
        const rules = [...new Set(list.map(c => c.ruleId))];
        const shown = rules.slice(0, 3).join(', ') + (rules.length > 3 ? ', …' : '');
        Parade.fixed(el, `${list.length} FIXED · ${shown}`);
    }

    function paradeAll() {
        if (typeof Parade === 'undefined' || !Parade.active) return;
        for (const [el, rec] of fixedBlocks) paradeMark(el, rec.list);
    }

    function clipDiagnosticText(text) {
        if (text.length <= CONFIG.MAX_DIAGNOSTIC_TEXT) return text;
        return text.slice(0, CONFIG.MAX_DIAGNOSTIC_TEXT) + '…';
    }

    function recordDiagnostic(before, after, corrections) {
        state.diagnosticEvents.push({
            time: new Date().toISOString(),
            before: clipDiagnosticText(before),
            after: clipDiagnosticText(after),
            truncated:
                before.length > CONFIG.MAX_DIAGNOSTIC_TEXT ||
                after.length > CONFIG.MAX_DIAGNOSTIC_TEXT,
            corrections,
        });

        if (state.diagnosticEvents.length > CONFIG.MAX_DIAGNOSTIC_EVENTS) {
            state.diagnosticEvents.splice(
                0,
                state.diagnosticEvents.length - CONFIG.MAX_DIAGNOSTIC_EVENTS
            );
        }

        updateControl();
    }

    function buildDiagnosticReport() {
        return {
            schema: 'grammar-fixer-diagnostic-v1',
            exportedAt: new Date().toISOString(),
            page: {
                hostname: location.hostname,
                pathname: location.pathname,
                title: document.title,
            },
            state: {
                enabled: state.enabled,
                pausedUntil: state.pausedUntil || null,
                totalCorrections: state.totalCorrections,
                retainedEvents: state.diagnosticEvents.length,
                eventLimit: CONFIG.MAX_DIAGNOSTIC_EVENTS,
                metrics: { ...state.metrics },
            },
            events: [...state.diagnosticEvents],
        };
    }

    function downloadDiagnosticReport() {
        const report = JSON.stringify(buildDiagnosticReport(), null, 2);
        const blob = new Blob([report], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');

        link.href = url;
        link.download = `grammar-fixer-diagnostic-${stamp}.json`;
        link.style.display = 'none';
        link.setAttribute('data-grammar-fixer-ui', '');
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function recordCorrection() {
        const now = Date.now();

        state.totalCorrections++;
        state.correctionTimes.push(now);

        state.correctionTimes =
            state.correctionTimes.filter(
                t =>
                    now - t <=
                    CONFIG.BUSY_WINDOW_MS
            );

        if (
            state.correctionTimes.length >=
            CONFIG.BUSY_CORRECTION_THRESHOLD
        ) {
            showControl(true);
        } else if (state.control) {
            updateControl();
        }
    }

    function mutationHandler(mutations) {
        state.metrics.mutations += mutations.length;

        for (const mutation of mutations) {
            /*
             * Pausing disables correction, NOT observation.
             *
             * We still discover shadow roots so the architecture stays
             * attached to the current document.
             */
            if (isPaused()) {
                for (
                    const node of
                    mutation.addedNodes || []
                ) {
                    if (
                        node.nodeType ===
                        Node.ELEMENT_NODE
                    ) {
                        discoverAndObserveShadowRoots(
                            node
                        );
                    }
                }

                continue;
            }

            if (mutation.type === 'characterData') {
                const node = mutation.target;

                /*
                 * Ignore the mutation generated by our own write.
                 *
                 * If Reddit restores the old text afterward, this
                 * equality fails and we immediately queue it again.
                 */
                if (
                    state.lastProduced.get(node) ===
                    node.nodeValue
                ) {
                    continue;
                }

                enqueueNode(node);
                continue;
            }

            /*
             * New nodes may be Reddit genuinely loading more content,
             * OR Reddit destroying and recreating a comment it already
             * rendered.
             *
             * We intentionally make no distinction.
             */
            for (const node of mutation.addedNodes) {
                enqueueTree(node);
            }
        }
    }

    const observer =
        new MutationObserver(mutationHandler);

    function observeRoot(root) {
        if (
            !root ||
            state.observedRoots.has(root)
        ) {
            return;
        }

        state.observedRoots.add(root);
        state.metrics.observedRoots++;

        observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        enqueueTree(root);
    }

    function discoverAndObserveShadowRoots(root) {
        if (!root) return;

        const elements = [];

        if (root.nodeType === Node.ELEMENT_NODE) {
            elements.push(root);
        }

        root.querySelectorAll?.('*')
            .forEach(el => elements.push(el));

        for (const el of elements) {
            if (el.shadowRoot) {
                observeRoot(el.shadowRoot);
            }
        }
    }

    function createControl() {
        if (
            state.control ||
            !document.documentElement
        ) {
            return;
        }

        const host =
            document.createElement('div');

        host.setAttribute(
            'data-grammar-fixer-ui',
            ''
        );

        host.style.cssText = [
            'position:fixed',
            'top:12px',
            'right:12px',
            'z-index:2147483647',
            'font:13px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'color:#eee'
        ].join(';');

        const shadow =
            host.attachShadow({ mode: 'open' });

        shadow.innerHTML = `
            <style>
                button {
                    font: inherit;
                }

                #pill {
                    border:
                        1px solid
                        rgba(255,255,255,.22);
                    border-radius:999px;
                    background:
                        rgba(28,28,32,.96);
                    color:#fff;
                    padding:6px 10px;
                    box-shadow:
                        0 3px 14px
                        rgba(0,0,0,.28);
                    cursor:pointer;
                }

                #menu {
                    display:none;
                    position:absolute;
                    right:0;
                    margin-top:6px;
                    min-width:210px;
                    background:
                        rgba(28,28,32,.98);
                    border:
                        1px solid
                        rgba(255,255,255,.18);
                    border-radius:10px;
                    padding:8px;
                    box-shadow:
                        0 5px 20px
                        rgba(0,0,0,.35);
                }

                #menu.open {
                    display:block;
                }

                .meta {
                    padding:4px 6px 8px;
                    opacity:.8;
                }

                #events {
                    max-height:240px;
                    overflow:auto;
                    margin:0 0 7px;
                    border-top:1px solid rgba(255,255,255,.12);
                    border-bottom:1px solid rgba(255,255,255,.12);
                }

                .event {
                    padding:7px 6px;
                    border-bottom:1px solid rgba(255,255,255,.08);
                    overflow-wrap:anywhere;
                }

                .event:last-child {
                    border-bottom:0;
                }

                .rule {
                    color:#f4d35e;
                    font-size:11px;
                }

                .change {
                    margin-top:2px;
                }

                .before {
                    color:#ffaaa5;
                }

                .after {
                    color:#a8e6a3;
                }

                .action {
                    display:block;
                    width:100%;
                    border:0;
                    border-radius:7px;
                    text-align:left;
                    background:transparent;
                    color:#fff;
                    padding:7px 8px;
                    cursor:pointer;
                }

                .action:hover {
                    background:
                        rgba(255,255,255,.1);
                }
            </style>

            <button
                id="pill"
                type="button"
            >
                Grammar Fixer
            </button>

            <div id="menu">
                <div
                    class="meta"
                    id="meta"
                ></div>

                <div id="events"></div>

                <button
                    class="action"
                    id="export"
                    type="button"
                >
                    Download diagnostic report
                </button>

                <button
                    class="action"
                    id="clearLog"
                    type="button"
                >
                    Clear session log
                </button>

                <button
                    class="action"
                    id="pause"
                    type="button"
                >
                    Pause for 10 minutes
                </button>

                <button
                    class="action"
                    id="toggleSite"
                    type="button"
                >
                    Disable on this site
                </button>

                <button
                    class="action"
                    id="close"
                    type="button"
                >
                    Hide control
                </button>
            </div>
        `;

        document.documentElement
            .appendChild(host);

        state.control = {
            host,
            shadow
        };

        const pill =
            shadow.getElementById('pill');

        const menu =
            shadow.getElementById('menu');

        pill.addEventListener(
            'click',
            () =>
                menu.classList.toggle('open')
        );

        shadow
            .getElementById('export')
            .addEventListener(
                'click',
                downloadDiagnosticReport
            );

        shadow
            .getElementById('clearLog')
            .addEventListener(
                'click',
                () => {
                    state.diagnosticEvents = [];
                    updateControl();
                }
            );

        shadow
            .getElementById('pause')
            .addEventListener(
                'click',
                () => {
                    state.eligibilityGeneration++;
                    state.queue.clear();

                    state.pausedUntil =
                        Date.now() +
                        10 * 60_000;

                    menu.classList.remove('open');

                    updateControl();

                    setTimeout(() => {
                        if (
                            state.enabled &&
                            Date.now() >=
                                state.pausedUntil
                        ) {
                            state.pausedUntil = 0;
                            state.eligibilityGeneration++;

                            enqueueTree(
                                document.documentElement ||
                                document
                            );

                            updateControl();
                        }
                    }, 10 * 60_000 + 50);
                }
            );

        shadow
            .getElementById('toggleSite')
            .addEventListener(
                'click',
                async () => {
                    state.eligibilityGeneration++;
                    state.enabled =
                        !state.enabled;

                    state.queue.clear();

                    await chrome.storage.local.set({
                        [siteStorageKey()]: {
                            enabled:
                                state.enabled
                        }
                    });

                    menu.classList.remove('open');

                    if (state.enabled) {
                        enqueueTree(
                            document.documentElement ||
                            document
                        );
                    }

                    updateControl();
                }
            );

        shadow
            .getElementById('close')
            .addEventListener(
                'click',
                hideControl
            );

        updateControl();
    }

    function updateControl() {
        if (!state.control) return;

        const { shadow } = state.control;

        const pill =
            shadow.getElementById('pill');

        const meta =
            shadow.getElementById('meta');

        const toggleSite =
            shadow.getElementById(
                'toggleSite'
            );

        const pause =
            shadow.getElementById('pause');

        const events =
            shadow.getElementById('events');

        events.replaceChildren();

        const recentEvents = state.diagnosticEvents.slice(-12).reverse();

        if (!recentEvents.length) {
            const empty = document.createElement('div');
            empty.className = 'event';
            empty.textContent = 'No corrections recorded this session.';
            events.appendChild(empty);
        }

        for (const event of recentEvents) {
            for (const correction of event.corrections) {
                const row = document.createElement('div');
                const rule = document.createElement('div');
                const change = document.createElement('div');
                const before = document.createElement('span');
                const arrow = document.createTextNode(' → ');
                const after = document.createElement('span');

                row.className = 'event';
                rule.className = 'rule';
                change.className = 'change';
                before.className = 'before';
                after.className = 'after';
                rule.textContent =
                    `${correction.ruleId} · ${correction.confidence}`;
                before.textContent = correction.original;
                after.textContent = correction.replacement;
                change.append(before, arrow, after);
                row.append(rule, change);
                events.appendChild(row);
            }
        }

        if (!state.enabled) {
            pill.textContent =
                'Grammar Fixer: off';

            meta.textContent =
                `Disabled on ${location.hostname}`;

            toggleSite.textContent =
                'Enable on this site';

            pause.style.display = 'none';
        } else if (
            Date.now() < state.pausedUntil
        ) {
            const mins = Math.max(
                1,
                Math.ceil(
                    (
                        state.pausedUntil -
                        Date.now()
                    ) / 60_000
                )
            );

            pill.textContent =
                'Grammar Fixer: paused';

            meta.textContent =
                `Paused for ~${mins} min · ` +
                `${state.totalCorrections} ` +
                'corrections this page · ' +
                `${state.metrics.processedNodes} nodes checked`;

            toggleSite.textContent =
                'Disable on this site';

            pause.style.display = 'block';
        } else {
            pill.textContent =
                `Grammar Fixer · ` +
                state.totalCorrections;

            meta.textContent =
                `${state.totalCorrections} ` +
                'corrections this page · ' +
                `${state.metrics.processedNodes} nodes checked · ` +
                `queue peak ${state.metrics.queuePeak}`;

            toggleSite.textContent =
                'Disable on this site';

            pause.style.display = 'block';
        }
    }

    function showControl(autoHide = false) {
        createControl();

        if (!state.control) return;

        state.control.host.style.display =
            'block';

        updateControl();

        if (state.controlHideTimer) {
            clearTimeout(
                state.controlHideTimer
            );
        }

        if (autoHide) {
            state.controlHideTimer =
                setTimeout(() => {
                    if (
                        state.control?.shadow
                            .getElementById('menu')
                            ?.classList
                            .contains('open')
                    ) {
                        return;
                    }

                    hideControl();
                }, CONFIG.CONTROL_VISIBLE_MS);
        }
    }

    function hideControl() {
        if (!state.control) return;

        state.control.shadow
            .getElementById('menu')
            ?.classList.remove('open');

        state.control.host.style.display =
            'none';
    }

    async function loadSitePreference() {
        const key = siteStorageKey();

        const stored =
            await chrome.storage.local.get(
                key
            );

        const pref = stored[key];

        if (pref?.enabled === false) {
            state.enabled = false;
        }
    }

    // shadow-hook.js (page world) announces each open root as it is
    // attached. Observation, like everything else here, continues while
    // paused.
    let switchedOn = false;
    document.addEventListener('grammar-fixer-v01:shadow-root', event => {
        if (!switchedOn) return;
        const host = event.composedPath()[0];
        if (host && host.shadowRoot) observeRoot(host.shadowRoot);
    }, true);

    // Frames: comment sections such as Disqus live in
    // an iframe from another site, which a top-frame-only script never sees.
    // So the scripts run in every frame, and a frame starts only once it is
    // big enough to hold prose: ad slots (300x250 and friends) stay untouched.
    // Comment frames often begin small and grow as they load, so a small
    // frame waits for a resize instead of giving up.
    const IN_FRAME = window !== window.top;
    const MIN_FRAME_W = 400, MIN_FRAME_H = 300;
    function frameBigEnough() {
        return window.innerWidth >= MIN_FRAME_W && window.innerHeight >= MIN_FRAME_H;
    }

    async function start() {
        // Experimental, and off by default (2026-10-18): on some
        // sites the fixer still does odd things. Until it is switched on in
        // the panel it does nothing here at all: no fixing, no observers, no
        // pill. Switching it on takes effect at the next page load.
        const { fixOtherSites } = await chrome.storage.local.get('fixOtherSites');
        if (fixOtherSites !== true) return;
        if (IN_FRAME && !frameBigEnough()) {
            // Resize events ride on rendering, which a background tab (or a
            // headless run) may never do; a slow poll backs them up for two
            // minutes.
            let polls = 0;
            const poll = setInterval(() => { if (++polls > 120) clearInterval(poll); else grow(); }, 1000);
            const grow = () => {
                if (!frameBigEnough()) return;
                window.removeEventListener('resize', grow);
                clearInterval(poll);
                start().catch(err => console.error('[Grammar Fixer v0.1] failed to start', err));
            };
            window.addEventListener('resize', grow);
            return;
        }
        if (switchedOn) return;
        switchedOn = true;

        if (typeof Parade !== 'undefined') {
            Parade.setHooks({ onChange: paradeAll, onStamp: openFinding });
            Parade.resume();
            document.addEventListener('click', onAltClick, true);
            // The panel asks the top frame (frameId 0) for state and toggles it
            // there, then tells every frame which way it went ('gf-parade-set'),
            // so frames follow the top instead of each toggling on its own.
            chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
                if (msg?.type === 'gf-parade-set') {
                    if (msg.on !== Parade.active) Parade.toggle();
                    return;
                }
                if (msg?.type !== 'gf-state' && msg?.type !== 'gf-parade') return;
                if (msg.type === 'gf-parade') Parade.toggle();
                reply({ parade: Parade.state, fixes: state.totalCorrections, host: location.hostname });
            });
        }

        await loadSitePreference();

        /*
         * Observation is intentionally permanent even when disabled
         * or paused. A later re-enable can therefore process the
         * newest DOM instead of requiring a reload.
         */
        observeRoot(
            document.documentElement ||
            document
        );

        discoverAndObserveShadowRoots(
            document
        );

        // This development build keeps the compact control reachable so a
        // bad correction can be exported with its receipts immediately.
        // One pill per tab: frames do not get their own.
        if (!IN_FRAME) showControl(false);

        console.log(
            '[Grammar Fixer v0.1] active on',
            location.hostname
        );
    }

    start().catch(err =>
        console.error(
            '[Grammar Fixer v0.1] failed to start',
            err
        )
    );
})();
