// ============================================================================
// e2e-ws.test.js — end-to-end: HTTP client → ProxyServer → mock WS userscript →
// arena executor (mocked arena.ai). Verifies streaming SSE (incl. reasoning),
// non-streaming JSON, meta diagnostics, and the HTTP 500 → sign-up recovery.
// Run: node tests/e2e-ws.test.js
// ============================================================================
'use strict';

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { ProxyServer } = require('../src/proxy-server');
const { arenaExecFactory } = require('../src/arena-client');

const PORT = 61999;
const API_KEY = 'test-key';

// ---------- browser mocks (shared by every executor run) ----------
let fetchImpl = null;
function installBrowserMocks() {
    const cookieJar = { value: '' };
    const store = new Map();
    global.window = global;
    global.grecaptcha = {
        enterprise: {
            ready: (cb) => { try { cb(); } catch (e) {} },
            execute: async (key, opts) => 'TOK_' + (opts && opts.action ? opts.action : 'none')
        }
    };
    global.turnstile = {
        render: (el, opts) => { setTimeout(() => opts.callback('TURNSTILE_OK'), 5); return 1; },
        getResponse: () => ''
    };
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); }
    };
    global.location = { origin: 'https://arena.ai' };
    global.document = {
        documentElement: { innerHTML: '', appendChild: () => {} },
        head: { appendChild: () => {} },
        body: { appendChild: () => {} },
        createElement: () => ({ style: { cssText: '' } }),
        querySelectorAll: () => [],
        get cookie() { return cookieJar.value; },
        set cookie(v) { cookieJar.value = cookieJar.value ? cookieJar.value + '; ' + v.split(';')[0] : v.split(';')[0]; }
    };
    global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    global.fetch = async (url, opts) => fetchImpl(url, opts);
    return { cookieJar };
}

function streamResponse(lines) {
    const enc = new TextEncoder().encode(lines);
    let sent = false;
    return {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => (!sent ? (sent = true, { value: enc, done: false }) : { done: true }) }) },
        text: async () => lines
    };
}

const NDJSON_OK = 'a0:"Hello"\na0:", world"\nag:"thinking aloud"\nad:{"finishReason":"stop","usage":{"promptTokens":2,"completionTokens":4}}\n';

function httpRequest(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: Object.assign({ 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

(async () => {
    installBrowserMocks();
    const { cookieJar } = installBrowserMocks();

    const fakeBrowserManager = {
        models: [{ id: 'gpt-test', name: 'gpt-test', outputs: ['text'], inputs: ['text'] }],
        modelUuidMap: { 'gpt-test': 'uuid-gpt-test' },
        initialModelAId: 'uuid-gpt-test',
        updateAvailableModels: () => {},
        getModelCapabilities: () => ({ outputs: ['text'], inputs: ['text'] }),
        executeArenaRequest: async () => { throw new Error('should not be used in this test'); },
        parseModelsFromHTML: () => []
    };

    const server = new ProxyServer(PORT, fakeBrowserManager, API_KEY);
    await server.start();

    // Mock userscript client: behaves like LMArena.js — runs the executor and streams events back
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const exec = arenaExecFactory();
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.command === 'send_page_source') return; // ignored in the test
        if (!msg.request_id || !msg.data) return;
        const requestId = msg.request_id;
        const send = (data) => { try { ws.send(JSON.stringify({ request_id: requestId, data })); } catch (e) {} };
        (async () => {
            await exec.run({
                mode: msg.data.mode || 'direct',
                modelAId: msg.data.modelAId,
                content: msg.data.content,
                template: msg.data.template || null,
                allowSignup: true
            }, send);
        })().catch((e) => send({ t: 'error', s: 'exec', d: e.message || String(e) }));
    });

    let failures = 0;
    const test = (name, cond, extra) => {
        if (cond) console.log('ok -', name);
        else { failures++; console.error('FAIL -', name, extra || ''); }
    };

    // ---- 1. streaming chat completion over WS userscript path ----
    fetchImpl = async (url) => streamResponse(NDJSON_OK);
    let res = await httpRequest('POST', '/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream: true
    });
    test('streaming: HTTP 200', res.status === 200, res.body.slice(0, 200));
    test('streaming: SSE contains content delta', res.body.includes('"content":"Hello"'));
    test('streaming: SSE carries reasoning_content', res.body.includes('"reasoning_content":"thinking aloud"'));
    test('streaming: usage passthrough', res.body.includes('"prompt_tokens":2'));
    test('streaming: ends with [DONE]', res.body.includes('data: [DONE]'));

    // ---- 2. non-streaming ----
    res = await httpRequest('POST', '/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream: false
    });
    test('non-streaming: HTTP 200', res.status === 200, res.body.slice(0, 200));
    try {
        const j = JSON.parse(res.body);
        const msg = j.choices[0].message;
        test('non-streaming: aggregated content', msg.content === 'Hello, world', JSON.stringify(msg));
        test('non-streaming: reasoning attached', msg.reasoning_content === 'thinking aloud');
    } catch (e) { test('non-streaming: JSON parse', false, e.message); }

    // ---- 3. HTTP 500 → anonymous sign-up → retry succeeds end-to-end ----
    let evalCalls = 0;
    fetchImpl = async (url) => {
        if (String(url).includes('/nextjs-api/sign-up')) {
            return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ session: { access_token: 'A', refresh_token: 'R', expires_in: 3600 } }) };
        }
        evalCalls++;
        if (evalCalls === 1) return { ok: false, status: 500, body: null, text: async () => '{"error":"Internal Server Error"}' };
        return streamResponse(NDJSON_OK);
    };
    res = await httpRequest('POST', '/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream: true
    });
    test('sign-up recovery: HTTP 200 after a 500', res.status === 200, res.body.slice(0, 200));
    test('sign-up recovery: content streamed after recovery', res.body.includes('"content":"Hello"'));
    test('sign-up recovery: eval was retried (2 eval calls)', evalCalls === 2, 'got ' + evalCalls);

    // ---- 4. unauthenticated request rejected ----
    const noAuth = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST' }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end('{}');
    });
    test('auth: 401 without API key', noAuth.status === 401);

    ws.close();
    await new Promise(r => setTimeout(r, 300));
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.error('E2E crashed:', e);
    process.exit(1);
});
