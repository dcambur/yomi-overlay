const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  saveConfig: (next) => ipcRenderer.invoke('cfg:save', next),
  // Both applied immediately, without restarting the overlay — see ipc.js.
  saveTrigger: (next) => ipcRenderer.invoke('cfg:trigger', next),
  saveDictionaries: (list) => ipcRenderer.invoke('cfg:dictionaries', list),
  listWindows: () => ipcRenderer.invoke('cfg:windows'),
  close: () => ipcRenderer.send('cfg:close'),

  // Dictionaries. Everything that changes what is installed goes through the
  // main process, because it owns the index the overlay reads.
  dictCatalogue: () => ipcRenderer.invoke('dict:catalogue'),
  dictInstalled: () => ipcRenderer.invoke('dict:installed'),
  dictDownload: (id) => ipcRenderer.invoke('dict:download', id),
  // The window names the job so its progress can be told apart from another
  // import queued behind it.
  dictImport: (job) => ipcRenderer.invoke('dict:import', job),
  dictRemove: (file) => ipcRenderer.invoke('dict:remove', file),
  onDictProgress: (fn) => ipcRenderer.on('dict:progress', (_e, p) => fn(p)),
});
