'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { DownloadManager } = require('./src/main/download-manager');

let mainWindow = null;
let manager = null;
let ipcRegistered = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 740,
    minHeight: 580,
    title: 'BlobDownloader · 视频下载工具',
    backgroundColor: '#12141c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  manager = new DownloadManager(mainWindow);
  registerIPC();

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    if (manager) manager.dispose();
    mainWindow = null;
    manager = null;
  });
}

function registerIPC() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('app:select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存目录',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('app:reveal-file', async (_event, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  });

  ipcMain.handle('webview:bind', (_event, id) => {
    manager.bindWebview(id);
    return true;
  });

  ipcMain.handle('webview:scan', async (_event, id) => {
    const target = webContents.fromId(id);
    if (!target || target.isDestroyed()) throw new Error('内置浏览器尚未就绪');
    const sources = await target.executeJavaScript(
      'window.videoCapture ? window.videoCapture.scanSources() : []'
    );
    if (sources && sources.length) return sources;
    // 扫不到时顺带取诊断信息，便于判断是加载时机、iframe 隔离还是 MSE
    try {
      const diag = await target.executeJavaScript(`(function () {
        var framesInfo = [];
        var videos = [];
        function walk(root, depth) {
          if (!root || depth > 4 || framesInfo.length >= 8) return;
          Array.prototype.forEach.call(root.querySelectorAll('iframe, frame'), function (f, i) {
            var cross = false;
            try { void f.contentDocument.documentElement; } catch (e) { cross = true; }
            framesInfo.push({ src: f.src || '', crossOrigin: cross, depth: depth });
            if (!cross) walk(f.contentDocument, depth + 1);
          });
          Array.prototype.forEach.call(root.querySelectorAll('video'), function (v) {
            videos.push({ src: v.src || '', currentSrc: v.currentSrc || '', readyState: v.readyState });
          });
          Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          });
        }
        walk(document, 0);
        return { videoCount: videos.length, videoStates: videos, frames: framesInfo };
      })()`);
      return { sources: [], diagnostic: diag };
    } catch (_err) {
      return { sources: [], diagnostic: null };
    }
  });

  ipcMain.on('webview:navigated', () => manager.notifyWebviewNavigated());

  // 把 guest 页面（含 ShadowRoot 与同域 iframe）的真实 DOM 结构 dump 出来
  ipcMain.handle('webview:inspect', async (_event, id) => {
    const target = webContents.fromId(id);
    if (!target || target.isDestroyed()) throw new Error('内置浏览器尚未就绪');
    return target.executeJavaScript(`(function () {
      var lines = [];
      function labelOf(el) {
        var s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string') {
          var c = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
          if (c) s += '.' + c;
        }
        return s;
      }
      function interesting(el) {
        var t = el.tagName;
        return t === 'VIDEO' || t === 'AUDIO' || t === 'SOURCE' || t === 'IFRAME' ||
          t === 'FRAME' || t === 'WEBVIEW' || !!el.shadowRoot;
      }
      function walk(root, indent, depth, tag) {
        if (!root || depth > 5 || lines.length > 240) return;
        var prefix = '  '.repeat(indent);
        lines.push(prefix + (tag ? '[' + tag + '] ' : '') + (root.nodeName || '#document'));
        var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var i = 0; i < all.length && lines.length < 240; i++) {
          var el = all[i];
          if (!interesting(el)) continue;
          var detail = '';
          if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
            detail = ' src=' + JSON.stringify(el.src || '') +
              ' currentSrc=' + JSON.stringify(el.currentSrc || '') +
              ' readyState=' + el.readyState;
          } else if (el.tagName === 'SOURCE') {
            detail = ' src=' + JSON.stringify(el.src || '');
          } else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
            detail = ' src=' + JSON.stringify(el.src || '');
            var cross = false;
            try { void el.contentDocument.documentElement; } catch (e) { cross = true; }
            detail += cross ? ' [跨域]' : ' [同域]';
          }
          lines.push(prefix + '  ' + labelOf(el) + detail);
          if (el.shadowRoot) walk(el.shadowRoot, indent + 2, depth + 1, 'shadowRoot');
          if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
            try { if (el.contentDocument) walk(el.contentDocument, indent + 2, depth + 1, 'iframe'); }
            catch (e) { lines.push(prefix + '    [无法读取跨域内容]'); }
          }
        }
      }
      walk(document, 0, 0, 'guest');
      return lines.join('\\n');
    })()`);
  });

  ipcMain.handle('download:create', (_event, options) => manager.create(options));
  ipcMain.handle('download:start', (_event, id) => manager.start(id));
  ipcMain.handle('download:pause', (_event, id) => manager.pause(id));
  ipcMain.handle('download:resume', (_event, id) => manager.resume(id));
  ipcMain.handle('download:cancel', (_event, id) => manager.cancel(id));

  ipcMain.on('blob:ready', (_event, payload) => manager.onBlobReady(payload));
  ipcMain.on('blob:chunk', (_event, payload) => manager.onBlobChunk(payload));
  ipcMain.on('blob:end', (_event, payload) => manager.onBlobEnd(payload));
  ipcMain.on('blob:error', (_event, payload) => manager.onBlobError(payload));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
