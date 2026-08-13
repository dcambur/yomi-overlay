const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  saveConfig: (next) => ipcRenderer.invoke('cfg:save', next),
  listWindows: () => ipcRenderer.invoke('cfg:windows'),
  close: () => ipcRenderer.send('cfg:close'),
});
