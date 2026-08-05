// ============================================================================
// arena-client.js — shared "in-page arena.ai executor" source
//
// This module builds the JavaScript source that is injected into a REAL
// arena.ai page (Puppeteer instance or the Tampermonkey userscript) and runs
// create-evaluation requests from inside that page context:
//   - same-origin HTTPS connection (passes Cloudflare & CORS naturally)
//   - the page's own session cookies are used automatically
//   - reCAPTCHA Enterprise tokens are minted via window.grecaptcha (the google
//     script is injected on demand when the site hasn't loaded it yet)
//   - anonymous sessions are created on demand via /nextjs-api/sign-up
//     (provisional_user_id + reCAPTCHA "sign_up" token + Cloudflare Turnstile)
//   - the NDJSON stream is parsed line-by-line: a0/b0 = text, ag/bg = reasoning
//     ("thoughts"), ad/bd = finish + usage, a2/b2 = images/meta, a3/b3 = errors
//
// Reference: the actively maintained CloudWaddie/LMArenaBridge (July 2026):
//   - create-evaluation ALWAYS includes modelBMessageId
//   - the reCAPTCHA token is ALSO sent as X-Recaptcha-Token / X-Recaptcha-Action
//     headers, action "chat_submit" for chat and "sign_up" for anonymous signup
//   - no auth cookie (arena-auth-prod-v1) => anonymous sign-up is REQUIRED,
//     otherwise create-evaluation fails (typically HTTP 500)
//   - body is sent as a plain string (browser default text/plain;charset=UTF-8)
//
// Events are pushed out as plain objects: { t, s, d }
//   t: 'text' | 'reasoning' | 'finish' | 'image' | 'error' | 'done' | 'meta'
//   s: 'a' | 'b' | 'http' | 'arena' | 'signup' | 'retry' | 'request'
//   d: payload (string or object)
//
// SYNC NOTE: LMArena.js + scripts/bridge-userscript.js contain an inline copy
// of this logic (Tampermonkey cannot require() files). Regenerate it with:
//   node scripts/sync-userscript.js
// ============================================================================

