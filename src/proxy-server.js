const express = require('express');
const http = require('http');
const cors = require('cors');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

// Supported chat modes on arena.ai
const VALID_MODES = new Set(['direct', 'direct-battle', 'battle', 'side-by-side', 'agent']);

// ============================================================================
// Aggregates structured arena events ({t, s, d}) into OpenAI-shaped output.
// Both backends (WebSocket userscript & Puppeteer in-page executor) emit the
// same event shape, so a single sink handles stream and non-stream modes.
// ============================================================================
class ArenaEventSink {
    constructor(dual) {
        this.dual = dual;               // battle / side-by-side → two model panels
        this.textBySide = { a: '', b: '' };
        this.reasoningBySide = { a: '', b: '' };
        this.headersEmitted = { a: false, b: false };
        this.finishReason = null;
        this.usage = null;
        this.error = null;
        this.done = false;
    }

    // Returns an array of { kind: 'content'|'reasoning', delta } actions to emit.
    ingest(evt) {
        const actions = [];
        if (!evt || typeof evt !== 'object') return actions;

        // Plain string from legacy userscripts — treat as model A text delta
        if (typeof evt === 'string') {
            if (evt === '[DONE]') { this.done = true; return actions; }
            return this._pushText('a', evt, actions);
        }

        switch (evt.t) {
            case 'text': this._pushText(evt.s || 'a', String(evt.d || ''), actions); break;
            case 'reasoning': {
                const d = String(evt.d || '');
                if (!d) break;
                this.reasoningBySide[evt.s || 'a'] += d;
                actions.push({ kind: 'reasoning', delta: d });
                break;
            }
            case 'image': {
                const url = String(evt.d || '');
                if (url) this._pushText(evt.s || 'a', `\n\n![generated image](${url})\n\n`, actions);
                break;
            }
            case 'finish': {
                const d = evt.d || {};
                if (d.finishReason && !this.finishReason) this.finishReason = String(d.finishReason);
                if (d.usage && typeof d.usage === 'object') this.usage = d.usage;
                break;
            }
            case 'error':
                if (!this.error) this.error = String(evt.d || 'Unknown arena error');
                this.done = true;
                break;
            case 'done':
                this.done = true;
                break;
            case 'meta':
            default:
                break; // meta/retry events are informational
        }
        return actions;
    }

    _pushText(side, delta, actions) {
        if (!delta) return actions;
        let out = delta;
        if (this.dual && !this.headersEmitted[side]) {
            this.headersEmitted[side] = true;
            out = (this.textBySide.a || this.textBySide.b ? '\n\n' : '') + `**Model ${side.toUpperCase()}:**\n\n` + out;
        }
        this.textBySide[side] += delta;
        actions.push({ kind: 'content', delta: out });
        return actions;
    }

    get content() {
        if (!this.dual) return this.textBySide.a + this.textBySide.b;
        // Non-streaming aggregation: label the two panels explicitly
        let out = '';
        if (this.textBySide.a) out += '**Model A:**\n\n' + this.textBySide.a;
        if (this.textBySide.b) out += (out ? '\n\n' : '') + '**Model B:**\n\n' + this.textBySide.b;
        return out;
    }

    get reasoning() {
        let out = this.reasoningBySide.a;
        if (this.dual && this.reasoningBySide.b) {
            out += (out ? '\n\n' : '') + this.reasoningBySide.b;
        }
        return out;
    }

    get finishReasonSafe() {
        return (this.finishReason && this.finishReason !== 'null') ? this.finishReason : 'stop';
    }
}

class ProxyServer {
    constructor(port, browserManager, apiKey, options) {
        this.port = port;
        this.browserManager = browserManager;
        this.apiKey = apiKey;
        this.defaultMode = (options && options.defaultMode) || 'direct';
        this.app = express();
        this.server = null;
        this.wss = null;
        this.wsClients = new Map();  // clientId -> { ws, info, activeRequests }
        this.wsClientId = 0;
        this.wsClientIndex = 0;      // round-robin counter
        this.onWsClientChange = null; // callback: notify the main process when a client connects/disconnects
        this.capturedApiInfo = null;   // API info captured from WS clients
        this.capturedModelData = null; // model UUID mapping extracted from WS clients
        this.onModelUpdate = null;     // callback: notify the main process when the model list updates
    }

