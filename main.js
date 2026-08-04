const { app, BrowserWindow, ipcMain, Tray, Menu, shell, screen, dialog } = require('electron');
const path = require('path');
const { randomUUID } = require('crypto');
const { ProxyServer } = require('./src/proxy-server');
const { BrowserManager } = require('./src/browser-manager');

let mainWindow;
let tray;
let proxyServer;
// browserManager is declared in the service control section below and promoted to
// module level so browser instances survive service restarts
let isQuitting = false;

// Configuration
const CONFIG = {
    httpPort: 61001,
    apiKey: '123456',
    headless: true,          // hidden browser instances (no window pops up)
    defaultMode: 'direct'    // default arena chat mode: direct | battle | side-by-side | agent
};

// ========== Application menu ==========
function createAppMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Configuration',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => mainWindow?.webContents.send('navigate-tab', 'config')
                },
                { type: 'separator' },
                {
                    label: 'Quit',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        isQuitting = true;
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
                { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
                { type: 'separator' },
                { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
                { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
                { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
                { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { label: 'Reload', accelerator: 'F5', role: 'reload' },
                { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
                { type: 'separator' },
                { label: 'Developer Tools', accelerator: 'F12', role: 'toggleDevTools' },
                { type: 'separator' },
                { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
                { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
                { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
                { type: 'separator' },
                { label: 'Toggle Full Screen', accelerator: 'F11', role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'User Guide',
                    click: () => mainWindow?.webContents.send('open-help')
                },
                { type: 'separator' },
                {
                    label: 'About AI Proxy Bridge',
                    click: () => {
                        dialog?.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'About',
                            message: 'AI Proxy Bridge',
                            detail: 'Version 1.0.0\n\nFree AI model proxy service powered by LMArena'
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// ========== Create window (frameless + fullscreen) ==========
function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    mainWindow = new BrowserWindow({
        x: 0,
        y: 0,
        width: width,
        height: height,
        frame: false,          // frameless window with a custom title bar
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 10, y: 8 },
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'build', 'icon.png'),
        title: 'AI Proxy Bridge',
        show: false,
        backgroundColor: '#f5f6f7'
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Notify the renderer when the window is maximized
    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('window-state-change', { maximized: true });
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('window-state-change', { maximized: false });
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

// ========== System tray ==========
function createTray() {
    try {
        tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show Window', click: () => mainWindow?.show() },
            { label: 'Hide Window', click: () => mainWindow?.hide() },
            { type: 'separator' },
            { label: 'Quit', click: () => { isQuitting = true; app.quit(); }}
        ]);
        tray.setToolTip('AI Proxy Bridge');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            mainWindow?.isVisible() ? mainWindow.hide() : mainWindow.show();
        });
    } catch (e) {
        console.log('[Tray] Icon not found, skipping tray creation:', e.message);
    }
}

// ========== Service control ==========
// browserManager is module-level so browser instances survive service restarts
let browserManager = null;

async function startServices() {
    try {
        // If browserManager already exists, this is a restart (config change) — reuse existing instances
        if (!browserManager) {
            browserManager = new BrowserManager();
        }
        await browserManager.init({ headless: CONFIG.headless });  // init is idempotent (path caching, script injection, etc.)

        // If an old proxyServer still exists, make sure it is fully stopped first
        if (proxyServer) {
            try { await proxyServer.stop(); } catch (e) {}
            proxyServer = null;
            // Wait a moment for the OS to release the port
            await new Promise(r => setTimeout(r, 500));
        }

        proxyServer = new ProxyServer(CONFIG.httpPort, browserManager, CONFIG.apiKey, { defaultMode: CONFIG.defaultMode });

        // Notify the renderer when a WebSocket client connects/disconnects
        proxyServer.onWsClientChange = (clientList) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ws-client-list-update', clientList);
            }
        };

        proxyServer.onModelUpdate = (models) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('model-list-update', models);
                console.log(`[Main] Model list updated from WS client: ${models.length} models`);
            }
        };

        proxyServer.onStatus = (statusData) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('hijack-status', statusData);
            }
        };

        proxyServer.onDiagnostics = (diagData) => {
            console.log(`[Main] Diagnostics:`, JSON.stringify(diagData));
        };

        await proxyServer.start();

        console.log(`[Main] HTTP+WS Proxy on port ${CONFIG.httpPort}`);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('service-status', { running: true, port: CONFIG.httpPort });
            // Push the current browser instance list
            mainWindow.webContents.send('browser-list-update', browserManager.getInstanceList());
            // Push the current WS client list
            mainWindow.webContents.send('ws-client-list-update', proxyServer.getWsClientList());
        }
    } catch (error) {
        console.error('[Main] Start failed:', error);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('service-error', error.message);
        }
    }
}