// The executor factory must be 100% self-contained — no external references,
// no template literals (the sync script re-indents it mechanically) — because
// its source is stringified and injected into the page.
function arenaExecFactory() {
    'use strict';

    // ---------- constants (arena.ai, as of Aug 2026) ----------
    var RECAPTCHA_SITEKEY_CANDIDATES = [
        '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I', // current (CloudWaddie main.py, Jul 2026)
        '6Led_uYrAAAAAIP_9E8Ais_67Z6Vp4vdf40p8SQU', // previous (CloudWaddie constants.py)
        '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0'  // legacy fallback (May 2026)
    ];
    var TURNSTILE_SITEKEY = '0x4AAAAAAA65vWDmG-O_lPtT'; // arena anonymous sign-up
    var DEFAULT_RECAPTCHA_ACTION = 'chat_submit';

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // ---------- UUIDv7 (BigInt precision; server validates the timestamp) ----------
    function uuid7() {
        var ts = BigInt(Date.now());
        var randA = BigInt(Math.floor(Math.random() * 0x1000));
        var randB = BigInt(Math.floor(Math.random() * 0x3ffffffffffff));
        var uuidInt = (ts << 80n) | ((BigInt(0x7000) | (randA & 0x0fffn)) << 64n) | (0x8000000000000000n | randB);
        var h = uuidInt.toString(16).padStart(32, '0');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }

    function uuid4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.floor(Math.random() * 16);
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    // ---------- reCAPTCHA Enterprise ----------
    // Collect every sitekey we can discover: mined from the page's JS
    // (grecaptcha.execute("KEY", ...) calls), from script src render= params,
    // and finally the known-good hardcoded candidates.
    function findRecaptchaSiteKeys() {
        var keys = [];
        function add(k) { if (k && keys.indexOf(k) === -1) keys.push(k); }
        var html = '';
        try { html = (document.documentElement && document.documentElement.innerHTML) || ''; } catch (e) {}
        try {
            var re = /execute\(\s*["'](6[A-Za-z0-9_-]{20,})["']\s*,\s*\{\s*(?:action|["']action["'])\s*:\s*["']([A-Za-z0-9_ -]{1,60})["']/g;
            var m;
            while ((m = re.exec(html)) !== null) add(m[1]);
        } catch (e) {}
        try {
            var re2 = /recaptcha\/(?:enterprise|api)\.js\?[^"'\\\s]*?render=([A-Za-z0-9_-]{20,})/g;
            var m2;
            while ((m2 = re2.exec(html)) !== null) add(m2[1]);
        } catch (e) {}
        try {
            var scripts = document.querySelectorAll('script[src]');
            for (var i = 0; i < scripts.length; i++) {
                var src = scripts[i].src || '';
                if (src.indexOf('recaptcha') === -1) continue;
                var mm = src.match(/[?&](?:render|k)=([A-Za-z0-9_-]{20,})/);
                if (mm) add(mm[1]);
            }
        } catch (e) {}
        for (var j = 0; j < RECAPTCHA_SITEKEY_CANDIDATES.length; j++) add(RECAPTCHA_SITEKEY_CANDIDATES[j]);
        return keys;
    }

    // Best effort: the action the site's own JS uses (usually "chat_submit")
    function findRecaptchaAction() {
        try {
            var html = (document.documentElement && document.documentElement.innerHTML) || '';
            var m = html.match(/execute\(\s*["']6[A-Za-z0-9_-]{20,}["']\s*,\s*\{\s*(?:action|["']action["'])\s*:\s*["']([A-Za-z0-9_ -]{1,60})["']/);
            if (m && m[1]) return m[1];
        } catch (e) {}
        return '';
    }

    function hasGrecaptcha() {
        try {
            var g = window.grecaptcha;
            if (!g) return false;
            if (g.enterprise && typeof g.enterprise.execute === 'function') return true;
            return typeof g.execute === 'function';
        } catch (e) { return false; }
    }

    // The site lazy-loads reCAPTCHA; inject Google's scripts ourselves if absent
    async function ensureRecaptcha(sitekey) {
        if (hasGrecaptcha()) return true;
        if (!window.__arenaRecaptchaInjected) {
            window.__arenaRecaptchaInjected = true;
            try {
                var head = document.head || document.documentElement;
                var urls = [
                    'https://www.google.com/recaptcha/enterprise.js?render=' + encodeURIComponent(sitekey),
                    'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(sitekey)
                ];
                for (var i = 0; i < urls.length; i++) {
                    var s = document.createElement('script');
                    s.src = urls[i];
                    s.async = true;
                    s.defer = true;
                    head.appendChild(s);
                }
            } catch (e) {}
        }
        var deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (hasGrecaptcha()) return true;
            await sleep(250);
        }
        return hasGrecaptcha();
    }

    async function mintRecaptcha(action, sitekey) {
        try {
            var key = sitekey || findRecaptchaSiteKeys()[0];
            var ready = await ensureRecaptcha(key);
            if (!ready) return '';
            var g = (window.grecaptcha.enterprise && typeof window.grecaptcha.enterprise.execute === 'function')
                ? window.grecaptcha.enterprise : window.grecaptcha;
            var readyOwner = (typeof g.ready === 'function') ? g
                : ((window.grecaptcha && typeof window.grecaptcha.ready === 'function') ? window.grecaptcha : null);
            // g.ready can hang — race it with a timeout (CloudWaddie trick)
            try {
                await Promise.race([
                    new Promise(function (resolve) {
                        try { if (readyOwner) readyOwner.ready(resolve); else resolve(true); } catch (e) { resolve(true); }
                    }),
                    sleep(5000)
                ]);
            } catch (e) {}
            return await new Promise(function (resolve) {
                var settled = false;
                function done(v) { if (!settled) { settled = true; resolve(typeof v === 'string' ? v : ''); } }
                setTimeout(function () { done(''); }, 15000);
                try {
                    g.execute(key, { action: action || DEFAULT_RECAPTCHA_ACTION })
                        .then(done)
                        .catch(function () { done(''); });
                } catch (e) { done(''); }
            });
        } catch (e) { return ''; }
    }

    // ---------- Cloudflare Turnstile (anonymous sign-up) ----------
    async function ensureTurnstileScript() {
        function has() { try { return !!(window.turnstile && typeof window.turnstile.render === 'function'); } catch (e) { return false; } }
        if (has()) return true;
        if (!window.__arenaTurnstileInjected) {
            window.__arenaTurnstileInjected = true;
            try {
                var head = document.head || document.documentElement;
                var s = document.createElement('script');
                s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                s.async = true;
                s.defer = true;
                head.appendChild(s);
            } catch (e) {}
        }
        var deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (has()) return true;
            await sleep(300);
        }
        return has();
    }

    // Render an (almost invisible) Turnstile widget and wait for the token.
    // It sits in the corner so a real browser page stays visually clean, and
    // Node-side automation can still click the iframe coordinates if needed.
    async function mintTurnstileToken(timeoutMs) {
        try {
            var ok = await ensureTurnstileScript();
            if (!ok || !window.turnstile) return '';
            window.__arenaTurnstileToken = '';
            var el = document.createElement('div');
            el.style.cssText = 'position:fixed;right:8px;bottom:8px;width:70px;height:65px;opacity:0.02;z-index:2147483647;';
            (document.body || document.documentElement).appendChild(el);
            var widgetId = null;
            try {
                widgetId = window.turnstile.render(el, {
                    sitekey: TURNSTILE_SITEKEY,
                    callback: function (tok) { window.__arenaTurnstileToken = String(tok || ''); },
                    'error-callback': function () { window.__arenaTurnstileToken = ''; },
                    'expired-callback': function () { window.__arenaTurnstileToken = ''; }
                });
            } catch (e) { return ''; }
            var deadline = Date.now() + (timeoutMs || 30000);
            while (Date.now() < deadline) {
                if (window.__arenaTurnstileToken) return window.__arenaTurnstileToken;
                try {
                    if (widgetId != null && typeof window.turnstile.getResponse === 'function') {
                        var t = window.turnstile.getResponse(widgetId);
                        if (t) return String(t);
                    }
                } catch (e) {}
                await sleep(500);
            }
            return '';
        } catch (e) { return ''; }
    }

    // ---------- anonymous sign-up (required when there is no auth cookie) ----------
    function readCookie(name) {
        try {
            var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : '';
        } catch (e) { return ''; }
    }

    function deriveSessionCookieValue(text) {
        try {
            var t = String(text || '').trim();
            if (!t) return '';
            if (t.indexOf('base64-') === 0) return t;
            var obj = JSON.parse(t);
            function looksLikeSession(v) {
                return !!(v && typeof v === 'object' && v.access_token && v.refresh_token);
            }
            var session = null;
            if (looksLikeSession(obj)) session = obj;
            else if (obj && looksLikeSession(obj.session)) session = obj.session;
            else if (obj && obj.data && looksLikeSession(obj.data)) session = obj.data;
            else if (obj && obj.data && looksLikeSession(obj.data.session)) session = obj.data.session;
            if (!session) return '';
            var s = {};
            for (var k in session) { if (Object.prototype.hasOwnProperty.call(session, k)) s[k] = session[k]; }
            if (!s.expires_at) {
                var ein = parseInt(s.expires_in || 0, 10);
                if (ein > 0) s.expires_at = Math.floor(Date.now() / 1000) + ein;
            }
            return 'base64-' + btoa(JSON.stringify(s));
        } catch (e) { return ''; }
    }

    // The exact flow the arena.ai frontend performs for anonymous visitors:
    //   POST /nextjs-api/sign-up { turnstileToken, recaptchaToken, provisionalUserId }
    // afterwards the browser holds an arena-auth-prod-v1 session cookie.
    async function signUpAnon(push) {
        function log(m) { push({ t: 'meta', s: 'signup', d: m }); }
        try {
            var pid = readCookie('provisional_user_id');
            try { if (!pid) pid = (window.localStorage && window.localStorage.getItem('provisional_user_id')) || ''; } catch (e) {}
            if (!pid) {
                pid = uuid4();
                try { window.localStorage.setItem('provisional_user_id', pid); } catch (e) {}
                try { document.cookie = 'provisional_user_id=' + pid + '; path=/; max-age=31536000; SameSite=None; Secure'; } catch (e) {}
            }
            log('provisional_user_id=' + pid.slice(0, 8) + '…, minting reCAPTCHA token (action: sign_up)…');
            var keys = findRecaptchaSiteKeys();
            var recaptchaToken = '';
            for (var i = 0; i < keys.length; i++) {
                recaptchaToken = await mintRecaptcha('sign_up', keys[i]);
                if (recaptchaToken) break;
            }
            if (!recaptchaToken) {
                log('reCAPTCHA token mint failed');
                return { ok: false, stage: 'recaptcha' };
            }
            log('got reCAPTCHA token, rendering Cloudflare Turnstile widget…');
            var turnstileToken = await mintTurnstileToken(30000);
            if (!turnstileToken) {
                log('Turnstile token mint failed (blocked in this environment?)');
                return { ok: false, stage: 'turnstile' };
            }
            log('got Turnstile token, POST /nextjs-api/sign-up …');
            var base = (location && location.origin ? location.origin : 'https://arena.ai').replace(/\/$/, '');
            var resp = await fetch(base + '/nextjs-api/sign-up', {
                method: 'POST',
                credentials: 'include',
                body: JSON.stringify({
                    turnstileToken: turnstileToken,
                    recaptchaToken: recaptchaToken,
                    provisionalUserId: pid
                })
            });
            var text = '';
            try { text = await resp.text(); } catch (e) {}
            if (!resp.ok) {
                log('sign-up failed: HTTP ' + resp.status + (text ? ' — ' + text.slice(0, 160) : ''));
                return { ok: false, stage: 'http', status: resp.status, body: text.slice(0, 200) };
            }
            var cookieValue = deriveSessionCookieValue(text);
            if (cookieValue) {
                try {
                    document.cookie = 'arena-auth-prod-v1=' + encodeURIComponent(cookieValue) + '; path=/; max-age=2592000; SameSite=None; Secure';
                } catch (e) {}
            }
            log('anonymous sign-up OK' + (cookieValue ? ' (auth session received)' : ' (relying on server-set cookie)'));
            return { ok: true, cookieValue: cookieValue, provisionalUserId: pid, status: resp.status };
        } catch (e) {
            log('sign-up error: ' + (e && e.message ? e.message : String(e)));
            return { ok: false, stage: 'exception', error: e && e.message ? e.message : String(e) };
        }
    }

    // ---------- request body ----------
    // mode: 'direct' | 'direct-battle' | 'battle' | 'side-by-side' | 'agent' (agent = experimental)
    // NOTE: the current site schema ALWAYS includes modelBMessageId (even direct).
    function buildBody(opts) {
        var body = {
            id: uuid7(),
            mode: opts.mode || 'direct',
            userMessageId: uuid7(),
            modelAMessageId: uuid7(),
            modelBMessageId: uuid7(),
            userMessage: {
                content: String(opts.content || ''),
                experimental_attachments: [],
                metadata: {}
            },
            modality: opts.modality || 'chat',
            recaptchaV3Token: opts.recaptchaToken || ''
        };
        if (opts.modelAId) body.modelAId = opts.modelAId;
        if (opts.modelBId) body.modelBId = opts.modelBId;
        // 'battle' mode is anonymous — model ids must not be sent
        if (body.mode === 'battle') {
            delete body.modelAId;
            delete body.modelBId;
        }
        return body;
    }

    // Clone a captured real request body (survives arena side schema changes)
    // and patch the per-request fields: fresh UUIDv7 ids, content, models, token.
    function bodyFromTemplate(template, opts) {
        var b = JSON.parse(JSON.stringify(template || {}));
        b.id = uuid7();
        b.userMessageId = uuid7();
        b.modelAMessageId = uuid7();
        b.modelBMessageId = uuid7();
        if (b.userMessage && typeof b.userMessage === 'object') {
            b.userMessage.content = String(opts.content || '');
        } else {
            b.userMessage = { content: String(opts.content || ''), experimental_attachments: [], metadata: {} };
        }
        if (opts.mode) b.mode = opts.mode;
        if (opts.mode === 'battle') { delete b.modelAId; delete b.modelBId; }
        else if (opts.modelAId) b.modelAId = opts.modelAId;
        if (opts.mode === 'side-by-side' && opts.modelBId) b.modelBId = opts.modelBId;
        if (opts.mode !== 'side-by-side' && opts.mode !== 'battle') { delete b.modelBId; }
        if (opts.modality && !('modality' in b)) b.modality = opts.modality;
        b.recaptchaV3Token = opts.recaptchaToken || '';
        return b;
    }

    // ---------- stream line parsing ----------
    function payloadToText(v) {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        // reasoning payloads sometimes come as objects — dig for text-ish fields
        var keys = ['thinking', 'thought', 'reasoning', 'text', 'content', 'delta'];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (typeof v[k] === 'string' && v[k]) return v[k];
        }
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }

    function parseStreamLine(line, push) {
        if (!line || !line.trim()) return;
        var ci = line.indexOf(':');
        if (ci <= 0 || ci > 3) return;
        var tag = line.slice(0, ci);
        var raw = line.slice(ci + 1);
        var val;
        try { val = JSON.parse(raw); } catch (e) { val = raw; }

        switch (tag) {
            case 'a0': { // model A text delta
                var t = payloadToText(val);
                if (t === 'hasArenaError') { push({ t: 'error', s: 'arena', d: 'hasArenaError (arena rejected the request — the model may be temporarily unavailable)' }); return; }
                if (t) push({ t: 'text', s: 'a', d: t });
                return;
            }
            case 'b0': { var tb = payloadToText(val); if (tb) push({ t: 'text', s: 'b', d: tb }); return; }
            case 'ag': { var tg = payloadToText(val); if (tg) push({ t: 'reasoning', s: 'a', d: tg }); return; }
            case 'bg': { var tbg = payloadToText(val); if (tbg) push({ t: 'reasoning', s: 'b', d: tbg }); return; }
            case 'ad': { push({ t: 'finish', s: 'a', d: (val && typeof val === 'object') ? val : {} }); return; }
            case 'bd': { push({ t: 'finish', s: 'b', d: (val && typeof val === 'object') ? val : {} }); return; }
            case 'a2':
            case 'b2': { // images / metadata / heartbeats
                try {
                    var arr = Array.isArray(val) ? val : [val];
                    for (var i = 0; i < arr.length; i++) {
                        var item = arr[i];
                        if (!item || typeof item !== 'object') continue;
                        if (item.type === 'heartbeat') continue;
                        if (item.image) push({ t: 'image', s: tag === 'a2' ? 'a' : 'b', d: item.image });
                    }
                } catch (e) {}
                return;
            }
            case 'a3': { push({ t: 'error', s: 'a', d: payloadToText(val) }); return; }
            case 'b3': { push({ t: 'error', s: 'b', d: payloadToText(val) }); return; }
            case '0': { // legacy RSC text channel
                var t0 = payloadToText(val);
                if (t0) push({ t: 'text', s: 'a', d: t0 });
                return;
            }
            default: return; // hex-id RSC reference lines etc.
        }
    }

    // ---------- one HTTP attempt (returns null on success, Error on failure) ----------
    async function attempt(opts, push) {
        var base = (opts.base || (location && location.origin) || 'https://arena.ai').replace(/\/$/, '');
        var url = opts.url || (base + '/nextjs-api/stream/create-evaluation');
        // Headers: the browser sets Content-Type: text/plain;charset=UTF-8 for
        // string bodies — exactly like the site's own code. The reCAPTCHA token
        // ALSO travels in dedicated headers (the current backend reads them).
        var headers = {};
        if (opts.recaptchaToken) {
            headers['X-Recaptcha-Token'] = opts.recaptchaToken;
            headers['X-Recaptcha-Action'] = opts.recaptchaAction || DEFAULT_RECAPTCHA_ACTION;
        }
        var resp = await fetch(url, {
            method: 'POST',
            headers: headers,
            credentials: 'include',
            body: JSON.stringify(opts.body)
        });
        if (!resp.ok) {
            var snippet = '';
            try { snippet = (await resp.text()).slice(0, 300); } catch (e) {}
            var err = new Error('HTTP ' + resp.status + (snippet ? ' — ' + snippet : ''));
            err.status = resp.status;
            return err;
        }
        if (!resp.body) {
            var text2 = await resp.text();
            var lines2 = text2.split('\n');
            for (var j = 0; j < lines2.length; j++) parseStreamLine(lines2[j], push);
            return null;
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        for (;;) {
            var r = await reader.read();
            if (r.done) break;
            buffer += decoder.decode(r.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) parseStreamLine(lines[i], push);
        }
        if (buffer.trim()) parseStreamLine(buffer, push);
        return null;
    }

    // ---------- main entry: run(opts, push) ----------
    // opts: { mode, modelAId, modelBId, content, modality, base, url, template, allowSignup }
    async function run(opts, push) {
        push = (typeof push === 'function') ? push : function () {};
        opts = opts || {};
        var allowSignup = opts.allowSignup !== false;
        var signupAttempted = false;
        var lastError = null;

        var recaptchaAction = findRecaptchaAction() || DEFAULT_RECAPTCHA_ACTION;
        var siteKeys = findRecaptchaSiteKeys();
        var siteKeyIdx = 0;

        // Fallback chain for direct mode — some deployments name it 'direct-battle'
        var modeChain = ((opts.mode || 'direct') === 'direct') ? ['direct', 'direct-battle'] : [opts.mode || 'direct'];

        var maxRounds = allowSignup ? 2 : 1;

        outer:
        for (var round = 0; round < maxRounds; round++) {
            for (var mi = 0; mi < modeChain.length; mi++) {
                var mode = modeChain[mi];
                var attemptsLeft = 1 + siteKeys.length; // room for sitekey rotation + retries
                while (attemptsLeft > 0) {
                    attemptsLeft--;
                    var err = null;
                    try {
                        var token = '';
                        var usedKey = '';
                        for (var k = siteKeyIdx; k < siteKeys.length; k++) {
                            token = await mintRecaptcha(recaptchaAction, siteKeys[k]);
                            if (token) { siteKeyIdx = k; usedKey = siteKeys[k]; break; }
                        }
                        var bodyOpts = {
                            mode: mode,
                            modelAId: opts.modelAId || '',
                            modelBId: opts.modelBId || '',
                            content: opts.content || '',
                            modality: opts.modality || 'chat',
                            recaptchaToken: token
                        };
                        var body = (opts.template && typeof opts.template === 'object')
                            ? bodyFromTemplate(opts.template, bodyOpts)
                            : buildBody(bodyOpts);
                        push({ t: 'meta', s: 'request', d: {
                            mode: body.mode,
                            modelAId: String(body.modelAId || '').slice(0, 13),
                            modality: body.modality,
                            hasToken: !!token,
                            cloned: !!opts.template,
                            round: round + 1,
                            url: opts.url ? 'captured' : 'default'
                        } });
                        err = await attempt({
                            base: opts.base,
                            url: opts.url,
                            body: body,
                            recaptchaToken: token,
                            recaptchaAction: recaptchaAction
                        }, push);
                        if (!err) {
                            push({ t: 'done', s: mode, d: { mode: body.mode, sessionId: body.id } });
                            return;
                        }
                        err.status = err.status || 0;
                    } catch (e) {
                        err = e;
                        err.status = err.status || 0;
                    }

                    lastError = err;
                    var st = err.status;

                    // 403 with an invalid token → rotate to the next sitekey candidate
                    if (st === 403 && siteKeyIdx + 1 < siteKeys.length) {
                        siteKeyIdx++;
                        push({ t: 'meta', s: 'retry', d: 'HTTP 403 — rotating reCAPTCHA sitekey' });
                        continue;
                    }
                    // rate limit / transient → re-mint the token and retry once
                    if ((st === 429 || st === 403 || st === 503 || st === 0) && attemptsLeft > 0) {
                        push({ t: 'meta', s: 'retry', d: 'HTTP ' + (st || 'network') + ' — one retry after a short pause' });
                        await sleep(1500);
                        continue;
                    }
                    // Not authorized / broken session → create an anonymous session once, then restart
                    if ((st === 401 || st === 403 || st === 500) && allowSignup && !signupAttempted) {
                        signupAttempted = true;
                        push({ t: 'meta', s: 'signup', d: 'HTTP ' + st + ' — attempting anonymous arena sign-up (Turnstile + reCAPTCHA)…' });
                        var res = await signUpAnon(push);
                        if (res && res.ok) {
                            push({ t: 'meta', s: 'signup', d: 'sign-up succeeded — resending the request' });
                            continue outer;
                        }
                        lastError = new Error((err.message || String(err)) +
                            ' — and anonymous sign-up failed at stage "' + ((res && res.stage) || '?') + '"' +
                            '. Import fresh arena.ai session cookies (Configuration tab) or keep a signed-in arena.ai tab open with the Tampermonkey script.');
                        break outer;
                    }
                    // 400/404/405/422 might mean the mode name is wrong → try the next alias;
                    // 500 also advances the alias chain (arena crashes on unknown modes).
                    if ((st === 400 || st === 404 || st === 405 || st === 422 || st === 500) && mi < modeChain.length - 1) {
                        push({ t: 'meta', s: 'retry', d: 'HTTP ' + st + ' — trying the next mode alias: ' + modeChain[mi + 1] });
                        break; // leave retry loop, advance the mode chain
                    }
                    break; // give up for this mode
                }
            }
        }

        if (lastError) push({ t: 'error', s: 'http', d: lastError.message || String(lastError) });
        push({ t: 'done', s: opts.mode || 'direct', d: { mode: opts.mode || 'direct', failed: true } });
    }

    return {
        run: run,
        mintRecaptcha: mintRecaptcha,
        mintTurnstileToken: mintTurnstileToken,
        signUpAnon: signUpAnon,
        uuid7: uuid7,
        uuid4: uuid4,
        buildBody: buildBody,
        bodyFromTemplate: bodyFromTemplate,
        findRecaptchaSiteKeys: findRecaptchaSiteKeys,
        findRecaptchaAction: findRecaptchaAction,
        deriveSessionCookieValue: deriveSessionCookieValue,
        parseStreamLine: parseStreamLine,
        payloadToText: payloadToText,
        RECAPTCHA_SITEKEY_CANDIDATES: RECAPTCHA_SITEKEY_CANDIDATES,
        TURNSTILE_SITEKEY: TURNSTILE_SITEKEY
    };
}

// Source used for page.evaluateOnNewDocument injection — defines globalThis.__arenaExec
const ARENA_EXEC_SOURCE =
    ';(function(){ try { globalThis.__arenaExec = (' + arenaExecFactory.toString() + ')(); } catch (e) { console.warn("[AI Proxy Bridge] arenaExec init failed:", e); } })();';

// Node-side helper: run an arena evaluation inside a Puppeteer page.
// push(evt) receives structured events ({t, s, d}) as they arrive.
async function runArenaEvalInPage(page, opts, push) {
    // Make sure the executor exists in this page (evaluateOnNewDocument only
    // applies to future navigations — inject on demand for the current page)
    const hasExec = await page.evaluate(() => !!(window.__arenaExec && typeof window.__arenaExec.run === 'function')).catch(() => false);
    if (!hasExec) {
        await page.evaluate(ARENA_EXEC_SOURCE).catch((e) => {
            throw new Error('Failed to inject the arena executor: ' + e.message);
        });
    }

    // Bridge in-page progress events to Node via an exposed function
    const cbName = '__arenaPush_' + Math.random().toString(36).slice(2);
    try {
        await page.exposeFunction(cbName, (json) => {
            try { push(JSON.parse(json)); } catch (e) {}
        });
    } catch (e) {
        // exposeFunction throws if already registered — fall back to a one-off name
    }

    return page.evaluate(async (optsJson, cbName) => {
        const opts = JSON.parse(optsJson);
        const cb = window[cbName];
        const push = (m) => { try { cb(JSON.stringify(m)); } catch (e) {} };
        try {
            return await window.__arenaExec.run(opts, push);
        } catch (e) {
            push({ t: 'error', s: 'exec', d: e.message || String(e) });
            push({ t: 'done', s: opts.mode || 'direct', d: { failed: true } });
        }
    }, JSON.stringify(opts || {}), cbName);
}

// Node-side helper: parse arena.ai HTML (from page.content() or a plain fetch)
// and extract the initialModels model list with UUIDs + capabilities.
// Returns { models: [{id, name, uuid, outputs, inputs, organization}], uuidMap, initialModelAId }
function parseArenaModelsHTML(html) {
    const result = { models: [], uuidMap: {}, initialModelAId: '' };
    if (!html || typeof html !== 'string') return result;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const seen = new Set();

    function ingest(models) {
        if (!Array.isArray(models)) return 0;
        let added = 0;
        for (const m of models) {
            if (!m || typeof m !== 'object') continue;
            const uuid = (typeof m.id === 'string' && UUID_RE.test(m.id)) ? m.id : '';
            const name = String(m.publicName || m.name || m.displayName || m.slug || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                const caps = m.capabilities || {};
                result.models.push({
                    id: name,                       // OpenAI-facing id = publicName
                    name: name,
                    uuid: uuid || undefined,
                    organization: m.organization || m.provider || undefined,
                    outputs: (caps.outputCapabilities || []).map(String),
                    inputs: (caps.inputCapabilities || []).map(String)
                });
                added++;
            }
            if (uuid) {
                result.uuidMap[name] = uuid;
                result.uuidMap[key] = uuid;
                if (m.slug) { result.uuidMap[String(m.slug)] = uuid; result.uuidMap[String(m.slug).toLowerCase()] = uuid; }
            }
        }
        return added;
    }

    // Balanced-bracket extractor after a key (string/escape aware)
    function extractJsonAfterKey(content, key) {
        let from = 0;
        for (;;) {
            const idx = content.indexOf(key, from);
            if (idx === -1) return null;
            const afterKey = content.substring(idx + key.length);
            const start = afterKey.search(/[[{]/);
            if (start === -1 || start > 12) { from = idx + key.length; continue; }
            const open = afterKey[start];
            const close = open === '[' ? ']' : '}';
            let depth = 0, inStr = false, esc = false;
            for (let i = start; i < afterKey.length; i++) {
                const c = afterKey[i];
                // A backslash escapes the next character EVERYWHERE — RSC text
                // quotes are written as \" sequences, so '\"' is never structural
                if (esc) { esc = false; continue; }
                if (c === '\\') { esc = true; continue; }
                if (c === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (c === open) depth++;
                else if (c === close) { depth--; if (depth === 0) return afterKey.substring(start, i + 1); }
            }
            return null;
        }
    }

    function unescapeRsc(s) {
        if (s.includes('\\"')) s = s.replace(/\\"/g, '"');
        if (s.includes('\\\\')) s = s.replace(/\\\\/g, '\\');
        return s;
    }

    // Collect script bodies (self.__next_f.push lines etc.), or treat the input as raw text
    const chunks = [];
    if (html.includes('<script')) {
        const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            if (m[1] && (m[1].includes('initialModels') || m[1].includes('initialModelAId'))) chunks.push(m[1]);
        }
    } else {
        chunks.push(html);
    }

    for (const content of chunks) {
        try {
            const frag = extractJsonAfterKey(content, 'initialModels');
            if (frag) {
                let parsed = null;
                try { parsed = JSON.parse(unescapeRsc(frag)); } catch (e) {}
                if (Array.isArray(parsed)) ingest(parsed);
            }
        } catch (e) {}
        try {
            if (!result.initialModelAId) {
                const aid = content.match(/initialModelAId[^"']*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/i)
                    || content.match(/initialModelAId[\\"'\s:]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                if (aid) result.initialModelAId = aid[1];
            }
        } catch (e) {}
    }
    return result;
}

module.exports = {
    ARENA_EXEC_SOURCE,
    arenaExecFactory,
    runArenaEvalInPage,
    parseArenaModelsHTML
};
