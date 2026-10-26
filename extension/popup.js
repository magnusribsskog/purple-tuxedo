// Purple Tuxedo panel: edits the tunable settings in chrome.storage.local
// (content.js re-judges the open thread when they change) and shows what Tux
// did on the current tab, lookup failures included.

const inputs = [...document.querySelectorAll('[data-key]')];
let defaults = {};
let slop = {};   // word -> [category, points], as the panel shows it

function renderWords() {
    const box = document.getElementById('words');
    box.innerHTML = '';
    for (const word of Object.keys(slop).sort()) {
        const [cat, pts] = slop[word];
        const row = document.createElement('div');
        row.className = 'w';
        row.innerHTML = `<span></span><select><option>grammar</option><option>slang</option></select>` +
                        `<input type="number" min="0" step="1"><button class="x" title="Remove">✕</button>`;
        row.children[0].textContent = word;
        row.children[1].value = cat;
        row.children[2].value = pts;
        row.children[1].addEventListener('change', e => { slop[word][0] = e.target.value; save(); });
        row.children[2].addEventListener('input', e => { slop[word][1] = Number(e.target.value); save(); });
        row.children[3].addEventListener('click', () => { delete slop[word]; renderWords(); save(); });
        box.appendChild(row);
    }
}

function render(config) {
    for (const el of inputs) {
        const v = config[el.dataset.key];
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
}

function read() {
    return { ...Object.fromEntries(inputs.map(el => [el.dataset.key,
        el.type === 'checkbox' ? el.checked : Number(el.value)])), slopWeights: slop };
}

let saveTimer;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ tuxSettings: read() }), 300);
}

function row(name, value, cls = '') {
    return `<span class="${cls}">${name}</span><span class="n ${cls}">${value}</span>`;
}

function showStats(r) {
    const s = r.stats, f = s.failures;
    const hidden = Object.values(s.hidden).reduce((a, b) => a + b, 0);
    const fails = f.noBody + f.noScore + f.noThingId + (f.noText || 0) + (f.thrown || 0);
    const box = document.getElementById('stats');
    box.innerHTML =
        row('Top-level comments judged', s.judged) +
        row('Hidden', `${hidden} <span class="ok">(short ${s.hidden.Short || 0}, slop ${s.hidden.Slop || 0}, collapsed ${s.hidden.Collapsed || 0})</span>`) +
        row('🤵‍♂️ Tuxedos', s.tuxedos, 'tux') +
        row('⭐ Heroes', s.heroes, 'hero') +
        row('Spared by upvotes', s.sparedByUpvotes) +
        row('Paragraphs fixed', s.paragraphsFixed) +
        (fails
            ? row('Unreadable: no text', f.noBody, f.noBody ? 'fail' : '') +
              row('Unreadable: no score', f.noScore, f.noScore ? 'fail' : '') +
              row('Unreadable: no id', f.noThingId, f.noThingId ? 'fail' : '') +
              row('No text after waiting', f.noText || 0, f.noText ? 'fail' : '') +
              row('Errors (see console)', f.thrown || 0, f.thrown ? 'fail' : '')
            : row('Lookup failures', 'none', 'ok'));
    box.hidden = false;
    document.getElementById('ver').textContent = 'v' + r.version;
    if (r.parade) {
        const btn = document.getElementById('parade');
        document.getElementById('paradeBox').hidden = false;
        btn.classList.toggle('on', r.parade.active);
        btn.textContent = r.parade.active ? '🦆 Adjourn the parade' : '🦆 Brainrot Parade';
        const m = Math.floor(r.parade.secondsLeft / 60), sec = String(r.parade.secondsLeft % 60).padStart(2, '0');
        document.getElementById('paradeState').textContent = r.parade.active ? `court adjourns in ${m}:${sec}` : '';
    }
}

let live = null;
async function refresh() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'tux-stats' });
        defaults = r.defaults;
        live = r;
        showStats(r);
        return r.config;
    } catch {
        document.getElementById('offpage').hidden = false;
        return null;
    }
}

