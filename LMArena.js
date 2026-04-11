// ==UserScript==
// @name         arena
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  LMArena API - WebSocket client for AI Proxy Bridge (RSC parsing + UUIDv7)
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
    const activeRequests = new Map();

    // ========== 模型 UUID 映射 ==========
    let modelUuidMap = {};        // { "gpt-4o": "019a98f7-...", "chatgpt-4o-latest": "019a98f7-..." }
    let modelDisplayNameMap = {}; // { "GPT-4o": "019a98f7-..." }
    let uuidToSlugMap = {};       // { "019a98f7-...": "gpt-4o" }
    let modelSlugList = [];       // 从 RSC 提取的 slug 列表
    let initialModelAId = '';     // 默认模型的 UUID

    // ========== 捕获 lmarena.ai 的真实请求 ==========
    let capturedRequestTemplate = null;
    let capturedDirectTemplate = null;
    let capturedArenaTemplate = null;

    // 请求劫持：当用户在浏览器中发送消息时，劫持页面的请求
    let pendingHijack = null; // { requestId, modelAId, content, resolve }

    const originalFetch = window.fetch;
     window.fetch = async function (...args) {
        const urlArg = args[0];
        let urlString = '';
        if (urlArg instanceof Request) { urlString = urlArg.url; }
        else if (urlArg instanceof URL) { urlString = urlArg.href; }
        else if (typeof urlArg === 'string') { urlString = urlArg; }

        // 诊断: 记录所有 API 相关的 fetch 调用
        if (urlString) {
            const shortUrl = urlString.substring(0, 150);
            if (urlString.includes('evaluation') || urlString.includes('api') || urlString.includes('chat') || urlString.includes('stream')) {
                console.log(`[LMArena API] FETCH: ${shortUrl} | pendingHijack=${!!pendingHijack}`);
                fetchLog.push(shortUrl);
                if (fetchLog.length > 50) fetchLog.shift();
            }
        }

        if (urlString && urlString.includes('create-evaluation') && !window.isProxyRequest) {
            try {
                const options = args[1] || {};
                const headers = {};
                if (options.headers) {
                    if (options.headers instanceof Headers) {
                        options.headers.forEach((v, k) => { headers[k] = v; });
                    } else if (typeof options.headers === 'object') {
                        Object.assign(headers, options.headers);
                    }
                }

                let body = null;
                if (options.body) {
                    try { body = JSON.parse(options.body); } catch (e) { body = options.body; }
                }

                const contentType = headers['content-type'] || headers['Content-Type'] || 'application/json';
                capturedRequestTemplate = { url: urlString, headers, body, contentType };

                if (body && body.recaptchaV3Token) window.recaptchaToken = body.recaptchaV3Token;

                // 请求劫持：如果有待处理的劫持请求，修改请求体并拦截响应
                if (pendingHijack && body && typeof body === 'object') {
                    const hijack = pendingHijack;
                    console.log(`[LMArena API] HIJACKING page request: modelAId=${body.modelAId} → ${hijack.modelAId}`);

                    // 替换请求体中的关键字段
                    body.modelAId = hijack.modelAId;
                    body.mode = 'direct';
                    if (body.userMessage) body.userMessage.content = hijack.content;
                    delete body.modelBId;
                    delete body.modelBMessageId;
                    options.body = JSON.stringify(body);
                    args[1] = options;

                    // 发送修改后的请求
                    const hijackedResponse = await originalFetch.apply(this, args);

                    // 如果 429（reCAPTCHA 拒绝），不清除 pendingHijack，允许用户手动重试
                    if (hijackedResponse.status === 429) {
                        console.warn('[LMArena API] Hijacked request got 429 — reCAPTCHA rejected auto-submit');
                        // 保持 pendingHijack 不变，等用户手动按 Enter
                        // 但标记已尝试自动提交，避免重复模拟 Enter
                        hijack.autoSubmitted = true;

                        // 通知应用：自动提交失败，需手动操作
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'status',
                                data: {
                                    status: 'auto_submit_429',
                                    requestId: hijack.requestId,
                                    message: '自动提交被 reCAPTCHA 拒绝，请在浏览器中手动按 Enter 发送消息'
                                }
                            }));
                        }

                        // 返回空 200 给页面（避免页面显示错误或自动重试）
                        return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
                    }

                    // 非 429：成功劫持，清除 pendingHijack
                    pendingHijack = null;

                    // 异步读取流并转发给代理
                    (async () => {
                        try {
                            await handleStreamResponse(hijackedResponse, hijack.requestId);
                            hijack.resolve(true);
                        } catch (e) {
                            console.error(`[LMArena API] Hijacked stream error:`, e.message);
                            sendToServer(hijack.requestId, { error: e.message });
                            hijack.resolve(false);
                        }
                    })();

                    // 返回空响应给页面（避免页面报错）
                    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
                }

                // 从捕获的请求中提取 modelAId → 建立 UUID 映射
                if (body && body.modelAId && /^[0-9a-f]{8}-/i.test(body.modelAId)) {
                    console.log(`[LMArena API] Captured modelAId UUID: ${body.modelAId}, mode: ${body.mode || 'unknown'}`);
                    // 把捕获的 UUID 记录下来，后续可用
                    addModelMapping('captured-modelAId', body.modelAId, 'Captured Model');

                    // 如果用户在 Direct Chat 页面选择了模型，尝试从页面获取模型名
                    tryCaptureModelSelection(body.modelAId);
                }

                const isDirectMode = body && body.mode === 'direct';
                if (isDirectMode) {
                    capturedDirectTemplate = capturedRequestTemplate;
                    console.log(`[LMArena API] Captured DIRECT create-evaluation:`, {
                        url: urlString.substring(0, 80), contentType,
                        modelAId: body.modelAId || 'N/A',
                        id: body.id || 'empty',
                        mode: body.mode,
                        bodyKeys: Object.keys(body)
                    });
                } else {
                    capturedArenaTemplate = capturedRequestTemplate;
                    console.log(`[LMArena API] Captured ARENA create-evaluation:`, {
                        url: urlString.substring(0, 80), contentType,
                        mode: body && body.mode || 'unknown',
                        bodyKeys: body ? Object.keys(body) : []
                    });
                }

                sendApiInfoToServer();
            } catch (e) {
                console.error('[LMArena API] Failed to capture request:', e);
            }
        }

        if (urlString && urlString.includes('post-to-evaluation') && !window.isProxyRequest) {
            try {
                const options = args[1] || {};
                let body = null;
                if (options.body) { try { body = JSON.parse(options.body); } catch (e) {} }
                if (body && body.recaptchaV3Token) window.recaptchaToken = body.recaptchaV3Token;
                console.log(`[LMArena API] Captured post-to-evaluation`);
            } catch (e) {}
        }

        // 捕获 Next-Action IDs（图片上传用）
        if (urlString && urlString.includes('?mode=direct') && args[1] && args[1].method === 'POST') {
            try {
                const headers = args[1].headers || {};
                const nextAction = headers['Next-Action'] || headers['next-action'];
                const bodyStr = args[1].body;
                if (nextAction && bodyStr) {
                    const body = JSON.parse(bodyStr);
                    if (Array.isArray(body) && body.length === 2 && typeof body[1] === 'string' && body[1].startsWith('image/')) {
                        localStorage.setItem('LMArena_Action_Upload_Step1', nextAction);
                    } else if (Array.isArray(body) && body.length === 1 && typeof body[0] === 'string' && !body[0].startsWith('http')) {
                        localStorage.setItem('LMArena_Action_Upload_Step3', nextAction);
                    }
                }
            } catch (e) {}
        }

        return originalFetch.apply(this, args);
    };

    // ========== 添加模型映射 ==========
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

    // ========== 尝试从页面捕获当前选中的模型 ==========
    function tryCaptureModelSelection(modelAId) {
        try {
            // 方法1: 从 cmdk 下拉菜单中找
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

            // 方法2: 从 combobox 按钮文本中找
            const comboBtn = document.querySelector('button[role="combobox"]');
            if (comboBtn) {
                const btnText = comboBtn.textContent.trim();
                if (btnText && btnText.length > 2 && btnText.length < 60) {
                    addModelMapping(btnText, modelAId, btnText);
                    const slug = btnText.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');
                    addModelMapping(slug, modelAId, btnText);
                    console.log(`[LMArena API] Mapped combobox "${btnText}" → ${modelAId}`);
                }
            }
        } catch (e) {}
    }

    // ========== UUIDv7 生成 ==========
    // lmarena.ai 服务器校验 UUIDv7 时间戳，偏移太大会被拒绝
    // 必须用 BigInt 避免精度丢失（JS 位运算只支持 32 位）
    function uuid7() {
        const ts = BigInt(Date.now());
        const randA = BigInt(Math.floor(Math.random() * 0x1000));
        const randB = BigInt(Math.floor(Math.random() * 0x3ffffffffffff)); // 62 bits
        // UUIDv7: timestamp(48bit) | version(4bit) | randA(12bit) | variant(2bit) | randB(62bit)
        const uuid_int = (ts << 80n) | (BigInt(0x7000) | (randA & 0x0fffn)) << 64n | (0x8000000000000000n | randB);
        const h = uuid_int.toString(16).padStart(32, '0');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    }

    // 兼容旧的 generateUUID
    function generateUUID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return uuid7();
    }

    // ========== 从页面 HTML 中提取模型 slug（最可靠的兜底方法） ==========
    function extractModelsFromPageHTML() {
        const models = [];
        const seen = new Set();
        try {
            const html = document.documentElement.outerHTML;
            // 与 browser-manager.js parseModelsFromHTML() 相同的正则
            const modelPattern = /(?:"|'|`)(claude-[a-z0-9._\-]+|gpt-[a-z0-9._\-]+|chatgpt-[a-z0-9._\-]+|o[134]-[a-z0-9._\-]+|gemini-[a-z0-9._\-]+|llama-[a-z0-9._\-]+|deepseek-[a-z0-9._\-]+|qwen[a-z0-9._\-]{3,60}|mistral-[a-z0-9._\-]+|grok-[a-z0-9._\-]+|glm-[a-z0-9._\-]+|ernie-[a-z0-9._\-]+|kimi-[a-z0-9._\-]+|gemma-[a-z0-9._\-]+|phi-[a-z0-9._\-]+|codestral[a-z0-9._\-]*|mixtral[a-z0-9._\-]*|pixtral[a-z0-9._\-]*|ministral[a-z0-9._\-]*|c4ai-[a-z0-9._\-]+|command-[a-z0-9._\-]+|dbrx[a-z0-9._\-]*|yi-[a-z0-9._\-]+|dall-e-[a-z0-9._\-]+)(?:"|'|`)/gi;
            let match;
            while ((match = modelPattern.exec(html)) !== null) {
                let slug = match[1];
                if (!slug || slug.length < 4 || slug.length > 80) continue;
                if (/^(script|style|class|chunk|webpack|module|next-|__|data-)/.test(slug)) continue;
                const lower = slug.toLowerCase();
                if (seen.has(lower)) continue;
                seen.add(lower);
                models.push(slug);
            }
        } catch (e) {
            console.error('[LMArena API] extractModelsFromPageHTML error:', e);
        }
        return models;
    }

    // ========== 从 RSC 飞行数据提取模型列表 ==========
    // lmarena.ai 是 Next.js 应用，模型数据嵌入在 self.__next_f.push() 中
    function extractModelsFromRSC() {
        let models = [];
        let modelAId = '';
        let allModelData = {};

        try {
            // 方法1: 解析 <script> 标签中的 __next_f.push 数据
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';
                if (!content.includes('initialModels')) continue;

                // 提取 initialModels 数据
                // RSC 格式: self.__next_f.push([1,"...initialModels:[...]..."])
                // 或直接在 HTML 中: \"initialModels\":[...]

                // 尝试解析转义的 JSON
                try {
                    // 查找 initialModels 附近的数据
                    const idx = content.indexOf('initialModels');
                    if (idx === -1) continue;

                    // 从 initialModels 开始提取
                    const afterKey = content.substring(idx + 'initialModels'.length);

                    // 查找数组开始
                    const arrStart = afterKey.indexOf('[');
                    if (arrStart === -1 || arrStart > 10) continue;

                    // 手动匹配括号找到数组结束
                    let depth = 0;
                    let arrEnd = -1;
                    for (let i = arrStart; i < afterKey.length; i++) {
                        if (afterKey[i] === '[') depth++;
                        else if (afterKey[i] === ']') {
                            depth--;
                            if (depth === 0) { arrEnd = i + 1; break; }
                        }
                    }

                    if (arrEnd === -1) continue;

                    let arrStr = afterKey.substring(arrStart, arrEnd);

                    // 处理转义
                    if (arrStr.includes('\\"')) {
                        arrStr = arrStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    }

                    const parsed = JSON.parse(arrStr);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        // 检查是字符串数组还是对象数组
                        if (typeof parsed[0] === 'string') {
                            models = parsed;
                            console.log(`[LMArena API] RSC: Found ${models.length} model slugs`);
                        } else if (typeof parsed[0] === 'object') {
                            // 对象数组，可能包含 UUID
                            for (const m of parsed) {
                                if (m && m.id) {
                                    const uuid = m.id;
                                    const name = m.name || m.slug || '';
                                    const slug = m.slug || name.toLowerCase().replace(/[\s.]+/g, '-');
                                    models.push(slug);
                                    if (/^[0-9a-f]{8}-/i.test(uuid)) {
                                        addModelMapping(slug, uuid, name);
                                    }
                                }
                            }
                            console.log(`[LMArena API] RSC: Found ${models.length} model objects with UUIDs`);
                        }
                    }
                } catch (e) {
                    // 解析失败，尝试正则提取
                    try {
                        const slugMatches = content.matchAll(/"([a-z][a-z0-9_-]{5,50})"/g);
                        const slugList = [];
                        for (const m of slugMatches) {
                            const slug = m[1];
                            // 过滤看起来像模型 slug 的字符串
                            if (/(?:gpt|claude|gemini|llama|deepseek|qwen|mistral|mixtral|grok|command|codestral|pixtral|ministral|dall-e|o[1-4]|c4ai)/.test(slug)) {
                                if (!slugList.includes(slug)) slugList.push(slug);
                            }
                        }
                        if (slugList.length > models.length) {
                            models = slugList;
                            console.log(`[LMArena API] RSC regex: Found ${models.length} model slugs`);
                        }
                    } catch (e2) {}
                }

                // 提取 initialModelAId
                try {
                    const aidMatch = content.match(/initialModelAId[^"]*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
                    if (aidMatch) {
                        modelAId = aidMatch[1];
                        console.log(`[LMArena API] RSC: Found initialModelAId: ${modelAId}`);
                    }
                } catch (e) {}

                // 提取其他模型数据字段
                try {
                    const dataPatterns = [
                        /"text_models"\s*:\s*(\[[\s\S]*?\])/,
                        /"all_models"\s*:\s*(\[[\s\S]*?\])/,
                        /"all_text_models"\s*:\s*(\[[\s\S]*?\])/,
                    ];
                    for (const pattern of dataPatterns) {
                        const match = content.match(pattern);
                        if (match) {
                            try {
                                let str = match[1];
                                if (str.includes('\\"')) str = str.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                                const parsed = JSON.parse(str);
                                if (Array.isArray(parsed)) {
                                    for (const slug of parsed) {
                                        if (typeof slug === 'string' && !models.includes(slug)) {
                                            models.push(slug);
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
            }

            // 方法2: 直接读取 window 上的 Next.js 数据
            if (models.length === 0 && window.__NEXT_DATA__) {
                try {
                    const nextDataStr = JSON.stringify(window.__NEXT_DATA__);
                    const modelMatch = nextDataStr.match(/"initialModels"\s*:\s*(\[[^\]]*\])/);
                    if (modelMatch) {
                        const parsed = JSON.parse(modelMatch[1]);
                        if (Array.isArray(parsed)) models = parsed;
                    }
                } catch (e) {}
            }

        } catch (e) {
            console.error('[LMArena API] RSC extraction error:', e);
        }

        return { models, modelAId };
    }

    // ========== 通过点击下拉菜单提取模型 ==========
    async function extractModelsViaDropdown() {
        const extracted = [];

        try {
            // 查找模型选择器按钮（cmdk combobox）
            const modelBtn = document.querySelector('button[role="combobox"][aria-haspopup="dialog"]');
            if (!modelBtn) {
                console.log('[LMArena API] Dropdown: Model selector button not found (may not be on Direct Chat page)');
                return extracted;
            }

            console.log('[LMArena API] Dropdown: Found model selector, opening...');

            // 模拟真实点击
            modelBtn.focus();
            await new Promise(r => setTimeout(r, 100));

            // 发送 pointer 事件（更真实）
            const rect = modelBtn.getBoundingClientRect();
            const clickX = rect.left + rect.width / 2;
            const clickY = rect.top + rect.height / 2;

            modelBtn.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse'
            }));
            await new Promise(r => setTimeout(r, 30));
            modelBtn.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse'
            }));
            modelBtn.dispatchEvent(new MouseEvent('click', {
                bubbles: true, clientX: clickX, clientY: clickY, cancelable: true
            }));
            modelBtn.click();

            // 等待下拉菜单加载
            await new Promise(r => setTimeout(r, 1200));

            // 读取所有模型选项
            const options = document.querySelectorAll('div[cmdk-item][role="option"]');
            console.log(`[LMArena API] Dropdown: Found ${options.length} model options`);

            for (const opt of options) {
                if (opt.offsetParent === null) continue; // 跳过隐藏项

                // 模型名称
                const nameSpan = opt.querySelector('span.flex-1.truncate');
                const name = nameSpan ? nameSpan.textContent.trim() : (opt.textContent || '').trim();

                // cmdk-item 的 value 属性可能包含 UUID
                const dataValue = opt.getAttribute('data-value') || opt.getAttribute('value') || '';
                const cmdkValue = opt.getAttribute('cmdk-item') || '';

                if (name && name.length > 2) {
                    const slug = name.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');

                    extracted.push({
                        name: name,
                        slug: slug,
                        dataValue: dataValue,
                        cmdkValue: cmdkValue
                    });

                    // 如果 dataValue 看起来像 UUID，建立映射
                    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dataValue)) {
                        addModelMapping(slug, dataValue, name);
                        addModelMapping(name, dataValue, name);
                        console.log(`[LMArena API] Dropdown: Mapped "${name}" → ${dataValue}`);
                    }
                }
            }

            // 关闭下拉菜单
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true
            }));
            await new Promise(r => setTimeout(r, 200));

        } catch (e) {
            console.error('[LMArena API] Dropdown extraction error:', e);
        }

        return extracted;
    }

    // ========== 综合提取模型数据 ==========
    async function extractAllModelData() {
        // 第1步: 从 RSC 飞行数据提取
        const rscData = extractModelsFromRSC();
        modelSlugList = rscData.models;
        initialModelAId = rscData.modelAId;

        console.log(`[LMArena API] RSC extraction: ${modelSlugList.length} slugs, initialModelAId: ${initialModelAId || 'none'}`);

        // 第2步: 如果 RSC 提取失败，从页面 HTML 中扫描模型 slug
        if (modelSlugList.length === 0) {
            const htmlSlugs = extractModelsFromPageHTML();
            if (htmlSlugs.length > 0) {
                modelSlugList = htmlSlugs;
                console.log(`[LMArena API] HTML slug extraction: ${htmlSlugs.length} models`);
            }
        }

        // 第3步: 尝试点击下拉菜单提取
        const dropdownModels = await extractModelsViaDropdown();
        if (dropdownModels.length > 0) {
            console.log(`[LMArena API] Dropdown: Extracted ${dropdownModels.length} models`);

            // 合并下拉菜单的模型到列表
            for (const dm of dropdownModels) {
                if (!modelSlugList.includes(dm.slug)) {
                    modelSlugList.push(dm.slug);
                }
            }
        }

        // 如果有 initialModelAId，把它关联到第一个模型（默认选中）
        if (initialModelAId && modelSlugList.length > 0) {
            addModelMapping(modelSlugList[0], initialModelAId, modelSlugList[0]);
        }

        // 第4步: 构建完整的模型列表
        const modelList = [];
        const seenUuids = new Set();
        const seenSlugs = new Set();

        for (const slug of modelSlugList) {
            if (seenSlugs.has(slug.toLowerCase())) continue;
            seenSlugs.add(slug.toLowerCase());

            const uuid = modelUuidMap[slug] || modelUuidMap[slug.toLowerCase()] || '';
            const displayName = uuidToSlugMap[uuid] || slug;

            modelList.push({
                id: uuid || slug,           // 优先 UUID，没有则用 slug
                name: displayName,
                slug: slug
            });

            if (uuid) seenUuids.add(uuid);
        }

        const totalMappings = Object.keys(modelUuidMap).length;
        const totalUuids = new Set(Object.values(modelUuidMap)).size;
        console.log(`[LMArena API] Total: ${modelList.length} models, ${totalUuids} UUIDs, ${totalMappings} mappings`);

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

    function sendApiInfoToServer() {
        if (socket && socket.readyState === WebSocket.OPEN && capturedRequestTemplate) {
            socket.send(JSON.stringify({
                type: 'api_info',
                data: { ...capturedRequestTemplate, isDirect: !!capturedDirectTemplate, isArena: !!capturedArenaTemplate }
            }));
        }
    }

    // ========== 解析 modelAId ==========
    function resolveModelAId(model) {
        if (!model) return initialModelAId || '';

        // 1. 精确匹配 slug→UUID
        if (modelUuidMap[model]) return modelUuidMap[model];
        if (modelUuidMap[model.toLowerCase()]) return modelUuidMap[model.toLowerCase()];

        // 2. 显示名→UUID
        if (modelDisplayNameMap[model]) return modelDisplayNameMap[model];
        if (modelDisplayNameMap[model.toLowerCase()]) return modelDisplayNameMap[model.toLowerCase()];

        // 3. 模糊匹配
        const normalized = model.toLowerCase().replace(/[-_.\s]/g, '');
        for (const [key, uuid] of Object.entries(modelUuidMap)) {
            if (key.toLowerCase().replace(/[-_.\s]/g, '') === normalized) return uuid;
        }

        // 4. 如果已经是 UUID 格式，直接返回
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(model)) {
            return model;
        }

        // 5. 无法解析 — 回退到 initialModelAId 或原始值
        if (initialModelAId) {
            console.warn(`[LMArena API] Cannot resolve "${model}", falling back to initialModelAId: ${initialModelAId}`);
            return initialModelAId;
        }

        console.warn(`[LMArena API] Cannot resolve modelAId for "${model}". No UUID mapping available.`);
        return model;  // 回退（大概率会 500）
    }

    // ========== 构建 Direct 模式请求体 ==========
    // 参考 gpt4free: https://github.com/xtekky/gpt4free/issues/2832
    // id 使用 UUIDv7, mode 包含 "direct", modelAId 为模型 UUID
    function buildDirectModeBody(modelId, content, serverModelAId) {
        const resolvedModelAId = serverModelAId ? resolveModelAId(serverModelAId) : resolveModelAId(modelId);

        return {
            id: uuid7(),             // UUIDv7 — 服务器会验证格式
            mode: 'direct',          // gpt4free 确认需要此字段
            modelAId: resolvedModelAId,
            userMessageId: uuid7(),
            modelAMessageId: uuid7(),
            userMessage: {
                content: content,
                experimental_attachments: [],
                metadata: {}
            },
            modality: 'chat',
            recaptchaV3Token: ''
        };
    }

    // ========== DOM 操作：填入消息到输入框（不点击发送） ==========
    // 不触发发送按钮，避免 Cloudflare Turnstile 检测
    // 用户只需按 Enter 键即可发送（这是真实用户交互，reCAPTCHA token 有效）

    function findChatInput() {
        const selectors = [
            'textarea[placeholder]',
            'textarea[name="message"]',
            'textarea[data-testid]',
            'form textarea',
            '[contenteditable="true"]',
            'textarea'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return el;
        }
        return null;
    }

    function setReactInputValue(element, value) {
        element.focus();

        // 方法1: execCommand — 最可靠，走浏览器原生输入管道，React 能正确捕获
        try {
            element.select(); // 选中现有文本
            if (document.execCommand('insertText', false, value)) {
                console.log('[LMArena API] setReactInputValue: execCommand 成功');
                return;
            }
        } catch (e) {}

        // 方法2: native setter + InputEvent（React 18 兼容）
        const nativeSetter = Object.getOwnPropertyDescriptor(
            element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
        )?.set;
        if (nativeSetter) {
            nativeSetter.call(element, value);
        } else {
            element.value = value;
        }
        // 使用 InputEvent 而非 Event，React 18 对 InputEvent 的处理更可靠
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: value
        }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LMArena API] setReactInputValue: native setter + InputEvent');
    }

    // 模拟 Enter 键发送消息
    function simulateEnterKey(element) {
        if (!element) element = findChatInput();
        if (!element) return false;
        element.focus();
        // 模拟完整的键盘事件链
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        console.log('[LMArena API] 已模拟 Enter 键');
        return true;
    }

    // 填入消息到页面输入框，返回是否成功
    function fillChatInput(content) {
        const input = findChatInput();
        if (!input) {
            console.warn('[LMArena API] 未找到输入框，无法自动填入消息');
            return false;
        }
        setReactInputValue(input, content);
        console.log('[LMArena API] 消息已填入输入框，将自动尝试提交');
        return true;
    }

    // ========== MutationObserver: 监听页面 DOM 捕获 AI 响应 ==========
    // 当 fetch 拦截无法捕获请求时，通过监听 DOM 变化获取 AI 回复
    let domObserver = null;
    let domObserverRequestId = null;
    let lastAssistantText = '';
    let domResponseComplete = false;

    function startDOMObserver(requestId) {
        stopDOMObserver();
        domObserverRequestId = requestId;
        lastAssistantText = '';
        domResponseComplete = false;

        // 查找聊天消息容器
        const chatContainer = findChatContainer();
        if (!chatContainer) {
            console.warn('[LMArena API] DOM Observer: 未找到聊天容器');
            return;
        }

        // 记录当前已有的助手消息数量（避免捕获旧消息）
        const existingAssistantMsgs = chatContainer.querySelectorAll(
            '[class*="assistant"], [data-message-role="assistant"]'
        );
        const existingCount = existingAssistantMsgs.length;
        console.log(`[LMArena API] DOM Observer 启动: ${existingCount} 条历史消息`);

        domObserver = new MutationObserver(() => {
            try {
                const text = getLatestAssistantText(chatContainer, existingCount);
                if (text && text.length > lastAssistantText.length) {
                    // 只发送增量内容
                    const delta = text.substring(lastAssistantText.length);
                    lastAssistantText = text;
                    sendToServer(requestId, delta);
                    console.log(`[LMArena API] DOM Observer: +${delta.length} 字符 (总计 ${text.length})`);
                }
            } catch (e) {}
        });

        domObserver.observe(chatContainer, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // 设置超时检查：5秒后如果还没有内容，检查页面是否有错误
        setTimeout(() => {
            if (domObserver && !lastAssistantText && domObserverRequestId === requestId) {
                const errorText = checkPageError();
                if (errorText) {
                    sendToServer(requestId, { error: errorText });
                    stopDOMObserver();
                }
            }
        }, 5000);

        // 60秒后自动停止（响应应该已经完成）
        setTimeout(() => {
            if (domObserverRequestId === requestId) {
                if (lastAssistantText) {
                    sendToServer(requestId, '[DONE]');
                }
                stopDOMObserver();
            }
        }, 60000);
    }

    function stopDOMObserver() {
        if (domObserver) {
            domObserver.disconnect();
            domObserver = null;
        }
        domObserverRequestId = null;
    }

    function findChatContainer() {
        // lmarena.ai 使用 Next.js，聊天消息通常在特定容器中
        const selectors = [
            '[class*="chat"] [class*="message"]',  // 通用聊天容器
            '[class*="conversation"]',
            '[class*="thread"]',
            '[role="log"]',
            'main [class*="flex-col"]',
            'main'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.children.length > 0) return el;
        }
        return document.body;
    }

    function getLatestAssistantText(container, skipCount) {
        // 策略1: 查找 class 含 "assistant" 的元素
        const assistantSelectors = [
            '[class*="assistant"] [class*="markdown"]',
            '[class*="assistant"] [class*="prose"]',
            '[class*="assistant"] [class*="message"]',
            '[class*="assistant"] [class*="content"]',
            '[data-message-role="assistant"]',
            '[class*="response"] [class*="markdown"]',
            '[class*="response"] [class*="prose"]',
        ];

        for (const sel of assistantSelectors) {
            const els = container.querySelectorAll(sel);
            if (els.length > skipCount) {
                // 取最后一个（最新的响应）
                const last = els[els.length - 1];
                const text = (last.innerText || last.textContent || '').trim();
                if (text.length > 2) return text;
            }
        }

        // 策略2: 查找所有消息块，取最后一个非用户消息
        const msgSelectors = '[class*="message"], [class*="turn"], [class*="bubble"]';
        const msgs = container.querySelectorAll(msgSelectors);
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            const text = (last.innerText || last.textContent || '').trim();
            // 排除用户消息（通常较短且在前面）
            if (text.length > 5 && !last.querySelector('textarea') && !last.querySelector('input')) {
                return text;
            }
        }

        // 策略3: 查找 markdown/prose 内容（AI 响应通常使用 markdown 渲染）
        const markdownEls = container.querySelectorAll('.markdown, .prose, [class*="markdown"], [class*="prose"]');
        if (markdownEls.length > 0) {
            const last = markdownEls[markdownEls.length - 1];
            const text = (last.innerText || last.textContent || '').trim();
            if (text.length > 5) return text;
        }

        return null;
    }

    function checkPageError() {
        const errEls = document.querySelectorAll('[class*="error"], [role="alert"], [class*="toast"]');
        for (const el of errEls) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text && text.length > 3) return text;
        }
        return null;
    }

    // ========== Fetch 诊断日志 ==========
    let fetchLog = [];  // 记录最近的 fetch 调用 URL

    function sendDiagnostics(label) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'diagnostics',
                data: {
                    event: label,
                    recentFetchUrls: fetchLog.slice(-15),
                    pendingHijack: !!pendingHijack,
                    hasSocket: true
                }
            }));
        }
    }
    function connect() {
        console.log(`[LMArena API] Connecting to ${SERVER_URL}...`);
        socket = new WebSocket(SERVER_URL);

        socket.onopen = () => {
            console.log("[LMArena API] Connected to desktop app");
            document.title = "✅ " + document.title.replace(/^✅\s*/, '');
            sendApiInfoToServer();
            sendPageSourceViaWs();
            sendModelDataToServer();
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
                        if (request_id && activeRequests.has(request_id)) {
                            activeRequests.get(request_id).abort();
                            activeRequests.delete(request_id);
                        }
                    } else if (message.command === 'upload_image') {
                        handleImageUpload(message);
                    } else if (message.command === 'update_recaptcha_token') {
                        if (message.token) window.recaptchaToken = message.token;
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

                console.log(`[LMArena API] Request ${request_id.substring(0, 8)}, model: ${data.model || 'N/A'}`);

                const controller = new AbortController();
                activeRequests.set(request_id, controller);

                (async () => {
                    try {
                        const model = data.model || '';
                        const content = data.content || '你好';
                        const modelAId = (buildDirectModeBody(model, content, data.modelAId)).modelAId;

                        // ====== 双重策略: fetch 劫持 + DOM 监听 ======
                        // 策略1: 请求劫持 — 拦截页面 fetch，替换模型 ID（需要 fetch 拦截器生效）
                        // 策略2: DOM 监听 — MutationObserver 捕获页面 AI 回复（始终可用，但无法替换模型）

                        console.log(`[LMArena API] Setting up hijack + DOM observer: modelAId=${modelAId}`);

                        // 发送诊断信息
                        sendDiagnostics('test_start');

                        // 填入消息到页面的输入框
                        const inputFilled = fillChatInput(content);

                        // 设置劫持
                        let hijackResolve;
                        const hijackPromise = new Promise(resolve => { hijackResolve = resolve; });
                        pendingHijack = {
                            requestId: request_id,
                            modelAId: modelAId,
                            content: content,
                            resolve: hijackResolve,
                            autoSubmitted: false
                        };

                        // 同时启动 DOM 监听（作为备用方案）
                        startDOMObserver(request_id);

                        // 通知代理
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'status',
                                data: {
                                    status: 'waiting_for_trigger',
                                    requestId: request_id,
                                    message: inputFilled
                                        ? '消息已填入浏览器输入框，将自动提交并监听响应'
                                        : '请在 lmarena.ai 发送一条消息来触发测试'
                                }
                            }));
                        }

                        // 延迟 800ms 后自动模拟 Enter 键提交
                        setTimeout(() => {
                            if (pendingHijack && pendingHijack.requestId === request_id) {
                                simulateEnterKey(findChatInput());
                                pendingHijack.autoSubmitted = true;
                            }
                        }, 800);

                        // 等待结果：fetch 劫持 或 DOM 监听
                        // fetch 劫持成功时 pendingHijack = null；DOM 监听成功时 lastAssistantText 非空
                        const startTime = Date.now();

                        // 轮询检查两种策略的结果
                        while (Date.now() - startTime < 120000) {
                            await new Promise(r => setTimeout(r, 500));

                            // 请求被取消
                            if (!activeRequests.has(request_id)) {
                                pendingHijack = null;
                                stopDOMObserver();
                                return;
                            }

                            // fetch 劫持成功：pendingHijack 已被清除
                            if (!pendingHijack) {
                                stopDOMObserver();
                                console.log(`[LMArena API] Fetch 劫持成功`);
                                return; // 响应已由 handleStreamResponse 处理
                            }

                            // DOM 监听成功：捕获到 AI 响应
                            if (lastAssistantText && domObserverRequestId === request_id) {
                                // 发送 [DONE] 标记
                                sendToServer(request_id, '[DONE]');
                                pendingHijack = null;
                                stopDOMObserver();
                                console.log(`[LMArena API] DOM Observer 捕获到响应: ${lastAssistantText.length} 字符`);
                                return;
                            }
                        }

                        // 两种策略都超时
                        pendingHijack = null;
                        stopDOMObserver();
                        sendDiagnostics('timeout');
                        throw new Error(
                            '请求超时 — 两种策略均未捕获到响应\n' +
                            '可能原因:\n' +
                            '1. 页面未发送请求（请确认输入框有内容且按了 Enter）\n' +
                            '2. 页面触发了人机验证（请完成验证后重试）\n' +
                            '3. fetch 拦截器未生效（请刷新页面重试）\n' +
                            '提示: 在浏览器中手动发送一条消息，观察是否正常响应。'
                        );

                    } catch (error) {
                        window.isProxyRequest = false;
                        if (error.name === 'AbortError') {
                            console.log(`[LMArena API] Aborted ${request_id.substring(0, 8)}`);
                        } else {
                            console.error(`[LMArena API] Error:`, error.message);
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
            activeRequests.forEach(controller => controller.abort());
            activeRequests.clear();
            setTimeout(connect, 5000);
        };

        socket.onerror = () => { socket.close(); };
    }

    async function handleStreamResponse(response, requestId) {
        if (!response.body) {
            const text = await response.text();
            // 尝试从非流式响应中提取文本
            const extracted = extractTextFromRSC(text);
            if (extracted) {
                sendToServer(requestId, extracted);
            } else {
                sendToServer(requestId, text);
            }
            sendToServer(requestId, "[DONE]");
            return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let totalChunks = 0;
        let buffer = ''; // 缓冲区，用于拼接不完整的行

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                // 处理缓冲区中剩余的数据
                if (buffer.trim()) {
                    const text = extractTextFromRSCLine(buffer);
                    if (text) sendToServer(requestId, text);
                }
                console.log(`[LMArena API] Complete (${totalChunks} chunks)`);
                sendToServer(requestId, "[DONE]");
                break;
            }
            totalChunks++;
            buffer += decoder.decode(value, { stream: true });

            // 按行分割并处理完整的行
            const lines = buffer.split('\n');
            // 最后一个元素可能是不完整的行，保留在缓冲区
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line || line.trim().length === 0) continue;
                const text = extractTextFromRSCLine(line);
                if (text) sendToServer(requestId, text);
            }
        }
    }

    // 从 RSC 流式行中提取文本内容
    // 格式: 0:"text" 或其他 type:value 格式
    function extractTextFromRSCLine(line) {
        try {
            const colonIdx = line.indexOf(':');
            if (colonIdx <= 0) return null;
            const type = line.substring(0, colonIdx);
            const value = line.substring(colonIdx + 1);
            if (type === '0') {
                const parsed = JSON.parse(value);
                if (typeof parsed === 'string' && parsed.length > 0) return parsed;
            }
        } catch (e) {}
        return null;
    }

    // 从完整的 RSC 响应中提取所有文本
    function extractTextFromRSC(rawData) {
        let text = '';
        const lines = rawData.split('\n');
        for (const line of lines) {
            const extracted = extractTextFromRSCLine(line);
            if (extracted) text += extracted;
        }
        return text;
    }

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

    // ========== 图片上传 ==========
    async function handleImageUpload(message) {
        const { id, data, mime } = message;
        try {
            const blob = base64ToBlob(data, mime);
            const result = await uploadImage(blob, mime);
            sendToServer(id, result);
        } catch (error) {
            sendToServer(id, { error: error.message });
        }
    }

    function base64ToBlob(base64, mime) {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
        return new Blob([new Uint8Array(byteNumbers)], { type: mime });
    }

    async function uploadImage(imageBlob, mimeType) {
        const filename = `upload-${Date.now()}.${mimeType.split('/')[1]}`;
        const ACTION_ID_STEP1 = localStorage.getItem('LMArena_Action_Upload_Step1') || "70cb393626e05a5f0ce7dcb46977c36c139fa85f91";
        const ACTION_ID_STEP3 = localStorage.getItem('LMArena_Action_Upload_Step3') || "6064c365792a3eaf40a60a874b327fe031ea6f22d7";
        const step1Resp = await fetch("https://arena.ai/?mode=direct", { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", "Next-Action": ACTION_ID_STEP1, "Referer": "https://arena.ai/?mode=direct" }, body: JSON.stringify([filename, mimeType]) });
        if (step1Resp.status === 404) throw new Error("Step 1 Action ID not found (404)");
        const step1Text = await step1Resp.text();
        const step1Line = step1Text.split('\n').find(line => line.startsWith('1:'));
        if (!step1Line) throw new Error('Invalid Step 1 response');
        const step1Json = JSON.parse(step1Line.substring(2));
        if (!step1Json.success) throw new Error("Failed to get upload URL");
        const { uploadUrl, key } = step1Json.data;
        await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mimeType }, body: imageBlob });
        const step3Resp = await fetch("https://arena.ai/?mode=direct", { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", "Next-Action": ACTION_ID_STEP3, "Referer": "https://arena.ai/?mode=direct" }, body: JSON.stringify([key]) });
        const step3Text = await step3Resp.text();
        const step3Line = step3Text.split('\n').find(line => line.startsWith('1:'));
        if (!step3Line) throw new Error('Invalid Step 3 response');
        const step3Json = JSON.parse(step3Line.substring(2));
        if (!step3Json.success) throw new Error("Failed to get download URL");
        return { name: key, contentType: mimeType, url: step3Json.data.url };
    }

    // ========== 自动提取 Next-Action IDs ==========
    function extractActionIDsFromPageSource(attempt = 1) {
        try {
            const scripts = document.querySelectorAll('script');
            let foundStep1 = localStorage.getItem('LMArena_Action_Upload_Step1');
            let foundStep3 = localStorage.getItem('LMArena_Action_Upload_Step3');
            let newStep1 = false, newStep3 = false;
            for (const script of scripts) {
                const content = script.textContent || '';
                const actionMatches = content.matchAll(/["']([a-f0-9]{40})["']/g);
                for (const match of actionMatches) {
                    const id = match[1];
                    const context = content.substring(Math.max(0, match.index - 200), match.index + 200).toLowerCase();
                    if (!newStep1 && (context.includes('upload') || context.includes('presign') || context.includes('r2') || context.includes('storage'))) {
                        if (id !== foundStep1) { localStorage.setItem('LMArena_Action_Upload_Step1', id); foundStep1 = id; }
                        newStep1 = true;
                    }
                    if (!newStep3 && (context.includes('getobject') || context.includes('download') || context.includes('signed'))) {
                        if (id !== foundStep3) { localStorage.setItem('LMArena_Action_Upload_Step3', id); foundStep3 = id; }
                        newStep3 = true;
                    }
                    if (newStep1 && newStep3) break;
                }
                if (newStep1 && newStep3) break;
            }
            if ((!newStep1 || !newStep3) && attempt < 3) setTimeout(() => extractActionIDsFromPageSource(attempt + 1), attempt * 2000);
        } catch (e) {}
    }

    // ========== 初始化 ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            extractActionIDsFromPageSource(1);
            sendModelDataToServer();
        });
    } else {
        extractActionIDsFromPageSource(1);
        sendModelDataToServer();
    }

    // 延迟提取（等待动态加载完成）
    setTimeout(() => { sendModelDataToServer(); }, 3000);
    setTimeout(() => { sendModelDataToServer(); }, 8000);
    setTimeout(() => { sendModelDataToServer(); }, 15000);

    connect();
})();
