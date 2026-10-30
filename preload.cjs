const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('projectIO', Object.freeze({
  save: text => ipcRenderer.invoke('project:save', text),
}));
