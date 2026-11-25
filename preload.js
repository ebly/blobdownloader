'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blobDownloaderApi', {
  selectDirectory: () => ipcRenderer.invoke('app:select-directory'),
  revealFile: (filePath) => ipcRenderer.invoke('app:reveal-file', filePath),

  bindWebview: (id) => ipcRenderer.invoke('webview:bind', id),
  scanWebview: (id) => ipcRenderer.invoke('webview:scan', id),
  inspectWebview: (id) => ipcRenderer.invoke('webview:inspect', id),
  notifyWebviewNavigated: () => ipcRenderer.send('webview:navigated'),

  createDownload: (options) => ipcRenderer.invoke('download:create', options),
  startDownload: (id) => ipcRenderer.invoke('download:start', id),
  pauseDownload: (id) => ipcRenderer.invoke('download:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('download:resume', id),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', id),

  onDownloadEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('download:event', listener);
    return () => ipcRenderer.removeListener('download:event', listener);
  },

  onBlobCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('blob:command', listener);
    return () => ipcRenderer.removeListener('blob:command', listener);
  },

  blobReady: (id, total) => ipcRenderer.send('blob:ready', { id, total }),
  blobChunk: (id, chunk) => ipcRenderer.send('blob:chunk', { id, chunk }),
  blobEnd: (id, total) => ipcRenderer.send('blob:end', { id, total }),
  blobError: (id, message) => ipcRenderer.send('blob:error', { id, message })
});