    setOptions(opts) {
        if (opts && typeof opts.defaultMode === 'string' && VALID_MODES.has(opts.defaultMode)) {
            this.defaultMode = opts.defaultMode;
        }
    }

    async start() {
        this.app.use(cors());
        this.app.use(express.json({ limit: '50mb' }));

        // ========== GET /v1/models ==========
        this.app.get('/v1/models', (req, res) => {
            const auth = req.headers.authorization;
            if (!this.validateAuth(auth)) {
                return res.status(401).json({ error: 'Invalid API key' });
            }
            const models = this.browserManager.getAvailableModels();
            res.json({
                object: 'list',
                data: models.map(m => ({
                    id: m.id,
                    object: 'model',
                    created: Date.now(),
                    owned_by: m.organization || m.provider || 'arena'
                }))
            });
        });

        // ========== POST /v1/chat/completions ==========
        this.app.post('/v1/chat/completions', async (req, res) => {
            const auth = req.headers.authorization;
            if (!this.validateAuth(auth)) {
                return res.status(401).json({ error: 'Invalid API key' });
            }

            const { model, messages, stream = false } = req.body;
            const requestId = randomUUID();
            const spec = this.parseModelSpec(model, req.body);
            const lastUserMsg = (messages || []).filter(m => m.role === 'user').pop();
            const messageText = typeof (lastUserMsg && lastUserMsg.content) === 'string'
                ? lastUserMsg.content
                : (lastUserMsg && Array.isArray(lastUserMsg.content)
                    ? lastUserMsg.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n')
                    : 'Hello');
            spec.content = messageText || 'Hello';
            this._resolveSpec(spec);

            console.log(`[HTTP] /v1/chat/completions: model=${model} → ${spec.modelA}${spec.modelB ? ' vs ' + spec.modelB : ''}, mode=${spec.mode}, stream=${stream}`);

            // Prefer a WebSocket client (real browser via Tampermonkey)
            const wsClient = this.getNextWsClient();
            if (wsClient) {
                return this.handleViaWsClient(wsClient, requestId, spec, stream, res);
            }

            // Fall back to the Puppeteer in-page executor (hidden by default)
            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const sink = new ArenaEventSink(spec.dual);
                try {
                    await this.browserManager.executeArenaRequest(spec, (evt) => {
                        const actions = sink.ingest(evt);
                        for (const a of actions) this._writeSseAction(res, requestId, spec.modelA, a);
                        if (sink.error) {
                            res.write(`data: ${JSON.stringify({ error: sink.error })}\n\n`);
                        }
                    });
                    if (!sink.error && !sink.content.trim() && !sink.reasoning.trim()) {
                        res.write(`data: ${JSON.stringify({ error: 'Empty response — make sure the instance is logged in (import session cookies) and the model is available' })}\n\n`);
                    }
                    this._writeSseFinal(res, requestId, spec.modelA, sink);
                    res.write('data: [DONE]\n\n');
                    res.end();
                } catch (error) {
                    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                    res.end();
                }
            } else {
                try {
                    const sink = await this._collectViaBrowser(spec);
                    if (sink.error) {
                        return res.status(500).json({ error: sink.error });
                    }
                    res.json(this._buildCompletionJson(requestId, spec.modelA, sink));
                } catch (error) {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        // ========== Internal API: parse model list from HTML ==========
        this.app.post('/internal/update_available_models', express.text({ type: 'text/html', limit: '10mb' }), (req, res) => {
            try {
                const models = this.browserManager.parseModelsFromHTML(req.body);
                console.log(`[ProxyServer] Parsed ${models.length} models from page source`);
                res.json({ success: true, count: models.length });
            } catch (e) {
                console.error('[ProxyServer] Model parse error:', e.message);
                res.status(500).json({ error: e.message });
            }
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', timestamp: Date.now(), wsClients: this.wsClients.size });
        });

        this.server = http.createServer(this.app);

        // ========== WebSocket server ==========
        this.setupWebSocket(this.server);

        return new Promise((resolve, reject) => {
            this.server.listen(this.port, () => {
                console.log(`[ProxyServer] HTTP+WS server listening on port ${this.port}`);
                resolve();
            }).on('error', reject);
        });
    }

    // ========== Model spec parsing: model suffixes select the arena mode ==========
    //   "gpt-5"                → direct mode (or configured default)
    //   "gpt-5~direct"         → explicit direct mode
    //   "gpt-5~battle"         → battle mode (anonymous pair, model choice ignored)
    //   "gpt-5~vs~claude-4.5"  → side-by-side with the two models
    //   "gpt-5~side-by-side"   → side-by-side (second model comes from modelB/model_b)
    //   "gpt-5~agent"          → agent mode (experimental)
    // The request body may also carry explicit fields: "mode" and "modelB"/"model_b".
    parseModelSpec(rawModel, body) {
        let model = String(rawModel || '').trim();
        let mode = null;
        let modelB = body && (body.modelB || body.model_b) ? String(body.modelB || body.model_b) : null;

        const bodyMode = body && typeof body.mode === 'string' ? body.mode.trim() : '';
        if (bodyMode && VALID_MODES.has(bodyMode)) mode = bodyMode;

        const vsIdx = model.toLowerCase().indexOf('~vs~');
        if (vsIdx !== -1) {
            const a = model.slice(0, vsIdx).trim();
            const b = model.slice(vsIdx + 4).trim();
            if (a) model = a;
            if (b) modelB = b;
            if (!mode) mode = 'side-by-side';
        } else {
            const suffixMatch = model.match(/~(direct|direct-battle|battle|side-by-side|side|agent)$/i);
            if (suffixMatch) {
                model = model.slice(0, suffixMatch.index).trim();
                if (!mode) {
                    let m = suffixMatch[1].toLowerCase();
                    if (m === 'side') m = 'side-by-side';
                    mode = m;
                }
            }
        }

        if (!mode) mode = this.defaultMode;
        if (mode === 'side-by-side' && !modelB) {
            // No second model — degrade gracefully to direct
            console.log('[ProxyServer] side-by-side requested without a second model — falling back to direct');
            mode = 'direct';
        }
        if (mode === 'agent') {
            console.log('[ProxyServer] Agent mode requested (experimental) — arena agent backend may differ; trying mode "agent" with fallback');
        }

        return {
            modelA: model,
            modelB: modelB,
            mode,
            dual: (mode === 'battle' || mode === 'side-by-side'),
            modelAId: '',
            modelBId: '',
            modality: 'chat',
            content: ''
        };
    }

    // Resolve UUIDs + modality for a parsed spec
    _resolveSpec(spec) {
        spec.modelAId = (spec.mode === 'battle') ? '' : this.resolveModelUuid(spec.modelA);
        spec.modelBId = (spec.mode === 'side-by-side' && spec.modelB) ? this.resolveModelUuid(spec.modelB) : '';
        // Clone the site's real request shape when we captured one (self-healing)
        if (this.capturedApiInfo && this.capturedApiInfo.body) {
            spec.template = this.capturedApiInfo.body;
            if (this.capturedApiInfo.url) spec.url = this.capturedApiInfo.url;
        }
        try {
            const caps = this.browserManager.getModelCapabilities
                ? this.browserManager.getModelCapabilities(spec.modelA)
                : { outputs: [] };
            const outs = caps.outputs || [];
            if (outs.length > 0 && outs.includes('image') && !outs.includes('text')) {
                spec.modality = 'image';
            }
        } catch (e) {}
        return spec;
    }

    resolveModelUuid(model) {
        if (!model) return (this.capturedModelData && this.capturedModelData.initialModelAId) || '';
        // UUID passed directly
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(model)) return model;

        const sources = [];
        if (this.capturedModelData) {
            sources.push(this.capturedModelData.uuidMap || {});
            sources.push(this.capturedModelData.nameMap || {});
        }
        if (this.browserManager && this.browserManager.modelUuidMap) {
            sources.push(this.browserManager.modelUuidMap);
        }

        // Exact matches
        for (const map of sources) {
            if (map[model]) return map[model];
            if (map[model.toLowerCase()]) return map[model.toLowerCase()];
        }
        // Fuzzy match
        const normalized = model.toLowerCase().replace(/[-_.\s]/g, '');
        for (const map of sources) {
            for (const [key, uuid] of Object.entries(map)) {
                if (key.toLowerCase().replace(/[-_.\s]/g, '') === normalized) return uuid;
            }
        }
        // Fall back to the default model UUID if we have one
        if (this.capturedModelData && this.capturedModelData.initialModelAId) return this.capturedModelData.initialModelAId;
        if (this.browserManager && this.browserManager.initialModelAId) return this.browserManager.initialModelAId;
        return model;
    }

    // ========== WebSocket server setup ==========
    setupWebSocket(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws' });

        this.wss.on('connection', (ws, req) => {
            const clientId = ++this.wsClientId;
            const clientInfo = {
                id: clientId,
                ip: req.socket.remoteAddress,
                connectedAt: new Date().toISOString(),
                url: ''
            };

            this.wsClients.set(clientId, { ws, info: clientInfo, activeRequests: new Map() });
            console.log(`[WS] Client #${clientId} connected from ${clientInfo.ip}, total: ${this.wsClients.size}`);

            this._notifyWsClientChange();

            // Request the page source after connecting to update the model list
            try {
                ws.send(JSON.stringify({ command: 'send_page_source' }));
            } catch (e) {}

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Handle page source (transferred over WS to avoid mixed-content issues)
                    if (msg.type === 'page_source' && msg.data) {
                        try {
                            // Prefer structured initialModels parsing (names + UUIDs + capabilities)
                            const { parseArenaModelsHTML } = require('./arena-client');
                            const parsed = parseArenaModelsHTML(msg.data);
                            if (parsed.models.length > 0) {
                                this.browserManager.models = parsed.models;
                                Object.assign(this.browserManager.modelUuidMap, parsed.uuidMap);
                                if (parsed.initialModelAId) this.browserManager.initialModelAId = parsed.initialModelAId;
                                console.log(`[WS] Parsed ${parsed.models.length} models (${Object.keys(parsed.uuidMap).length} UUID mappings) from page source via WS`);
                                if (this.onModelUpdate) this.onModelUpdate(this.browserManager.models);
                            } else {
                                const models = this.browserManager.parseModelsFromHTML(msg.data);
                                if (models.length > 0) {
                                    this.browserManager.models = models;
                                    console.log(`[WS] Parsed ${models.length} models from page source via WS (slug scan)`);
                                }
                            }
                        } catch (e) {
                            console.error('[WS] Failed to parse page source:', e.message);
                        }
                        return;
                    }

                    // Handle captured request template (real create-evaluation shape from the page)
                    if (msg.type === 'api_info' && msg.data) {
                        this.capturedApiInfo = msg.data;
                        const bodyKeys = msg.data.body && typeof msg.data.body === 'object' ? Object.keys(msg.data.body).join(',') : '-';
                        console.log(`[WS] Captured request template: mode=${msg.data.mode || '?'}, url=${(msg.data.url || '').slice(0, 90)}, body keys: ${bodyKeys}`);
                        return;
                    }

                    // Handle model UUID mapping
                    if (msg.type === 'model_data' && msg.data) {
                        this.capturedModelData = msg.data;
                        const modelCount = (msg.data.models || []).length;
                        const mappingCount = Object.keys(msg.data.uuidMap || {}).length;
                        const uuidCount = new Set(Object.values(msg.data.uuidMap || {})).size;
                        const initAId = msg.data.initialModelAId || '';
                        console.log(`[WS] Captured model data: ${modelCount} models, ${uuidCount} UUIDs, ${mappingCount} mappings, initialModelAId: ${initAId.substring(0, 12)}...`);

                        // Update browserManager's model list
                        if (msg.data.models && msg.data.models.length > 0) {
                            this.browserManager.models = msg.data.models;
                            if (msg.data.uuidMap) Object.assign(this.browserManager.modelUuidMap, msg.data.uuidMap);
                            if (initAId) this.browserManager.initialModelAId = initAId;
                            if (this.onModelUpdate) {
                                this.onModelUpdate(msg.data.models);
                            }
                        }
                        return;
                    }

                    // Handle diagnostics
                    if (msg.type === 'diagnostics' && msg.data) {
                        const d = msg.data;
                        if (d.recentFetchUrls) {
                            console.log(`[WS] Diagnostics: ${d.event} | fetchUrls: ${JSON.stringify(d.recentFetchUrls)} | pendingHijack: ${d.pendingHijack}`);
                        } else {
                            console.log(`[WS] Diagnostics: recaptcha=${d.recaptcha}, modelAId=${d.modelAId}, template=${d.templateUsed}`);
                        }
                        if (this.onDiagnostics) {
                            this.onDiagnostics(d);
                        }
                        return;
                    }

                    // Handle status messages
                    if (msg.type === 'status' && msg.data) {
                        const statusData = msg.data;
                        console.log(`[WS] Status: ${statusData.status} - ${statusData.message || ''}`);
                        if (this.onStatus) {
                            this.onStatus(statusData);
                        }
                        return;
                    }

                    // Request response: { request_id, data }
                    if (msg.request_id && msg.data !== undefined) {
                        const requestId = msg.request_id;
                        for (const [, client] of this.wsClients) {
                            const handler = client.activeRequests.get(requestId);
                            if (handler) {
                                handler(msg.data);
                                return;
                            }
                        }
                        console.log(`[WS] Received response for unknown request: ${requestId.substring(0, 8)}`);
                    }
                } catch (e) {
                    console.error('[WS] Message parse error:', e.message);
                }
            });

            ws.on('close', () => {
                const client = this.wsClients.get(clientId);
                if (client) {
                    // Cancel all active requests
                    for (const [requestId, handler] of client.activeRequests) {
                        handler({ t: 'error', s: 'ws', d: 'WebSocket client disconnected' });
                        handler({ t: 'done', s: 'ws', d: {} });
                    }
                }
                this.wsClients.delete(clientId);
                console.log(`[WS] Client #${clientId} disconnected, total: ${this.wsClients.size}`);
                this._notifyWsClientChange();
            });

            ws.on('error', (err) => {
                console.error(`[WS] Client #${clientId} error:`, err.message);
            });
        });

