const puppeteer = require('puppeteer-core');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { execSync } = require('child_process');
const { ARENA_EXEC_SOURCE, runArenaEvalInPage, parseArenaModelsHTML } = require('./arena-client');

// Base directory for Chrome profiles.
// In the packaged Electron app __dirname points inside app.asar (not writable),
// so browser profiles must live in a real writable OS directory.
function getProfilesBaseDir() {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'browser-profiles');
    } catch (e) {
        return path.join(os.homedir(), '.aiproxybridge', 'browser-profiles');
    }
}

class BrowserManager {
    constructor() {
        this.browsers = [];
        this.pages = [];
        this.instanceInfos = [];
        this.currentPageIndex = 0;
        this.models = [];
        this.modelUuidMap = {};       // name/slug -> arena model UUID
        this.initialModelAId = '';
        this.headless = true;         // default: no browser windows (override via config)
        this.cookies = [];
        this.scriptsPath = path.join(__dirname, '../scripts');
        this.cachedChromePath = null;
        this._creatingInstance = null; // dedupe concurrent ensureInstance() calls
    }

    setOptions(opts) {
        if (opts && typeof opts.headless === 'boolean') this.headless = opts.headless;
    }

    async init(opts) {
        if (opts) this.setOptions(opts);
        this.profilesDir = getProfilesBaseDir();
        await fs.mkdir(this.profilesDir, { recursive: true });
        await this.loadStoredCookies();
        const chromePath = await this.findChromePath();
        if (!chromePath) {
            console.warn('[BrowserManager] Chrome/Edge was NOT found. Puppeteer instances are unavailable; the Tampermonkey WebSocket client path will still work.');
            return;
        }
        this.cachedChromePath = chromePath;
        console.log(`[BrowserManager] Using browser: ${chromePath}`);
        console.log('[BrowserManager] Initialization complete, waiting to create browser instances...');
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

    // Navigate to LMArena with retries (site may redirect lmarena.ai -> arena.ai,
    // first attempt can also fail on slow networks)
    async navigateToArena(page, timeout = 45000) {
        const targets = ['https://lmarena.ai/?mode=direct', 'https://arena.ai/?mode=direct'];
        for (let i = 0; i < 3; i++) {
            const url = targets[Math.min(i, targets.length - 1)];
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
                return true;
            } catch (e) {
                const cur = (typeof page.url === 'function') ? (page.url() || '') : '';
                if (cur.includes('arena.ai') || cur.includes('lmarena.ai')) return true;
                console.log(`[BrowserManager] Navigation to ${url} failed (attempt ${i + 1}/3): ${e.message}`);
                await sleep(1500);
            }
        }
        return false;
    }

    // ========== Arena request execution (in-page fetch = real streaming) ==========

