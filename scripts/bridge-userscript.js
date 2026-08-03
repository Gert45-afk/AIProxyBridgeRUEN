
// ==UserScript==
// @name         AI Proxy Bridge Client
// @namespace    http://aiproxybridge/
// @version      9.0
// @description  Bridge between AI Proxy Bridge desktop app and LMArena (RSC parsing + UUIDv7)
// @match        https://lmarena.ai/*
// @match        https://*.lmarena.ai/*
// @match        https://arena.ai/*
// @match        https://*.arena.ai/*
// @connect      localhost
// @connect      127.0.0.1
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const SERVER_URL = "ws://127.0.0.1:61001/ws";
    let socket;
    const activeRequests = new Map();

    let modelUuidMap = {};
    let modelDisplayNameMap = {};
    let uuidToSlugMap = {};
    let modelSlugList = [];
    let initialModelAId = '';

    let capturedRequestTemplate = null;
    let capturedDirectTemplate = null;
    let capturedArenaTemplate = null;

    // Request hijack
    let pendingHijack = null;

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const urlArg = args[0];
        let urlString = '';
        if (urlArg instanceof Request) { urlString = urlArg.url; }
        else if (urlArg instanceof URL) { urlString = urlArg.href; }
        else if (typeof urlArg === 'string') { urlString = urlArg; }

        // Diagnostics: log API-related fetch calls
        if (urlString && (urlString.includes('evaluation') || urlString.includes('api') || urlString.includes('stream'))) {
            const shortUrl = urlString.substring(0, 150);
            console.log(`[AI Proxy Bridge] FETCH: ${shortUrl} | pendingHijack=${!!pendingHijack}`);
            fetchLog.push(shortUrl);
            if (fetchLog.length > 50) fetchLog.shift();
        }

        if (urlString && urlString.includes('create-evaluation') && !window.isProxyRequest) {
            try {
                const options = args[1] || {};
                const headers = {};
                if (options.headers) {
                    if (options.headers instanceof Headers) { options.headers.forEach((v, k) => { headers[k] = v; }); }
                    else if (typeof options.headers === 'object') { Object.assign(headers, options.headers); }
                }
                let body = null;
                if (options.body) { try { body = JSON.parse(options.body); } catch(e) { body = options.body; } }
                const contentType = headers['content-type'] || headers['Content-Type'] || 'application/json';

                capturedRequestTemplate = { url: urlString, headers, body, contentType };
                if (body && body.recaptchaV3Token) window.recaptchaToken = body.recaptchaV3Token;

                // Request hijack
                if (pendingHijack && body && typeof body === 'object') {
                    const hijack = pendingHijack;
                    pendingHijack = null;
                    console.log(`[AI Proxy Bridge] HIJACKING page request: modelAId=${body.modelAId} → ${hijack.modelAId}`);

                    body.modelAId = hijack.modelAId;
                    body.mode = 'direct';
                    if (body.userMessage) body.userMessage.content = hijack.content;
                    delete body.modelBId;
                    delete body.modelBMessageId;
                    options.body = JSON.stringify(body);
                    args[1] = options;

                    const hijackedResponse = await originalFetch.apply(this, args);

                    // 429: rejected by reCAPTCHA — don't clear pendingHijack, allow manual retry
                    if (hijackedResponse.status === 429) {
                        console.warn('[AI Proxy Bridge] Hijacked request got 429 — reCAPTCHA rejected');
                        hijack.autoSubmitted = true;
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'status',
                                data: { status: 'auto_submit_429', requestId: hijack.requestId, message: 'Auto-submit was rejected by reCAPTCHA — press Enter manually in the browser to send the message' }
                            }));
                        }
                        return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
                    }

                    // Non-429: hijack succeeded
                    pendingHijack = null;
                    (async () => {
                        try {
                            await handleStream(hijackedResponse, hijack.requestId);
                            hijack.resolve(true);
                        } catch (e) {
                            console.error(`[AI Proxy Bridge] Hijacked stream error:`, e.message);
                            sendToServer(hijack.requestId, { error: e.message });
                            hijack.resolve(false);
                        }
                    })();
                    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
                }

                // Extract modelAId from the captured request
                if (body && body.modelAId && /^[0-9a-f]{8}-/i.test(body.modelAId)) {
                    console.log(`[AI Proxy Bridge] Captured modelAId UUID: ${body.modelAId}`);
                    addModelMapping('captured-modelAId', body.modelAId, 'Captured Model');
                    tryCaptureModelSelection(body.modelAId);
                }

                const isDirectMode = body && body.mode === 'direct';
                if (isDirectMode) {
                    capturedDirectTemplate = capturedRequestTemplate;
                    console.log('[AI Proxy Bridge] Captured DIRECT:', { modelAId: body.modelAId || 'N/A', mode: body.mode });
                } else {
                    capturedArenaTemplate = capturedRequestTemplate;
                    console.log('[AI Proxy Bridge] Captured ARENA');
                }
                sendApiInfoToServer();
            } catch (e) { console.error('[AI Proxy Bridge] Capture error:', e); }
        }
        return originalFetch.apply(this, args);
    };

    function addModelMapping(slug, uuid, displayName) {
        if (!slug || !uuid) return;
        modelUuidMap[slug] = uuid;
        modelUuidMap[slug.toLowerCase()] = uuid;
        if (displayName) { modelDisplayNameMap[displayName] = uuid; modelDisplayNameMap[displayName.toLowerCase()] = uuid; }
        uuidToSlugMap[uuid] = slug;
    }

    function tryCaptureModelSelection(modelAId) {
        try {
            const selectedOption = document.querySelector('div[cmdk-item][role="option"][aria-selected="true"]');
            if (selectedOption) {
                const nameSpan = selectedOption.querySelector('span.flex-1.truncate');
                if (nameSpan) {
                    const name = nameSpan.textContent.trim();
                    if (name) {
                        const slug = name.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');
                        addModelMapping(slug, modelAId, name);
                        addModelMapping(name, modelAId, name);
                        console.log(`[AI Proxy Bridge] Mapped "${name}" → ${modelAId}`);
                    }
                }
            }
            const comboBtn = document.querySelector('button[role="combobox"]');
            if (comboBtn) {
                const btnText = comboBtn.textContent.trim();
                if (btnText && btnText.length > 2 && btnText.length < 60) {
                    const slug = btnText.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');
                    addModelMapping(slug, modelAId, btnText);
                    addModelMapping(btnText, modelAId, btnText);
                    console.log(`[AI Proxy Bridge] Mapped combobox "${btnText}" → ${modelAId}`);
                }
            }
        } catch (e) {}
    }

    // UUIDv7 generation (BigInt precision; the server validates the timestamp)
    function uuid7() {
        const ts = BigInt(Date.now());
        const randA = BigInt(Math.floor(Math.random() * 0x1000));
        const randB = BigInt(Math.floor(Math.random() * 0x3ffffffffffff));
        const uuid_int = (ts << 80n) | (BigInt(0x7000) | (randA & 0x0fffn)) << 64n | (0x8000000000000000n | randB);
        const h = uuid_int.toString(16).padStart(32, '0');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    }

    function generateUUID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return uuid7();
    }

    function extractModelsFromPageHTML() {
        const models = [];
        const seen = new Set();
        try {
            const html = document.documentElement.outerHTML;
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
        } catch (e) {}
        return models;
    }

    // RSC flight data extraction
    function extractModelsFromRSC() {
        let models = [];
        let modelAId = '';
        try {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';
                if (!content.includes('initialModels')) continue;
                try {
                    const idx = content.indexOf('initialModels');
                    if (idx === -1) continue;
                    const afterKey = content.substring(idx + 'initialModels'.length);
                    const arrStart = afterKey.indexOf('[');
                    if (arrStart === -1 || arrStart > 10) continue;
                    let depth = 0, arrEnd = -1;
                    for (let i = arrStart; i < afterKey.length; i++) {
                        if (afterKey[i] === '[') depth++;
                        else if (afterKey[i] === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
                    }
                    if (arrEnd === -1) continue;
                    let arrStr = afterKey.substring(arrStart, arrEnd);
                    if (arrStr.includes('\\"')) arrStr = arrStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    const parsed = JSON.parse(arrStr);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        if (typeof parsed[0] === 'string') { models = parsed; }
                        else if (typeof parsed[0] === 'object') {
                            for (const m of parsed) {
                                if (m && m.id) {
                                    const uuid = m.id; const name = m.name || m.slug || '';
                                    const slug = m.slug || name.toLowerCase().replace(/[\s.]+/g, '-');
                                    models.push(slug);
                                    if (/^[0-9a-f]{8}-/i.test(uuid)) addModelMapping(slug, uuid, name);
                                }
                            }
                        }
                    }
                } catch (e) {}
                try {
                    const aidMatch = content.match(/initialModelAId[^"]*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
                    if (aidMatch) modelAId = aidMatch[1];
                } catch (e) {}
            }
            if (models.length === 0 && window.__NEXT_DATA__) {
                try {
                    const nextDataStr = JSON.stringify(window.__NEXT_DATA__);
                    const modelMatch = nextDataStr.match(/"initialModels"\s*:\s*(\[[^\]]*\])/);
                    if (modelMatch) { const p = JSON.parse(modelMatch[1]); if (Array.isArray(p)) models = p; }
                } catch (e) {}
            }
        } catch (e) {}
        return { models, modelAId };
    }

    // Click the dropdown menu to extract models
    async function extractModelsViaDropdown() {
        const extracted = [];
        try {
            const modelBtn = document.querySelector('button[role="combobox"][aria-haspopup="dialog"]');
            if (!modelBtn) return extracted;
            modelBtn.focus();
            await new Promise(r => setTimeout(r, 100));
            const rect = modelBtn.getBoundingClientRect();
            const clickX = rect.left + rect.width / 2, clickY = rect.top + rect.height / 2;
            modelBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse' }));
            await new Promise(r => setTimeout(r, 30));
            modelBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse' }));
            modelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: clickX, clientY: clickY, cancelable: true }));
            modelBtn.click();
            await new Promise(r => setTimeout(r, 1200));
            const options = document.querySelectorAll('div[cmdk-item][role="option"]');
            for (const opt of options) {
                if (opt.offsetParent === null) continue;
                const nameSpan = opt.querySelector('span.flex-1.truncate');
                const name = nameSpan ? nameSpan.textContent.trim() : (opt.textContent || '').trim();
                const dataValue = opt.getAttribute('data-value') || opt.getAttribute('value') || '';
                if (name && name.length > 2) {
                    const slug = name.toLowerCase().replace(/[\s.]+/g, '-').replace(/[()]+/g, '');
                    extracted.push({ name, slug, dataValue });
                    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dataValue)) {
                        addModelMapping(slug, dataValue, name);
                        addModelMapping(name, dataValue, name);
                    }
                }
            }
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {}
        return extracted;
    }

    async function extractAllModelData() {
        const rscData = extractModelsFromRSC();
        modelSlugList = rscData.models;
        initialModelAId = rscData.modelAId;
        console.log(`[AI Proxy Bridge] RSC: ${modelSlugList.length} slugs, initialModelAId: ${initialModelAId || 'none'}`);
        // If RSC fails, scan slugs from the page HTML
        if (modelSlugList.length === 0) {
            const htmlSlugs = extractModelsFromPageHTML();
            if (htmlSlugs.length > 0) {
                modelSlugList = htmlSlugs;
                console.log(`[AI Proxy Bridge] HTML slug: ${htmlSlugs.length} models`);
            }
        }
        if (initialModelAId && modelSlugList.length > 0) addModelMapping(modelSlugList[0], initialModelAId, modelSlugList[0]);
        const dropdownModels = await extractModelsViaDropdown();
        if (dropdownModels.length > 0) {
            for (const dm of dropdownModels) { if (!modelSlugList.includes(dm.slug)) modelSlugList.push(dm.slug); }
        }
        const modelList = [];
        const seenSlugs = new Set();
        for (const slug of modelSlugList) {
            if (seenSlugs.has(slug.toLowerCase())) continue;
            seenSlugs.add(slug.toLowerCase());
            const uuid = modelUuidMap[slug] || modelUuidMap[slug.toLowerCase()] || '';
            const displayName = uuidToSlugMap[uuid] || slug;
            modelList.push({ id: uuid || slug, name: displayName, slug: slug });
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
                        data: { uuidMap: modelUuidMap, nameMap: modelDisplayNameMap, uuidToSlug: uuidToSlugMap, models: modelList, initialModelAId: initialModelAId }
                    }));
                    console.log(`[AI Proxy Bridge] Sent model data: ${modelList.length} models, ${new Set(Object.values(modelUuidMap)).size} UUIDs`);
                }
            } catch (e) { console.error('[AI Proxy Bridge] sendModelDataToServer error:', e); }
        })();
    }

    function sendApiInfoToServer() {
        if (socket && socket.readyState === WebSocket.OPEN && capturedRequestTemplate) {
            socket.send(JSON.stringify({ type: 'api_info', data: { ...capturedRequestTemplate, isDirect: !!capturedDirectTemplate, isArena: !!capturedArenaTemplate } }));
        }
    }

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
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(model)) return model;
        if (initialModelAId) return initialModelAId;
        return model;
    }

    function buildDirectModeBody(modelId, content, serverModelAId) {
        const resolvedModelAId = serverModelAId ? resolveModelAId(serverModelAId) : resolveModelAId(modelId);
        return {
            id: uuid7(),
            mode: 'direct',
            modelAId: resolvedModelAId,
            userMessageId: uuid7(),
            modelAMessageId: uuid7(),
            userMessage: { content, experimental_attachments: [], metadata: {} },
            modality: 'chat',
            recaptchaV3Token: ''
        };
    }

    // ========== DOM operations: fill the message into the input box ==========
    function findChatInput() {
        const selectors = ['textarea[placeholder]', 'textarea[name="message"]', 'form textarea', 'textarea'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return el;
        }
        return null;
    }

    function setReactInputValue(element, value) {
        element.focus();

        // Method 1: execCommand — most reliable, uses the browser's native input pipeline
        try {
            element.select();
            if (document.execCommand('insertText', false, value)) {
                console.log('[AI Proxy Bridge] setReactInputValue: execCommand succeeded');
                return;
            }
        } catch (e) {}

        // Method 2: native setter + InputEvent (React 18 compatible)
        const nativeSetter = Object.getOwnPropertyDescriptor(
            element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(element, value); else element.value = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[AI Proxy Bridge] setReactInputValue: native setter + InputEvent');
    }

    function simulateEnterKey(element) {
        if (!element) element = findChatInput();
        if (!element) return false;
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        console.log('[AI Proxy Bridge] Enter key simulated');
        return true;
    }

    function fillChatInput(content) {
        const input = findChatInput();
        if (!input) return false;
        setReactInputValue(input, content);
        console.log('[AI Proxy Bridge] Message filled into the input box — will try to auto-submit');
        return true;
    }

    // ========== MutationObserver: watch page DOM to capture the AI response ==========
    let domObserver = null;
    let domObserverRequestId = null;
    let lastAssistantText = '';

    function startDOMObserver(requestId) {
        stopDOMObserver();
        domObserverRequestId = requestId;
        lastAssistantText = '';

        const chatContainer = document.querySelector('[role="log"]') ||
            document.querySelector('[class*="conversation"]') ||
            document.querySelector('[class*="thread"]') ||
            document.querySelector('main') || document.body;

        const existingAssistantMsgs = chatContainer.querySelectorAll('[class*="assistant"], [data-message-role="assistant"]');
        const existingCount = existingAssistantMsgs.length;

        domObserver = new MutationObserver(() => {
            try {
                const text = getLatestAssistantText(chatContainer, existingCount);
                if (text && text.length > lastAssistantText.length) {
                    const delta = text.substring(lastAssistantText.length);
                    lastAssistantText = text;
                    sendToServer(requestId, delta);
                }
            } catch (e) {}
        });
        domObserver.observe(chatContainer, { childList: true, subtree: true, characterData: true });
    }

    function stopDOMObserver() {
        if (domObserver) { domObserver.disconnect(); domObserver = null; }
        domObserverRequestId = null;
    }

    function getLatestAssistantText(container, skipCount) {
        const selectors = [
            '[class*="assistant"] [class*="markdown"]', '[class*="assistant"] [class*="prose"]',
            '[class*="assistant"] [class*="message"]', '[class*="assistant"] [class*="content"]',
            '[data-message-role="assistant"]',
            '[class*="response"] [class*="markdown"]', '[class*="response"] [class*="prose"]',
        ];
        for (const sel of selectors) {
            const els = container.querySelectorAll(sel);
            if (els.length > skipCount) {
                const last = els[els.length - 1];
                const text = (last.innerText || last.textContent || '').trim();
                if (text.length > 2) return text;
            }
        }
        const markdownEls = container.querySelectorAll('.markdown, .prose, [class*="markdown"], [class*="prose"]');
        if (markdownEls.length > 0) {
            const last = markdownEls[markdownEls.length - 1];
            const text = (last.innerText || last.textContent || '').trim();
            if (text.length > 5) return text;
        }
        return null;
    }

    // ========== Fetch diagnostics log ==========
    let fetchLog = [];

    function connect() {
        socket = new WebSocket(SERVER_URL);
        socket.onopen = () => {
            console.log("[AI Proxy Bridge] Connected");
            document.title = "✅ " + document.title.replace(/^✅\s*/, '');
            sendApiInfoToServer(); sendPageSourceViaWs(); sendModelDataToServer();
        };
        socket.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.command) {
                    if (message.command === 'send_page_source') sendPageSourceViaWs();
                    else if (message.command === 'refresh' || message.command === 'reconnect') location.reload();
                    else if (message.command === 'cancel_request') {
                        const { request_id } = message;
                        if (request_id && activeRequests.has(request_id)) { activeRequests.get(request_id).abort(); activeRequests.delete(request_id); }
                    } else if (message.command === 'refresh_models') sendModelDataToServer();
                    return;
                }
                const { request_id, data } = message;
                if (!request_id || !data) return;
                const controller = new AbortController();
                activeRequests.set(request_id, controller);
                (async () => {
                    try {
                        const model = data.model || '';
                        const content = data.content || 'Hello';
                        const modelAId = (buildDirectModeBody(model, content, data.modelAId)).modelAId;

                        // ====== Dual strategy: fetch hijack + DOM watching ======
                        console.log(`[AI Proxy Bridge] Setting up hijack + DOM observer: modelAId=${modelAId}`);

                        const inputFilled = fillChatInput(content);

                        let hijackResolve;
                        const hijackPromise = new Promise(resolve => { hijackResolve = resolve; });
                        pendingHijack = { requestId: request_id, modelAId, content, resolve: hijackResolve, autoSubmitted: false };

                        // Also start DOM watching at the same time
                        startDOMObserver(request_id);

                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'status',
                                data: { status: 'waiting_for_trigger', requestId: request_id, message: inputFilled ? 'Message filled — will auto-submit and listen for the response' : 'Please send a message on the page' }
                            }));
                        }

                        // Auto-simulate Enter after an 800ms delay
                        setTimeout(() => {
                            if (pendingHijack && pendingHijack.requestId === request_id) {
                                simulateEnterKey(findChatInput());
                                pendingHijack.autoSubmitted = true;
                            }
                        }, 800);

                        // Wait: fetch hijack or DOM watching
                        const startTime = Date.now();
                        while (Date.now() - startTime < 120000) {
                            await new Promise(r => setTimeout(r, 500));
                            if (!activeRequests.has(request_id)) { pendingHijack = null; stopDOMObserver(); return; }
                            if (!pendingHijack) { stopDOMObserver(); return; } // fetch hijack succeeded
                            if (lastAssistantText && domObserverRequestId === request_id) {
                                sendToServer(request_id, '[DONE]');
                                pendingHijack = null;
                                stopDOMObserver();
                                return;
                            }
                        }

                        pendingHijack = null;
                        stopDOMObserver();
                        throw new Error('Request timed out — press Enter manually in the browser to send the message, or refresh the lmarena.ai page and try again.');
                    } catch (error) {
                        window.isProxyRequest = false;
                        if (error.name !== 'AbortError') { console.error('[AI Proxy Bridge] Error:', error.message); sendToServer(request_id, { error: error.message }); }
                    } finally { activeRequests.delete(request_id); }
                })();
            } catch (e) { console.error('[AI Proxy Bridge] Message error:', e); }
        };
        socket.onclose = () => {
            if (document.title.startsWith("✅ ")) document.title = document.title.substring(2);
            activeRequests.forEach(c => c.abort()); activeRequests.clear(); setTimeout(connect, 5000);
        };
        socket.onerror = () => { socket.close(); };
    }

    async function handleStream(response, requestId) {
        if (!response.body) {
            const text = await response.text();
            const extracted = extractTextFromRSC(text);
            if (extracted) sendToServer(requestId, extracted); else sendToServer(requestId, text);
            sendToServer(requestId, "[DONE]"); return;
        }
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                if (buffer.trim()) { const t = extractTextFromRSCLine(buffer); if (t) sendToServer(requestId, t); }
                sendToServer(requestId, "[DONE]"); break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line || !line.trim()) continue;
                const t = extractTextFromRSCLine(line);
                if (t) sendToServer(requestId, t);
            }
        }
    }

    function extractTextFromRSCLine(line) {
        try {
            const ci = line.indexOf(':');
            if (ci <= 0) return null;
            if (line.substring(0, ci) === '0') {
                const parsed = JSON.parse(line.substring(ci + 1));
                if (typeof parsed === 'string' && parsed.length > 0) return parsed;
            }
        } catch (e) {}
        return null;
    }

    function extractTextFromRSC(raw) {
        let text = '';
        for (const line of raw.split('\n')) { const t = extractTextFromRSCLine(line); if (t) text += t; }
        return text;
    }

    function sendToServer(requestId, data) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ request_id: requestId, data: data })); }
    function sendPageSourceViaWs() { try { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'page_source', data: document.documentElement.outerHTML })); } catch (e) {} }

    if (document.readyState !== 'loading') sendModelDataToServer();
    else document.addEventListener('DOMContentLoaded', () => sendModelDataToServer());
    setTimeout(() => sendModelDataToServer(), 3000);
    setTimeout(() => sendModelDataToServer(), 8000);
    setTimeout(() => sendModelDataToServer(), 15000);

    connect();
})();
