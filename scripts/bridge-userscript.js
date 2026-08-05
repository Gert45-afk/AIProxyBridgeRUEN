// ==UserScript==
// @name         arena
// @namespace    http://tampermonkey.net/
// @version      10.2
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

        function uuid7() {
            const ts = BigInt(Date.now());
            const randA = BigInt(Math.floor(Math.random() * 0x1000));
            const randB = BigInt(Math.floor(Math.random() * 0x3ffffffffffff));
            const uuidInt = (ts << 80n) | ((BigInt(0x7000) | (randA & 0x0fffn)) << 64n) | (0x8000000000000000n | randB);
            const h = uuidInt.toString(16).padStart(32, '0');
            return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
        }

        function findRecaptchaSiteKey() {
            try {
                const scripts = document.querySelectorAll('script[src]');
                for (const s of scripts) {
                    const src = s.src || '';
                    if (src.indexOf('recaptcha') === -1) continue;
                    const m = src.match(/[?&](?:render|k)=([A-Za-z0-9_-]{20,})/);
                    if (m) return m[1];
                }
            } catch (e) {}
            return '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0';
        }

        async function mintRecaptcha(action) {
            try {
                const g = window.grecaptcha;
                if (!g || !g.enterprise || typeof g.enterprise.execute !== 'function') return '';
                const key = findRecaptchaSiteKey();
                return await new Promise((resolve) => {
                    let settled = false;
                    const done = (v) => { if (!settled) { settled = true; resolve(v || ''); } };
                    setTimeout(() => done(''), 15000);
                    try {
                        g.enterprise.ready(() => {
                            g.enterprise.execute(key, { action: action || 'chat_submit' })
                                .then(done)
                                .catch(() => done(''));
                        });
                    } catch (e) { done(''); }
                });
            } catch (e) { return ''; }
        }

        function buildBody(opts) {
            const body = {
                id: uuid7(),
                mode: opts.mode || 'direct',
                userMessageId: uuid7(),
                modelAMessageId: uuid7(),
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
            if (body.mode === 'side-by-side' || body.mode === 'battle') {
                body.modelBMessageId = uuid7();
                if (!body.userMessage.modelIds) body.userMessage.modelIds = undefined;
            }
            if (body.mode === 'battle') {
                delete body.modelAId;
                delete body.modelBId;
            }
            return body;
        }

        // Clone a captured real request body (survives arena side schema changes)
        // and patch the per-request fields: fresh UUIDv7 ids, content, models, token.
        function bodyFromTemplate(template, opts) {
            const b = JSON.parse(JSON.stringify(template || {}));
            b.id = uuid7();
            b.userMessageId = uuid7();
            b.modelAMessageId = uuid7();
            const wantsB = (opts.mode === 'side-by-side' || opts.mode === 'battle') || ('modelBMessageId' in b);
            if (wantsB) b.modelBMessageId = uuid7();
            if (b.userMessage && typeof b.userMessage === 'object') {
                b.userMessage.content = String(opts.content || '');
            } else {
                b.userMessage = { content: String(opts.content || ''), experimental_attachments: [], metadata: {} };
            }
            if (opts.mode) b.mode = opts.mode;
            if (opts.mode === 'battle') { delete b.modelAId; delete b.modelBId; }
            else if (opts.modelAId) b.modelAId = opts.modelAId;
            if (opts.mode === 'side-by-side' && opts.modelBId) b.modelBId = opts.modelBId;
            if (opts.mode !== 'side-by-side' && opts.mode !== 'battle') { delete b.modelBId; delete b.modelBMessageId; }
            if (opts.modality && !('modality' in b)) b.modality = opts.modality;
            b.recaptchaV3Token = opts.recaptchaToken || '';
            return b;
        }

        function payloadToText(v) {
            if (v == null) return '';
            if (typeof v === 'string') return v;
            for (const k of ['thinking', 'thought', 'reasoning', 'text', 'content', 'delta']) {
                if (typeof v[k] === 'string' && v[k]) return v[k];
            }
            try { return JSON.stringify(v); } catch (e) { return String(v); }
        }

        function parseStreamLine(line, push) {
            if (!line || !line.trim()) return;
            const ci = line.indexOf(':');
            if (ci <= 0 || ci > 3) return;
            const tag = line.slice(0, ci);
            const raw = line.slice(ci + 1);
            let val;
            try { val = JSON.parse(raw); } catch (e) { val = raw; }

            switch (tag) {
                case 'a0': {
                    const t = payloadToText(val);
                    if (t === 'hasArenaError') { push({ t: 'error', s: 'arena', d: 'hasArenaError (arena rejected the request — the model may be temporarily unavailable)' }); return; }
                    if (t) push({ t: 'text', s: 'a', d: t });
                    return;
                }
                case 'b0': { const t = payloadToText(val); if (t) push({ t: 'text', s: 'b', d: t }); return; }
                case 'ag': { const t = payloadToText(val); if (t) push({ t: 'reasoning', s: 'a', d: t }); return; }
                case 'bg': { const t = payloadToText(val); if (t) push({ t: 'reasoning', s: 'b', d: t }); return; }
                case 'ad': { push({ t: 'finish', s: 'a', d: (val && typeof val === 'object') ? val : {} }); return; }
                case 'bd': { push({ t: 'finish', s: 'b', d: (val && typeof val === 'object') ? val : {} }); return; }
                case 'a2':
                case 'b2': {
                    try {
                        const arr = Array.isArray(val) ? val : [val];
                        for (const item of arr) {
                            if (!item || typeof item !== 'object') continue;
                            if (item.type === 'heartbeat') continue;
                            if (item.image) push({ t: 'image', s: tag === 'a2' ? 'a' : 'b', d: item.image });
                        }
                    } catch (e) {}
                    return;
                }
                case 'a3': { push({ t: 'error', s: 'a', d: payloadToText(val) }); return; }
                case 'b3': { push({ t: 'error', s: 'b', d: payloadToText(val) }); return; }
                case '0': {
                    const t = payloadToText(val);
                    if (t) push({ t: 'text', s: 'a', d: t });
                    return;
                }
                default: return;
            }
        }

        async function attempt(opts, push) {
            const base = opts.base || location.origin;
            const url = opts.url || (base.replace(/\/$/, '') + '/nextjs-api/stream/create-evaluation');
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(opts.body)
            });
            if (!resp.ok) {
                let snippet = '';
                try { snippet = (await resp.text()).slice(0, 300); } catch (e) {}
                const err = new Error('HTTP ' + resp.status + (snippet ? ' — ' + snippet : ''));
                err.status = resp.status;
                throw err;
            }
            if (!resp.body) {
                const text = await resp.text();
                for (const line of text.split('\n')) parseStreamLine(line, push);
                return;
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const r = await reader.read();
                if (r.done) break;
                buffer += decoder.decode(r.value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) parseStreamLine(line, push);
            }
            if (buffer.trim()) parseStreamLine(buffer, push);
        }

        async function run(opts, push) {
            push = (typeof push === 'function') ? push : () => {};
            opts = opts || {};
            let mode = opts.mode || 'direct';
            let lastError = null;

            const modeChain = (mode === 'direct') ? ['direct', 'direct-battle'] : [mode];

            for (let m = 0; m < modeChain.length; m++) {
                mode = modeChain[m];
                for (let retry = 0; retry < 2; retry++) {
                    try {
                        const token = await mintRecaptcha('chat_submit');
                        const bodyOpts = {
                            mode: mode,
                            modelAId: opts.modelAId || '',
                            modelBId: opts.modelBId || '',
                            content: opts.content || '',
                            modality: opts.modality || 'chat',
                            recaptchaToken: token
                        };
                        const body = (opts.template && typeof opts.template === 'object')
                            ? bodyFromTemplate(opts.template, bodyOpts)
                            : buildBody(bodyOpts);
                        push({ t: 'meta', s: 'request', d: { mode: body.mode, modelAId: body.modelAId || '', modelBId: body.modelBId || '', modality: body.modality, hasToken: !!token, cloned: !!opts.template, url: opts.url || 'default', attempt: retry + 1 } });
                        await attempt({ base: opts.base, url: opts.url, body: body }, push);
                        push({ t: 'done', s: mode, d: { mode: body.mode, sessionId: body.id } });
                        return;
                    } catch (e) {
                        lastError = e;
                        const st = e && e.status;
                        if ((st === 429 || st === 403 || st === 503) && retry === 0) {
                            push({ t: 'meta', s: 'retry', d: { reason: 'HTTP ' + st, retry: retry + 1 } });
                            await new Promise(r => setTimeout(r, 1500));
                            continue;
                        }
                        if ((st === 400 || st === 404 || st === 405 || st === 422) && m < modeChain.length - 1) {
                            break;
                        }
                        push({ t: 'error', s: 'http', d: e.message || String(e) });
                    }
                }
            }
            if (lastError) push({ t: 'error', s: 'http', d: 'All attempts failed, last error: ' + (lastError.message || String(lastError)) });
            push({ t: 'done', s: mode, d: { mode: mode, failed: true } });
        }

        return { run: run, mintRecaptcha: mintRecaptcha, uuid7: uuid7, buildBody: buildBody, bodyFromTemplate: bodyFromTemplate };
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
                                return; // meta events are logged locally only
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
