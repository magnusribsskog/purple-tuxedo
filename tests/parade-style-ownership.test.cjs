// Regression checks for the style ownership contract in parade.js.
// Run: node --test tests/parade-style-ownership.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const file = fs.readFileSync(path.join(__dirname, '../extension/parade.js'), 'utf8');
const begin = file.indexOf('    const originals = new Map();');
const end = file.indexOf('    const marked = new Map();', begin);
assert.ok(begin > 0 && end > begin, 'style ownership section found');
// Evaluate the actual production helpers rather than keeping a test copy.
const functions = file.slice(begin, end) + '\n({setParadeStyle, giveStyleBack, giveStylesBack, originals})';
const { setParadeStyle, giveStyleBack, giveStylesBack, originals } = vm.runInNewContext(functions);

function element(initial = {}) {
    const values = new Map(Object.entries(initial).map(([p, v]) => [p, Array.isArray(v) ? v : [v, '']]));
    return {
        style: {
            getPropertyValue: p => (values.get(p) || ['', ''])[0],
            getPropertyPriority: p => (values.get(p) || ['', ''])[1],
            setProperty: (p, v, priority = '') => values.set(p, [String(v), priority]),
            removeProperty: p => values.delete(p),
        },
    };
}
function style(el, property) {
    return [el.style.getPropertyValue(property), el.style.getPropertyPriority(property)];
}

test('restores original inline values and !important priorities', () => {
    const el = element({ position: ['sticky', 'important'], filter: ['blur(1px)', ''] });
    setParadeStyle(el, 'position', 'relative', 'important');
    setParadeStyle(el, 'filter', 'grayscale(1)', 'important');
    giveStylesBack(el);
    assert.deepEqual(style(el, 'position'), ['sticky', 'important']);
    assert.deepEqual(style(el, 'filter'), ['blur(1px)', '']);
    assert.equal(originals.has(el), false);
});
test('removes only properties that the parade introduced', () => {
    const el = element({ color: ['red', ''] });
    setParadeStyle(el, 'outline', '3px solid blue', 'important');
    giveStylesBack(el);
    assert.deepEqual(style(el, 'outline'), ['', '']);
    assert.deepEqual(style(el, 'color'), ['red', '']);
});
test('a newer page value survives parade cleanup', () => {
    const el = element({ position: ['static', ''] });
    setParadeStyle(el, 'position', 'relative', 'important');
    el.style.setProperty('position', 'absolute', 'important');
    giveStylesBack(el);
    assert.deepEqual(style(el, 'position'), ['absolute', 'important']);
});
test('a site write before restamping becomes the restoration baseline', () => {
    const el = element({ outline: ['1px solid red', ''] });
    setParadeStyle(el, 'outline', '3px solid blue', 'important');
    el.style.setProperty('outline', '2px dashed green');
    setParadeStyle(el, 'outline', '4px solid purple', 'important');
    giveStylesBack(el);
    assert.deepEqual(style(el, 'outline'), ['2px dashed green', '']);
});
test('repeated writes without interference preserve the initial baseline', () => {
    const el = element({ outline: ['1px solid red', ''] });
    setParadeStyle(el, 'outline', '3px solid blue', 'important');
    setParadeStyle(el, 'outline', '4px solid purple', 'important');
    giveStylesBack(el);
    assert.deepEqual(style(el, 'outline'), ['1px solid red', '']);
});
test('dim-to-mark cleanup restores filter without removing a concurrent change', () => {
    const el = element({ filter: ['blur(2px)', ''] });
    setParadeStyle(el, 'filter', 'grayscale(1) brightness(0.55)', 'important');
    giveStyleBack(el, 'filter'); // mark() ends dimming
    assert.deepEqual(style(el, 'filter'), ['blur(2px)', '']);
    setParadeStyle(el, 'filter', 'grayscale(1) brightness(0.55)', 'important');
    el.style.setProperty('filter', 'contrast(2)', 'important');
    giveStyleBack(el, 'filter');
    assert.deepEqual(style(el, 'filter'), ['contrast(2)', 'important']);
    assert.equal(originals.has(el), false);
});
