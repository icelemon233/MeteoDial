'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('guanxiang', {
  read: () => ipcRenderer.invoke('guanxiang:read'),
  save: (patch) => ipcRenderer.invoke('guanxiang:save', patch),
  quit: () => ipcRenderer.invoke('guanxiang:quit'),
  hide: () => ipcRenderer.invoke('guanxiang:hide'),
  locate: () => ipcRenderer.invoke('guanxiang:locate'),
});
