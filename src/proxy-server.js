const express = require('express');
const http = require('http');
const cors = require('cors');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

class ProxyServer {
    constructor(port, browserManager, apiKey) {
        this.port = port;
        this.browserManager = browserManager;
        this.apiKey = apiKey;
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
                    owned_by: m.provider || 'arena'
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

            // Prefer WebSocket client mode
            const wsClient = this.getNextWsClient();
            if (wsClient) {
                return this.handleViaWsClient(wsClient, requestId, model, messages, stream, res);
            }

            // Fall back to browser client mode (Puppeteer UI automation)
            if (!this.browserManager || this.browserManager.pages.length === 0) {
                return res.status(503).json({
                    error: 'No clients available — create a browser instance and log in to lmarena.ai first, or install the Tampermonkey script to connect a WebSocket client'
                });
            }

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                try {
                    await this.browserManager.handleChatCompletion(requestId, model, messages, (chunk) => {
                        if (chunk.error) {
                            res.write(`data: ${JSON.stringify({ error: chunk.error })}\n\n`);
                        } else {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    });
                    res.write('data: [DONE]\n\n');
                    res.end();
                } catch (error) {
                    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                    res.end();
                }
            } else {
                try {
                    let fullContent = '';
                    let chunkError = null;
                    await this.browserManager.handleChatCompletion(requestId, model, messages, (chunk) => {
                        if (chunk.error) {
                            chunkError = chunk.error;
                            return;
                        }
                        if (chunk.choices && chunk.choices[0].delta && chunk.choices[0].delta.content) {
                            fullContent += chunk.choices[0].delta.content;
                        }
                    });
                    if (chunkError) {
                        return res.status(500).json({ error: chunkError });
                    }
                    res.json({
                        id: requestId,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: model,
                        choices: [{
                            index: 0,
                            message: { role: 'assistant', content: fullContent },
                            finish_reason: 'stop'
                        }]
                    });
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

    // ========== WebSocket server setup ==========
    setupWebSocket(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws' });

        // Store API info (URL, headers, etc.) sent by WS clients
        this.capturedApiInfo = null;

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

            // Notify the main process about client list changes
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
                            const models = this.browserManager.parseModelsFromHTML(msg.data);
                            if (models.length > 0) {
                                this.browserManager.models = models;
                                console.log(`[WS] Parsed ${models.length} models from page source via WS`);
                            }
                        } catch (e) {
                            console.error('[WS] Failed to parse page source:', e.message);
                        }
                        return;
                    }

                    // Handle captured API info
                    if (msg.type === 'api_info' && msg.data) {
                        this.capturedApiInfo = msg.data;
                        console.log(`[WS] Captured API info: url=${msg.data.url}, headers=${Object.keys(msg.data.headers || {}).join(',')}`);
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
                        // Update even without UUIDs as long as a slug list exists (otherwise the old list is shown forever)
                        if (msg.data.models && msg.data.models.length > 0) {
                            this.browserManager.models = msg.data.models;
                            // Notify the main process that the model list was updated
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
                            console.log(`[WS] Diagnostics: recaptcha=${d.recaptcha}, source=${d.recaptchaSource}, time=${d.recaptchaTime}, grecaptcha=${d.grecaptchaAvailable}, modelAId=${d.modelAId}, template=${d.templateUsed}`);
                        }
                        // Forward to the main process log
                        if (this.onDiagnostics) {
                            this.onDiagnostics(d);
                        }
                        return;
                    }

                    // Handle status messages (waiting for user trigger, etc.)
                    if (msg.type === 'status' && msg.data) {
                        const statusData = msg.data;
                        console.log(`[WS] Status: ${statusData.status} - ${statusData.message || ''}`);
                        // Forward to the main process
                        if (this.onStatus) {
                            this.onStatus(statusData);
                        }
                        return;
                    }

                    // Request response: { request_id, data }
                    if (msg.request_id && msg.data !== undefined) {
                        const requestId = msg.request_id;
                        // Find the client holding this request
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
                        handler({ error: 'WebSocket client disconnected' });
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

    // ========== Forward requests to the lmarena.ai API via a WebSocket client ==========
    handleViaWsClient(client, requestId, model, messages, stream, res) {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const messageText = lastUserMsg ? lastUserMsg.content : 'Hello';

        // Resolve modelAId — prefer the UUID mapping, fall back to initialModelAId
        let modelAId = model;  // use the model name by default
        if (this.capturedModelData) {
            const uuidMap = this.capturedModelData.uuidMap || {};
            const nameMap = this.capturedModelData.nameMap || {};

            // Exact match
            if (uuidMap[model]) modelAId = uuidMap[model];
            else if (uuidMap[model.toLowerCase()]) modelAId = uuidMap[model.toLowerCase()];
            else if (nameMap[model]) modelAId = nameMap[model];
            else if (nameMap[model.toLowerCase()]) modelAId = nameMap[model.toLowerCase()];

            // Fuzzy match
            if (modelAId === model) {
                const normalized = model.toLowerCase().replace(/[-_.\s]/g, '');
                for (const [key, uuid] of Object.entries(uuidMap)) {
                    if (key.toLowerCase().replace(/[-_.\s]/g, '') === normalized) {
                        modelAId = uuid;
                        break;
                    }
                }
            }

            // If it is still the raw model name, fall back to initialModelAId
            if (modelAId === model && this.capturedModelData.initialModelAId) {
                modelAId = this.capturedModelData.initialModelAId;
            }
        }

        const wsMessage = {
            request_id: requestId,
            data: {
                model: model,
                modelAId: modelAId,
                content: messageText
            }
        };

        console.log(`[WS] Sending request ${requestId.substring(0, 8)} to client #${client.info.id}, model: ${model}`);

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // Register the response handler
            client.activeRequests.set(requestId, (data) => {
                if (data && typeof data === 'object' && data.error) {
                    res.write(`data: ${JSON.stringify({ error: data.error })}\n\n`);
                    client.activeRequests.delete(requestId);
                    res.end();
                    return;
                }

                if (data === '[DONE]') {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    client.activeRequests.delete(requestId);
                    return;
                }

                // Convert lmarena.ai's streamed response to OpenAI SSE format
                try {
                    // Try RSC format parsing first (older userscripts send raw RSC data)
                    const chunks = this._parseLmarenaStream(data);
                    if (chunks.length > 0) {
                        for (const chunk of chunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    } else if (typeof data === 'string' && data.length > 0) {
                        // Newer userscript versions send plain-text content directly
                        res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: '', choices: [{ index: 0, delta: { content: data }, finish_reason: null }] })}\n\n`);
                    }
                } catch (e) {
                    // On parse failure, pass the data through as-is
                    res.write(`data: ${JSON.stringify({ id: requestId, choices: [{ delta: { content: data }, finish_reason: null }] })}\n\n`);
                }
            });

            try {
                client.ws.send(JSON.stringify(wsMessage));
            } catch (e) {
                client.activeRequests.delete(requestId);
                res.status(503).json({ error: 'WebSocket send failed: ' + e.message });
            }
        } else {
            // Non-streaming: collect all data and return it at once
            let fullContent = '';
            let chunkError = null;

            client.activeRequests.set(requestId, (data) => {
                if (data && typeof data === 'object' && data.error) {
                    chunkError = data.error;
                    client.activeRequests.delete(requestId);
                    return;
                }

                if (data === '[DONE]') {
                    client.activeRequests.delete(requestId);
                    return;
                }

                // Extract text content from lmarena.ai stream data
                try {
                    const text = this._extractTextFromLmarenaChunk(data);
                    if (text) {
                        fullContent += text;
                    } else if (typeof data === 'string' && data.length > 0) {
                        // Newer userscript versions send plain-text content directly
                        fullContent += data;
                    }
                } catch (e) {
                    // Ignore unparseable chunks
                }
            });

            try {
                client.ws.send(JSON.stringify(wsMessage));
            } catch (e) {
                client.activeRequests.delete(requestId);
                return res.status(503).json({ error: 'WebSocket send failed: ' + e.message });
            }

            // Wait for the request to complete (watch for this requestId being removed from activeRequests)
            const checkInterval = setInterval(() => {
                if (!client.activeRequests.has(requestId)) {
                    clearInterval(checkInterval);
                    if (chunkError) {
                        res.status(500).json({ error: chunkError });
                    } else {
                        res.json({
                            id: requestId,
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: model,
                            choices: [{
                                index: 0,
                                message: { role: 'assistant', content: fullContent || '(The model returned an empty response)' },
                                finish_reason: 'stop'
                            }]
                        });
                    }
                }
            }, 200);

            // 150-second timeout (hijack mode requires waiting for the user to press Enter in the browser)
            setTimeout(() => {
                if (client.activeRequests.has(requestId)) {
                    clearInterval(checkInterval);
                    client.activeRequests.delete(requestId);
                    res.status(504).json({ error: 'Request timed out' });
                }
            }, 150000);
        }
    }

    // ========== Parse lmarena.ai's streamed response format ==========
    _parseLmarenaStream(rawData) {
        const results = [];
        const requestId = randomUUID();

        // lmarena.ai uses the Next.js Server Actions streaming format, like:
        // 0:"text"\n
        // 1:{"data":...}\n
        // Each line has the format: <type>:<json_value>
        const lines = rawData.split('\n');

        for (const line of lines) {
            if (!line || line.trim().length === 0) continue;

            try {
                // Try parsing the type:value format
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const type = line.substring(0, colonIdx);
                    const value = line.substring(colonIdx + 1);

                    if (type === '0') {
                        // Text stream: 0:"content" — extract the text inside the quotes
                        const text = JSON.parse(value);
                        if (typeof text === 'string' && text.length > 0) {
                            results.push({
                                id: requestId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                            });
                        }
                    }
                }
            } catch (e) {
                // Skip lines that cannot be parsed
            }
        }

        return results;
    }

    _extractTextFromLmarenaChunk(rawData) {
        let text = '';
        const lines = rawData.split('\n');
        for (const line of lines) {
            if (!line || line.trim().length === 0) continue;
            try {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const type = line.substring(0, colonIdx);
                    const value = line.substring(colonIdx + 1);
                    if (type === '0') {
                        const parsed = JSON.parse(value);
                        if (typeof parsed === 'string') text += parsed;
                    }
                }
            } catch (e) {}
        }
        return text;
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

module.exports = { ProxyServer };
