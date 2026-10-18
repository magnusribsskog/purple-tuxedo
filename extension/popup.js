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
otherSites.addEventListener('change', () => chrome.storage.local.set({ fixOtherSites: otherSites.checked }));

// The parade off Reddit: only answered where the fixer is switched on and
// running (everywhere/content.js). On Reddit, and where it is off, no answer.
const fixParade = document.getElementById('fixParade');
async function askFixer(type) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { return await chrome.tabs.sendMessage(tab.id, { type }); } catch { return null; }
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