async function init() {
    const cfg = await refresh();
    const { tuxSettings } = await chrome.storage.local.get('tuxSettings');
    if (!cfg && !tuxSettings) {
        // Off Reddit and never tuned: there are no values to show yet.
        inputs.forEach(el => { el.disabled = true; });
        document.getElementById('reset').disabled = true;
        document.getElementById('add').disabled = true;
        return;
    }
    render({ ...defaults, ...(cfg || {}), ...(tuxSettings || {}) });
    slop = structuredClone(tuxSettings?.slopWeights || live?.slopWeights || defaults.slopWeights || {});
    renderWords();
    setInterval(refresh, 1500);
}

for (const el of inputs) el.addEventListener('input', save);

document.getElementById('add').addEventListener('click', () => {
    const word = document.getElementById('newWord').value.toLowerCase().trim();
    if (!word || /\s/.test(word)) return;
    slop[word] = [document.getElementById('newCat').value, Number(document.getElementById('newPts').value) || 0];
    document.getElementById('newWord').value = '';
    renderWords();
    save();
});

document.getElementById('reset').addEventListener('click', async () => {
    await chrome.storage.local.remove('tuxSettings');
    render(defaults);
    slop = structuredClone(defaults.slopWeights || {});
    renderWords();
});

document.getElementById('parade').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { await chrome.tabs.sendMessage(tab.id, { type: 'tux-parade' }); } catch {}
    refresh();
});

init();

// Grammar fixing on other sites: experimental and off by default. Its own
// setting, outside tuxSettings, so it works off Reddit and survives "Reset".
const otherSites = document.getElementById('otherSites');
chrome.storage.local.get('fixOtherSites').then(({ fixOtherSites }) => {
    otherSites.checked = fixOtherSites === true;
});
otherSites.addEventListener('change', async () => {
    const enabled = otherSites.checked;
    try {
        await chrome.storage.local.set({ fixOtherSites: enabled });
        const result = await chrome.runtime.sendMessage({ type: 'gf-sync-shadow-hook' });
        if (!result?.ok) throw new Error(result?.error || 'shadow registration failed');
    } catch (err) {
        otherSites.checked = !enabled;
        await chrome.storage.local.set({ fixOtherSites: !enabled });
        console.error('[Grammar Fixer] cross-site setting failed', err);
    }
});

// The parade off Reddit: only answered where the fixer is switched on and
// running (everywhere/content.js). On Reddit, and where it is off, no answer.
const fixParade = document.getElementById('fixParade');
// The fixer runs in every big-enough frame (comment sections are often
// iframes), and a broadcast answers with whichever frame replies first. So
// ask the top frame, and after a toggle tell all frames which way it went.
async function askFixer(type) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let r = null;
    try { r = await chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 }); } catch { return null; }
    if (type === 'gf-parade' && r) {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'gf-parade-set', on: r.parade.active }); } catch {}
    }
    return r;
}
function showFixer(r) {
    if (!r) return;
    fixParade.hidden = false;
    document.getElementById('fixParadeNote').hidden = false;
    fixParade.classList.toggle('on', r.parade.active);
    fixParade.textContent = r.parade.active ? '🦆 Adjourn the parade' : '🦆 Parade the fixes';
    document.getElementById('offpage').textContent =
        `No Reddit thread here. Grammar fixes on ${r.host} so far: ${r.fixes}.`;
}
askFixer('gf-state').then(showFixer);
fixParade.addEventListener('click', async () => showFixer(await askFixer('gf-parade')));

// ---- The report: findings from the cards, shipped as one .org file ----
// A browser extension can only write NEW files, and only under Downloads, so
// each report lands as its own file in a subfolder, never loose in Downloads.
// Whoever receives it (a maintainer, or an AI assistant) reads it from there.

const reportBox = document.getElementById('reportBox');
const shipBtn = document.getElementById('ship');
const folderInput = document.getElementById('reportFolder');

function safeFolder(raw) {
    const parts = String(raw || '').split(/[\\/]+/)
        .map(p => p.replace(/[^\w .-]/g, '').trim())
        .filter(p => p && p !== '.' && p !== '..');
    return parts.join('/') || 'tux-bugs';
}

