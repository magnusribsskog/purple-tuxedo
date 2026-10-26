/* Register the page-world shadow hook only while cross-site fixing is on.
 * Persistent registration makes document_start work even when this worker
 * is asleep. Changing the setting affects future page loads.
 */
const SHADOW_ID = 'grammar-fixer-shadow-hook';
const SHADOW_SCRIPT = {
    id: SHADOW_ID,
    matches: ['http://*/*', 'https://*/*'],
    excludeMatches: ['https://www.reddit.com/*'],
    js: ['everywhere/shadow-hook.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: true,
    persistAcrossSessions: true,
};

let registration = Promise.resolve();
function reconcile() {
    // Serialize storage changes and lifecycle events. Read the preference
    // inside the queue so the last transition wins even after rapid toggles.
    registration = registration.catch(() => {}).then(async () => {
        const { fixOtherSites } = await chrome.storage.local.get('fixOtherSites');
        const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [SHADOW_ID] });
        const installed = scripts.some(script => script.id === SHADOW_ID);
        if (fixOtherSites === true && !installed) {
            await chrome.scripting.registerContentScripts([SHADOW_SCRIPT]);
        } else if (fixOtherSites !== true && installed) {
            await chrome.scripting.unregisterContentScripts({ ids: [SHADOW_ID] });
        }
    });
    return registration;
}

chrome.runtime.onInstalled.addListener(() => {
    reconcile().catch(err => console.error('[Grammar Fixer] shadow registration failed', err));
});
chrome.runtime.onStartup.addListener(() => {
    reconcile().catch(err => console.error('[Grammar Fixer] shadow registration failed', err));
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.fixOtherSites) return;
    reconcile().catch(err => console.error('[Grammar Fixer] shadow registration failed', err));
});
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'gf-sync-shadow-hook') return;
    reconcile().then(() => reply({ ok: true }), err => reply({ ok: false, error: String(err) }));
    return true;
});
