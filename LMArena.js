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

    // ========== Model UUID mapping ==========
    let modelUuidMap = {};        // { "gpt-4o": "019a98f7-...", "chatgpt-4o-latest": "019a98f7-..." }
    let modelDisplayNameMap = {}; // { "GPT-4o": "019a98f7-..." }
    let uuidToSlugMap = {};       // { "019a98f7-...": "gpt-4o" }
    let modelSlugList = [];       // slug list extracted from RSC
    let initialModelAId = '';     // UUID of the default model

    // ========== Capture real requests from lmarena.ai ==========
    let capturedRequestTemplate = null;
    let capturedDirectTemplate = null;
    let capturedArenaTemplate = null;

    // Request hijack: when the user sends a message in the browser, hijack the page's request
    let pendingHijack = null; // { requestId, modelAId, content, resolve }

    const originalFetch = window.fetch;
     window.fetch = async function (...args) {
        const urlArg = args[0];
        let urlString = '';
        if (urlArg instanceof Request) { urlString = urlArg.url; }
        else if (urlArg instanceof URL) { urlString = urlArg.href; }
        else if (typeof urlArg === 'string') { urlString = urlArg; }

        // Diagnostics: log all API-related fetch calls
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

                // Request hijack: if a hijack is pending, modify the request body and intercept the response
                if (pendingHijack && body && typeof body === 'object') {
                    const hijack = pendingHijack;
                    console.log(`[LMArena API] HIJACKING page request: modelAId=${body.modelAId} → ${hijack.modelAId}`);

                    // Replace key fields in the request body
                    body.modelAId = hijack.modelAId;
                    body.mode = 'direct';
                    if (body.userMessage) body.userMessage.content = hijack.content;
                    delete body.modelBId;
                    delete body.modelBMessageId;
                    options.body = JSON.stringify(body);
                    args[1] = options;

                    // Send the modified request
                    const hijackedResponse = await originalFetch.apply(this, args);

                    // On 429 (reCAPTCHA rejection), don't clear pendingHijack — allow the user to retry manually
                    if (hijackedResponse.status === 429) {
                        console.warn('[LMArena API] Hijacked request got 429 — reCAPTCHA rejected auto-submit');
                        // Keep pendingHijack unchanged, wait for the user to press Enter manually
                        // But mark that auto-submit was attempted, to avoid simulating Enter twice
                        hijack.autoSubmitted = true;

                        // Notify the app: auto-submit failed, manual action required
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'status',
                                data: {
                                    status: 'auto_submit_429',
                                    requestId: hijack.requestId,
                                    message: 'Auto-submit was rejected by reCAPTCHA — press Enter manually in the browser to send the message'
                                }
                            }));
                        }

                        // Return an empty 200 to the page (avoid page errors or auto-retries)
                        return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
                    }

                    // Non-429: hijack succeeded, clear pendingHijack
                    pendingHijack = null;

                    // Read the stream asynchronously and forward it to the proxy
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

                    // Return an empty response to the page (avoid page errors)
                    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
                }

                // Extract modelAId from the captured request → build the UUID mapping
                if (body && body.modelAId && /^[0-9a-f]{8}-/i.test(body.modelAId)) {
                    console.log(`[LMArena API] Captured modelAId UUID: ${body.modelAId}, mode: ${body.mode || 'unknown'}`);
                    // Record the captured UUID for later use
                    addModelMapping('captured-modelAId', body.modelAId, 'Captured Model');

                    // If the user selected a model on the Direct Chat page, try to get the model name from the page
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

        // Capture Next-Action IDs (used for image uploads)
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
            // Method 1: look in the cmdk dropdown menu
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

            // Method 2: look in the combobox button text
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

    // ========== UUIDv7 generation ==========
    // The lmarena.ai server validates the UUIDv7 timestamp — too much skew gets rejected
    // Must use BigInt to avoid precision loss (JS bitwise ops only support 32 bits)
    function uuid7() {
        const ts = BigInt(Date.now());
        const randA = BigInt(Math.floor(Math.random() * 0x1000));
        const randB = BigInt(Math.floor(Math.random() * 0x3ffffffffffff)); // 62 bits
        // UUIDv7: timestamp(48bit) | version(4bit) | randA(12bit) | variant(2bit) | randB(62bit)
        const uuid_int = (ts << 80n) | (BigInt(0x7000) | (randA & 0x0fffn)) << 64n | (0x8000000000000000n | randB);
        const h = uuid_int.toString(16).padStart(32, '0');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    }

    // Compatible with the old generateUUID
    function generateUUID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return uuid7();
    }

    // ========== Extract model slugs from the page HTML (most reliable fallback) ==========
    function extractModelsFromPageHTML() {
        const models = [];
        const seen = new Set();
        try {
            const html = document.documentElement.outerHTML;
            // Same regex as browser-manager.js parseModelsFromHTML()
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

    // ========== Extract the model list from RSC flight data ==========
    // lmarena.ai is a Next.js app — model data is embedded in self.__next_f.push()
    function extractModelsFromRSC() {
        let models = [];
        let modelAId = '';
        let allModelData = {};

        try {
            // Method 1: parse the __next_f.push data in <script> tags
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';
                if (!content.includes('initialModels')) continue;

                // Extract the initialModels data
                // RSC format: self.__next_f.push([1,"...initialModels:[...]..."])
                // Or directly in the HTML: \"initialModels\":[...]

                // Try to parse the escaped JSON
                try {
                    // Find the data near initialModels
                    const idx = content.indexOf('initialModels');
                    if (idx === -1) continue;

                    // Start extracting from initialModels
                    const afterKey = content.substring(idx + 'initialModels'.length);

                    // Find the start of the array
                    const arrStart = afterKey.indexOf('[');
                    if (arrStart === -1 || arrStart > 10) continue;

                    // Manually match brackets to find the end of the array
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

                    // Handle escaping
                    if (arrStr.includes('\\"')) {
                        arrStr = arrStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    }

                    const parsed = JSON.parse(arrStr);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        // Check whether it's an array of strings or of objects
                        if (typeof parsed[0] === 'string') {
                            models = parsed;
                            console.log(`[LMArena API] RSC: Found ${models.length} model slugs`);
                        } else if (typeof parsed[0] === 'object') {
                            // Array of objects, which may contain UUIDs
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
                    // Parsing failed — try regex extraction
                    try {
                        const slugMatches = content.matchAll(/"([a-z][a-z0-9_-]{5,50})"/g);
                        const slugList = [];
                        for (const m of slugMatches) {
                            const slug = m[1];
                            // Filter out strings that look like model slugs
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

                // Extract initialModelAId
                try {
                    const aidMatch = content.match(/initialModelAId[^"]*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
                    if (aidMatch) {
                        modelAId = aidMatch[1];
                        console.log(`[LMArena API] RSC: Found initialModelAId: ${modelAId}`);
                    }
                } catch (e) {}

                // Extract other model data fields
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

            // Method 2: read the Next.js data directly from window
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

    // ========== Extract models by clicking the dropdown menu ==========
    async function extractModelsViaDropdown() {
        const extracted = [];

        try {
            // Find the model selector button (cmdk combobox)
            const modelBtn = document.querySelector('button[role="combobox"][aria-haspopup="dialog"]');
            if (!modelBtn) {
                console.log('[LMArena API] Dropdown: Model selector button not found (may not be on Direct Chat page)');
                return extracted;
            }

            console.log('[LMArena API] Dropdown: Found model selector, opening...');

            // Simulate a real click
            modelBtn.focus();
            await new Promise(r => setTimeout(r, 100));

            // Send pointer events (more realistic)
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

            // Wait for the dropdown menu to load
            await new Promise(r => setTimeout(r, 1200));

            // Read all model options
            const options = document.querySelectorAll('div[cmdk-item][role="option"]');
            console.log(`[LMArena API] Dropdown: Found ${options.length} model options`);

            for (const opt of options) {
                if (opt.offsetParent === null) continue; // skip hidden items

                // Model name
                const nameSpan = opt.querySelector('span.flex-1.truncate');
                const name = nameSpan ? nameSpan.textContent.trim() : (opt.textContent || '').trim();

                // The cmdk-item's value attribute may contain a UUID
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

                    // If dataValue looks like a UUID, create the mapping
                    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dataValue)) {
                        addModelMapping(slug, dataValue, name);
                        addModelMapping(name, dataValue, name);
                        console.log(`[LMArena API] Dropdown: Mapped "${name}" → ${dataValue}`);
                    }
                }
            }

            // Close the dropdown menu
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true
            }));
            await new Promise(r => setTimeout(r, 200));

        } catch (e) {
            console.error('[LMArena API] Dropdown extraction error:', e);
        }

        return extracted;
    }

    // ========== Combined model data extraction ==========
    async function extractAllModelData() {
        // Step 1: extract from RSC flight data
        const rscData = extractModelsFromRSC();
        modelSlugList = rscData.models;
        initialModelAId = rscData.modelAId;

        console.log(`[LMArena API] RSC extraction: ${modelSlugList.length} slugs, initialModelAId: ${initialModelAId || 'none'}`);

        // Step 2: if RSC extraction fails, scan model slugs from the page HTML
        if (modelSlugList.length === 0) {
            const htmlSlugs = extractModelsFromPageHTML();
            if (htmlSlugs.length > 0) {
                modelSlugList = htmlSlugs;
                console.log(`[LMArena API] HTML slug extraction: ${htmlSlugs.length} models`);
            }
        }

        // Step 3: try extracting by clicking the dropdown menu
        const dropdownModels = await extractModelsViaDropdown();
        if (dropdownModels.length > 0) {
            console.log(`[LMArena API] Dropdown: Extracted ${dropdownModels.length} models`);

            // Merge the dropdown models into the list
            for (const dm of dropdownModels) {
                if (!modelSlugList.includes(dm.slug)) {
                    modelSlugList.push(dm.slug);
                }
            }
        }

        // If there is an initialModelAId, associate it with the first model (selected by default)
        if (initialModelAId && modelSlugList.length > 0) {
            addModelMapping(modelSlugList[0], initialModelAId, modelSlugList[0]);
        }

        // Step 4: build the complete model list
        const modelList = [];
        const seenUuids = new Set();
        const seenSlugs = new Set();

        for (const slug of modelSlugList) {
            if (seenSlugs.has(slug.toLowerCase())) continue;
            seenSlugs.add(slug.toLowerCase());

            const uuid = modelUuidMap[slug] || modelUuidMap[slug.toLowerCase()] || '';
            const displayName = uuidToSlugMap[uuid] || slug;

            modelList.push({
                id: uuid || slug,           // prefer the UUID, use the slug if none
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

    // ========== Resolve modelAId ==========
    function resolveModelAId(model) {
        if (!model) return initialModelAId || '';

        // 1. Exact match slug → UUID
        if (modelUuidMap[model]) return modelUuidMap[model];
        if (modelUuidMap[model.toLowerCase()]) return modelUuidMap[model.toLowerCase()];

        // 2. Display name → UUID
        if (modelDisplayNameMap[model]) return modelDisplayNameMap[model];
        if (modelDisplayNameMap[model.toLowerCase()]) return modelDisplayNameMap[model.toLowerCase()];

        // 3. Fuzzy match
        const normalized = model.toLowerCase().replace(/[-_.\s]/g, '');
        for (const [key, uuid] of Object.entries(modelUuidMap)) {
            if (key.toLowerCase().replace(/[-_.\s]/g, '') === normalized) return uuid;
        }

        // 4. If it's already in UUID format, return it as-is
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(model)) {
            return model;
        }

        // 5. Cannot resolve — fall back to initialModelAId or the raw value
        if (initialModelAId) {
            console.warn(`[LMArena API] Cannot resolve "${model}", falling back to initialModelAId: ${initialModelAId}`);
            return initialModelAId;
        }

        console.warn(`[LMArena API] Cannot resolve modelAId for "${model}". No UUID mapping available.`);
        return model;  // fallback (will likely 500)
    }

    // ========== Build the Direct-mode request body ==========
    // Reference gpt4free: https://github.com/xtekky/gpt4free/issues/2832
    // id uses UUIDv7, mode contains "direct", modelAId is the model UUID
    function buildDirectModeBody(modelId, content, serverModelAId) {
        const resolvedModelAId = serverModelAId ? resolveModelAId(serverModelAId) : resolveModelAId(modelId);

        return {
            id: uuid7(),             // UUIDv7 — the server validates the format
            mode: 'direct',          // gpt4free confirms this field is required
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

    // ========== DOM operations: fill the message into the input box (without clicking send) ==========
    // Don't trigger the send button — avoids Cloudflare Turnstile detection
    // The user just presses Enter to send (this is real user interaction, the reCAPTCHA token stays valid)

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

        // Method 1: execCommand — most reliable, uses the browser's native input pipeline, captured correctly by React
        try {
            element.select(); // select the existing text
            if (document.execCommand('insertText', false, value)) {
                console.log('[LMArena API] setReactInputValue: execCommand succeeded');
                return;
            }
        } catch (e) {}

        // Method 2: native setter + InputEvent (React 18 compatible)
        const nativeSetter = Object.getOwnPropertyDescriptor(
            element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
        )?.set;
        if (nativeSetter) {
            nativeSetter.call(element, value);
        } else {
            element.value = value;
        }
        // Use InputEvent instead of Event — React 18 handles InputEvent more reliably
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: value
        }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LMArena API] setReactInputValue: native setter + InputEvent');
    }

    // Simulate the Enter key to send the message
    function simulateEnterKey(element) {
        if (!element) element = findChatInput();
        if (!element) return false;
        element.focus();
        // Simulate the full keyboard event chain
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        console.log('[LMArena API] Enter key simulated');
        return true;
    }

    // Fill the message into the page input box, returns success
    function fillChatInput(content) {
        const input = findChatInput();
        if (!input) {
            console.warn('[LMArena API] Input box not found — could not auto-fill the message');
            return false;
        }
        setReactInputValue(input, content);
        console.log('[LMArena API] Message filled into the input box — will try to auto-submit');
        return true;
    }

    // ========== MutationObserver: watch page DOM to capture the AI response ==========
    // When fetch interception can't capture the request, get the AI reply by watching DOM changes
    let domObserver = null;
    let domObserverRequestId = null;
    let lastAssistantText = '';
    let domResponseComplete = false;

    function startDOMObserver(requestId) {
        stopDOMObserver();
        domObserverRequestId = requestId;
        lastAssistantText = '';
        domResponseComplete = false;

        // Find the chat message container
        const chatContainer = findChatContainer();
        if (!chatContainer) {
            console.warn('[LMArena API] DOM Observer: chat container not found');
            return;
        }

        // Record the current number of assistant messages (avoid capturing old messages)
        const existingAssistantMsgs = chatContainer.querySelectorAll(
            '[class*="assistant"], [data-message-role="assistant"]'
        );
        const existingCount = existingAssistantMsgs.length;
        console.log(`[LMArena API] DOM Observer started: ${existingCount} existing messages`);

        domObserver = new MutationObserver(() => {
            try {
                const text = getLatestAssistantText(chatContainer, existingCount);
                if (text && text.length > lastAssistantText.length) {
                    // Only send the incremental content
                    const delta = text.substring(lastAssistantText.length);
                    lastAssistantText = text;
                    sendToServer(requestId, delta);
                    console.log(`[LMArena API] DOM Observer: +${delta.length} chars (total ${text.length})`);
                }
            } catch (e) {}
        });

        domObserver.observe(chatContainer, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // Set a timeout check: if there's still no content after 5 seconds, check the page for errors
        setTimeout(() => {
            if (domObserver && !lastAssistantText && domObserverRequestId === requestId) {
                const errorText = checkPageError();
                if (errorText) {
                    sendToServer(requestId, { error: errorText });
                    stopDOMObserver();
                }
            }
        }, 5000);

        // Auto-stop after 60 seconds (the response should be complete by then)
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
        // lmarena.ai uses Next.js — chat messages are usually in specific containers
        const selectors = [
            '[class*="chat"] [class*="message"]',  // generic chat container
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
        // Strategy 1: find elements whose class contains "assistant"
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
                // Take the last one (the newest response)
                const last = els[els.length - 1];
                const text = (last.innerText || last.textContent || '').trim();
                if (text.length > 2) return text;
            }
        }

        // Strategy 2: find all message blocks and take the last non-user message
        const msgSelectors = '[class*="message"], [class*="turn"], [class*="bubble"]';
        const msgs = container.querySelectorAll(msgSelectors);
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            const text = (last.innerText || last.textContent || '').trim();
            // Exclude user messages (usually shorter and earlier)
            if (text.length > 5 && !last.querySelector('textarea') && !last.querySelector('input')) {
                return text;
            }
        }

        // Strategy 3: look for markdown/prose content (AI responses are usually rendered as markdown)
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

    // ========== Fetch diagnostics log ==========
    let fetchLog = [];  // records recent fetch call URLs

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
                        const content = data.content || 'Hello';
                        const modelAId = (buildDirectModeBody(model, content, data.modelAId)).modelAId;

                        // ====== Dual strategy: fetch hijack + DOM watching ======
                        // Strategy 1: request hijack — intercept the page's fetch and replace the model ID (requires the fetch interceptor to work)
                        // Strategy 2: DOM watching — a MutationObserver captures the page's AI reply (always available, but cannot replace the model)

                        console.log(`[LMArena API] Setting up hijack + DOM observer: modelAId=${modelAId}`);

                        // Send diagnostics
                        sendDiagnostics('test_start');

                        // Fill the message into the page's input box
                        const inputFilled = fillChatInput(content);

                        // Set up the hijack
                        let hijackResolve;
                        const hijackPromise = new Promise(resolve => { hijackResolve = resolve; });
                        pendingHijack = {
                            requestId: request_id,
                            modelAId: modelAId,
                            content: content,
                            resolve: hijackResolve,
                            autoSubmitted: false
                        };

                        // Also start DOM watching (as a fallback)
                        startDOMObserver(request_id);

                        // Notify the proxy
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'status',
                                data: {
                                    status: 'waiting_for_trigger',
                                    requestId: request_id,
                                    message: inputFilled
                                        ? 'Message filled into the browser input box — will auto-submit and listen for the response'
                                        : 'Please send a message on lmarena.ai to trigger the test'
                                }
                            }));
                        }

                        // Auto-simulate the Enter key after an 800ms delay to submit
                        setTimeout(() => {
                            if (pendingHijack && pendingHijack.requestId === request_id) {
                                simulateEnterKey(findChatInput());
                                pendingHijack.autoSubmitted = true;
                            }
                        }, 800);

                        // Wait for a result: fetch hijack or DOM watching
                        // fetch hijack success sets pendingHijack = null; DOM watching success makes lastAssistantText non-empty
                        const startTime = Date.now();

                        // Poll for results from both strategies
                        while (Date.now() - startTime < 120000) {
                            await new Promise(r => setTimeout(r, 500));

                            // Request was cancelled
                            if (!activeRequests.has(request_id)) {
                                pendingHijack = null;
                                stopDOMObserver();
                                return;
                            }

                            // fetch hijack succeeded: pendingHijack has been cleared
                            if (!pendingHijack) {
                                stopDOMObserver();
                                console.log(`[LMArena API] Fetch hijack succeeded`);
                                return; // the response is handled by handleStreamResponse
                            }

                            // DOM watching succeeded: AI response captured
                            if (lastAssistantText && domObserverRequestId === request_id) {
                                // Send the [DONE] marker
                                sendToServer(request_id, '[DONE]');
                                pendingHijack = null;
                                stopDOMObserver();
                                console.log(`[LMArena API] DOM Observer captured a response: ${lastAssistantText.length} chars`);
                                return;
                            }
                        }

                        // Both strategies timed out
                        pendingHijack = null;
                        stopDOMObserver();
                        sendDiagnostics('timeout');
                        throw new Error(
                            'Request timed out — neither strategy captured a response\n' +
                            'Possible causes:\n' +
                            '1. The page did not send a request (make sure the input box has content and Enter was pressed)\n' +
                            '2. The page triggered a CAPTCHA check (complete it and try again)\n' +
                            '3. The fetch interceptor did not work (refresh the page and try again)\n' +
                            'Tip: send a message manually in the browser and check whether it responds normally.'
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
            // Try to extract text from a non-streamed response
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
        let buffer = ''; // buffer for joining incomplete lines

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                // Process the remaining data in the buffer
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

            // Split by line and process complete lines
            const lines = buffer.split('\n');
            // The last element may be an incomplete line — keep it in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line || line.trim().length === 0) continue;
                const text = extractTextFromRSCLine(line);
                if (text) sendToServer(requestId, text);
            }
        }
    }

    // Extract text content from an RSC stream line
    // Format: 0:"text" or another type:value format
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

    // Extract all text from a complete RSC response
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

    // ========== Image upload ==========
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

    // ========== Automatically extract Next-Action IDs ==========
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

    // ========== Initialization ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            extractActionIDsFromPageSource(1);
            sendModelDataToServer();
        });
    } else {
        extractActionIDsFromPageSource(1);
        sendModelDataToServer();
    }

    // Delayed extraction (wait for dynamic loading to finish)
    setTimeout(() => { sendModelDataToServer(); }, 3000);
    setTimeout(() => { sendModelDataToServer(); }, 8000);
    setTimeout(() => { sendModelDataToServer(); }, 15000);

    connect();
})();
