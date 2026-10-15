/*
 * Grammar fixer — shadow-root announcer (runs in the page's world).
 *
 * Attaching a shadow root is not a DOM mutation: no MutationObserver hears
 * it, so content.js only ever found roots that existed when it started. A
 * root attached later, or attached to a host it had already read, stayed
 * invisible.
 *
 * content.js runs in an isolated world and cannot see the page's
 * attachShadow. This file runs in the page's world at document_start, wraps
 * attachShadow, and after each OPEN root is made, dispatches one event on
 * its host. The event does not bubble, carries no data, and is named so no
 * page listens for it by accident. content.js hears it in the capture phase
 * and starts observing host.shadowRoot. Closed roots are not announced: a
 * closed room stays closed.
 */
(() => {
    'use strict';

    const EVENT = 'grammar-fixer-v01:shadow-root';
    const proto = Element.prototype;
    const original = proto.attachShadow;
    if (typeof original !== 'function' || original.__grammarFixerWrapped) return;

    function attachShadow(init) {
        const root = original.call(this, init);
        if (init && init.mode === 'open') {
            try {
                this.dispatchEvent(new Event(EVENT, { bubbles: false, composed: true }));
            } catch (_) { /* never break the page's own call */ }
        }
        return root;
    }
    attachShadow.__grammarFixerWrapped = true;
    Object.defineProperty(proto, 'attachShadow', {
        value: attachShadow, writable: true, configurable: true, enumerable: false,
    });
})();
