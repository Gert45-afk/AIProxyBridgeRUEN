const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // 配置
    getConfig: () => ipcRenderer.invoke('get-config'),
    updateConfig: (config) => ipcRenderer.invoke('update-config', config),

    // 服务控制
    startServices: () => ipcRenderer.invoke('start-services'),
    stopServices: () => ipcRenderer.invoke('stop-services'),

    // 模型管理
    getModels: () => ipcRenderer.invoke('get-models'),
    refreshModels: () => ipcRenderer.invoke('refresh-models'),
    testModel: (model, message) => ipcRenderer.invoke('test-model', model, message),

    // 浏览器实例
    createBrowserInstance: () => ipcRenderer.invoke('create-browser-instance'),
    closeBrowserInstance: (instanceId) => ipcRenderer.invoke('close-browser-instance', instanceId),
    getInstances: () => ipcRenderer.invoke('get-instances'),

    // WebSocket 客户端
    getWsClients: () => ipcRenderer.invoke('get-ws-clients'),
    refreshModelsWs: () => ipcRenderer.invoke('refresh-models-ws'),

    // 窗口控制
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),

    // 事件监听
    onServiceStatus: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('service-status', handler);
        return () => ipcRenderer.removeListener('service-status', handler);
    },
    onServiceError: (callback) => ipcRenderer.on('service-error', (e, err) => callback(err)),

    // 浏览器列表更新
    onBrowserListUpdate: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('browser-list-update', handler);
        return () => ipcRenderer.removeListener('browser-list-update', handler);
    },

    // WebSocket 客户端列表更新
    onWsClientListUpdate: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('ws-client-list-update', handler);
        return () => ipcRenderer.removeListener('ws-client-list-update', handler);
    },
    onModelListUpdate: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('model-list-update', handler);
        return () => ipcRenderer.removeListener('model-list-update', handler);
    },

    // 窗口状态变化
    onWindowStateChange: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('window-state-change', handler);
        return () => ipcRenderer.removeListener('window-state-change', handler);
    },

    // 导航指令
    onNavigateTab: (callback) => ipcRenderer.on('navigate-tab', (e, tabId) => callback(tabId)),
    onOpenHelp: (callback) => ipcRenderer.on('open-help', () => callback()),

    // 日志
    onLog: (callback) => ipcRenderer.on('log', (e, msg) => callback(msg)),

    // 请求劫持状态（等待用户在浏览器中发消息）
    onHijackStatus: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('hijack-status', handler);
        return () => ipcRenderer.removeListener('hijack-status', handler);
    }
});
