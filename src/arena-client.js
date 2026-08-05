// ============================================================================
// arena-client.js — shared "in-page arena.ai executor" source
//
// This module builds the JavaScript source that is injected into a REAL
// arena.ai page (Puppeteer instance or the Tampermonkey userscript) and runs
// create-evaluation requests from inside that page context:
//   - same-origin HTTPS connection (passes Cloudflare & CORS naturally)
//   - the page's own session cookies are used automatically
//   - reCAPTCHA Enterprise tokens are minted via window.grecaptcha when present
//   - the NDJSON stream is parsed line-by-line: a0/b0 = text, ag/bg = reasoning
//     ("thoughts"), ad/bd = finish + usage, a2/b2 = images/meta, a3/b3 = errors
//
// Events are pushed out as plain objects: { t, s, d }
//   t: 'text' | 'reasoning' | 'finish' | 'image' | 'error' | 'done'
//   s: 'a' | 'b' | 'http' | 'arena'  (which model panel / channel)
//   d: payload (string or object)
//
// SYNC NOTE: LMArena.js + scripts/bridge-userscript.js contain an inline copy
// of this logic (Tampermonkey cannot require() files). Keep them in sync.
// ============================================================================

// The executor factory must be 100% self-contained — no external references —
// because its source is stringified and injected into the page.
function arenaExecFactory() {
    'use strict';

    // ---------- UUIDv7 (BigInt precision; server validates the timestamp) ----------
    function uuid7() {
        const ts = BigInt(Date.now());
        const randA = BigInt(Math.floor(Math.random() * 0x1000));
        const randB = BigInt(Math.floor(Math.random() * 0x3ffffffffffff));
        const uuidInt = (ts << 80n) | ((BigInt(0x7000) | (randA & 0x0fffn)) << 64n) | (0x8000000000000000n | randB);
        const h = uuidInt.toString(16).padStart(32, '0');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }

    // ---------- reCAPTCHA Enterprise ----------
    function findRecaptchaSiteKey() {
        try {
            // Preferred: the site key visible in the loaded enterprise script URL
            const scripts = document.querySelectorAll('script[src]');
            for (const s of scripts) {
                const src = s.src || '';
                if (src.indexOf('recaptcha') === -1) continue;
                const m = src.match(/[?&](?:render|k)=([A-Za-z0-9_-]{20,})/);
                if (m) return m[1];
            }
        } catch (e) {}
        // Fallback key observed on arena.ai (May 2026, also used by gpt4free)
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

    // ---------- request body ----------
    // mode: 'direct' | 'battle' | 'side-by-side' | 'agent' (agent = experimental)
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

    // ---------- stream line parsing ----------
    function payloadToText(v) {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        // reasoning payloads sometimes come as objects — dig for text-ish fields
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
            case 'a0': { // model A text delta
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
            case 'b2': { // images / metadata / heartbeats
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
            case '0': { // legacy RSC text channel
                const t = payloadToText(val);
                if (t) push({ t: 'text', s: 'a', d: t });
                return;
            }
            default: return; // hex-id RSC reference lines etc.
        }
    }

    // ---------- one HTTP attempt ----------
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

    // ---------- main entry: run(opts, push) ----------
    // opts: { mode, modelAId, modelBId, content, modality, base }
    async function run(opts, push) {
        push = (typeof push === 'function') ? push : () => {};
        opts = opts || {};
        let mode = opts.mode || 'direct';
        let lastError = null;

        // Fallback chain for direct mode — some deployments name it 'direct-battle'
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
                    // 429/403 → re-mint the token and retry once (reCAPTCHA rejection)
                    if ((st === 429 || st === 403 || st === 503) && retry === 0) {
                        push({ t: 'meta', s: 'retry', d: { reason: 'HTTP ' + st, retry: retry + 1 } });
                        await new Promise(r => setTimeout(r, 1500));
                        continue;
                    }
                    // 400/404/405/422 might mean the mode name is wrong → try next alias
                    if ((st === 400 || st === 404 || st === 405 || st === 422) && m < modeChain.length - 1) {
                        break; // leave retry loop, advance the mode chain
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
