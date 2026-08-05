// ==UserScript==
// @name         arena
// @namespace    http://tampermonkey.net/
// @version      10.3
// @description  LMArena API - WebSocket client for AI Proxy Bridge (direct in-page fetch + streaming + reasoning)
// @author       abc
// @match        https://arena.ai/*
// @match        https://*.arena.ai/*
// @match        https://lmarena.ai/*
// @match        https://*.lmarena.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=arena.ai
// @connect      localhost
// @connect      127.0.0.1
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL = "ws://127.0.0.1:61001/ws";
    let socket;
    const activeRequests = new Set();

    // ========== Model UUID mapping ==========
    let modelUuidMap = {};        // { "gpt-4o": "019a98f7-...", ... }
    let modelDisplayNameMap = {};
    let uuidToSlugMap = {};
    let modelSlugList = [];
    let modelCapsMap = {};        // slug -> { outputs: [...], inputs: [...] }
    let initialModelAId = '';

    // ============================================================================
    // SYNC-WITH-ARENA-CLIENT — inline copy of arenaExecFactory from
    // src/arena-client.js (Tampermonkey cannot require() files). Keep in sync.
    // ============================================================================
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
    // ============================================================================
    // END SYNC-WITH-ARENA-CLIENT
    // ============================================================================

    const arenaExec = arenaExecFactory();

    // ========== Fetch tap: capture the real request template (self-healing against site changes) ==========
    // When YOU send a message on arena.ai by hand, the exact request shape (URL + body
    // with every field the site uses today) is remembered and later cloned by the proxy.
    let capturedUrl = '';
    let capturedBodyTemplate = null;
    let capturedMode = '';

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        try {
            const urlArg = args[0];
            const urlString = urlArg instanceof Request ? urlArg.url
                : urlArg instanceof URL ? urlArg.href
                : (typeof urlArg === 'string' ? urlArg : '');
            if (urlString && urlString.includes('create-evaluation') && !window.isProxyRequest) {
                const options = args[1] || {};
                let body = null;
                if (options.body) { try { body = JSON.parse(options.body); } catch (e) {} }
                if (body && typeof body === 'object' && body.userMessage) {
                    if (body.recaptchaV3Token) window.recaptchaToken = body.recaptchaV3Token;
                    if (body.modelAId && /^[0-9a-f]{8}-/i.test(body.modelAId)) {
                        addModelMapping('captured-modelAId', body.modelAId, 'Captured Model');
                        tryCaptureModelSelection(body.modelAId);
                    }
                    capturedUrl = urlString;
                    capturedBodyTemplate = JSON.parse(JSON.stringify(body));
                    capturedMode = String(body.mode || '');
                    console.log(`[LMArena API] Captured request template: mode=${capturedMode || '?'}, url=${urlString.slice(0, 90)}, keys=${Object.keys(body).join(',')}`);
                    sendApiInfoToServer();
                }
            }
        } catch (e) {}
        return originalFetch.apply(this, args);
    };

    function sendApiInfoToServer() {
        if (socket && socket.readyState === WebSocket.OPEN && capturedBodyTemplate) {
            socket.send(JSON.stringify({
                type: 'api_info',
                data: { url: capturedUrl, mode: capturedMode, body: capturedBodyTemplate }
            }));
        }
    }

    // ========== Add model mapping ==========
    function addModelMapping(slug, uuid, displayName) {
        if (!slug || !uuid) return;
        modelUuidMap[slug] = uuid;
        modelUuidMap[slug.toLowerCase()] = uuid;
        if (displayName) {
            modelDisplayNameMap[displayName] = uuid;
            modelDisplayNameMap[displayName.toLowerCase()] = uuid;
        }
        uuidToSlugMap[uuid] = slug;
        uuidToSlugMap[uuid.toLowerCase()] = slug;
    }

    // ========== Try to capture the currently selected model from the page ==========
    function tryCaptureModelSelection(modelAId) {
        try {
            const selectedOption = document.querySelector('div[cmdk-item][role="option"][aria-selected="true"]');
            if (selectedOption) {
                const nameSpan = selectedOption.querySelector('span.flex-1.truncate');
                if (nameSpan) {
                    const name = nameSpan.textContent.trim();
                    if (name) {
                        addModelMapping(name, modelAId, name);
                        const slug = name.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');
                        addModelMapping(slug, modelAId, name);
                        console.log(`[LMArena API] Mapped model "${name}" → ${modelAId}`);
                        return;
                    }
                }
            }
            const comboBtn = document.querySelector('button[role="combobox"]');
            if (comboBtn) {
                const btnText = comboBtn.textContent.trim();
                if (btnText && btnText.length > 2 && btnText.length < 60) {
                    addModelMapping(btnText, modelAId, btnText);
                    const slug = btnText.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');
                    addModelMapping(slug, modelAId, btnText);
                }
            }
        } catch (e) {}
    }

    // ========== Model slug patterns (shared by all extractors) ==========
    const MODEL_SLUG_ALT = 'claude-[a-z0-9._\\-]+|gpt-[a-z0-9._\\-]+|chatgpt-[a-z0-9._\\-]+|gpt-oss-[a-z0-9._\\-]+|o[0-9]+(?:-[a-z0-9._\\-]+)?|gemini-[a-z0-9._\\-]+|gemma-[a-z0-9._\\-]+|imagen-[a-z0-9._\\-]+|veo-[a-z0-9._\\-]+|nano-banana[a-z0-9._\\-]*|llama-[a-z0-9._\\-]+|meta-llama[a-z0-9._\\-]*|deepseek-[a-z0-9._\\-]+|qwen[a-z0-9._\\-]*|qwq[a-z0-9._\\-]*|mistral-[a-z0-9._\\-]+|mixtral[a-z0-9._\\-]*|pixtral[a-z0-9._\\-]*|ministral[a-z0-9._\\-]*|codestral[a-z0-9._\\-]*|devstral[a-z0-9._\\-]*|grok[a-z0-9._\\-]*|glm-[a-z0-9._\\-]+|chatglm[0-9][a-z0-9._\\-]*|ernie-[a-z0-9._\\-]+|kimi[a-z0-9._\\-]*|moonshot-[a-z0-9._\\-]+|phi-[a-z0-9._\\-]+|phi[0-9][a-z0-9._\\-]*|nova-[a-z0-9._\\-]+|command-[a-z0-9._\\-]+|c4ai-[a-z0-9._\\-]+|aya-[a-z0-9._\\-]+|jamba-[a-z0-9._\\-]+|mercury-[a-z0-9._\\-]*|hunyuan-[a-z0-9._\\-]+|abab[0-9][a-z0-9._\\-]*|minimax-[a-z0-9._\\-]+|mimo-[a-z0-9._\\-]+|step-[a-z0-9._\\-]+|skywork-[a-z0-9._\\-]+|seedream[a-z0-9._\\-]*|wan[0-9][a-z0-9._\\-]*|flux[a-z0-9._\\-]*|ideogram[a-z0-9._\\-]*|longcat-[a-z0-9._\\-]+|dots[.-][a-z0-9._\\-]+|solar-[a-z0-9._\\-]+|lfm[a-z0-9._\\-]*|exaone[a-z0-9._\\-]*|trinity-[a-z0-9._\\-]+|sonar-[a-z0-9._\\-]+|rwkv[0-9][a-z0-9._\\-]*|internlm[a-z0-9._\\-]*|internvl[a-z0-9._\\-]*|yi-[a-z0-9._\\-]+|dall-e-[a-z0-9._\\-]+|dbrx[a-z0-9._\\-]*|vicuna-[a-z0-9._\\-]+|pplx-[a-z0-9._\\-]+|mpt-[a-z0-9._\\-]+|reka-[a-z0-9._\\-]+|nemotron[a-z0-9._\\-]*|falcon[0-9][a-z0-9._\\-]*|aurora[a-z0-9._\\-]*|recraft[a-z0-9._\\-]*|stable-[a-z0-9._\\-]+|sdxl[a-z0-9._\\-]*|mamba-[a-z0-9._\\-]+|kat-[a-z0-9._\\-]+|orion[a-z0-9._\\-]*|lucy-[a-z0-9._\\-]+|whisper-[a-z0-9._\\-]+|tts-[a-z0-9._\\-]+|bge-[a-z0-9._\\-]+';
    const MODEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const MODEL_SLUG_TEST_RE = new RegExp('^(?:' + MODEL_SLUG_ALT + ')$', 'i');

    function looksLikeModelSlug(s) {
        return typeof s === 'string' && s.length >= 3 && s.length <= 90 && MODEL_SLUG_TEST_RE.test(s);
    }

    // ========== Extract model slugs from the page HTML (fallback) ==========
    function extractModelsFromPageHTML() {
        const models = [];
        const seen = new Set();
        try {
            const html = document.documentElement.outerHTML;
            const re = new RegExp('(?:"|\'|`)(' + MODEL_SLUG_ALT + ')(?:"|\'|`)', 'gi');
            let match;
            while ((match = re.exec(html)) !== null) {
                const slug = match[1];
                if (!slug || slug.length < 4 || slug.length > 90) continue;
                if (/^(script|style|class|chunk|webpack|module|next-|__|data-)/.test(slug)) continue;
                const lower = slug.toLowerCase();
                if (seen.has(lower)) continue;
                seen.add(lower);
                models.push(slug);
            }
        } catch (e) {}
        return models;
    }

    // ========== Extract the model list from RSC flight data ==========
    // initialModels may be:
    //   - an array of slugs:      ["gpt-4o", "claude-sonnet-4.5", ...]
    //   - an array of objects:    [{ id: <uuid>, publicName: "...", capabilities: {...} }]
    //   - a dict keyed by slug:   { "gpt-4o": {...} }
    function extractModelsFromRSC(sourceTexts) {
        const models = [];
        const seen = new Set();
        let modelAId = '';

        function pushSlug(slug) {
            if (typeof slug !== 'string') return;
            slug = slug.trim().replace(/^["'`]+|["'`]+$/g, '');
            if (!slug || slug.length < 3 || slug.length > 90) return;
            if (/^(script|style|class|chunk|webpack|module|next-|__|data-|http)/i.test(slug)) return;
            const lower = slug.toLowerCase();
            if (seen.has(lower)) return;
            seen.add(lower);
            models.push(slug);
        }

        function ingestModels(data, strict) {
            if (!data) return;
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (typeof item === 'string') {
                        if (!strict || looksLikeModelSlug(item)) pushSlug(item);
                    } else if (item && typeof item === 'object') {
                        const uuid = item.id || item.modelId || '';
                        const name = item.publicName || item.name || item.displayName || '';
                        const slug = (item.slug || name || '').toString();
                        if (slug && (!strict || looksLikeModelSlug(slug))) pushSlug(slug);
                        const caps = item.capabilities || {};
                        if (caps && (caps.outputCapabilities || caps.inputCapabilities)) {
                            modelCapsMap[slug || name] = {
                                outputs: (caps.outputCapabilities || []).map(String),
                                inputs: (caps.inputCapabilities || []).map(String)
                            };
                        }
                        if (MODEL_UUID_RE.test(uuid)) addModelMapping(name || slug || String(uuid), uuid, name || slug);
                        if (item.organization && slug) {
                            (modelCapsMap[slug] = modelCapsMap[slug] || { outputs: [], inputs: [] }).organization = item.organization;
                        }
                    }
                }
            } else if (data && typeof data === 'object') {
                for (const [key, val] of Object.entries(data)) {
                    const isUuidKey = MODEL_UUID_RE.test(key);
                    const v = (val && typeof val === 'object') ? val : {};
                    const name = v.publicName || v.name || v.displayName || '';
                    const slug = (v.slug || (isUuidKey ? name : key) || '').toString();
                    if (slug && (!strict || looksLikeModelSlug(slug))) pushSlug(slug);
                    const uuidVal = v.id || v.modelId || '';
                    if (MODEL_UUID_RE.test(uuidVal)) addModelMapping(name || slug || key, uuidVal, name || slug || key);
                    if (isUuidKey && (slug || name)) addModelMapping(slug || name, key, name || slug);
                }
            }
        }

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
            return s;
        }

        try {
            let scriptTexts = sourceTexts;
            if (!scriptTexts) {
                scriptTexts = [];
                for (const script of document.querySelectorAll('script')) {
                    const content = script.textContent || '';
                    if (content) scriptTexts.push(content);
                }
            }
            let combinedText = '';
            for (const content of scriptTexts) {
                if (!content) continue;
                if (!(content.includes('initialModels') || content.includes('initialModelAId') || content.includes('__next_f'))) continue;
                combinedText += '\n' + content.slice(0, 3000000);

                try {
                    let frag = extractJsonAfterKey(content, 'initialModels');
                    if (frag) {
                        const before = models.length;
                        try { ingestModels(JSON.parse(unescapeRsc(frag)), false); } catch (e) {}
                        if (models.length > before) {
                            console.log(`[LMArena API] RSC initialModels: found ${models.length - before} models`);
                        }
                    }
                } catch (e) {}

                for (const key of ['text_models', 'all_models', 'all_text_models', '"models"']) {
                    try {
                        let frag = extractJsonAfterKey(content, key);
                        if (!frag) continue;
                        try { ingestModels(JSON.parse(unescapeRsc(frag)), true); } catch (e) {}
                    } catch (e) {}
                }

                try {
                    const aidMatch = content.match(/initialModelAId[^"]*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i)
                        || content.match(/initialModelAId[^0-9a-fA-F]{0,16}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                    if (aidMatch && !modelAId) {
                        modelAId = aidMatch[1];
                        console.log(`[LMArena API] RSC: Found initialModelAId: ${modelAId}`);
                    }
                } catch (e) {}
            }

            if (combinedText) {
                try {
                    const before = models.length;
                    const scanRe = new RegExp('(?:[^a-z0-9]|^)(' + MODEL_SLUG_ALT + ')(?![a-z0-9])', 'gi');
                    for (const m of combinedText.matchAll(scanRe)) pushSlug(m[1]);
                    if (models.length > before) {
                        console.log(`[LMArena API] RSC slug scan: ${models.length} models total`);
                    }
                } catch (e) {}
            }

            if (!sourceTexts && window.__NEXT_DATA__) {
                try {
                    const str = JSON.stringify(window.__NEXT_DATA__);
                    let frag = extractJsonAfterKey(str, 'initialModels');
                    if (frag) { try { ingestModels(JSON.parse(frag), false); } catch (e) {} }
                } catch (e) {}
            }

        } catch (e) {
            console.error('[LMArena API] RSC extraction error:', e);
        }

        return { models, modelAId };
    }

    // ========== Extract models by clicking the dropdown menu ==========
    async function extractModelsViaDropdown() {
        const extracted = [];

        try {
            const modelBtn = document.querySelector('button[role="combobox"][aria-haspopup="dialog"]');
            if (!modelBtn) return extracted;

            modelBtn.focus();
            await new Promise(r => setTimeout(r, 100));

            const rect = modelBtn.getBoundingClientRect();
            const clickX = rect.left + rect.width / 2;
            const clickY = rect.top + rect.height / 2;

            modelBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse' }));
            await new Promise(r => setTimeout(r, 30));
            modelBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse' }));
            modelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: clickX, clientY: clickY, cancelable: true }));
            modelBtn.click();

            await new Promise(r => setTimeout(r, 1200));

            const options = document.querySelectorAll('div[cmdk-item][role="option"]');
            console.log(`[LMArena API] Dropdown: Found ${options.length} model options`);

            for (const opt of options) {
                if (opt.offsetParent === null) continue;

                const nameSpan = opt.querySelector('span.flex-1.truncate');
                const name = nameSpan ? nameSpan.textContent.trim() : (opt.textContent || '').trim();
                const dataValue = opt.getAttribute('data-value') || opt.getAttribute('value') || '';

                if (name && name.length > 2) {
                    const slug = name.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');

                    extracted.push({ name: name, slug: slug, dataValue: dataValue });

                    if (MODEL_UUID_RE.test(dataValue)) {
                        addModelMapping(slug, dataValue, name);
                        addModelMapping(name, dataValue, name);
                    }
                }
            }

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 200));

        } catch (e) {
            console.error('[LMArena API] Dropdown extraction error:', e);
        }

        return extracted;
    }

    // ========== Fetch the direct-chat page and extract models from its HTML ==========
    // The battle/landing page may not embed initialModels — the ?mode=direct page does.
    async function fetchDirectPageTexts() {
        const texts = [];
        try {
            const resp = await originalFetch(location.origin + '/?mode=direct', { credentials: 'include' });
            if (resp.ok) {
                const t = await resp.text();
                if (t && t.length > 1000) texts.push(t);
            }
        } catch (e) {
            console.warn('[LMArena API] Failed to fetch /?mode=direct for models:', e.message);
        }
        return texts;
    }

    // ========== Combined model data extraction ==========
    async function extractAllModelData() {
        const rscData = extractModelsFromRSC();
        modelSlugList = rscData.models;
        initialModelAId = rscData.modelAId;

        console.log(`[LMArena API] RSC extraction (page): ${modelSlugList.length} slugs, ${Object.keys(modelUuidMap).length} mappings, initialModelAId: ${initialModelAId || 'none'}`);

        // The current page (battle/landing) may embed little or no model data —
        // fetch the direct-chat page and extract from its HTML instead
        if (modelSlugList.length < 5 || Object.keys(modelUuidMap).length < 3) {
            const fetchedTexts = await fetchDirectPageTexts();
            for (const t of fetchedTexts) {
                const r2 = extractModelsFromRSC([t]);
                let added = 0;
                for (const m of r2.models) { if (!modelSlugList.includes(m)) { modelSlugList.push(m); added++; } }
                if (!initialModelAId && r2.modelAId) initialModelAId = r2.modelAId;
                console.log(`[LMArena API] RSC extraction (fetched /?mode=direct): +${added} slugs, ${Object.keys(modelUuidMap).length} mappings total`);
            }
        }

        if (modelSlugList.length === 0) {
            const htmlSlugs = extractModelsFromPageHTML();
            if (htmlSlugs.length > 0) {
                modelSlugList = htmlSlugs;
                console.log(`[LMArena API] HTML slug extraction: ${htmlSlugs.length} models`);
            }
        }

        const dropdownModels = await extractModelsViaDropdown();
        if (dropdownModels.length > 0) {
            console.log(`[LMArena API] Dropdown: Extracted ${dropdownModels.length} models`);
            for (const dm of dropdownModels) {
                if (!modelSlugList.includes(dm.slug)) modelSlugList.push(dm.slug);
            }
        }

        if (initialModelAId && modelSlugList.length > 0) {
            addModelMapping(modelSlugList[0], initialModelAId, modelSlugList[0]);
        }

        const modelList = [];
        const seenSlugs = new Set();

        for (const slug of modelSlugList) {
            if (seenSlugs.has(slug.toLowerCase())) continue;
            seenSlugs.add(slug.toLowerCase());

            const uuid = modelUuidMap[slug] || modelUuidMap[slug.toLowerCase()] || '';
            const displayName = uuidToSlugMap[uuid] || slug;
            const caps = modelCapsMap[slug] || modelCapsMap[displayName] || {};

            modelList.push({
                id: uuid || slug,
                name: displayName,
                slug: slug,
                outputs: caps.outputs || [],
                inputs: caps.inputs || [],
                organization: caps.organization || undefined
            });
        }

        return modelList;
    }

    function sendModelDataToServer() {
        (async () => {
            try {
                const modelList = await extractAllModelData();

                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        type: 'model_data',
                        data: {
                            uuidMap: modelUuidMap,
                            nameMap: modelDisplayNameMap,
                            uuidToSlug: uuidToSlugMap,
                            models: modelList,
                            initialModelAId: initialModelAId
                        }
                    }));
                    console.log(`[LMArena API] Sent model data: ${modelList.length} models, ${new Set(Object.values(modelUuidMap)).size} UUIDs`);
                }
            } catch (e) {
                console.error('[LMArena API] sendModelDataToServer error:', e);
            }
        })();
    }

    // ========== Resolve modelAId ==========
    function resolveModelAId(model) {
        if (!model) return initialModelAId || '';

        if (modelUuidMap[model]) return modelUuidMap[model];
        if (modelUuidMap[model.toLowerCase()]) return modelUuidMap[model.toLowerCase()];

        if (modelDisplayNameMap[model]) return modelDisplayNameMap[model];
        if (modelDisplayNameMap[model.toLowerCase()]) return modelDisplayNameMap[model.toLowerCase()];

        const normalized = model.toLowerCase().replace(/[-_.\s]/g, '');
        for (const [key, uuid] of Object.entries(modelUuidMap)) {
            if (key.toLowerCase().replace(/[-_.\s]/g, '') === normalized) return uuid;
        }

        if (MODEL_UUID_RE.test(model)) return model;

        if (initialModelAId) {
            console.warn(`[LMArena API] Cannot resolve "${model}", falling back to initialModelAId`);
            return initialModelAId;
        }

        return model;
    }

    // ========== WebSocket connection ==========
    function sendToServer(requestId, data) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ request_id: requestId, data: data }));
        }
    }

    function sendPageSourceViaWs() {
        try {
            const htmlContent = document.documentElement.outerHTML;
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'page_source', data: htmlContent }));
            }
        } catch (e) {}
    }

    function sendStatus(requestId, status, message) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'status',
                data: { status: status, requestId: requestId, message: message || '' }
            }));
        }
    }

    function connect() {
        console.log(`[LMArena API] Connecting to ${SERVER_URL}...`);
        socket = new WebSocket(SERVER_URL);

        socket.onopen = () => {
            console.log("[LMArena API] Connected to desktop app");
            document.title = "✅ " + document.title.replace(/^✅\s*/, '');
            sendPageSourceViaWs();
            sendModelDataToServer();
            sendApiInfoToServer();
        };

        socket.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);

                if (message.command) {
                    if (message.command === 'refresh' || message.command === 'reconnect') {
                        location.reload();
                    } else if (message.command === 'send_page_source') {
                        sendPageSourceViaWs();
                    } else if (message.command === 'cancel_request') {
                        const { request_id } = message;
                        if (request_id) activeRequests.delete(request_id);
                    } else if (message.command === 'refresh_models') {
                        sendModelDataToServer();
                    }
                    return;
                }

                const { request_id, data } = message;
                if (!request_id || !data) {
                    console.error("[LMArena API] Invalid request message");
                    return;
                }

                console.log(`[LMArena API] Request ${request_id.substring(0, 8)}, model: ${data.model || 'N/A'}, mode: ${data.mode || 'direct'}`);

                activeRequests.add(request_id);

                (async () => {
                    try {
                        const modelAId = data.modelAId || resolveModelAId(data.model || '');
                        const modelBId = data.modelBId || (data.modelB ? resolveModelAId(data.modelB) : '');
                        if (!modelAId && (data.mode || 'direct') !== 'battle') {
                            console.warn('[LMArena API] No model UUID resolved — the model list may not be loaded yet; sending without modelAId (arena default model will answer)');
                        }

                        sendStatus(request_id, 'executing', `Running ${data.mode || 'direct'} request on the page (model: ${data.model || modelAId})`);

                        const push = (evt) => {
                            if (!activeRequests.has(request_id)) return; // cancelled — drop
                            if (evt && evt.t === 'meta') {
                                console.log(`[LMArena API] meta: ${JSON.stringify(evt.d)}`);
                                sendToServer(request_id, evt); // forward in-page diagnostics (attempts, sign-up stages) to the app's Logs
                                return;
                            }
                            sendToServer(request_id, evt);
                        };

                        window.isProxyRequest = true; // never capture our own requests as the template
                        try {
                            await arenaExec.run({
                                mode: data.mode || 'direct',
                                modelAId: modelAId,
                                modelBId: modelBId,
                                content: data.content || 'Hello',
                                modality: data.modality || 'chat',
                                template: capturedBodyTemplate || data.template || null,
                                url: capturedUrl || data.url || ''
                            }, push);
                        } finally {
                            window.isProxyRequest = false;
                        }

                        console.log(`[LMArena API] Request ${request_id.substring(0, 8)} finished`);
                    } catch (error) {
                        console.error(`[LMArena API] Error:`, error.message);
                        if (activeRequests.has(request_id)) {
                            sendToServer(request_id, { error: error.message });
                        }
                    } finally {
                        activeRequests.delete(request_id);
                    }
                })();

            } catch (error) {
                console.error("[LMArena API] Message error:", error);
            }
        };

        socket.onclose = () => {
            console.warn("[LMArena API] Disconnected. Reconnecting in 5s...");
            if (document.title.startsWith("✅ ")) document.title = document.title.substring(2);
            activeRequests.clear();
            setTimeout(connect, 5000);
        };

        socket.onerror = () => { socket.close(); };
    }

    // ========== Initialization ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => sendModelDataToServer());
    } else {
        sendModelDataToServer();
    }

    // Delayed extraction (wait for dynamic loading to finish)
    setTimeout(() => { sendModelDataToServer(); }, 3000);
    setTimeout(() => { sendModelDataToServer(); }, 8000);
    setTimeout(() => { sendModelDataToServer(); }, 15000);

    connect();
})();
