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
        this.wsClientIndex = 0;      // 轮询计数器
        this.onWsClientChange = null; // 回调：客户端连接/断开时通知主进程
        this.capturedApiInfo = null;   // 从 WS 客户端捕获的 API 信息
        this.capturedModelData = null; // 从 WS 客户端提取的模型 UUID 映射
        this.onModelUpdate = null;     // 回调：模型列表更新时通知主进程
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

            // 优先使用 WebSocket 客户端模式
            const wsClient = this.getNextWsClient();
            if (wsClient) {
                return this.handleViaWsClient(wsClient, requestId, model, messages, stream, res);
            }

            // 回退到网页客户端模式（Puppeteer UI 操控）
            if (!this.browserManager || this.browserManager.pages.length === 0) {
                return res.status(503).json({
                    error: '没有可用的客户端 — 请先创建浏览器实例并登录 lmarena.ai，或安装油猴脚本连接 WebSocket 客户端'
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

        // ========== 内部API：从HTML解析模型列表 ==========
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

        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', timestamp: Date.now(), wsClients: this.wsClients.size });
        });

        this.server = http.createServer(this.app);

        // ========== WebSocket 服务端 ==========
        this.setupWebSocket(this.server);

        return new Promise((resolve, reject) => {
            this.server.listen(this.port, () => {
                console.log(`[ProxyServer] HTTP+WS server listening on port ${this.port}`);
                resolve();
            }).on('error', reject);
        });
    }

    // ========== WebSocket 服务端设置 ==========
    setupWebSocket(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws' });

        // 存储 WS 客户端发来的 API 信息（URL、headers 等）
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

            // 通知主进程客户端列表变化
            this._notifyWsClientChange();

            // 连接后请求页面源码以更新模型列表
            try {
                ws.send(JSON.stringify({ command: 'send_page_source' }));
            } catch (e) {}

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // 处理页面源码（通过 WS 传输，避免混合内容问题）
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

                    // 处理捕获的 API 信息
                    if (msg.type === 'api_info' && msg.data) {
                        this.capturedApiInfo = msg.data;
                        console.log(`[WS] Captured API info: url=${msg.data.url}, headers=${Object.keys(msg.data.headers || {}).join(',')}`);
                        return;
                    }

                    // 处理模型 UUID 映射
                    if (msg.type === 'model_data' && msg.data) {
                        this.capturedModelData = msg.data;
                        const modelCount = (msg.data.models || []).length;
                        const mappingCount = Object.keys(msg.data.uuidMap || {}).length;
                        const uuidCount = new Set(Object.values(msg.data.uuidMap || {})).size;
                        const initAId = msg.data.initialModelAId || '';
                        console.log(`[WS] Captured model data: ${modelCount} models, ${uuidCount} UUIDs, ${mappingCount} mappings, initialModelAId: ${initAId.substring(0, 12)}...`);

                        // 更新 browserManager 的模型列表
                        // 即使没有 UUID，只要有 slug 列表就更新（否则一直显示旧列表）
                        if (msg.data.models && msg.data.models.length > 0) {
                            this.browserManager.models = msg.data.models;
                            // 通知主进程模型列表已更新
                            if (this.onModelUpdate) {
                                this.onModelUpdate(msg.data.models);
                            }
                        }
                        return;
                    }

                    // 处理诊断信息
                    if (msg.type === 'diagnostics' && msg.data) {
                        const d = msg.data;
                        if (d.recentFetchUrls) {
                            console.log(`[WS] Diagnostics: ${d.event} | fetchUrls: ${JSON.stringify(d.recentFetchUrls)} | pendingHijack: ${d.pendingHijack}`);
                        } else {
                            console.log(`[WS] Diagnostics: recaptcha=${d.recaptcha}, source=${d.recaptchaSource}, time=${d.recaptchaTime}, grecaptcha=${d.grecaptchaAvailable}, modelAId=${d.modelAId}, template=${d.templateUsed}`);
                        }
                        // 转发到主进程日志
                        if (this.onDiagnostics) {
                            this.onDiagnostics(d);
                        }
                        return;
                    }

                    // 处理状态消息（等待用户触发等）
                    if (msg.type === 'status' && msg.data) {
                        const statusData = msg.data;
                        console.log(`[WS] Status: ${statusData.status} - ${statusData.message || ''}`);
                        // 转发到主进程
                        if (this.onStatus) {
                            this.onStatus(statusData);
                        }
                        return;
                    }

                    // 请求响应：{ request_id, data }
                    if (msg.request_id && msg.data !== undefined) {
                        const requestId = msg.request_id;
                        // 查找所有客户端中持有该请求的
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
                    // 取消所有活跃请求
                    for (const [requestId, handler] of client.activeRequests) {
                        handler({ error: 'WebSocket 客户端断开连接' });
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

    // ========== 通过 WebSocket 客户端转发请求到 lmarena.ai API ==========
    handleViaWsClient(client, requestId, model, messages, stream, res) {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const messageText = lastUserMsg ? lastUserMsg.content : '你好';

        // 解析 modelAId — 优先使用 UUID 映射，回退到 initialModelAId
        let modelAId = model;  // 默认用模型名
        if (this.capturedModelData) {
            const uuidMap = this.capturedModelData.uuidMap || {};
            const nameMap = this.capturedModelData.nameMap || {};

            // 精确匹配
            if (uuidMap[model]) modelAId = uuidMap[model];
            else if (uuidMap[model.toLowerCase()]) modelAId = uuidMap[model.toLowerCase()];
            else if (nameMap[model]) modelAId = nameMap[model];
            else if (nameMap[model.toLowerCase()]) modelAId = nameMap[model.toLowerCase()];

            // 模糊匹配
            if (modelAId === model) {
                const normalized = model.toLowerCase().replace(/[-_.\s]/g, '');
                for (const [key, uuid] of Object.entries(uuidMap)) {
                    if (key.toLowerCase().replace(/[-_.\s]/g, '') === normalized) {
                        modelAId = uuid;
                        break;
                    }
                }
            }

            // 如果仍然是原始模型名，回退到 initialModelAId
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

            // 注册响应处理器
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

                // 将 lmarena.ai 的流式响应转换为 OpenAI SSE 格式
                try {
                    // 优先尝试 RSC 格式解析（兼容旧版 userscript 发送原始 RSC 数据）
                    const chunks = this._parseLmarenaStream(data);
                    if (chunks.length > 0) {
                        for (const chunk of chunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    } else if (typeof data === 'string' && data.length > 0) {
                        // 新版 userscript 直接发送纯文本内容
                        res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: '', choices: [{ index: 0, delta: { content: data }, finish_reason: null }] })}\n\n`);
                    }
                } catch (e) {
                    // 解析失败时直接透传
                    res.write(`data: ${JSON.stringify({ id: requestId, choices: [{ delta: { content: data }, finish_reason: null }] })}\n\n`);
                }
            });

            try {
                client.ws.send(JSON.stringify(wsMessage));
            } catch (e) {
                client.activeRequests.delete(requestId);
                res.status(503).json({ error: 'WebSocket 发送失败: ' + e.message });
            }
        } else {
            // 非流式：收集所有数据后一次性返回
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

                // 从 lmarena.ai 流式数据中提取文本内容
                try {
                    const text = this._extractTextFromLmarenaChunk(data);
                    if (text) {
                        fullContent += text;
                    } else if (typeof data === 'string' && data.length > 0) {
                        // 新版 userscript 直接发送纯文本内容
                        fullContent += data;
                    }
                } catch (e) {
                    // 无法解析的 chunk 忽略
                }
            });

            try {
                client.ws.send(JSON.stringify(wsMessage));
            } catch (e) {
                client.activeRequests.delete(requestId);
                return res.status(503).json({ error: 'WebSocket 发送失败: ' + e.message });
            }

            // 等待请求完成（监听 activeRequests 中该 requestId 被删除）
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
                                message: { role: 'assistant', content: fullContent || '(模型返回空响应)' },
                                finish_reason: 'stop'
                            }]
                        });
                    }
                }
            }, 200);

            // 150 秒超时（劫持模式需要等待用户在浏览器中按 Enter）
            setTimeout(() => {
                if (client.activeRequests.has(requestId)) {
                    clearInterval(checkInterval);
                    client.activeRequests.delete(requestId);
                    res.status(504).json({ error: '请求超时' });
                }
            }, 150000);
        }
    }

    // ========== 解析 lmarena.ai 的流式响应格式 ==========
    _parseLmarenaStream(rawData) {
        const results = [];
        const requestId = randomUUID();

        // lmarena.ai 使用 Next.js Server Actions 流式格式，形如：
        // 0:"text"\n
        // 1:{"data":...}\n
        // 每行格式: <type>:<json_value>
        const lines = rawData.split('\n');

        for (const line of lines) {
            if (!line || line.trim().length === 0) continue;

            try {
                // 尝试解析 type:value 格式
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const type = line.substring(0, colonIdx);
                    const value = line.substring(colonIdx + 1);

                    if (type === '0') {
                        // 文本流：0:"content" — 提取引号内的文本
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
                // 无法解析的行跳过
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

    // ========== WebSocket 客户端管理 ==========
    getNextWsClient() {
        if (this.wsClients.size === 0) return null;

        const clients = [...this.wsClients.values()].filter(c => c.ws.readyState === WebSocket.OPEN);
        if (clients.length === 0) return null;

        // 轮询选择
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

    // 向所有 WS 客户端发送命令
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

        // 关闭所有 WS 连接
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