    // Make sure the page is on arena.ai and run the evaluation inside it.
    // push(evt) receives {t, s, d} events — resolves when the stream ends.
    async executeArenaRequest(opts, push) {
        const inst = await this.ensureInstance();
        const page = inst.page;

        const currentUrl = page.url() || '';
        if (!currentUrl.includes('arena.ai') && !currentUrl.includes('lmarena.ai')) {
            console.log('[BrowserManager] Page not on arena.ai — navigating...');
            await this.navigateToArena(page, 30000);
            await sleep(1500);
        }

        // Wait for the arena executor (injected via evaluateOnNewDocument or on demand)
        let done = false;
        let resolved = false;
        const finish = () => { if (!resolved) { resolved = true; done = true; } };

        const wrappedPush = (evt) => {
            try {
                if (evt && evt.t === 'done') finish();
                push(evt);
            } catch (e) {}
        };

        // Watchdog: meta/retry events and stream data keep the request alive
        const WATCHDOG_MS = 120000; // 2 min without any event → give up
        let watchdog = setTimeout(() => {
            wrappedPush({ t: 'error', s: 'timeout', d: 'No events from the page for 120 seconds' });
            finish();
        }, WATCHDOG_MS);
        const petWatchdog = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                wrappedPush({ t: 'error', s: 'timeout', d: 'No events from the page for 120 seconds' });
                finish();
            }, WATCHDOG_MS);
        };
        const origPush = wrappedPush;
        const alivePush = (evt) => { petWatchdog(); origPush(evt); };

        await runArenaEvalInPage(page, opts, alivePush).catch((e) => {
            alivePush({ t: 'error', s: 'exec', d: e.message || String(e) });
            alivePush({ t: 'done', s: opts.mode || 'direct', d: { failed: true } });
        });
        clearTimeout(watchdog);
    }

    // Ensure at least one instance exists (lazy auto-create — used when cookies
    // are imported and the user never clicked "New Instance")
    async ensureInstance() {
        for (let i = 0; i < this.pages.length; i++) {
            const p = this.pages[i];
            try { if (!p.isClosed()) return { page: p, index: i }; } catch (e) {}
        }
        if (this._creatingInstance) return this._creatingInstance;
        this._creatingInstance = (async () => {
            try {
                console.log('[BrowserManager] No live instances — auto-creating a hidden one...');
                const inst = await this.createInstance();
                return { page: inst.page, index: this.pages.length - 1 };
            } finally {
                this._creatingInstance = null;
            }
        })();
        return this._creatingInstance;
    }

    // ========== Browser instance creation ==========

    async createInstance() {
        let chromePath = this.cachedChromePath;
        if (!chromePath) chromePath = await this.findChromePath();
        if (!chromePath) {
            throw new Error('Cannot create browser instance: no usable browser (Chrome/Edge) found.');
        }
        console.log(`[BrowserManager] Launching browser: ${chromePath} (headless: ${this.headless})`);

        const instanceProfileDir = path.join(this.profilesDir || getProfilesBaseDir(), 'browser-profile-' + (this.browsers.length + 1));
        await fs.mkdir(instanceProfileDir, { recursive: true });

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--user-data-dir=' + instanceProfileDir,
            '--disable-blink-features=AutomationControlled',
        ];

        const browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: !!this.headless,
            args: launchArgs,
            defaultViewport: this.headless ? { width: 1280, height: 900 } : null,
            ignoreDefaultArgs: ['--enable-automation', '--disable-infobars'],
            ignoreHTTPSErrors: true
        });

        browser.on('disconnected', () => {
            console.log('[BrowserManager] Browser disconnected (closed)');
            const idx = this.browsers.indexOf(browser);
            if (idx !== -1) {
                this.browsers.splice(idx, 1);
                this.pages.splice(idx, 1);
                const removed = this.instanceInfos.splice(idx, 1)[0];
                console.log(`[BrowserManager] Auto-removed instance #${removed?.id}, ${this.instanceInfos.length} remaining`);
            }
        });

        // Intercept chat.lmarena.ai redirect tabs
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

        // Get the initial page
        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();

        // Inject the anti-detection script + the arena executor
        await page.evaluateOnNewDocument(() => {
            try {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                    configurable: true
                });
                window.chrome = window.chrome || {};
                window.chrome.runtime = window.chrome.runtime || {};
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                    configurable: true
                });
            } catch (e) {}
        });
        await page.evaluateOnNewDocument(ARENA_EXEC_SOURCE).catch(() => {});

        // Apply stored session cookies so no manual login is needed
        const appliedCookies = await this.applyCookiesToPage(page);
        if (appliedCookies > 0) {
            console.log(`[BrowserManager] Applied ${appliedCookies} stored cookies to the new instance`);
        }

        // Navigate to LMArena (with retries; falls back to arena.ai)
        await this.navigateToArena(page, 45000);
        const landedUrl = page.url();
        if (!landedUrl || landedUrl.startsWith('about:')) {
            console.error('[BrowserManager] Page is still blank after navigation attempts — check your internet connection or VPN/proxy');
        } else {
            console.log(`[BrowserManager] Instance landed on: ${landedUrl}`);
        }

        const instanceInfo = {
            id: this.browsers.length + 1,
            status: 'active',
            createdAt: new Date().toISOString(),
            url: page.url(),
            headless: !!this.headless,
            browserPath: chromePath,
            browserType: chromePath.toLowerCase().includes('edge') ? 'edge' : 'chrome'
        };

        this.browsers.push(browser);
        this.pages.push(page);
        this.instanceInfos.push(instanceInfo);
        console.log(`[BrowserManager] Created instance #${instanceInfo.id}, URL: ${page.url()}`);
        return { browser, page, info: instanceInfo };
    }

    // ========== Session cookies (login bypass for browser instances) ==========
    getCookiesFile() {
        return path.join(this.profilesDir || getProfilesBaseDir(), 'cookies.json');
    }

    async loadStoredCookies() {
        try {
            const raw = await fs.readFile(this.getCookiesFile(), 'utf8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) this.cookies = arr;
        } catch (e) {}
    }

    _mapCookiesForPuppeteer(cookies) {
        const out = [];
        for (const c of cookies) {
            if (!c || !c.name || typeof c.value === 'undefined') continue;
            let domain = String(c.domain || '').trim() || 'arena.ai';
            if (!domain.endsWith('arena.ai') && !domain.endsWith('lmarena.ai')) continue;
            const mapped = {
                name: String(c.name),
                value: String(c.value).replace(/&amp;/g, '&'),
                domain,
                path: c.path || '/',
                httpOnly: !!c.httpOnly,
                secure: !!c.secure
            };
            if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
                mapped.expires = Math.floor(c.expirationDate);
            }
            const ss = String(c.sameSite || '').toLowerCase();
            if (ss === 'lax') mapped.sameSite = 'Lax';
            else if (ss === 'strict') mapped.sameSite = 'Strict';
            else if (ss === 'no_restriction' || ss === 'none') mapped.sameSite = 'None';
            out.push(mapped);
        }
        return out;
    }

    async applyCookiesToPage(page) {
        if (!this.cookies || this.cookies.length === 0) return 0;
        const mapped = this._mapCookiesForPuppeteer(this.cookies);
        if (mapped.length === 0) return 0;
        try {
            await page.setCookie(...mapped);
            return mapped.length;
        } catch (e) {
            console.log('[BrowserManager] setCookie note:', e.message);
            return 0;
        }
    }

    async importCookies(cookies) {
        if (!Array.isArray(cookies)) throw new Error('Expected a JSON array of cookies (EditThisCookie export)');
        const mapped = this._mapCookiesForPuppeteer(cookies);
        if (mapped.length === 0) {
            throw new Error('No usable arena.ai / lmarena.ai cookies found in the JSON');
        }
        this.cookies = cookies;
        try { await fs.writeFile(this.getCookiesFile(), JSON.stringify(cookies, null, 2), 'utf8'); } catch (e) {}
        let applied = 0;
        for (const page of this.pages) {
            try {
                await page.setCookie(...mapped);
                applied++;
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            } catch (e) {
                console.log('[BrowserManager] apply cookies note:', e.message);
            }
        }
        console.log(`[BrowserManager] Imported ${mapped.length} arena cookies, applied to ${applied} page(s)`);
        return { imported: mapped.length, appliedTo: applied };
    }

    getCookiesStatus() {
        return { count: (this.cookies || []).length };
    }

    // ========== Model list management ==========

    async updateModels() {
        if (this.pages.length === 0) {
            if (this.models.length === 0) this.models = this.getDefaultModels();
            return;
        }

        const page = this.pages[0];
        try {
            const pageUrl = page.url() || '';
            if (!pageUrl.includes('arena.ai') && !pageUrl.includes('lmarena.ai')) {
                if (this.models.length === 0) this.models = this.getDefaultModels();
                return;
            }

            // Method 1 (best): initialModels objects from RSC data — names, UUIDs and capabilities
            try {
                const html = await page.content();
                const parsed = parseArenaModelsHTML(html);
                if (parsed.models.length > 0) {
                    this.models = parsed.models;
                    Object.assign(this.modelUuidMap, parsed.uuidMap);
                    if (parsed.initialModelAId) this.initialModelAId = parsed.initialModelAId;
                    console.log(`[BrowserManager] Extracted ${parsed.models.length} models (${Object.keys(parsed.uuidMap).length} UUID mappings) from RSC data`);
                    return;
                }
            } catch (e) {}

            // Method 2: regex slug scan of the page HTML
            try {
                const html = await page.content();
                if (html && html.length > 1000) {
                    const parsedModels = this.parseModelsFromHTML(html);
                    if (parsedModels.length > 0) {
                        this.models = parsedModels;
                        console.log(`[BrowserManager] Extracted ${parsedModels.length} models from page HTML (slug scan)`);
                        return;
                    }
                }
            } catch (e) {}

            // Final fallback
            if (this.models.length === 0) this.models = this.getDefaultModels();
        } catch (error) {
            console.error('[BrowserManager] updateModels error:', error.message);
            if (this.models.length === 0) this.models = this.getDefaultModels();
        }
    }

    // Capabilities lookup (used to pick modality for image models)
    getModelCapabilities(modelId) {
        const m = (this.models || []).find(x =>
            x.id === modelId || x.name === modelId ||
            String(x.id).toLowerCase() === String(modelId).toLowerCase());
        return m ? { outputs: m.outputs || [], inputs: m.inputs || [] } : { outputs: [], inputs: [] };
    }

    getDefaultModels() {
        // Fallback list — shown until real data arrives from a client instance
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
            const modelPattern = /(?:"|'|`)(claude-[a-z0-9._\-]+|gpt-[a-z0-9._\-]+|chatgpt-[a-z0-9._\-]+|gpt-oss-[a-z0-9._\-]+|o[0-9]+(?:-[a-z0-9._\-]+)?|gemini-[a-z0-9._\-]+|gemma-[a-z0-9._\-]+|imagen-[a-z0-9._\-]+|veo-[a-z0-9._\-]+|nano-banana[a-z0-9._\-]*|llama-[a-z0-9._\-]+|meta-llama[a-z0-9._\-]*|deepseek-[a-z0-9._\-]+|qwen[a-z0-9._\-]*|qwq[a-z0-9._\-]*|mistral-[a-z0-9._\-]+|mixtral[a-z0-9._\-]*|pixtral[a-z0-9._\-]*|ministral[a-z0-9._\-]*|codestral[a-z0-9._\-]*|devstral[a-z0-9._\-]*|grok[a-z0-9._\-]*|glm-[a-z0-9._\-]+|chatglm[0-9][a-z0-9._\-]*|ernie-[a-z0-9._\-]+|kimi[a-z0-9._\-]*|moonshot-[a-z0-9._\-]+|phi-[a-z0-9._\-]+|phi[0-9][a-z0-9._\-]*|nova-[a-z0-9._\-]+|command-[a-z0-9._\-]+|c4ai-[a-z0-9._\-]+|aya-[a-z0-9._\-]+|jamba-[a-z0-9._\-]+|mercury-[a-z0-9._\-]*|hunyuan-[a-z0-9._\-]+|abab[0-9][a-z0-9._\-]*|minimax-[a-z0-9._\-]+|mimo-[a-z0-9._\-]+|step-[a-z0-9._\-]+|skywork-[a-z0-9._\-]+|seedream[a-z0-9._\-]*|wan[0-9][a-z0-9._\-]*|flux[a-z0-9._\-]*|ideogram[a-z0-9._\-]*|longcat-[a-z0-9._\-]+|dots[.-][a-z0-9._\-]+|solar-[a-z0-9._\-]+|lfm[a-z0-9._\-]*|exaone[a-z0-9._\-]*|trinity-[a-z0-9._\-]+|sonar-[a-z0-9._\-]+|rwkv[0-9][a-z0-9._\-]*|internlm[a-z0-9._\-]*|internvl[a-z0-9._\-]*|yi-[a-z0-9._\-]+|dall-e-[a-z0-9._\-]+|dbrx[a-z0-9._\-]*|vicuna-[a-z0-9._\-]+|pplx-[a-z0-9._\-]+|mpt-[a-z0-9._\-]+|reka-[a-z0-9._\-]+|nemotron[a-z0-9._\-]*|falcon[0-9][a-z0-9._\-]*|aurora[a-z0-9._\-]*|recraft[a-z0-9._\-]*|stable-[a-z0-9._\-]+|sdxl[a-z0-9._\-]*|mamba-[a-z0-9._\-]+|kat-[a-z0-9._\-]+|orion[a-z0-9._\-]*|lucy-[a-z0-9._\-]+|whisper-[a-z0-9._\-]+|tts-[a-z0-9._\-]+|bge-[a-z0-9._\-]+)(?:"|'|`)/gi;
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
        if (idx === -1) throw new Error('Instance does not exist: #' + instanceId);
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