async function stopServices() {
    if (proxyServer) await proxyServer.stop();
    // Note: browserManager is NOT closed! Browser instances keep running.
    // Browsers are closed only when the app exits.
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('service-status', { running: false });
    }
}

// ========== IPC event handlers ==========
ipcMain.handle('get-config', () => CONFIG);

ipcMain.handle('update-config', (event, newConfig) => {
    Object.assign(CONFIG, newConfig);
    // Apply hot-reloadable options without a full restart
    try { browserManager && browserManager.setOptions({ headless: CONFIG.headless }); } catch (e) {}
    try { proxyServer && proxyServer.setOptions({ defaultMode: CONFIG.defaultMode }); } catch (e) {}
    stopServices().then(() => startServices());
    return CONFIG;
});

ipcMain.handle('get-models', async () => {
    if (browserManager) return browserManager.getAvailableModels();
    return [];
});

// Refresh model list: actively trigger updateModels() to re-extract from the page
ipcMain.handle('refresh-models', async () => {
    if (!browserManager) throw new Error('Browser manager is not initialized');
    await browserManager.updateModels();
    return browserManager.getAvailableModels();
});

// Get the current instance list
ipcMain.handle('get-instances', async () => {
    if (browserManager) return browserManager.getInstanceList();
    return [];
});

// Close a browser instance
ipcMain.handle('close-browser-instance', async (event, instanceId) => {
    if (!browserManager) throw new Error('Browser manager is not initialized');
    const result = await browserManager.closeInstance(instanceId);
    // Push the updated instance list after closing
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-list-update', browserManager.getInstanceList());
    }
    return result;
});

// Test model: run through the unified completion pipeline (WS userscript first,
// then the hidden Puppeteer instance). Returns { content, reasoning, model }.
ipcMain.handle('test-model', async (event, model, message) => {
    if (!proxyServer) throw new Error('Service is not running — start the service first');

    const rawModel = String(model || '');
    const spec = proxyServer.parseModelSpec(rawModel.replace(/~test$/, ''), {});
    spec.content = message || 'Hello, please introduce yourself in one sentence.';

    console.log('[Main] test-model → model:', spec.modelA, '| mode:', spec.mode);

    const sink = await proxyServer.collectCompletion(spec);

    if (sink.error) {
        throw new Error(sink.error);
    }
    if (!sink.content.trim() && !sink.reasoning.trim()) {
        throw new Error('The model returned an empty response — update the Tampermonkey script, or log in a hidden instance by importing session cookies');
    }
    return { content: sink.content, reasoning: sink.reasoning, model: spec.modelA, mode: spec.mode };
});

ipcMain.handle('create-browser-instance', async () => {
    if (!browserManager) throw new Error('Browser manager is not initialized');

    const instance = await browserManager.createInstance();

    // Update the list after creation
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser-list-update', browserManager.getInstanceList());
        }
    }, 500);

    return instance;
});

// Session cookies import (EditThisCookie JSON array — stored locally, applied to instances)
ipcMain.handle('import-cookies', async (event, jsonText) => {
    if (!browserManager) throw new Error('Service is not running — start the service first');
    let parsed;
    try {
        parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    } catch (e) {
        throw new Error('Invalid JSON: ' + e.message + ' — re-export the cookies fully (the text must end with }] )');
    }
    return browserManager.importCookies(parsed);
});

ipcMain.handle('get-cookies-status', async () => {
    if (browserManager) return browserManager.getCookiesStatus();
    return { count: 0 };
});

ipcMain.handle('stop-services', () => stopServices());

ipcMain.handle('start-services', () => startServices());

// WebSocket client list
ipcMain.handle('get-ws-clients', async () => {
    if (proxyServer) return proxyServer.getWsClientList();
    return [];
});

// Refresh model list: request the page source via a WS client
ipcMain.handle('refresh-models-ws', async () => {
    if (proxyServer) proxyServer.broadcastCommand('send_page_source');
    return { sent: true };
});

// Window control IPC
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.hide(); // minimize to system tray
});
ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});
ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.hide(); // the close button also hides to the tray
});

// ========== Lifecycle ==========
app.whenReady().then(() => {
    createAppMenu();
    createWindow();
    createTray();
    startServices();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    isQuitting = true;
    stopServices();
});

app.setAsDefaultProtocolClient('aiproxybridge');
