const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');

class BrowserManager {
    constructor() {
        this.browsers = [];
        this.pages = [];
        this.instanceInfos = [];
        this.currentPageIndex = 0;
        this.models = [];
        this.scriptsPath = path.join(__dirname, '../scripts');
        this.cachedChromePath = null;
    }

    async init() {
        await fs.mkdir(this.scriptsPath, { recursive: true });
        const chromePath = await this.findChromePath();
        if (!chromePath) {
            throw new Error(
                '找不到 Chrome/Edge 浏览器！\n' +
                '请安装 Google Chrome 或 Microsoft Edge，或者配置浏览器路径。'
            );
        }
        this.cachedChromePath = chromePath;
        console.log(`[BrowserManager] Using browser: ${chromePath}`);
        console.log('[BrowserManager] 初始化完成，等待创建浏览器实例...');
        setInterval(() => this.updateModels(), 3600000);
    }

    async findChromePath() {
        if (this.cachedChromePath) {
            try {
                await fs.access(this.cachedChromePath);
                return this.cachedChromePath;
            } catch (e) {
                this.cachedChromePath = null;
            }
        }

        const candidates = [];
        if (process.platform === 'win32') {
            try {
                const regChrome = execSync(
                    'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
                );
                const match = regChrome.match(/REG_SZ\s+(.+)/);
                if (match && match[1]) candidates.push(match[1].trim());
            } catch (e) {}
            try {
                const regEdge = execSync(
                    'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve',
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
                );
                const match = regEdge.match(/REG_SZ\s+(.+)/);
                if (match && match[1]) candidates.push(match[1].trim());
            } catch (e) {}
            candidates.push(
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
            );
            if (process.env.LOCALAPPDATA) {
                candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
            }
            candidates.push(
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
            );
            if (process.env['PROGRAMFILES(X86)']) {
                candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
            }
        }
        if (process.platform === 'darwin') {
            candidates.push(
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
            );
        }
        if (process.platform === 'linux') {
            candidates.push(
                '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser', '/usr/bin/chromium',
                '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'
            );
            try {
                const whichResult = execSync('which google-chrome chromium chromium-browser microsoft-edge 2>/dev/null', { encoding: 'utf8' }).trim();
                if (whichResult) whichResult.split('\n').forEach(p => candidates.push(p.trim()));
            } catch (e) {}
        }

        const seen = new Set();
        for (const p of candidates) {
            if (!p || seen.has(p)) continue;
            seen.add(p);
            try {
                await fs.access(p);
                console.log(`[BrowserManager] Found browser at: ${p}`);
                return p;
            } catch (e) {}
        }
        return null;
    }

    // ========== 核心：通过 UI 操控页面发送消息并获取响应 ==========

    async handleChatCompletion(requestId, model, messages, onChunk) {
        if (this.pages.length === 0) {
            onChunk({ error: '没有可用的浏览器实例' });
            return;
        }

        const page = this.pages[this.currentPageIndex % this.pages.length];
        this.currentPageIndex++;

        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const messageText = lastUserMsg ? lastUserMsg.content : '你好';

        console.log(`[BrowserManager] handleChatCompletion → model:${model}, msg:"${messageText.substring(0, 50)}"`);

        try {
            // 1. 确保页面在 lmarena.ai
            const currentUrl = page.url();
            if (!currentUrl.includes('lmarena.ai') && !currentUrl.includes('arena.ai')) {
                console.log('[BrowserManager] Navigating to lmarena.ai...');
                await page.goto('https://lmarena.ai/?mode=direct', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await sleep(2000);
            }

            // 2. 点击 "New Chat" 或导航到 direct mode 开始新对话
            await this.startNewChat(page);

            // 3. 选择模型（direct mode 下有模型选择器）
            await this.selectModel(page, model);

            // 4. 在输入框中输入消息
            await this.typeMessage(page, messageText);

            // 5. 发送消息
            await this.sendMessage(page);

            // 6. 等待并提取 AI 响应
            const content = await this.waitForResponse(page, requestId, model, onChunk);

            if (!content || content.trim().length === 0) {
                onChunk({ error: '模型返回空响应 — 请确认已登录 lmarena.ai 且模型可用' });
            }
        } catch (e) {
            console.error('[BrowserManager] handleChatCompletion failed:', e.message);
            onChunk({ error: '执行失败：' + e.message });
        }
    }

    // 开始新对话
    async startNewChat(page) {
        try {
            // 尝试找 "New Chat" 按钮
            const clicked = await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button, a, [role="button"]')];
                const newChatBtn = btns.find(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    return text === 'new chat' || text.includes('new chat') || text === '新对话';
                });
                if (newChatBtn) {
                    newChatBtn.click();
                    return true;
                }
                return false;
            });

