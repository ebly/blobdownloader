'use strict';

// 端到端验证：本地 sample.mp4 -> blob.html 生成 blob -> 内置浏览器扫描 -> 下载落盘 -> 字节比对
// 运行：env -u ELECTRON_RUN_AS_NODE npx electron verify-e2e.js [--revoke] [--pause]

const { app, BrowserWindow, ipcMain, webContents, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REVOKE = process.argv.includes('--revoke');
const PAUSE = process.argv.includes('--pause');
const ROOT = __dirname;
const SAMPLE = path.join(ROOT, 'testdata', 'sample.mp4');
const OUT = path.join(ROOT, 'testdata', 'out');
const PAGE = 'http://127.0.0.1:8765/blob.html' + (REVOKE ? '?revoke=1' : '');

const expected = fs.readFileSync(SAMPLE);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let win = null;
let manager = null;
let guestId = null;
const events = [];
let finished = false;

const log = (...a) => console.log('[E2E]', ...a);

function finish(ok, reason) {
  if (finished) return;
  finished = true;
  log('events:', events.map((e) => e.type + (e.state ? ':' + e.state : '')).join(' > '));
  log('RESULT:', ok ? 'OK' : 'FAIL', reason ? '- ' + reason : '');
  setTimeout(() => app.quit(), 200);
}

function registerIPC() {
  const handle = (channel, fn) => ipcMain.handle(channel, fn);
  handle('webview:bind', (_e, id) => { guestId = Number(id); return true; });
  handle('webview:scan', async () => {
    const guest = webContents.fromId(guestId);
    return guest.executeJavaScript('window.videoCapture ? window.videoCapture.scanSources() : []');
  });
  handle('download:create', (_e, opts) => manager.create(opts));
  handle('download:start', (_e, id) => manager.start(id));
  handle('download:pause', (_e, id) => manager.pause(id));
  handle('download:resume', (_e, id) => manager.resume(id));
  handle('download:cancel', (_e, id) => manager.cancel(id));

  ipcMain.on('blob:ready', (_e, p) => manager.onBlobReady(p));
  ipcMain.on('blob:chunk', (_e, p) => manager.onBlobChunk(p));
  ipcMain.on('blob:end', (_e, p) => manager.onBlobEnd(p));
  ipcMain.on('blob:error', (_e, p) => manager.onBlobError(p));
}

async function run() {
  const { DownloadManager } = require('./src/main/download-manager');

  // 固定端口，若上一次未释放则先不带验证直接失败提示
  win = new BrowserWindow({
    width: 700,
    height: 520,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: true
    }
  });

  manager = new DownloadManager(win);
  registerIPC();
  const origEmit = manager._emit.bind(manager);
  manager._emit = (id, payload) => {
    events.push(payload);
    if (payload.type === 'done') {
      const file = payload.filePath;
      const ok = fs.existsSync(file) && sha(fs.readFileSync(file)) === sha(expected);
      finish(ok, `${payload.size}/${expected.length} bytes, sha256 ${ok ? 'match' : 'MISMATCH'} -> ${file}`);
    } else if (payload.type === 'error') {
      finish(false, payload.message);
    }
    origEmit(id, payload);
  };

  let guestReadyResolve = null;
  const guestReady = new Promise((resolve) => { guestReadyResolve = resolve; });
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    guestId = contents.id;
    if (manager) manager.bindWebview(contents.id);
    log('guest created:', contents.id);
    contents.on('did-finish-load', () => {
      const url = contents.getURL();
      log('guest loaded:', url);
      if (url.indexOf('blob.html') !== -1 && guestReadyResolve) guestReadyResolve();
    });
  });

  await win.loadFile(path.join(ROOT, 'testdata', 'host.html'));
  await new Promise((r) => setTimeout(r, 300));

  await win.webContents.executeJavaScript(`
    (function () {
      var w = document.getElementById('guest');
      w.setAttribute('src', ${JSON.stringify(PAGE)});
      return true;
    })()
  `);
  await guestReady;

  // 等待页面 fetch -> createObjectURL 完成（轮询 __testBlobUrl）
  let blobUrl = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      blobUrl = await webContents.fromId(guestId).executeJavaScript('window.__testBlobUrl || null');
    } catch (_err) { /* ignore */ }
    if (blobUrl) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!blobUrl) return finish(false, '页面未生成 blob 地址');
  log('page blob:', blobUrl.slice(0, 60) + '...', REVOKE ? '(revoke mode)' : '');

  const sources = await webContents.fromId(guestId).executeJavaScript(
    'window.videoCapture ? window.videoCapture.scanSources() : []'
  );
  log('scanned sources:', JSON.stringify(sources));
  if (!sources.some((s) => s.url === blobUrl)) return finish(false, '扫描结果未包含页面 blob');

  fs.mkdirSync(OUT, { recursive: true });
  // --stale: 故意用一个已失效的旧 blob URL，验证自动回退到当前 video 源
  const staleUrl = blobUrl.replace(/-[0-9a-f-]+$/, '-00000000-0000-0000-0000-000000000000');
  const HTML_SOURCE = process.argv.includes('--html-source');
  const created = manager.create({
    url: HTML_SOURCE ? 'http://127.0.0.1:8765/blob.html'
      : process.argv.includes('--stale') ? staleUrl : blobUrl,
    dir: OUT,
    filename: 'e2e-blob' + (REVOKE ? '-revoke' : '') + (PAUSE ? '-pause' : ''),
    extension: process.env.E2E_EXT || 'mp4',
    policy: 'overwrite',
    blobFrom: 'webview'
  });
  log('created task:', created.id);
  await manager.start(created.id);

  if (PAUSE) {
    setTimeout(async () => {
      try { await manager.pause(created.id); log('paused'); } catch (_e) { /* ignore */ }
      setTimeout(async () => {
        try { await manager.resume(created.id); log('resumed'); } catch (_e) { /* ignore */ }
      }, 200);
    }, 120);
  }
}

app.whenReady().then(() => {
  run().catch((err) => finish(false, err && err.stack ? err.stack : String(err)));
  setTimeout(() => { if (!finished) finish(false, 'timeout 25s'); }, 25000);
});
