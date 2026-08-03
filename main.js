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
    apiKey: '123456'
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
        await browserManager.init();  // init is idempotent (path caching, script injection, etc.)

        // If an old proxyServer still exists, make sure it is fully stopped first
        if (proxyServer) {
            try { await proxyServer.stop(); } catch (e) {}
            proxyServer = null;
            // Wait a moment for the OS to release the port
            await new Promise(r => setTimeout(r, 500));
        }

        proxyServer = new ProxyServer(CONFIG.httpPort, browserManager, CONFIG.apiKey);

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

// Test model: prefer sending through a WebSocket client, fall back to Puppeteer UI automation
ipcMain.handle('test-model', async (event, model, message) => {
    if (!proxyServer) throw new Error('Service is not running — start the service first');

    const requestId = randomUUID();
    const messages = [{ role: 'user', content: message || 'Hello, please introduce yourself in one sentence.' }];

    // Prefer a WebSocket client
    const wsClient = proxyServer.getNextWsClient();
    if (wsClient) {
        console.log('[Main] test-model via WS client → model:', model, '| client:', wsClient.info.id);
        return new Promise((resolve, reject) => {
            let fullContent = '';
            let error = null;
            let settled = false;

            function doResolve(val) { if (!settled) { settled = true; resolve(val); } }
            function doReject(err) { if (!settled) { settled = true; reject(err); } }

            // Register the response handler
            wsClient.activeRequests.set(requestId, (data) => {
                if (data && typeof data === 'object' && data.error) {
                    error = data.error;
                    wsClient.activeRequests.delete(requestId);
                    doReject(new Error(error));
                    return;
                }

                if (data === '[DONE]') {
                    wsClient.activeRequests.delete(requestId);
                    if (!fullContent.trim()) {
                        doReject(new Error('The model returned an empty response — make sure you are logged in to lmarena.ai and the model is available'));
                    } else {
                        doResolve({ content: fullContent, model });
                    }
                    return;
                }

                // Extract text from streamed data
                try {
                    // Try RSC format parsing first (compatible with older versions)
                    const text = proxyServer._extractTextFromLmarenaChunk(data);
                    if (text) {
                        fullContent += text;
                    } else if (typeof data === 'string' && data.length > 0) {
                        // Newer userscript versions send plain-text content directly
                        fullContent += data;
                    }
                } catch (e) {}
            });

            // Send simplified data — the userscript builds the correct Direct-mode request body
            try {
                let modelAId = model;  // Use the model name by default
                if (proxyServer.capturedModelData) {
                    const uuidMap = proxyServer.capturedModelData.uuidMap || {};
                    const nameMap = proxyServer.capturedModelData.nameMap || {};

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

                    // Fall back to initialModelAId
                    if (modelAId === model && proxyServer.capturedModelData.initialModelAId) {
                        modelAId = proxyServer.capturedModelData.initialModelAId;
                    }
                }

                wsClient.ws.send(JSON.stringify({
                    request_id: requestId,
                    data: {
                        model: model,
                        modelAId: modelAId,
                        content: message || 'Hello, please introduce yourself in one sentence.'
                    }
                }));
                console.log('[Main] test-model WS request sent, model:', model, 'modelAId:', modelAId);
            } catch (e) {
                wsClient.activeRequests.delete(requestId);
                doReject(new Error('WebSocket send failed: ' + e.message));
            }

            // 150-second timeout (waiting for the user to manually send a message in the browser to trigger the hijack)
            setTimeout(() => {
                if (!settled) {
                    wsClient.activeRequests.delete(requestId);
                    if (fullContent) {
                        doResolve({ content: fullContent + '\n[Response truncated]', model });
                    } else {
                        doReject(new Error('Request timed out (150 seconds) — press Enter on the lmarena.ai page to send the message'));
                    }
                }
            }, 150000);
        });
    }

    // Fall back to Puppeteer browser client mode
    if (!browserManager || browserManager.pages.length === 0) {
        throw new Error('No clients available — create a browser instance and log in to lmarena.ai first, or install the Tampermonkey script to connect a WebSocket client');
    }

    console.log('[Main] test-model via Puppeteer → model:', model, '| pages:', browserManager.pages.length);

    return new Promise((resolve, reject) => {
        let fullContent = '';
        let error = null;
        let settled = false;

        function doResolve(val) { if (!settled) { settled = true; resolve(val); } }
        function doReject(err)  { if (!settled) { settled = true; reject(err); } }

        try {
            browserManager.handleChatCompletion(requestId, model, messages, (chunk) => {
                if (chunk.error) {
                    error = chunk.error;
                    console.error('[Main] test-model chunk error:', error);
                } else if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                    const delta = chunk.choices[0].delta.content || '';
                    if (delta) fullContent += delta;
                }
            }).then(() => {
                console.log('[Main] test-model completed, fullContent length:', fullContent.length);
                if (error) doReject(new Error(error));
                else doResolve({ content: fullContent || '(The model returned an empty response)', model });
            }).catch((err) => {
                console.error('[Main] test-model promise rejected:', err.message);
                doReject(err);
            });
        } catch (e) {
            console.error('[Main] test-model sync error:', e.message);
            doReject(e);
        }

        // 90-second timeout
        setTimeout(() => {
            if (!settled) {
                if (fullContent) {
                    doResolve({ content: fullContent + '\n[Response truncated]', model });
                } else {
                    doReject(new Error('Request timed out (no response for 90 seconds) — make sure a browser instance is open and logged in to lmarena.ai'));
                }
            }
        }, 90000);
    });
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
