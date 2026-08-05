// ============================================================================
// arena-client.test.js — unit tests for the in-page executor logic
// Run: node tests/arena-client.test.js   (no dependencies required)
// ============================================================================
'use strict';

const assert = require('assert');
const { arenaExecFactory, parseArenaModelsHTML } = require('../src/arena-client');

// ---------- browser environment mocks ----------
function installBrowserMocks(fetchMock) {
    const cookieJar = { value: '' };
    const store = new Map();
    const grecaptcha = {
        enterprise: {
            ready: (cb) => { try { cb(); } catch (e) {} },
            execute: async (key, opts) => 'TOK_' + (opts && opts.action ? opts.action : 'none')
        }
    };
    global.window = global;
    global.grecaptcha = grecaptcha;
    global.turnstile = {
        render: (el, opts) => { setTimeout(() => opts.callback('TURNSTILE_OK'), 5); return 1; },
        getResponse: () => ''
    };
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        _store: store
    };
    global.location = { origin: 'https://arena.ai' };
    global.document = {
        documentElement: { innerHTML: '', appendChild: () => {} },
        head: { appendChild: () => {} },
        body: { appendChild: () => {} },
        createElement: () => ({ style: { cssText: '' }, setAttribute: () => {}, appendChild: () => {} }),
        querySelectorAll: () => [],
        get cookie() { return cookieJar.value; },
        set cookie(v) { cookieJar.value = cookieJar.value ? cookieJar.value + '; ' + v.split(';')[0] : v.split(';')[0]; }
    };
    global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    global.fetch = fetchMock;
    return { cookieJar, store };
}

function streamResponse(lines) {
    const enc = new TextEncoder().encode(lines);
    let sent = false;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (!sent) { sent = true; return { value: enc, done: false }; }
                    return { done: true };
                }
            })
        },
        text: async () => lines
    };
}

function errorResponse(status, bodyText) {
    return {
        ok: false,
        status,
        body: null,
        text: async () => bodyText || ''
    };
}

const NDJSON_OK = 'a0:"Hello, world!"\nag:"I should greet back."\nad:{"finishReason":"stop","usage":{"promptTokens":3,"completionTokens":5}}\n';

async function test(name, fn) {
    try {
        await fn();
        console.log('ok -', name);
    } catch (e) {
        console.error('FAIL -', name);
        console.error(e && e.stack ? e.stack : e);
        process.exitCode = 1;
    }
}

