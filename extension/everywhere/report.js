/*
 * Purple Tuxedo — finding cards and the report basket (2026-10-19)
 * =====================================================================
 *
 * The parade shows where the grammar fixer acted. This turns what you see
 * into a report a maintainer or an AI can work from without a single
 * follow-up question, and lets one report carry many bugs.
 *
 *   - Click a FIXED stamp: a card with everything about that paragraph
 *     (before, after, each correction with its rule and confidence, the URL,
 *     a short DOM path), a verdict, and a field for your own observation.
 *   - Alt-click any paragraph while the parade runs: the same card for a fix
 *     the fixer MISSED, which has no stamp to click.
 *   - "Add to report" puts the finding in a basket that lasts across pages
 *     (chrome.storage.local, key tuxBasket). The panel ships the basket as
 *     one .org file into a subfolder of Downloads.
 *
 * A finding carries only its own paragraph, never the rest of the page.
 * The card is our own element in a CLOSED shadow root (the shadow hook only
 * announces open ones), marked data-grammar-fixer-ui, so the fixer never
 * reads or fixes it.
 */

const Report = (() => {
    'use strict';

    const BASKET = 'tuxBasket';
    const MAX_TEXT = 2000;
    const ENGINE = '0.1';
    const VERDICTS = [
        ['wrong-fix', 'Wrong fix'],
        ['should-fix', 'Should have fixed'],
        ['ugly', 'Right, but ugly'],
        ['curious', 'Fine, just curious'],
    ];

    let card = null;

    function clip(text) {
        text = String(text ?? '');
        return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
    }

    // A short path a person and a model can both read: up to eight steps,
    // ids that look generated are left out, and shadow boundaries are marked.
    function domPath(el) {
        const steps = [];
        let node = el;
        while (node && steps.length < 8) {
            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && node.host) {
                steps.push('⟨shadow⟩');
                node = node.host;
                continue;
            }
            if (node.nodeType !== Node.ELEMENT_NODE ||
                node === document.body || node === document.documentElement) break;
            let step = node.tagName.toLowerCase();
            if (node.id && !/\d{3,}|[0-9a-f]{8,}/i.test(node.id)) step += '#' + node.id;
            else if (node.classList.length) step += '.' + [...node.classList].slice(0, 2).join('.');
            steps.push(step);
            node = node.parentNode;
        }
        return steps.reverse().join(' › ');
    }

    async function basket() {
        const stored = await chrome.storage.local.get(BASKET);
        return stored[BASKET] || [];
    }

    async function addToBasket(finding) {
        const list = await basket();
        list.push(finding);
        await chrome.storage.local.set({ [BASKET]: list });
        return list.length;
    }

    function newId() {
        return 'tux-' + new Date().toISOString().slice(0, 10) + '-' +
            Math.random().toString(16).slice(2, 6);
    }

    function close() {
        if (card) card.remove();
        card = null;
        document.removeEventListener('keydown', onKey, true);
    }

    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    const CSS = `
        :host { all: initial; }
        .card { box-sizing: border-box; width: 420px; max-height: 70vh; overflow: auto;
                font: 13px/1.4 system-ui, sans-serif; color: #1a1a1a; background: #fffdf7;
                border: 2px solid #2e9e6a; border-radius: 10px; padding: 10px 12px;
                box-shadow: 0 8px 28px rgba(0,0,0,0.35); }
        h1 { font-size: 14px; margin: 0 0 6px; }
        .host { font-weight: normal; color: #666; }
        .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin: 8px 0 2px; }
        pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 4px 6px;
              background: #f1efe6; border-radius: 4px; font: 12px/1.35 ui-monospace, monospace; }
        ul { margin: 0; padding-left: 18px; }
        li { font: 12px ui-monospace, monospace; }
        .verdicts { display: flex; flex-wrap: wrap; gap: 4px; }
        .verdicts button { font: 12px system-ui; padding: 3px 8px; border: 1px solid #2e9e6a;
                           border-radius: 12px; background: #fff; cursor: pointer; }
        .verdicts button.on { background: #2e9e6a; color: #fff; }
        textarea { box-sizing: border-box; width: 100%; min-height: 64px; font: 13px system-ui;
                   padding: 4px 6px; border: 1px solid #bbb; border-radius: 4px; resize: vertical; }
        .row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
        .row button { font: 600 12px system-ui; padding: 4px 10px; border-radius: 6px; cursor: pointer;
                      border: 1px solid #2e9e6a; background: #2e9e6a; color: #fff; }
        .row button.plain { background: #fff; color: #1a1a1a; border-color: #bbb; }
        .status { color: #666; font-size: 12px; }
    `;

    function el(tag, props = {}, text) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        if (text != null) node.textContent = text;
        return node;
    }

    /*
     * data: { kind: 'fixed' | 'missed', before, after, corrections }
     * Page text only ever goes in through textContent.
     */
    async function open(target, data, x = 40, y = 40) {
        close();
        const finding = {
            id: newId(),
            kind: data.kind,
            verdict: data.kind === 'missed' ? 'should-fix' : 'wrong-fix',
            note: '',
            found: new Date().toISOString(),
            url: location.href,
            host: location.hostname,
            route: location.pathname,
            dom: domPath(target),
            before: clip(data.before),
            after: clip(data.after),
            corrections: (data.corrections || []).map(c => ({
                rule: c.ruleId, original: c.original, replacement: c.replacement,
                confidence: c.confidence,
            })),
            version: chrome.runtime.getManifest().version,
            engine: ENGINE,
        };

        const host = el('div');
        host.setAttribute('data-grammar-fixer-ui', '');
        host.setAttribute('data-tux-card', '');
        host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
        const root = host.attachShadow({ mode: 'closed' });
        root.append(el('style', {}, CSS));
        const box = el('div', { className: 'card' });
        root.append(box);

        const h1 = el('h1', {}, data.kind === 'missed' ? 'Missed fix ' : 'Finding ');
        h1.append(el('span', { className: 'host' }, '· ' + finding.host));
        box.append(h1);

        if (data.kind === 'missed') {
            box.append(el('div', { className: 'label' }, 'Paragraph'), el('pre', {}, finding.before));
        } else {
            box.append(el('div', { className: 'label' }, 'Before'), el('pre', {}, finding.before));
            box.append(el('div', { className: 'label' }, 'After'), el('pre', {}, finding.after));
            const ul = el('ul');
            for (const c of finding.corrections) {
                ul.append(el('li', {}, `${c.rule} (${c.confidence}): ${c.original} → ${c.replacement}`));
            }
            box.append(el('div', { className: 'label' }, 'Corrections'), ul);
        }
        box.append(el('div', { className: 'label' }, 'Where'), el('pre', {}, finding.dom || '(page root)'));

        box.append(el('div', { className: 'label' }, 'Verdict'));
        const verdicts = el('div', { className: 'verdicts' });
        for (const [key, label] of VERDICTS) {
            const b = el('button', { type: 'button' }, label);
            if (key === finding.verdict) b.classList.add('on');
            b.addEventListener('click', () => {
                finding.verdict = key;
                for (const other of verdicts.children) other.classList.toggle('on', other === b);
            });
            verdicts.append(b);
        }
        box.append(verdicts);

        box.append(el('div', { className: 'label' }, 'Your observation'));
        const privacy = el('div', { className: 'status' },
            'Goes in the report: this paragraph and the address of this page, nothing else.');
        const note = el('textarea', { placeholder: 'What did you see? Why is it wrong, or interesting?' });
        box.append(note, privacy);

        const row = el('div', { className: 'row' });
        const add = el('button', { type: 'button' }, 'Add to report');
        const cancel = el('button', { type: 'button', className: 'plain' }, 'Close');
        const status = el('span', { className: 'status' });
        row.append(add, cancel, status);
        box.append(row);

        basket().then(list => {
            if (list.length) status.textContent = `${list.length} in the report`;
        });
        add.addEventListener('click', async () => {
            finding.note = note.value.trim();
            const n = await addToBasket(finding);
            status.textContent = `Added. ${n} in the report; ship it from the Tux panel.`;
            add.disabled = true;
            setTimeout(close, 1200);
        });
        cancel.addEventListener('click', close);
        // Keystrokes in the card belong to the card, not to the page's shortcuts.
        box.addEventListener('keydown', e => e.stopPropagation());

        (document.body || document.documentElement).append(host);
        const w = 420, h = Math.min(box.offsetHeight || 360, innerHeight * 0.7);
        host.style.left = Math.max(8, Math.min(x + 12, innerWidth - w - 16)) + 'px';
        host.style.top = Math.max(8, Math.min(y + 12, innerHeight - h - 16)) + 'px';
        card = host;
        document.addEventListener('keydown', onKey, true);
        note.focus();
    }

    return { open, close, basket };
})();