function orgStamp(d) {
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    const p = n => String(n).padStart(2, '0');
    return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${day} ${p(d.getHours())}:${p(d.getMinutes())}]`;
}

function oneLine(text, max = 60) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function headline(f) {
    const c = f.corrections?.[0];
    if (f.kind === 'missed' || !c) return `TODO ${f.verdict}: ${oneLine(f.before)}`;
    const more = f.corrections.length > 1 ? ` (+${f.corrections.length - 1})` : '';
    return `TODO ${f.verdict}: ${c.original} → ${c.replacement}${more}`;
}

function orgReport(findings) {
    const now = new Date();
    const out = [
        `#+TITLE: Tux bug report ${orgStamp(now)}`,
        `#+STARTUP: overview`,
        `# A bug report from Purple Tuxedo's parade: one entry per finding, the`,
        `# reporter's words first, then the exact data.`,
        `# To send it: attach this file to an issue at`,
        `#   https://github.com/magnusribsskog/purple-tuxedo/issues`,
        `# or give it to your AI assistant together with the extension's source.`,
        `# It holds the paragraphs you reported and the addresses of their pages;`,
        `# read it through before you share it.`,
        '',
    ];
    const bySite = new Map();
    for (const f of findings) {
        if (!bySite.has(f.host)) bySite.set(f.host, new Map());
        const routes = bySite.get(f.host);
        if (!routes.has(f.route)) routes.set(f.route, []);
        routes.get(f.route).push(f);
    }
    for (const [host, routes] of bySite) {
        out.push(`* ${host || '(local file)'}`);
        for (const [route, list] of routes) {
            out.push(`** ${route || '/'}`);
            for (const f of list) {
                const c = f.corrections?.[0];
                out.push(`*** ${headline(f)}`,
                    '    :PROPERTIES:',
                    `    :ID:       ${f.id}`,
                    `    :FOUND:    ${orgStamp(new Date(f.found))}`,
                    `    :URL:      ${f.url}`,
                    `    :KIND:     ${f.kind}`,
                    `    :VERDICT:  ${f.verdict}`,
                    `    :RULE:     ${c ? f.corrections.map(x => `${x.rule} (${x.confidence})`).join(', ') : '-'}`,
                    `    :VERSION:  ${f.version} / engine ${f.engine}`,
                    `    :DOM:      ${f.dom || '-'}`,
                    '    :END:',
                    '    #+begin_quote');
                const note = f.note ? f.note.split('\n') : ['(no observation written)'];
                for (const line of note) out.push('    ' + line);
                out.push('    #+end_quote',
                    '    #+begin_src json');
                const data = { kind: f.kind, before: f.before, after: f.after, corrections: f.corrections };
                for (const line of JSON.stringify(data, null, 2).split('\n')) out.push('    ' + line);
                out.push('    #+end_src', '');
            }
        }
    }
    return out.join('\n') + '\n';
}

async function showReport() {
    const { tuxBasket = [], tuxReportFolder } = await chrome.storage.local.get(['tuxBasket', 'tuxReportFolder']);
    folderInput.value = tuxReportFolder || '';
    reportBox.hidden = !tuxBasket.length;
    shipBtn.textContent = `📮 Ship report (${tuxBasket.length})`;
}

folderInput.addEventListener('change', () =>
    chrome.storage.local.set({ tuxReportFolder: safeFolder(folderInput.value) }).then(showReport));

shipBtn.addEventListener('click', async () => {
    const { tuxBasket = [], tuxReportFolder } = await chrome.storage.local.get(['tuxBasket', 'tuxReportFolder']);
    if (!tuxBasket.length) return;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filename = `${safeFolder(tuxReportFolder)}/tux-report-${stamp}.org`;
    // As plain bytes: given text/plain, Chrome renames the file to .txt.
    const url = 'data:application/octet-stream;charset=utf-8,' + encodeURIComponent(orgReport(tuxBasket));
    try {
        await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
        await chrome.storage.local.set({ tuxBasket: [] });
        shipBtn.textContent = '📮 Shipped';
        setTimeout(showReport, 1500);
    } catch (e) {
        shipBtn.textContent = '📮 Could not save: ' + (e.message || e);
    }
});

document.getElementById('discard').addEventListener('click', async () => {
    if (!confirm('Throw away the findings in the report?')) return;
    await chrome.storage.local.set({ tuxBasket: [] });
    showReport();
});

showReport();
