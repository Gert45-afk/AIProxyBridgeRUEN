const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Configuration
    getConfig: () => ipcRenderer.invoke('get-config'),
    updateConfig: (config) => ipcRenderer.invoke('update-config', config),

    // Service control
    startServices: () => ipcRenderer.invoke('start-services'),
    stopServices: () => ipcRenderer.invoke('stop-services'),

    // Model management
    getModels: () => ipcRenderer.invoke('get-models'),
    refreshModels: () => ipcRenderer.invoke('refresh-models'),
    testModel: (model, message) => ipcRenderer.invoke('test-model', model, message),

    // Browser instances
    createBrowserInstance: () => ipcRenderer.invoke('create-browser-instance'),
    closeBrowserInstance: (instanceId) => ipcRenderer.invoke('close-browser-instance', instanceId),
    getInstances: () => ipcRenderer.invoke('get-instances'),

    // WebSocket clients
    getWsClients: () => ipcRenderer.invoke('get-ws-clients'),
    refreshModelsWs: () => ipcRenderer.invoke('refresh-models-ws'),

    // Window controls
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),

    // Event listeners
    onServiceStatus: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('service-status', handler);
        return () => ipcRenderer.removeListener('service-status', handler);
    },
    onServiceError: (callback) => ipcRenderer.on('service-error', (e, err) => callback(err)),

    // Browser list updates
    onBrowserListUpdate: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('browser-list-update', handler);
        return () => ipcRenderer.removeListener('browser-list-update', handler);
    },

    // WebSocket client list updates
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

    // Window state changes
    onWindowStateChange: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('window-state-change', handler);
        return () => ipcRenderer.removeListener('window-state-change', handler);
    },

    // Navigation commands
    onNavigateTab: (callback) => ipcRenderer.on('navigate-tab', (e, tabId) => callback(tabId)),
    onOpenHelp: (callback) => ipcRenderer.on('open-help', () => callback()),

    // Logs
    onLog: (callback) => ipcRenderer.on('log', (e, msg) => callback(msg)),

    // Request hijack status (waiting for the user to send a message in the browser)
    onHijackStatus: (callback) => {
        const handler = (e, data) => callback(data);
        ipcRenderer.on('hijack-status', handler);
        return () => ipcRenderer.removeListener('hijack-status', handler);
    }
});