            if (clicked) {
                console.log('[BrowserManager] Clicked "New Chat"');
                await sleep(1000);
            } else {
                // 导航到 direct mode 开始新对话
                await page.goto('https://lmarena.ai/?mode=direct', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await sleep(2000);
                console.log('[BrowserManager] Navigated to new chat');
            }
        } catch (e) {
            console.log('[BrowserManager] startNewChat note:', e.message);
        }
    }

    // 选择模型
    async selectModel(page, model) {
        try {
            const selected = await page.evaluate((targetModel) => {
                // 方法1: select 元素
                const selects = document.querySelectorAll('select');
                for (const sel of selects) {
                    const options = [...sel.options];
                    for (const opt of options) {
                        if (opt.value === targetModel ||
                            opt.textContent.toLowerCase().includes(targetModel.toLowerCase())) {
                            sel.value = opt.value;
                            sel.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        }
                    }
                }

                // 方法2: 点击模型选择按钮打开下拉菜单
                const btns = [...document.querySelectorAll('button, [role="button"], [role="combobox"]')];
                const modelBtn = btns.find(el => {
                    const text = (el.textContent || '').toLowerCase();
                    // 查找包含 "model" 或已知模型名的按钮
                    return text.includes('select model') || text.includes('choose model') ||
                           text.includes('选择模型') || text.includes('direct');
                });

                if (modelBtn) {
                    modelBtn.click();
                    return 'opened_menu';
                }

                return false;
            }, model);

            if (selected === 'opened_menu') {
                await sleep(500);
                // 从下拉菜单中选择目标模型
                await page.evaluate((targetModel) => {
                    const items = [...document.querySelectorAll(
                        '[role="option"], [role="listbox"] li, [role="menuitem"], ' +
                        '[data-model], [data-model-id], [data-value], ' +
                        '.dropdown-item, [class*="option"], [class*="item"]'
                    )];
                    const target = items.find(el => {
                        const text = (el.textContent || '').toLowerCase();
                        const val = (el.getAttribute('data-model') || el.getAttribute('data-model-id') || el.getAttribute('data-value') || '').toLowerCase();
                        return text.includes(targetModel.toLowerCase()) || val === targetModel.toLowerCase();
                    });
                    if (target) target.click();
                }, model);
                await sleep(500);
                console.log('[BrowserManager] Selected model:', model);
            } else if (selected === true) {
                console.log('[BrowserManager] Selected model via select:', model);
            } else {
                console.log('[BrowserManager] Model selector not found, using default');
            }
        } catch (e) {
            console.log('[BrowserManager] selectModel note:', e.message);
        }
    }

    // 在输入框输入消息
    async typeMessage(page, messageText) {
        try {
            // 等待输入框出现
            await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
            await sleep(300);

            // 清空输入框并输入
            await page.evaluate((text) => {
                const textarea = document.querySelector('textarea') ||
                                document.querySelector('[contenteditable="true"]');
                if (!textarea) throw new Error('输入框未找到');

                // 聚焦
                textarea.focus();

                if (textarea.tagName === 'TEXTAREA' || textarea.tagName === 'INPUT') {
                    // 使用 React 兼容的方式设置值
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype, 'value'
                    )?.set;
                    if (nativeSetter) {
                        nativeSetter.call(textarea, text);
                    } else {
                        textarea.value = text;
                    }
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (textarea.getAttribute('contenteditable') === 'true') {
                    textarea.textContent = text;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, messageText);

            console.log('[BrowserManager] Message typed:', messageText.substring(0, 30) + '...');
        } catch (e) {
            throw new Error('无法在页面中找到输入框: ' + e.message);
        }
    }

    // 发送消息
    async sendMessage(page) {
        try {
            const sent = await page.evaluate(() => {
                // 策略1: 找发送按钮
                const strategies = [
                    () => document.querySelector('button[aria-label*="Send" i]'),
                    () => document.querySelector('button[aria-label*="发送" i]'),
                    () => document.querySelector('button[type="submit"]'),
                    () => {
                        // 在输入框容器附近找按钮
                        const input = document.querySelector('textarea, [contenteditable="true"]');
                        if (!input) return null;
                        const form = input.closest('form') || input.parentElement?.parentElement;
                        if (!form) return null;
                        const btns = [...form.querySelectorAll('button')];
                        return btns[btns.length - 1] || null;
                    },
                    () => {
                        // 找带 SVG 发送图标的按钮
                        const btns = [...document.querySelectorAll('button')];
                        return btns.find(btn => {
                            const svg = btn.querySelector('svg');
                            if (!svg) return false;
                            const html = svg.innerHTML.toLowerCase();
                            return html.includes('send') || html.includes('paper') ||
                                   html.includes('arrow') || html.includes('plane');
                        }) || null;
                    }
                ];

                for (const strategy of strategies) {
                    try {
                        const btn = strategy();
                        if (btn) { btn.click(); return true; }
                    } catch (e) {}
                }
                return false;
            });

            if (!sent) {
                // 回退：按 Enter 发送
                await page.keyboard.press('Enter');
                console.log('[BrowserManager] Used Enter to send');
            } else {
                console.log('[BrowserManager] Clicked send button');
            }
            await sleep(500);
        } catch (e) {
            try { await page.keyboard.press('Enter'); } catch (e2) {}
            console.log('[BrowserManager] sendMessage fallback to Enter');
        }
    }

    // 等待 AI 响应（轮询 DOM 变化）
    async waitForResponse(page, requestId, model, onChunk) {
        return new Promise((resolve) => {
            let lastContent = '';
            let lastLength = 0;
            let stableCount = 0;
            let pollCount = 0;
            const MAX_STABLE = 10;     // 连续 10 次内容不变则认为完成
            const MIN_POLLS = 6;       // 至少轮询 6 次才开始判断
            const POLL_INTERVAL = 600; // 每 600ms 轮询

            const timeout = setTimeout(() => {
                cleanup();
                resolve(lastContent || '');
            }, 60000);

            function cleanup() {
                clearTimeout(timeout);
                clearInterval(poller);
            }

            const poller = setInterval(async () => {
                try {
                    if (page.isClosed()) {
                        cleanup();
                        resolve(lastContent);
                        return;
                    }

                    const result = await page.evaluate(() => {
                        // 查找 AI 响应文本
                        // 策略1: 查找 assistant/message 相关 DOM
                        const selectors = [
                            '[class*="assistant"] [class*="markdown"], [class*="assistant"] [class*="prose"]',
                            '[class*="assistant"] [class*="message"], [class*="assistant"] [class*="content"]',
                            '[class*="response"] [class*="markdown"], [class*="response"] [class*="prose"]',
                            '[data-message-role="assistant"]',
                            '[class*="message-content"]',
                            '.markdown, .prose, article',
                            '[class*="bot"] [class*="message"]',
                            '[class*="ai-"] [class*="message"]',
                        ];

                        for (const sel of selectors) {
                            const els = document.querySelectorAll(sel);
                            if (els.length > 0) {
                                // 取最后一个（最新的响应）
                                const last = els[els.length - 1];
                                const text = (last.innerText || last.textContent || '').trim();
                                if (text.length > 2) return { text, found: true };
                            }
                        }

                        // 策略2: 查找所有消息块，排除用户消息
                        const allMsgs = document.querySelectorAll('[class*="message"], [class*="turn"], [class*="bubble"]');
                        const texts = [];
                        for (const msg of allMsgs) {
                            const text = (msg.innerText || msg.textContent || '').trim();
                            if (text.length > 5) texts.push(text);
                        }
                        if (texts.length >= 2) {
                            // 最后一个通常是 AI 响应
                            return { text: texts[texts.length - 1], found: true };
                        }

                        // 策略3: 查找 streaming/loading 指示器
                        const loading = document.querySelector(
                            '[class*="loading"], [class*="typing"], [class*="streaming"], ' +
                            '[class*="cursor"], [class*="blink"]'
                        );
                        if (loading) {
                            return { text: '', found: false, loading: true };
                        }

                        return { text: '', found: false };
                    });

                    pollCount++;

                    if (result.found && result.text.length > 0) {
                        if (result.text.length > lastLength) {
                            // 内容增长了，发送增量
                            const delta = result.text.substring(lastLength);
                            lastContent = result.text;
                            lastLength = result.text.length;
                            stableCount = 0;

                            onChunk({
                                id: requestId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                choices: [{
                                    index: 0,
                                    delta: { content: delta },
                                    finish_reason: null
                                }]
                            });
                        } else {
                            stableCount++;
                        }

                        // 判断完成
                        if (stableCount >= MAX_STABLE && pollCount >= MIN_POLLS && lastContent.length > 0) {
                            cleanup();
                            onChunk({
                                id: requestId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                            });
                            console.log('[BrowserManager] Response complete, length:', lastContent.length);
                            resolve(lastContent);
                        }
                    }

                    // 检测错误
                    if (pollCount > 5 && !lastContent) {
                        const errorText = await page.evaluate(() => {
                            const errEls = document.querySelectorAll('[class*="error"], [role="alert"]');
                            for (const el of errEls) {
                                const text = (el.textContent || '').trim();
                                if (text.length > 5 && text.length < 300) return text;
                            }
                            return null;
                        }).catch(() => null);
                        if (errorText) {
                            cleanup();
                            onChunk({ error: '页面错误: ' + errorText });
                            resolve('');
                        }
                    }
                } catch (e) {
                    if (e.message.includes('context was destroyed') || e.message.includes('Target closed')) {
                        cleanup();
                        resolve(lastContent);
                    }
                }
            }, POLL_INTERVAL);
        });
    }

    // ========== 浏览器实例创建 ==========

    async createInstance() {
        let chromePath = this.cachedChromePath;
        if (!chromePath) chromePath = await this.findChromePath();
        if (!chromePath) {
            throw new Error('无法创建浏览器实例：未找到可用的浏览器（Chrome/Edge）。');
        }
        console.log(`[BrowserManager] Launching browser: ${chromePath}`);

        const instanceProfileDir = path.join(this.scriptsPath, 'browser-profile-' + (this.browsers.length + 1));

        const browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--user-data-dir=' + instanceProfileDir,
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation', '--disable-infobars'],
            ignoreHTTPSErrors: true
        });

        browser.on('disconnected', () => {
            console.log('[BrowserManager] Browser disconnected (user closed it)');
            const idx = this.browsers.indexOf(browser);
            if (idx !== -1) {
                this.browsers.splice(idx, 1);
                this.pages.splice(idx, 1);
                const removed = this.instanceInfos.splice(idx, 1)[0];
                console.log(`[BrowserManager] Auto-removed instance #${removed?.id}, ${this.instanceInfos.length} remaining`);
            }
        });

        let page = null;
        let pages = null;

        // 拦截 chat.lmarena.ai 重定向标签页
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() !== 'page') return;
                const targetUrl = target.url() || '';
                let newPage = null;
                try { newPage = await target.page(); } catch (e) {}

                if (targetUrl.includes('chat.lmarena.ai')) {
                    try { await newPage.close(); } catch (e) {}
                    console.log('[BrowserManager] Closed chat.lmarena.ai redirect tab');
                }
            } catch (e) {}
        });

        // 获取初始页面
        pages = await browser.pages();
        page = pages[0] || await browser.newPage();

        // 注入反检测脚本
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
                configurable: true
            });
            window.chrome = window.chrome || {};
            window.chrome.runtime = window.chrome.runtime || {};
            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh', 'en-US', 'en'],
                configurable: true
            });
        });

        // 导航到 lmarena.ai
        try {
            await page.goto('https://lmarena.ai/?mode=direct', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        } catch (navErr) {
            const currentUrl = page.url();
            if (currentUrl.includes('arena.ai') || currentUrl.includes('lmarena.ai')) {
                console.log(`[BrowserManager] Navigation completed: ${currentUrl}`);
            } else {
                console.error(`[BrowserManager] Navigation error: ${navErr.message}`);
            }
        }

        const instanceInfo = {
            id: this.browsers.length + 1,
            status: 'active',
            createdAt: new Date().toISOString(),
            url: page.url(),
            browserPath: chromePath,
            browserType: chromePath.toLowerCase().includes('edge') ? 'edge' : 'chrome'
        };

        this.browsers.push(browser);
        this.pages.push(page);
        this.instanceInfos.push(instanceInfo);
        console.log(`[BrowserManager] Created instance #${instanceInfo.id}, URL: ${page.url()}`);
        return { browser, page, info: instanceInfo };
    }

    // ========== 模型列表管理 ==========

    async updateModels() {
        if (this.pages.length === 0) {
            this.models = this.getDefaultModels();
            return;
        }

        const page = this.pages[0];
        try {
            const pageUrl = page.url();
            if (!pageUrl.includes('arena.ai') && !pageUrl.includes('lmarena.ai')) {
                this.models = this.getDefaultModels();
                return;
            }

            // 方法1: 从页面 JS 上下文提取模型列表（最准确，包含 UUID）
            try {
                const jsModels = await page.evaluate(() => {
                    const results = [];
                    try {
                        // Next.js 页面数据中的模型列表
                        const nextData = window.__NEXT_DATA__;
                        if (nextData) {
                            const jsonStr = JSON.stringify(nextData);
                            // 提取 initialModels 数组
                            const modelsMatch = jsonStr.match(/"initialModels"\s*:\s*(\[[\s\S]*?\])\s*,\s*"/);
                            if (modelsMatch) {
                                try {
                                    const models = JSON.parse(modelsMatch[1]);
                                    for (const m of models) {
                                        if (m.id && m.name) {
                                            results.push({ id: m.id, name: m.name, provider: m.provider || '' });
                                        } else if (typeof m === 'string') {
                                            results.push({ id: m, name: m });
                                        }
                                    }
                                } catch (e) {}
                            }
                        }
                    } catch (e) {}

                    // 备选：从页面 DOM 提取
                    try {
                        document.querySelectorAll('select option, [role="option"]').forEach(el => {
                            const val = (el.value || el.getAttribute('data-value') || el.textContent || '').trim();
                            const text = (el.textContent || '').trim();
                            if (val && val.length >= 3 && val.length <= 80) {
                                // 避免重复
                                if (!results.find(r => r.id === val || r.name === text)) {
                                    results.push({ id: val, name: text || val });
                                }
                            }
                        });
                    } catch (e) {}

                    const seen = new Set();
                    return results.filter(m => {
                        const key = m.id.toLowerCase();
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                });

                if (jsModels.length > 0) {
                    this.models = jsModels;
                    console.log(`[BrowserManager] Extracted ${jsModels.length} models from page JS`);
                    return;
                }
            } catch (e) {}

            // 方法2: 从 HTML 解析
            try {
                const html = await page.content();
                if (html && html.length > 1000) {
                    const parsedModels = this.parseModelsFromHTML(html);
                    if (parsedModels.length > 0) {
                        this.models = parsedModels;
                        console.log(`[BrowserManager] Extracted ${parsedModels.length} models from page HTML`);
                        return;
                    }
                }
            } catch (e) {}

            // 兜底
            this.models = this.getDefaultModels();
        } catch (error) {
            console.error('[BrowserManager] updateModels error:', error.message);
            this.models = this.getDefaultModels();
        }
    }

    getDefaultModels() {
        // 2026年4月更新 — 覆盖 lmarena.ai 常见模型
        return [
            // OpenAI
            { id: 'chatgpt-4o-latest', name: 'ChatGPT-4o Latest' },
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
            { id: 'gpt-4.1', name: 'GPT-4.1' },
            { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
            { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
            { id: 'gpt-4.5', name: 'GPT-4.5' },
            { id: 'gpt-5', name: 'GPT-5' },
            { id: 'gpt-5.1', name: 'GPT-5.1' },
            { id: 'gpt-5.2', name: 'GPT-5.2' },
            { id: 'o1', name: 'o1' },
            { id: 'o3', name: 'o3' },
            { id: 'o3-mini', name: 'o3 Mini' },
            { id: 'o4-mini', name: 'o4 Mini' },
            // Anthropic
            { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet' },
            { id: 'claude-3-opus', name: 'Claude 3 Opus' },
            { id: 'claude-3-haiku', name: 'Claude 3 Haiku' },
            { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
            { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
            { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-opus-4', name: 'Claude Opus 4' },
            { id: 'claude-opus-4.5', name: 'Claude Opus 4.5' },
            { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
            // Google
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
            { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
            { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
            { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
            { id: 'gemma-3', name: 'Gemma 3' },
            // Meta
            { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
            { id: 'llama-4-maverick', name: 'Llama 4 Maverick' },
            { id: 'llama-4-scout', name: 'Llama 4 Scout' },
            // DeepSeek
            { id: 'deepseek-v3', name: 'DeepSeek V3' },
            { id: 'deepseek-v3.1', name: 'DeepSeek V3.1' },
            { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
            { id: 'deepseek-r1', name: 'DeepSeek R1' },
            { id: 'deepseek-r2', name: 'DeepSeek R2' },
            // Alibaba/Qwen
            { id: 'qwen-plus', name: 'Qwen Plus' },
            { id: 'qwen-max', name: 'Qwen Max' },
            { id: 'qwen3', name: 'Qwen3' },
            { id: 'qwen3-235b', name: 'Qwen3 235B' },
            // Mistral
            { id: 'mistral-large', name: 'Mistral Large' },
            { id: 'mistral-medium', name: 'Mistral Medium' },
            { id: 'mistral-small', name: 'Mistral Small' },
            { id: 'codestral', name: 'Codestral' },
            { id: 'mixtral', name: 'Mixtral' },
            { id: 'pixtral', name: 'Pixtral' },
            { id: 'ministral', name: 'Ministral' },
            // xAI
            { id: 'grok-3', name: 'Grok 3' },
            { id: 'grok-4', name: 'Grok 4' },
            { id: 'grok-4.1', name: 'Grok 4.1' },
            // Zhipu
            { id: 'glm-4', name: 'GLM-4' },
            { id: 'glm-4.5', name: 'GLM-4.5' },
            { id: 'glm-4.7', name: 'GLM-4.7' },
            { id: 'glm-5', name: 'GLM-5' },
            { id: 'glm-5.1', name: 'GLM-5.1' },
            // Moonshot
            { id: 'kimi', name: 'Kimi' },
            { id: 'kimi-2', name: 'Kimi 2' },
            { id: 'kimi-2.5', name: 'Kimi 2.5' },
            // Cohere
            { id: 'command-r', name: 'Command R' },
            { id: 'command-r-plus', name: 'Command R+' },
            { id: 'c4ai-aya', name: 'Aya' },
            // Microsoft
            { id: 'phi-4', name: 'Phi-4' },
            // MiniMax
            { id: 'minimax', name: 'MiniMax' },
            { id: 'mimo', name: 'Mimo' },
            // 01.AI
            { id: 'yi-lightning', name: 'Yi Lightning' },
            { id: 'yi-large', name: 'Yi Large' },
        ];
    }

    parseModelsFromHTML(html) {
        const models = [];
        const seen = new Set();
        try {
            const modelPattern = /(?:"|'|`)(claude-[a-z0-9._\-]+|gpt-[a-z0-9._\-]+|chatgpt-[a-z0-9._\-]+|o[134]-[a-z0-9._\-]+|gemini-[a-z0-9._\-]+|llama-[a-z0-9._\-]+|deepseek-[a-z0-9._\-]+|qwen[a-z0-9._\-]{3,60}|mistral-[a-z0-9._\-]+|grok-[a-z0-9._\-]+|glm-[a-z0-9._\-]+|ernie-[a-z0-9._\-]+|kimi-[a-z0-9._\-]+|gemma-[a-z0-9._\-]+|phi-[a-z0-9._\-]+)(?:"|'|`)/gi;
            let match;
            while ((match = modelPattern.exec(html)) !== null) {
                let name = match[1] || match[0].replace(/^['"`]+|['"`]+$/g, '');
                if (!name || name.length < 4 || name.length > 80) continue;
                if (/^(script|style|class|chunk|webpack|module|next-|__|data-)/.test(name)) continue;
                const lower = name.toLowerCase();
                if (seen.has(lower)) continue;
                seen.add(lower);
                models.push({ id: name, name: name });
            }
        } catch (e) {}
        return models;
    }

    getAvailableModels() { return this.models; }

    getInstanceList() {
        if (this.instanceInfos.length > 0) return this.instanceInfos;
        return this.pages.map((page, index) => ({
            id: index + 1, status: 'active', createdAt: new Date().toISOString()
        }));
    }

    async closeInstance(instanceId) {
        const idx = this.instanceInfos.findIndex(info => info.id === instanceId);
        if (idx === -1) throw new Error('实例不存在: #' + instanceId);
        const browser = this.browsers[idx];
        const page = this.pages[idx];
        if (page) try { await page.close(); } catch (e) {}
        if (browser) try { await browser.close(); } catch (e) {}
        this.browsers.splice(idx, 1);
        this.pages.splice(idx, 1);
        this.instanceInfos.splice(idx, 1);
        console.log(`[BrowserManager] Closed instance #${instanceId}, ${this.instanceInfos.length} remaining`);
        return { success: true, remaining: this.instanceInfos.length };
    }

    async close() {
        for (const browser of this.browsers) await browser.close();
        this.browsers = [];
        this.pages = [];
        this.instanceInfos = [];
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { BrowserManager };