(async () => {
    const exec = arenaExecFactory();

    await test('buildBody: direct always includes modelBMessageId (current site schema)', () => {
        const b = exec.buildBody({ mode: 'direct', modelAId: 'UUID-A', content: 'hi', recaptchaToken: 'T' });
        assert.strictEqual(b.mode, 'direct');
        assert.strictEqual(b.modelAId, 'UUID-A');
        assert.ok(b.modelBMessageId, 'modelBMessageId must be present in direct mode');
        assert.strictEqual(b.userMessage.content, 'hi');
        assert.strictEqual(b.recaptchaV3Token, 'T');
        JSON.parse(JSON.stringify(b)); // serializes cleanly
    });

    await test('buildBody: battle strips model ids but keeps modelBMessageId', () => {
        const b = exec.buildBody({ mode: 'battle', modelAId: 'A', modelBId: 'B', content: 'x' });
        assert.strictEqual(b.modelAId, undefined);
        assert.strictEqual(b.modelBId, undefined);
        assert.ok(b.modelBMessageId);
    });

    await test('bodyFromTemplate: patches ids/content/mode, keeps unknown fields', () => {
        const template = {
            id: 'old', mode: 'direct', userMessageId: 'old', modelAMessageId: 'old', modelBMessageId: 'old',
            modelAId: 'old-A',
            userMessage: { content: 'old content', experimental_attachments: [], metadata: {} },
            modality: 'chat', recaptchaV3Token: 'old-token', brandNewField: { nested: true }
        };
        const b = exec.bodyFromTemplate(template, { mode: 'direct', modelAId: 'NEW-A', content: 'new content', recaptchaToken: 'T2' });
        assert.strictEqual(b.modelAId, 'NEW-A');
        assert.strictEqual(b.userMessage.content, 'new content');
        assert.strictEqual(b.recaptchaV3Token, 'T2');
        assert.deepStrictEqual(b.brandNewField, { nested: true });
        assert.notStrictEqual(b.id, 'old');
        assert.ok(b.modelBMessageId && b.modelBMessageId !== 'old');
    });

    await test('parseStreamLine: text / reasoning / finish / error / hasArenaError', () => {
        const events = [];
        const push = (e) => events.push(e);
        exec.parseStreamLine('a0:"chunk"', push);
        exec.parseStreamLine('ag:"a thought"', push);
        exec.parseStreamLine('ad:{"finishReason":"stop"}', push);
        exec.parseStreamLine('a2:[{"type":"heartbeat"}]', push);
        exec.parseStreamLine('a0:"hasArenaError"', push);
        assert.deepStrictEqual(events[0], { t: 'text', s: 'a', d: 'chunk' });
        assert.deepStrictEqual(events[1], { t: 'reasoning', s: 'a', d: 'a thought' });
        assert.strictEqual(events[2].t, 'finish');
        assert.strictEqual(events.length, 4);
        assert.strictEqual(events[3].t, 'error');
    });

    await test('run: happy path streams text+reasoning, sends X-Recaptcha headers, no manual Content-Type', async () => {
        const calls = [];
        installBrowserMocks(async (url, opts) => {
            calls.push({ url, opts });
            return streamResponse(NDJSON_OK);
        });
        const events = [];
        await exec.run({ mode: 'direct', modelAId: 'UUID-A', content: 'hi', allowSignup: false }, (e) => events.push(e));
        assert.strictEqual(calls.length, 1);
        assert.ok(String(calls[0].url).includes('/nextjs-api/stream/create-evaluation'));
        assert.strictEqual(calls[0].opts.headers['X-Recaptcha-Token'], 'TOK_chat_submit');
        assert.strictEqual(calls[0].opts.headers['X-Recaptcha-Action'], 'chat_submit');
        assert.strictEqual(calls[0].opts.headers['Content-Type'], undefined, 'Content-Type must be left to the browser');
        const texts = events.filter(e => e.t === 'text').map(e => e.d).join('');
        const reasons = events.filter(e => e.t === 'reasoning').map(e => e.d).join('');
        assert.strictEqual(texts, 'Hello, world!');
        assert.strictEqual(reasons, 'I should greet back.');
        assert.ok(events.some(e => e.t === 'finish'));
        assert.ok(events.some(e => e.t === 'done' && !e.d.failed));
        assert.ok(!events.some(e => e.t === 'error'), 'no error events on the happy path');
    });

    await test('run: HTTP 500 → anonymous sign-up → retry succeeds and sets the auth cookie', async () => {
        const calls = [];
        let evalCalls = 0;
        const mocks = installBrowserMocks(async (url, opts) => {
            calls.push(url);
            if (String(url).includes('/nextjs-api/sign-up')) {
                return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ session: { access_token: 'A', refresh_token: 'R', expires_in: 3600 } }) };
            }
            evalCalls++;
            if (evalCalls === 1) return errorResponse(500, '{"error":"Internal Server Error"}');
            return streamResponse(NDJSON_OK);
        });
        const events = [];
        await exec.run({ mode: 'direct', modelAId: 'UUID-A', content: 'hi' }, (e) => events.push(e));
        assert.strictEqual(calls.length, 3, 'eval → sign-up → eval');
        assert.ok(String(calls[1]).includes('/nextjs-api/sign-up'));
        assert.ok(String(calls[2]).includes('/nextjs-api/stream/create-evaluation'));
        assert.ok(events.some(e => e.t === 'meta' && e.s === 'signup'), 'signup meta events logged');
        assert.ok(!events.some(e => e.t === 'error'), 'recovered without an error event');
        assert.ok(mocks.cookieJar.value.includes('arena-auth-prod-v1='), 'auth cookie set from the sign-up session');
        assert.ok(mocks.cookieJar.value.includes('provisional_user_id='), 'provisional user id persisted');
    });

    await test('run: 500 advances the direct → direct-battle alias chain when sign-up is disabled', async () => {
        const bodies = [];
        installBrowserMocks(async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            if (bodies.length === 1) return errorResponse(500, '{"error":"Internal Server Error"}');
            return streamResponse(NDJSON_OK);
        });
        const events = [];
        await exec.run({ mode: 'direct', modelAId: 'UUID-A', content: 'hi', allowSignup: false }, (e) => events.push(e));
        assert.strictEqual(bodies.length, 2);
        assert.strictEqual(bodies[0].mode, 'direct');
        assert.strictEqual(bodies[1].mode, 'direct-battle', 'second attempt tries the direct-battle alias');
        assert.ok(!events.some(e => e.t === 'error'));
    });

    await test('run: gives up with a helpful error when sign-up cannot complete', async () => {
        global.turnstile = { render: () => 1, getResponse: () => '' }; // no token ever
        installBrowserMocks(async (url) => {
            if (String(url).includes('/nextjs-api/sign-up')) return errorResponse(403, 'forbidden');
            return errorResponse(500, '{"error":"Internal Server Error"}');
        });
        global.turnstile.render = () => 1; // still no callback token
        const events = [];
        await exec.run({ mode: 'direct', modelAId: 'UUID-A', content: 'hi', allowSignup: true }, (e) => events.push(e));
        const errs = events.filter(e => e.t === 'error');
        assert.strictEqual(errs.length, 1);
        assert.ok(errs[0].d.includes('HTTP 500'));
        assert.ok(errs[0].d.includes('anonymous sign-up failed') || errs[0].d.includes('sign-up failed'), 'error mentions the failed sign-up');
        assert.ok(errs[0].d.includes('session cookies') || errs[0].d.includes('Tampermonkey'), 'error suggests the next steps');
        assert.ok(events.some(e => e.t === 'done' && e.d.failed));
    });

    await test('run: battle mode never sends model ids', async () => {
        const bodies = [];
        installBrowserMocks(async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            return streamResponse('a0:"A"\nb0:"B"\nad:{}\nbd:{}\n');
        });
        await exec.run({ mode: 'battle', content: 'hi', allowSignup: false }, () => {});
        assert.strictEqual(bodies[0].mode, 'battle');
        assert.ok(!('modelAId' in bodies[0]));
        assert.ok(!('modelBId' in bodies[0]));
        assert.ok(bodies[0].modelBMessageId);
    });

    await test('parseArenaModelsHTML: RSC-escaped initialModels block', () => {
        const html = '<script>self.__next_f.push([1,"x\\"initialModels\\":[{\\"id\\":\\"11111111-2222-3333-4444-555555555555\\",\\"publicName\\":\\"gpt-5-test\\",\\"organization\\":\\"OpenAI\\",\\"capabilities\\":{\\"outputCapabilities\\":[\\"text\\"],\\"inputCapabilities\\":[\\"text\\",\\"image\\"]}}],\\"initialModelAId\\":\\"11111111-2222-3333-4444-555555555555\\""])</script>';
        const res = parseArenaModelsHTML(html);
        assert.strictEqual(res.models.length, 1);
        assert.strictEqual(res.models[0].name, 'gpt-5-test');
        assert.strictEqual(res.models[0].uuid, '11111111-2222-3333-4444-555555555555');
        assert.strictEqual(res.uuidMap['gpt-5-test'], '11111111-2222-3333-4444-555555555555');
        assert.strictEqual(res.initialModelAId, '11111111-2222-3333-4444-555555555555');
    });

    console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nall arena-client tests passed');
})();
