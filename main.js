const { app, BrowserWindow, ipcMain, Tray, Menu, shell, screen, dialog } = require('electron');
const path = require('path');
const { randomUUID } = require('crypto');
const { ProxyServer } = require('./src/proxy-server');
const { BrowserManager } = require('./src/browser-manager');

let mainWindow;
let tray;
let proxyServer;
// browserManager 已在服务控制区域声明，提升为模块级变量以支持跨重启保持实例
let isQuitting = false;

// 配置
const CONFIG = {
    httpPort: 61001,
    apiKey: '123456'
};

// ========== 应用菜单（中文） ==========
function createAppMenu() {
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '配置管理',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => mainWindow?.webContents.send('navigate-tab', 'config')
                },
                { type: 'separator' },
                {
                    label: '退出',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        isQuitting = true;
                        app.quit();
                    }
                }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
                { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
                { type: 'separator' },
                { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
                { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
                { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
                { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
            ]
        },
        {
            label: '视图',
            submenu: [
                { label: '重新加载', accelerator: 'F5', role: 'reload' },
                { label: '强制重载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
                { type: 'separator' },
                { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
                { type: 'separator' },
                { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
                { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
                { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
                { type: 'separator' },
                { label: '切换全屏', accelerator: 'F11', role: 'togglefullscreen' }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '使用指南',
                    click: () => mainWindow?.webContents.send('open-help')
                },
                { type: 'separator' },
                {
                    label: '关于 AI Proxy Bridge',
                    click: () => {
                        dialog?.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '关于',
                            message: 'AI Proxy Bridge',
                            detail: '版本 1.0.0\n\n通过 LMArena 提供免费 AI 模型代理服务'
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// ========== 创建窗口（无边框 + 全屏） ==========
function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    mainWindow = new BrowserWindow({
        x: 0,
        y: 0,
        width: width,
        height: height,
        frame: false,          // 无边框，自定义标题栏
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

    // 窗口最大化时通知渲染进程
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

// ========== 系统托盘 ==========
function createTray() {
    try {
        tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
        const contextMenu = Menu.buildFromTemplate([
            { label: '显示窗口', click: () => mainWindow?.show() },
            { label: '隐藏窗口', click: () => mainWindow?.hide() },
            { type: 'separator' },
            { label: '退出', click: () => { isQuitting = true; app.quit(); }}
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

// ========== 服务控制 ==========
// browserManager 提升为模块级变量，服务重启时保留浏览器实例
let browserManager = null;

async function startServices() {
    try {
        // 如果 browserManager 已存在，说明是重启（配置变更），复用已有实例
        if (!browserManager) {
            browserManager = new BrowserManager();
        }
        await browserManager.init();  // init 是幂等的（路径缓存、脚本注入等）

        // 如果旧的 proxyServer 还存在，先确保它完全停止
        if (proxyServer) {
            try { await proxyServer.stop(); } catch (e) {}
            proxyServer = null;
            // 等一小会儿让操作系统释放端口
            await new Promise(r => setTimeout(r, 500));
        }

        proxyServer = new ProxyServer(CONFIG.httpPort, browserManager, CONFIG.apiKey);

        // WebSocket 客户端连接/断开时通知渲染进程
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
            // 推送当前已有的浏览器实例列表
            mainWindow.webContents.send('browser-list-update', browserManager.getInstanceList());
            // 推送当前 WS 客户端列表
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
    // 注意：不再关闭 browserManager！浏览器实例保持运行
    // 只有应用退出时才关闭浏览器
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('service-status', { running: false });
    }
}

// ========== IPC 事件处理 ==========
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

// 刷新模型列表：主动触发 updateModels() 从页面重新提取
ipcMain.handle('refresh-models', async () => {
    if (!browserManager) throw new Error('浏览器管理器未初始化');
    await browserManager.updateModels();
    return browserManager.getAvailableModels();
});

// 获取当前实例列表
ipcMain.handle('get-instances', async () => {
    if (browserManager) return browserManager.getInstanceList();
    return [];
});

// 关闭浏览器实例
ipcMain.handle('close-browser-instance', async (event, instanceId) => {
    if (!browserManager) throw new Error('浏览器管理器未初始化');
    const result = await browserManager.closeInstance(instanceId);
    // 关闭后推送更新后的实例列表
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-list-update', browserManager.getInstanceList());
    }
    return result;
});

// 测试模型：优先通过 WebSocket 客户端发送请求，回退到 Puppeteer UI 操控
ipcMain.handle('test-model', async (event, model, message) => {
    if (!proxyServer) throw new Error('服务未启动，请先启动服务');

    const requestId = randomUUID();
    const messages = [{ role: 'user', content: message || '你好，请用一句话介绍自己。' }];

    // 优先使用 WebSocket 客户端
    const wsClient = proxyServer.getNextWsClient();
    if (wsClient) {
        console.log('[Main] test-model via WS client → model:', model, '| client:', wsClient.info.id);
        return new Promise((resolve, reject) => {
            let fullContent = '';
            let error = null;
            let settled = false;

            function doResolve(val) { if (!settled) { settled = true; resolve(val); } }
            function doReject(err) { if (!settled) { settled = true; reject(err); } }

            // 注册响应处理器
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
                        doReject(new Error('模型返回空响应 — 请确认已登录 lmarena.ai 且模型可用'));
                    } else {
                        doResolve({ content: fullContent, model });
                    }
                    return;
                }

                // 从流式数据中提取文本
                try {
                    // 优先尝试 RSC 格式解析（兼容旧版）
                    const text = proxyServer._extractTextFromLmarenaChunk(data);
                    if (text) {
                        fullContent += text;
                    } else if (typeof data === 'string' && data.length > 0) {
                        // 新版 userscript 直接发送纯文本内容
                        fullContent += data;
                    }
                } catch (e) {}
            });

            // 发送简化数据 — 油猴脚本会构建正确的 Direct 模式请求体
            try {
                let modelAId = model;  // 默认用模型名
                if (proxyServer.capturedModelData) {
                    const uuidMap = proxyServer.capturedModelData.uuidMap || {};
                    const nameMap = proxyServer.capturedModelData.nameMap || {};

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

                    // 回退到 initialModelAId
                    if (modelAId === model && proxyServer.capturedModelData.initialModelAId) {
                        modelAId = proxyServer.capturedModelData.initialModelAId;
                    }
                }

                wsClient.ws.send(JSON.stringify({
                    request_id: requestId,
                    data: {
                        model: model,
                        modelAId: modelAId,
                        content: message || '你好，请用一句话介绍自己。'
                    }
                }));
                console.log('[Main] test-model WS request sent, model:', model, 'modelAId:', modelAId);
            } catch (e) {
                wsClient.activeRequests.delete(requestId);
                doReject(new Error('WebSocket 发送失败: ' + e.message));
            }

            // 150秒超时（等待用户在浏览器中手动发消息触发劫持）
            setTimeout(() => {
                if (!settled) {
                    wsClient.activeRequests.delete(requestId);
                    if (fullContent) {
                        doResolve({ content: fullContent + '\n[响应截断]', model });
                    } else {
                        doReject(new Error('请求超时（150秒）— 请在 lmarena.ai 页面按 Enter 发送消息'));
                    }
                }
            }, 150000);
        });
    }

    // 回退到 Puppeteer 网页客户端模式
    if (!browserManager || browserManager.pages.length === 0) {
        throw new Error('没有可用的客户端 — 请先创建浏览器实例并登录 lmarena.ai，或安装油猴脚本连接 WebSocket 客户端');
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
                else doResolve({ content: fullContent || '(模型返回空响应)', model });
            }).catch((err) => {
                console.error('[Main] test-model promise rejected:', err.message);
                doReject(err);
            });
        } catch (e) {
            console.error('[Main] test-model sync error:', e.message);
            doReject(e);
        }

        // 90秒超时
        setTimeout(() => {
            if (!settled) {
                if (fullContent) {
                    doResolve({ content: fullContent + '\n[响应截断]', model });
                } else {
                    doReject(new Error('请求超时（90秒无响应）— 请确认浏览器实例已打开并登录 lmarena.ai'));
                }
            }
        }, 90000);
    });
});

ipcMain.handle('create-browser-instance', async () => {
    if (!browserManager) throw new Error('浏览器管理器未初始化');

    const instance = await browserManager.createInstance();

    // 创建后更新列表
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser-list-update', browserManager.getInstanceList());
        }
    }, 500);

    return instance;
});

ipcMain.handle('stop-services', () => stopServices());

ipcMain.handle('start-services', () => startServices());

// WebSocket 客户端列表
ipcMain.handle('get-ws-clients', async () => {
    if (proxyServer) return proxyServer.getWsClientList();
    return [];
});

// 刷新模型列表：通过 WS 客户端请求页面源码
ipcMain.handle('refresh-models-ws', async () => {
    if (proxyServer) proxyServer.broadcastCommand('send_page_source');
    return { sent: true };
});

// 窗口控制 IPC
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.hide(); // 最小化到系统托盘
});
ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});
ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.hide(); // 关闭按钮也隐藏到托盘
});

// ========== 生命周期 ==========
app.whenReady().then(() => {
    createAppMenu();   // 中文菜单
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
