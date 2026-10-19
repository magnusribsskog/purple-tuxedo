/*
 * Purple Tuxedo — The Brainrot Parade 🦆⚖️
 * =====================================================================
 *
 * A diagnostic mode that hides nothing. Every comment Tux would hide stays
 * on the page with a rubber stamp naming the rule that caught it; the
 * comments a hero saved, the ones upvotes spared, and the ones that barely
 * survived get stamps of their own; everything clean dims to gray. Mr. Duck,
 * Court Marshal, presides from the corner and slams his gavel at each
 * verdict. It is the fastest way to see what the thresholds actually do.
 *
 * Adapted from YouTube Tuner's clown mode (clown.js): its synthesized audio,
 * confetti, banner, parachutes, stamp slam and clean exit carry over nearly
 * as they were; the tiers, the stamps and the judge are Tux's own.
 *
 * Rules, inherited:
 *   - The parade hides nothing and decides nothing. content.js judges as
 *     usual and asks the parade to show the verdict instead of acting on it.
 *   - No stylesheet injection. Animations use the Web Animations API;
 *     cosmetic changes are inline properties, tracked and reverted on exit.
 *   - Reddit's own elements receive only reversible styling and our stamps.
 *     Overlays (the judge, confetti, banner, parachutes) are our own
 *     elements, pointer-events none, removed on exit.
 *   - Session-only, with a safety valve: the parade leaves after ten minutes,
 *     because nobody should come back to a courtroom they forgot convening.
 *   - No external assets. All audio is synthesized.
 *
 * Loaded before content.js; content.js calls in, the parade never reaches
 * into content.js except through the onChange hook it is given.
 *
 * Off Reddit (2026-10-18) the same parade runs for the experimental grammar
 * fixer (everywhere/content.js): every paragraph it changed wears a FIXED
 * stamp, floating in our own overlay layer above the page (see THE OVERLAY);
 * it turns see-through under the mouse, and a click opens a finding card
 * (everywhere/report.js).
 * A debugging aid for hardening the fixer, never on by default.
 */

