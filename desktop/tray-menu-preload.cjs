const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cinnaTray', {
  state: () => ipcRenderer.invoke('guanxiang:tray-state'),
  layout: (value) => ipcRenderer.send('guanxiang:tray', 'layout', value),
  dismiss: (reason) => ipcRenderer.send('guanxiang:tray', 'dismiss', reason),
  command: (id) => ipcRenderer.send('guanxiang:tray', 'command', id),
  onRender: (callback) => ipcRenderer.on('guanxiang:tray-render', (_event, value) => callback(value)),
  onFocus: (callback) => ipcRenderer.on('guanxiang:tray-focus', () => callback()),
});