        console.log('[ProxyServer] WebSocket server ready at /ws');
    }

    // ========== Forward requests to arena.ai via a WebSocket client ==========
    handleViaWsClient(client, requestId, spec, stream, res) {
        const wsMessage = {
            request_id: requestId,
            data: {
                model: spec.modelA,
                modelAId: spec.modelAId,
                modelB: spec.modelB || '',
                modelBId: spec.modelBId || '',
                mode: spec.mode,
                modality: spec.modality,
                template: spec.template || null,
                url: spec.url || '',
                content: spec.content
            }
        };

        console.log(`[WS] Sending request ${requestId.substring(0, 8)} to client #${client.info.id}, model: ${spec.modelA}, mode: ${spec.mode}`);

        const sink = new ArenaEventSink(spec.dual);

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            client.activeRequests.set(requestId, (data) => {
                if (data && typeof data === 'object' && data.error && !data.t) {
                    // Legacy error shape { error }
                    sink.ingest({ t: 'error', s: 'ws', d: data.error });
                    res.write(`data: ${JSON.stringify({ error: data.error })}\n\n`);
                    client.activeRequests.delete(requestId);
                    res.end();
                    return;
                }

                const legacyText = this._legacyEventToText(data);
                const actions = legacyText !== null ? sink.ingest(legacyText) : sink.ingest(data);

                for (const a of actions) this._writeSseAction(res, requestId, spec.modelA, a);

                if (sink.error) {
                    res.write(`data: ${JSON.stringify({ error: sink.error })}\n\n`);
                    client.activeRequests.delete(requestId);
                    res.end();
                    return;
                }
                if (sink.done) {
                    this._writeSseFinal(res, requestId, spec.modelA, sink);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    client.activeRequests.delete(requestId);
                }
            });

            try {
                client.ws.send(JSON.stringify(wsMessage));
            } catch (e) {
                client.activeRequests.delete(requestId);
                res.status(503).json({ error: 'WebSocket send failed: ' + e.message });
            }

            // Stream timeout safety net
            setTimeout(() => {
                if (client.activeRequests.has(requestId)) {
                    client.activeRequests.delete(requestId);
                    try {
                        this._writeSseFinal(res, requestId, spec.modelA, sink);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } catch (e) {}
                }
            }, 150000);
        } else {
            // Non-streaming: collect everything, then respond
            client.activeRequests.set(requestId, (data) => {
                if (data && typeof data === 'object' && data.error && !data.t) {
                    sink.ingest({ t: 'error', s: 'ws', d: data.error });
                    client.activeRequests.delete(requestId);
                    return;
                }
                const legacyText = this._legacyEventToText(data);
                if (legacyText !== null) sink.ingest(legacyText); else sink.ingest(data);
                if (sink.done || sink.error) client.activeRequests.delete(requestId);
            });

            try {
                client.ws.send(JSON.stringify(wsMessage));
            } catch (e) {
                client.activeRequests.delete(requestId);
                return res.status(503).json({ error: 'WebSocket send failed: ' + e.message });
            }

            const checkInterval = setInterval(() => {
                if (!client.activeRequests.has(requestId)) {
                    clearInterval(checkInterval);
                    if (sink.error) {
                        res.status(500).json({ error: sink.error });
                    } else {
                        res.json(this._buildCompletionJson(requestId, spec.modelA, sink));
                    }
                }
            }, 200);

            setTimeout(() => {
                if (client.activeRequests.has(requestId)) {
                    clearInterval(checkInterval);
                    client.activeRequests.delete(requestId);
                    res.status(504).json({ error: 'Request timed out' });
                }
            }, 150000);
        }
    }

    // Raw arena events ready for the pipeline — also usable from the main process (Test button)
    collectCompletion(spec) {
        this._resolveSpec(spec);
        const wsClient = this.getNextWsClient();
        const sink = new ArenaEventSink(spec.dual);

        return new Promise((resolve, reject) => {
            const finish = () => resolve(sink);

            if (wsClient) {
                const requestId = randomUUID();
                wsClient.activeRequests.set(requestId, (data) => {
                    if (data && typeof data === 'object' && data.error && !data.t) {
                        sink.ingest({ t: 'error', s: 'ws', d: data.error });
                        wsClient.activeRequests.delete(requestId);
                        finish();
                        return;
                    }
                    const legacyText = this._legacyEventToText(data);
                    if (legacyText !== null) sink.ingest(legacyText); else sink.ingest(data);
                    if (sink.done || sink.error) {
                        wsClient.activeRequests.delete(requestId);
                        finish();
                    }
                });
                try {
                    wsClient.ws.send(JSON.stringify({
                        request_id: requestId,
                        data: {
                            model: spec.modelA,
                            modelAId: spec.modelAId,
                            modelB: spec.modelB || '',
                            modelBId: spec.modelBId || '',
                            mode: spec.mode,
                            modality: spec.modality,
                            template: spec.template || null,
                            url: spec.url || '',
                            content: spec.content
                        }
                    }));
                } catch (e) {
                    wsClient.activeRequests.delete(requestId);
                    reject(new Error('WebSocket send failed: ' + e.message));
                }
                setTimeout(() => {
                    if (wsClient.activeRequests.has(requestId)) {
                        wsClient.activeRequests.delete(requestId);
                        finish(); // resolve with whatever was collected
                    }
                }, 150000);
            } else {
                this.browserManager.executeArenaRequest(spec, (evt) => {
                    sink.ingest(evt);
                    if (sink.done || sink.error) finish();
                }).catch((e) => {
                    sink.ingest({ t: 'error', s: 'exec', d: e.message || String(e) });
                    finish();
                });
            }
        });
    }

    // ========== Internals ==========

    _collectViaBrowser(spec) {
        const sink = new ArenaEventSink(spec.dual);
        return new Promise((resolve) => {
            this.browserManager.executeArenaRequest(spec, (evt) => {
                sink.ingest(evt);
                if (sink.done || sink.error) resolve(sink);
            }).catch((e) => {
                sink.ingest({ t: 'error', s: 'exec', d: e.message || String(e) });
                resolve(sink);
            });
            // Safety timeout
            setTimeout(() => resolve(sink), 150000);
        });
    }

    // Convert legacy userscript payloads (plain text / RSC text lines) to a text delta string;
    // returns null when the payload is a structured arena event ({t, s, d})
    _legacyEventToText(data) {
        if (data == null) return null;
        if (typeof data === 'string') return data; // plain delta or [DONE]
        if (typeof data === 'object' && typeof data.t === 'string') return null; // structured event
        return null;
    }

    _writeSseAction(res, requestId, model, action) {
        const delta = action.kind === 'reasoning'
            ? { reasoning_content: action.delta }
            : { content: action.delta };
        res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta, finish_reason: null }]
        })}\n\n`);
    }

    _writeSseFinal(res, requestId, model, sink) {
        const chunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: sink.finishReasonSafe }]
        };
        if (sink.usage) chunk.usage = sink.usage;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    _buildCompletionJson(requestId, model, sink) {
        const message = {
            role: 'assistant',
            content: sink.content || '(The model returned an empty response)'
        };
        if (sink.reasoning) message.reasoning_content = sink.reasoning;
        const json = {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message,
                finish_reason: sink.finishReasonSafe
            }]
        };
        if (sink.usage) json.usage = sink.usage;
        return json;
    }

    // ========== WebSocket client management ==========
    getNextWsClient() {
        if (this.wsClients.size === 0) return null;

        const clients = [...this.wsClients.values()].filter(c => c.ws.readyState === WebSocket.OPEN);
        if (clients.length === 0) return null;

        // Round-robin selection
        this.wsClientIndex = this.wsClientIndex % clients.length;
        return clients[this.wsClientIndex++];
    }

    getWsClientList() {
        return [...this.wsClients.values()].map(c => ({
            id: c.info.id,
            status: c.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
            connectedAt: c.info.connectedAt,
            ip: c.info.ip,
            activeRequests: c.activeRequests.size
        }));
    }

    getWsClientCount() {
        return this.wsClients.size;
    }

    _notifyWsClientChange() {
        if (this.onWsClientChange) {
            this.onWsClientChange(this.getWsClientList());
        }
    }

    // Send a command to all WS clients
    broadcastCommand(command) {
        const msg = JSON.stringify({ command });
        for (const [, client] of this.wsClients) {
            if (client.ws.readyState === WebSocket.OPEN) {
                try { client.ws.send(msg); } catch (e) {}
            }
        }
    }

    validateAuth(auth) {
        if (!auth) return false;
        const token = auth.replace('Bearer ', '');
        return token === this.apiKey;
    }

    async stop() {
        console.log('[ProxyServer] Stopping servers...');

        // Close all WS connections
        if (this.wss) {
            for (const [, client] of this.wsClients) {
                try { client.ws.close(); } catch (e) {}
            }
            this.wsClients.clear();
            this.wss.close();
        }

        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    console.log('[ProxyServer] HTTP server closed');
                    resolve();
                });
            });
        }
    }
}

module.exports = { ProxyServer, ArenaEventSink };