const Parade = (() => {
    "use strict";

    const SAFETY_VALVE_MS = 10 * 60 * 1000;
    const CHAOS_TICK_MS   = 20 * 1000;

    let active = false;
    let activatedAt = 0;
    let safetyTimer = null, chaosTimer = null;
    let onChange = () => {};
    let onStamp = null;   // off Reddit: a click on a FIXED stamp opens its finding card
    let audioCtx = null;

    // ======================== AUDIO (all synthesized) ========================
    function ctx() {
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === "suspended") audioCtx.resume();
        return audioCtx;
    }

    function tone(freqFrom, freqTo, dur, type = "sine", gainPeak = 0.08, when = 0) {
        try {
            const ac  = ctx();
            const t0  = ac.currentTime + when;
            const osc = ac.createOscillator();
            const g   = ac.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freqFrom, t0);
            osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), t0 + dur);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(gainPeak, t0 + dur * 0.15);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            osc.connect(g).connect(ac.destination);
            osc.start(t0);
            osc.stop(t0 + dur + 0.05);
        } catch (e) { /* audio is garnish */ }
    }

    // Chrome keeps page audio muted until the PAGE gets a gesture; a popup
    // click does not count. The first click or key on the page unlocks it.
    function armAudioUnlock() {
        const unlock = () => { try { ctx(); } catch (e) {} };
        window.addEventListener("pointerdown", unlock, { once: true, capture: true });
        window.addEventListener("keydown",     unlock, { once: true, capture: true });
    }

    const bonk = () => { tone(240, 120, 0.06, "square", 0.05); tone(95, 55, 0.14, "sine", 0.12); };  // wood on wood
    const quack = () => [0, 0.09].forEach(w => tone(620, 380, 0.08, "sawtooth", 0.035, w));
    function fanfare() {
        [[523, 0], [659, 0.18], [784, 0.36]].forEach(([f, when]) => tone(f, f, 0.16, "square", 0.06, when));
    }

    // ======================== CONFETTI, BANNER, PARACHUTES ========================
    const CONFETTI_COLORS = ["#9b4d96", "#e0b440", "#f2d24b", "#c58bc1", "#ffffff", "#e8892a"];

    function confettiBurst(x, y, count = 36) {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            canvas.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
            document.documentElement.appendChild(canvas);
            const c = canvas.getContext("2d");
            const parts = Array.from({ length: count }, () => ({
                x, y, vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 11 - 3,
                w: Math.random() * 7 + 4, h: Math.random() * 4 + 2,
                rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
                color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
            }));
            const t0 = performance.now();
            (function frame(t) {
                c.clearRect(0, 0, canvas.width, canvas.height);
                let alive = false;
                for (const p of parts) {
                    p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
                    if (p.y < canvas.height + 20) alive = true;
                    c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
                    c.fillStyle = p.color; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    c.restore();
                }
                if (alive && t - t0 < 2500) requestAnimationFrame(frame);
                else canvas.remove();
            })(t0);
        } catch (e) { /* garnish */ }
    }

    function banner(text) {
        try {
            const b = document.createElement("div");
            b.textContent = text;
            b.style.cssText = `
                position: fixed; top: 18%; left: 50%; z-index: 2147483646;
                transform: translateX(-50%);
                background: #9b4d96; color: #fff;
                border: 5px solid; padding: 16px 30px; border-radius: 16px;
                border-image: repeating-linear-gradient(45deg, #f2d24b 0 10px, #fff 10px 20px) 5;
                font-family: 'Comic Sans MS', 'Comic Sans', cursive;
                font-size: 28px; font-weight: 900; letter-spacing: 1px;
                pointer-events: none; white-space: nowrap;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6);
            `;
            document.documentElement.appendChild(b);
            b.animate([
                { transform: "translateX(-50%) translateY(-250%) rotate(-6deg)" },
                { transform: "translateX(-50%) translateY(12%) rotate(3deg)", offset: 0.55 },
                { transform: "translateX(-50%) translateY(-4%) rotate(-1deg)", offset: 0.75 },
                { transform: "translateX(-50%) translateY(0) rotate(0deg)" },
            ], { duration: 900, easing: "ease-out" });
            setTimeout(() => {
                const out = b.animate(
                    [{ opacity: 1, transform: "translateX(-50%) scale(1)" },
                     { opacity: 0, transform: "translateX(-50%) scale(0.6) rotate(8deg)" }],
                    { duration: 400, easing: "ease-in" });
                out.onfinish = () => b.remove();
            }, 2600);
        } catch (e) { /* garnish */ }
    }

    function parachute() {
        try {
            const d = document.createElement("div");
            d.textContent = Math.random() < 0.7 ? "🦆" : "⚖️";
            d.style.cssText = `position: fixed; top: -60px; left: ${8 + Math.random() * 84}vw;
                               z-index: 2147483646; font-size: 40px; pointer-events: none;`;
            document.documentElement.appendChild(d);
            const fall = d.animate([
                { transform: "translateY(0) rotate(-8deg)" },
                { transform: `translateY(40vh) translateX(${Math.random() > 0.5 ? "" : "-"}30px) rotate(8deg)`, offset: 0.5 },
                { transform: "translateY(115vh) rotate(-6deg)" },
            ], { duration: 4200 + Math.random() * 1500, easing: "linear" });
            fall.onfinish = fall.oncancel = () => d.remove();
        } catch (e) { /* garnish */ }
    }

    // ======================== MR. DUCK, COURT MARSHAL ========================
    // The duck from our Mr. Duck game, in his wig, with napkin and gavel.
    // His brow does the sentencing.
    const BROW = {
        rest:      "M2,-44 L18,-40",
        furious:   "M0,-49 L18,-37",   // a comment would be hidden
        delighted: "M2,-50 L18,-52",   // a hero saved the thread
        skeptical: "M2,-42 L18,-48",   // barely survived
        resigned:  "M2,-45 L18,-45",   // spared by upvotes
    };
    let judge = null;      // { root, gavel, brow }
    let lastSlam = 0;
    let slamQueue = 0;

    function seatJudge() {
        if (judge) return;
        try {
            const NS = "http://www.w3.org/2000/svg";
            const root = document.createElement("div");
            root.style.cssText = `position: fixed; right: 18px; bottom: 18px; width: 150px; height: 120px;
                                  z-index: 2147483645; pointer-events: none;
                                  filter: drop-shadow(0 6px 14px rgba(0,0,0,0.45));`;
            root.setAttribute("data-grammar-fixer-ui", "");
            // A closed shadow root: page CSS cannot reach the judge. Facebook's
            // pinned the gavel's SVG transform (2026-10-19): the bonk sounded,
            // the gavel never moved.
            const shadow = root.attachShadow({ mode: "closed" });
            shadow.innerHTML = `
              <svg xmlns="${NS}" viewBox="250 40 320 230" width="150" height="120" aria-hidden="true">
                <rect x="250" y="150" width="300" height="110" rx="6" fill="#6b4423"/>
                <rect x="240" y="140" width="320" height="18" rx="4" fill="#8a5a2e"/>
                <g transform="translate(400,112)">
                  <ellipse cx="0" cy="18" rx="46" ry="34" fill="#f2d24b"/>
                  <circle cx="0" cy="-28" r="26" fill="#f2d24b"/>
                  <path d="M22,-26 L50,-20 L22,-14 Z" fill="#e8892a"/>
                  <circle cx="9" cy="-34" r="4" fill="#111"/>
                  <path class="brow" d="${BROW.rest}" stroke="#111" stroke-width="3" stroke-linecap="round"/>
                  <rect x="-20" y="4" width="18" height="16" fill="#fff" transform="rotate(-10)"/>
                  <path d="M-26,-40 q26,-30 52,0 q-6,-8 -26,-10 q-20,2 -26,10z" fill="#eee"/>
                </g>
                <g class="gavel">
                  <rect x="-4" y="0" width="8" height="46" fill="#5a3a1c"/>
                  <rect x="-18" y="-12" width="36" height="16" rx="3" fill="#7b4f28"/>
                </g>
              </svg>`;
            document.documentElement.appendChild(root);
            const gavel = shadow.querySelector(".gavel");
            gavel.setAttribute("transform", "translate(520,120) rotate(-30)");
            judge = { root, gavel, brow: shadow.querySelector(".brow") };
            root.animate([{ transform: "translateY(160px)" }, { transform: "translateY(-8px)", offset: 0.7 },
                          { transform: "translateY(0)" }], { duration: 700, easing: "ease-out" });
        } catch (e) { judge = null; }
    }

    function unseatJudge() {
        if (!judge) return;
        const j = judge; judge = null;
        try {
            const out = j.root.animate([{ transform: "translateY(0)" }, { transform: "translateY(170px)" }],
                                       { duration: 500, easing: "ease-in" });
            out.onfinish = out.oncancel = () => j.root.remove();
        } catch (e) { j.root.remove(); }
    }

    // One swing per verdict, but never a drum roll: verdicts that land
    // together (a whole thread judged at once) queue a few slams, not dozens.
    function slam(mood) {
        if (!judge) return;
        judge.brow.setAttribute("d", BROW[mood] || BROW.rest);
        const now = performance.now();
        if (now - lastSlam < 260) { slamQueue = Math.min(slamQueue + 1, 2); return; }
        lastSlam = now;
        swing();
        if (slamQueue > 0) { slamQueue--; setTimeout(() => slam(mood), 280); }
    }

    function swing() {
        if (!judge) return;
        let t0 = null;
        const frames = [-30, 38, -30];   // SVG transforms animate by hand: rotate is an attribute
        const step = now => {
            if (!judge) return;
            t0 ??= now;
            const k = Math.min((now - t0) / 260, 1);
            const a = k < 0.45 ? frames[0] + (frames[1] - frames[0]) * (k / 0.45)
                               : frames[1] + (frames[2] - frames[1]) * ((k - 0.45) / 0.55);
            judge.gavel.setAttribute("transform", `translate(520,120) rotate(${a.toFixed(1)})`);
            if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        setTimeout(bonk, 110);
    }

    // ======================== STAMPS ========================
    const TIER_STYLE = {
        hit: {          // Tux would hide this
            outline: "4px solid #e0b440", glow: "0 0 22px 5px rgba(224,180,64,0.5)",
            stamp: "background: rgba(170,25,45,0.93); color: #fff; border: 3px dashed #fff; font-size: 20px; padding: 5px 14px;",
            tilt: -7, mood: "furious",
        },
        saved: {        // weak, but a hero replied
            outline: "4px solid #9b4d96", glow: "0 0 22px 5px rgba(155,77,150,0.45)",
            stamp: "background: rgba(155,77,150,0.95); color: #fff; border: 3px solid #f2d24b; font-size: 18px; padding: 5px 14px;",
            tilt: 5, mood: "delighted",
        },
        near: {         // passed, but only just
            outline: "3px dashed rgba(224,180,64,0.75)", glow: "none",
            stamp: "background: rgba(242,210,75,0.94); color: #1a1a1a; border: 2px dashed #1a1a1a; font-size: 13px; padding: 3px 10px;",
            tilt: 6, mood: "skeptical",
        },
        spared: {       // weak, kept by its upvotes
            outline: "3px solid #6f7a87", glow: "none",
            stamp: "background: rgba(87,101,116,0.94); color: #fff; border: 2px solid #fff; font-size: 13px; padding: 3px 10px;",
            tilt: -4, mood: "resigned",
        },
        fix: {          // off Reddit: the grammar fixer changed this paragraph
            outline: "3px solid #2e9e6a", glow: "0 0 16px 3px rgba(46,158,106,0.4)",
            stamp: "background: rgba(30,120,80,0.94); color: #fff; border: 2px dashed #fff; font-size: 13px; padding: 3px 10px;",
            tilt: -3, mood: "skeptical",
        },
    };
    const STYLED = ["outline", "outline-offset", "box-shadow", "position", "filter", "transition"];

    const marked = new Map();   // comment → { stampEl, tier, text }
    const dimmed = new Set();


    // ======================== THE OVERLAY (FIXED stamps, off Reddit) ========================
    // Stamps placed INSIDE a page's elements belong to its stacking order and
    // its framework. On Facebook (2026-10-19) a stamp over a video sat under
    // the player's click layer, so clicks went to the video; and React's
    // re-renders wiped stamps it did not own. So FIXED stamps and their
    // outlines live in our own layer at the top of the document, in a closed
    // shadow root no page CSS can reach, positioned over each paragraph from
    // its on-screen rectangle. The page's own elements are never touched.
    let layer = null;        // { host, root }
    const floating = new Map();   // paragraph → { box, stampEl, text }
    let placeQueued = false, placeTimer = null;

    function ensureLayer() {
        if (layer && layer.host.isConnected) return layer;
        const host = document.createElement("div");
        host.setAttribute("data-grammar-fixer-ui", "");
        host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483644; pointer-events: none;";
        const root = host.attachShadow({ mode: "closed" });
        document.documentElement.appendChild(host);
        layer = { host, root };
        addEventListener("scroll", queuePlace, true);
        addEventListener("resize", queuePlace);
        placeTimer = setInterval(placeAll, 500);   // layout shifts and removals scroll nothing
        return layer;
    }

    function dropLayer() {
        removeEventListener("scroll", queuePlace, true);
        removeEventListener("resize", queuePlace);
        clearInterval(placeTimer);
        placeTimer = null;
        for (const f of floating.values()) { f.box.remove(); f.stampEl.remove(); }
        floating.clear();
        if (layer) layer.host.remove();
        layer = null;
    }

    function queuePlace() {
        if (placeQueued) return;
        placeQueued = true;
        requestAnimationFrame(() => { placeQueued = false; placeAll(); });
    }

    function place(el, f) {
        const r = el.getBoundingClientRect();
        const hidden = !r.width || !r.height || r.bottom < 0 || r.top > innerHeight;
        f.box.style.display = f.stampEl.style.display = hidden ? "none" : "block";
        if (hidden) return;
        Object.assign(f.box.style, { left: (r.left - 4) + "px", top: (r.top - 4) + "px",
                                     width: (r.width + 8) + "px", height: (r.height + 8) + "px" });
        const w = f.stampEl.offsetWidth;
        f.stampEl.style.left = Math.max(4, Math.min(r.right - w - 12, innerWidth - w - 8)) + "px";
        f.stampEl.style.top = Math.max(4, r.top + 4) + "px";
    }

    function placeAll() {
        for (const [el, f] of floating) {
            if (!el.isConnected) {   // the page removed the paragraph: its stamp goes too
                f.box.remove(); f.stampEl.remove(); floating.delete(el);
                continue;
            }
            place(el, f);
        }
    }

    function floatMark(el, text) {
        const style = TIER_STYLE.fix;
        const prev = floating.get(el);
        if (prev && prev.text === text) return false;
        if (prev) { prev.box.remove(); prev.stampEl.remove(); }
        const { root } = ensureLayer();
        const box = document.createElement("div");
        box.style.cssText = `position: fixed; box-sizing: border-box; border: ${style.outline};
                             border-radius: 6px; box-shadow: ${style.glow}; pointer-events: none;`;
        const stampEl = document.createElement("div");
        stampEl.textContent = text;
        stampEl.style.cssText = `
            position: fixed; z-index: 1; font-family: 'Comic Sans MS', 'Comic Sans', cursive;
            font-weight: 900; letter-spacing: 1px; white-space: nowrap; border-radius: 8px;
            pointer-events: auto; cursor: pointer; transition: opacity 0.15s;
            transform: rotate(${style.tilt}deg); ${style.stamp}`;
        // See-through under the mouse, so the text beneath stays readable;
        // a click opens the finding card.
        stampEl.addEventListener("mouseenter", () => { stampEl.style.opacity = "0.15"; });
        stampEl.addEventListener("mouseleave", () => { stampEl.style.opacity = "1"; });
        stampEl.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            if (onStamp) onStamp(el, e);
        });
        root.append(box, stampEl);
        const f = { box, stampEl, text };
        floating.set(el, f);
        place(el, f);
        stampEl.animate([
            { transform: `rotate(${style.tilt}deg) scale(2.4)`, opacity: 0 },
            { transform: `rotate(${style.tilt}deg) scale(0.9)`, opacity: 1, offset: 0.7 },
            { transform: `rotate(${style.tilt}deg) scale(1)`,   opacity: 1 },
        ], { duration: 350, easing: "ease-in" });
        slam(style.mood);
        return true;
    }

    function mark(el, tier, text) {
        if (!active) return false;
        if (tier === "fix") { try { return floatMark(el, text); } catch (e) { return false; } }
        const prev = marked.get(el);
        if (prev) {
            if (prev.tier === tier && prev.text === text && prev.stampEl.isConnected) return false;
            prev.stampEl.remove();
        }
        try {
            const style = TIER_STYLE[tier];
            dimmed.delete(el);
            el.style.removeProperty("filter");
            el.style.setProperty("outline", style.outline, "important");
            el.style.setProperty("outline-offset", "4px", "important");
            el.style.setProperty("box-shadow", style.glow, "important");
            el.style.setProperty("position", "relative", "important");

            const stampEl = document.createElement("div");
            stampEl.className = "tux-parade-stamp";
            // The grammar fixer must never fix our own stamps.
            stampEl.setAttribute("data-grammar-fixer-ui", "");
            stampEl.textContent = text;
            stampEl.style.cssText = `
                position: absolute; top: 4px; right: 12px; z-index: 5;
                font-family: 'Comic Sans MS', 'Comic Sans', cursive;
                font-weight: 900; letter-spacing: 1px; white-space: nowrap;
                border-radius: 8px; pointer-events: none;
                transform: rotate(${style.tilt}deg);
                ${style.stamp}
            `;
            el.appendChild(stampEl);
            stampEl.animate([
                { transform: `rotate(${style.tilt}deg) scale(2.4)`, opacity: 0 },
                { transform: `rotate(${style.tilt}deg) scale(0.9)`, opacity: 1, offset: 0.7 },
                { transform: `rotate(${style.tilt}deg) scale(1)`,   opacity: 1 },
            ], { duration: 350, easing: "ease-in" });
            marked.set(el, { stampEl, tier, text });
            slam(style.mood);
            return true;
        } catch (e) { return false; }
    }

    function dim(el) {
        if (!active || dimmed.has(el) || marked.has(el)) return;
        try {
            el.style.setProperty("filter", "grayscale(1) brightness(0.55)", "important");
            el.style.setProperty("transition", "filter 0.4s", "important");
            dimmed.add(el);
        } catch (e) { /* garnish */ }
    }

    function clear() {
        dropLayer();
        for (const el of dimmed) for (const p of STYLED) el.style.removeProperty(p);
        dimmed.clear();
        for (const [el, m] of marked) {
            m.stampEl.remove();
            for (const p of STYLED) el.style.removeProperty(p);
        }
        marked.clear();
    }

    // ======================== LIFECYCLE ========================
    function on() {
        if (active) return;
        active = true;
        activatedAt = Date.now();
        armAudioUnlock();
        seatJudge();
        fanfare();
        banner("⚖️ ALL RISE 🦆");
        const w = window.innerWidth, h = window.innerHeight;
        confettiBurst(w * 0.3, h * 0.3, 40);
        setTimeout(() => confettiBurst(w * 0.7, h * 0.3, 40), 250);
        chaosTimer = setInterval(() => { parachute(); if (Math.random() < 0.3) quack(); }, CHAOS_TICK_MS);
        safetyTimer = setTimeout(() => off("⚖️ court is adjourned 🦆"), SAFETY_VALVE_MS);
        onChange();
    }

    function off(text = "⚖️ court is adjourned 🦆") {
        if (!active) return;
        active = false;
        clearTimeout(safetyTimer);
        clearInterval(chaosTimer);
        safetyTimer = chaosTimer = null;
        clear();
        unseatJudge();
        banner(text);
        onChange();
    }

    return {
        get active() { return active; },
        get state() {
            return { active, secondsLeft: active ? Math.max(0, Math.round((SAFETY_VALVE_MS - (Date.now() - activatedAt)) / 1000)) : 0 };
        },
        setHooks(hooks) { onChange = hooks.onChange || onChange; onStamp = hooks.onStamp || onStamp; },
        toggle() { active ? off() : on(); return this.state; },
        hit:    (el, text) => mark(el, "hit",    `🤡 ${text}`),
        saved:  (el)       => mark(el, "saved",  "⭐ SAVED BY A HERO"),
        near:   (el, text) => mark(el, "near",   `😬 BARELY SURVIVED — ${text}`),
        spared: (el, text) => mark(el, "spared", `🍀 SPARED BY UPVOTES — ${text}`),
        fixed:  (el, text) => mark(el, "fix", `✏️ ${text}`),
        dim,
        clear,
    };
})();
