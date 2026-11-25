'use strict';

const bridge = window.blobDownloaderApi;
if (!bridge) {
  const banner = document.createElement('div');
  banner.style.cssText = 'padding:10px 16px;background:#7a4a00;color:#ffd9a0;font-size:12px;text-align:center';
  banner.textContent = '当前是静态 HTML 预览，按钮不可用。请在 Electron 窗口中运行 npm start。';
  document.body.insertBefore(banner, document.body.firstChild);
}
const api = bridge || new Proxy({}, { get: () => () => {} });

const $ = (id) => document.getElementById(id);
const els = {
  dir: $('dirInput'),
  name: $('nameInput'),
  ext: $('extInput'),
  policy: $('policySelect'),
  targetHint: $('targetHint'),
  selectDir: $('selectDirBtn'),
  pageUrl: $('pageUrlInput'),
  openPage: $('openPageBtn'),
  scan: $('scanBtn'),
  inspect: $('inspectBtn'),
  inspectBox: $('inspectBox'),
  webview: $('videoWebView'),
  sourceList: $('sourceList'),
  sourceCount: $('sourceCount'),
  selectAll: $('selectAllSources'),
  downloadSelected: $('downloadSelectedBtn'),
  url: $('urlInput'),
  start: $('startBtn'),
  taskList: $('taskList'),
  taskEmpty: $('taskEmpty'),
  log: $('logBox'),
  toasts: $('toastStack'),
  badge: $('engineBadge')
};

let webviewId = null;
let blobFrom = 'renderer';
let lastProgress = { downloaded: 0, total: null, speed: 0 };
const tasks = new Map(); // id -> { id, url, filePath, state, els }
const blobStreams = new Map();

/* ------------------------------ 工具函数 ------------------------------ */

function formatBytes(bytes) {
  if (bytes == null || !isFinite(bytes)) return '--';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
}

function formatSpeed(bytesPerSec) {
  return bytesPerSec > 0 ? formatBytes(bytesPerSec) + '/s' : '0 B/s';
}

function formatEta(remaining, speed) {
  if (!remaining || !speed || speed <= 0) return '--';
  const seconds = Math.ceil(remaining / speed);
  if (seconds < 60) return seconds + ' 秒';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
  return Math.floor(seconds / 3600) + ' 时 ' + Math.floor((seconds % 3600) / 60) + ' 分';
}

function log(message, level = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (level ? ' ' + level : '');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.innerHTML = `<span class="log-time">[${time}]</span>${escapeHtml(message)}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function toast(title, message, level = '') {
  const box = document.createElement('div');
  box.className = 'toast' + (level ? ' ' + level : '');
  box.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>` +
    (message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : '');
  els.toasts.appendChild(box);
  setTimeout(() => box.remove(), 5000);
}

function updateBadge() {
  const list = [...tasks.values()];
  const active = list.filter((t) => t.state === 'downloading' || t.state === 'pausing').length;
  const done = list.filter((t) => t.state === 'completed').length;
  const failed = list.filter((t) => t.state === 'error').length;
  if (active) els.badge.textContent = `下载中 ${active}`;
  else if (failed) els.badge.textContent = `${failed} 个失败`;
  else if (done) els.badge.textContent = `${done} 个完成`;
  else els.badge.textContent = '就绪';
}

function updateTargetHint() {
  const dir = els.dir.value.trim();
  const name = els.name.value.trim() || 'video';
  let ext = els.ext.value.trim() || '.mp4';
  if (!ext.startsWith('.')) ext = '.' + ext;
  els.targetHint.textContent = dir
    ? `保存位置：${dir} / ${name}*${ext}（多任务自动加序号，重名再处理）`
    : '最终路径：尚未选择目录';
}

/* ------------------------------ 保存目录 ------------------------------ */

els.selectDir.addEventListener('click', async () => {
  const dir = await api.selectDirectory();
  if (!dir) return;
  els.dir.value = dir;
  if (!els.name.value.trim()) {
    els.name.value = 'video-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  updateTargetHint();
  log(`保存目录：${dir}`);
});

['name', 'ext'].forEach((key) => els[key].addEventListener('input', updateTargetHint));

/* ---------------------------- 内置浏览器 / Blob ---------------------------- */

function bindWebview() {
  try {
    const id = els.webview.getWebContentsId();
    if (id && id !== webviewId) {
      webviewId = id;
      api.bindWebview(id);
      log(`内置浏览器已就绪（webContents ${id}）`);
    }
  } catch (_err) {
    // webview 尚未挂载，等待下一次事件
  }
}

els.webview.addEventListener('did-attach', bindWebview);
els.webview.addEventListener('did-navigate', () => {
  bindWebview();
  clearSources();
  els.inspectBox.hidden = true;
  api.notifyWebviewNavigated();
  log('页面已跳转，扫描结果已清空', 'warn');
});
els.webview.addEventListener('did-finish-load', () => {
  bindWebview();
  log('视频页面加载完成，可点击“扫描视频源”');
});

function isValidPageUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    if (!host || host === 'undefined' || host === 'null') return false;
    if (host !== 'localhost' && !host.includes('.')) return false;
    return true;
  } catch (_err) {
    return false;
  }
}

els.webview.addEventListener('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
  if (errorCode === -3 || !isMainFrame) return;
  log(`页面加载失败（${errorCode}）：${errorDescription} · ${validatedURL}`, 'error');
  toast('页面加载失败', errorDescription || '地址不可达或域名无效', 'error');
});

els.openPage.addEventListener('click', () => {
  const target = els.pageUrl.value.trim();
  if (!isValidPageUrl(target)) {
    toast('地址无效', '域名无效（如 undefined），请重新复制完整页面地址', 'error');
    return;
  }
  const busy = [...tasks.values()].some((t) => t.state === 'downloading' || t.state === 'paused');
  if (busy) {
    toast('请先停止下载', '页面跳转会使正在进行的 Blob 下载失效', 'warn');
    return;
  }
  clearSources();
  log('正在打开视频页面：' + target);
  els.webview.setAttribute('src', target);
});

function clearSources() {
  els.sourceList.innerHTML = '';
  els.sourceCount.textContent = '未扫描';
}

let scannedSources = [];

els.scan.addEventListener('click', async () => {
  bindWebview();
  if (!webviewId) { toast('浏览器未就绪', '请先打开视频页面', 'error'); return; }
  try {
    const result = await api.scanWebview(webviewId);
    const sources = Array.isArray(result) ? result : (result && result.sources) || [];
    if (!sources.length) {
      const diag = result && result.diagnostic;
      let hint = '请等待页面加载并开始播放后重试';
      if (diag) {
        if (diag.videoCount > 0 && (!diag.videoStates || diag.videoStates.every((v) => !v.src && !v.currentSrc))) {
          hint = '页面有 video 但还没有 src，通常是 HLS/MediaSource 动态流，请播放后重试';
        } else if (diag.frames && diag.frames.some((f) => f.crossOrigin)) {
          hint = '播放器在跨域 iframe 中，受浏览器隔离无法直接读取；请改用视频直链';
        } else if (diag.frames && diag.frames.length) {
          hint = '播放器可能在 iframe 中，请等视频播放后重试';
        }
      }
      log('未扫描到视频源：' + hint, 'warn');
      toast('未发现视频源', hint, 'warn');
      return;
    }
    scannedSources = sources;
    renderSources(sources);
    els.sourceCount.textContent = `共 ${sources.length} 个源，已全选`;
    log(`扫描到 ${sources.length} 个候选视频源，已全部勾选`);
  } catch (err) {
    toast('扫描失败', err.message, 'error');
    log('扫描失败：' + err.message, 'error');
  }
});

els.inspect.addEventListener('click', async () => {
  if (!webviewId) { toast('浏览器未就绪', '请先打开视频页面', 'error'); return; }
  try {
    const tree = await api.inspectWebview(webviewId);
    els.inspectBox.textContent = tree || '(空)';
    els.inspectBox.hidden = false;
    log('已导出 guest 页面 DOM 结构');
  } catch (err) {
    toast('导出失败', err.message, 'error');
  }
});

function renderSources(sources) {
  els.sourceList.innerHTML = '';
  const counters = { blob: 0, http: 0, hls: 0 };
  sources.forEach((source) => {
    const isBlob = source.url.toLowerCase().startsWith('blob:');
    const isHls = /\.m3u8(\?|$)/i.test(source.url);
    const type = isBlob ? 'blob' : (isHls ? 'hls' : 'http');
    counters[type] = (counters[type] || 0) + 1;

    const item = document.createElement('label');
    item.className = 'source-item';
    item.title = source.url;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !source.unusable; // 标记为不可用的伪源默认不勾选
    check.className = 'source-check';

    const url = document.createElement('span');
    url.className = 'source-url';
    url.textContent = source.url;
    url.title = source.url;

    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = (isBlob ? 'BLOB' : isHls ? 'HLS' : 'HTTP') + ' ' + counters[type];

    const label = document.createElement('span');
    label.className = 'source-label' + (source.unusable ? ' source-unusable' : '');
    label.textContent = source.label || (isBlob ? 'Blob 视频源' : '视频直链');

    // 顺序：复选框 → src 路径 → 类型徽章 → 标签
    item.append(check, url, badge, label);
    els.sourceList.appendChild(item);
  });
  els.selectAll.checked = sources.length > 0;
}

els.selectAll.addEventListener('change', () => {
  const checks = els.sourceList.querySelectorAll('.source-check');
  checks.forEach((c) => { c.checked = els.selectAll.checked; });
  const n = [...checks].filter((c) => c.checked).length;
  els.sourceCount.textContent = scannedSources.length ? `共 ${scannedSources.length} 个源，已选 ${n} 个` : '未扫描';
});

els.sourceList.addEventListener('change', () => {
  const checks = els.sourceList.querySelectorAll('.source-check');
  const n = [...checks].filter((c) => c.checked).length;
  els.selectAll.checked = checks.length > 0 && n === checks.length;
  els.sourceCount.textContent = scannedSources.length ? `共 ${scannedSources.length} 个源，已选 ${n} 个` : '未扫描';
});

/* ------------------------------ 任务创建 ------------------------------ */

function guessName(url) {
  if (!/^https?:/i.test(url)) return null;
  try {
    const path = new URL(url).pathname;
    const file = decodeURIComponent(path.split('/').pop() || '');
    const match = /^(.+?)(\.[a-z0-9]{2,5})$/i.exec(file);
    return match ? { name: match[1], ext: match[2] } : null;
  } catch (_err) {
    return null;
  }
}

function createTaskRow(task) {
  if (els.taskEmpty) els.taskEmpty.hidden = true;
  const row = document.createElement('div');
  row.className = 'task-row';

  const head = document.createElement('div');
  head.className = 'task-head';
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const badge = document.createElement('span');
  badge.className = 'source-badge';
  badge.textContent = task.isHls ? 'HLS' : task.sourceType === 'blob' ? 'BLOB' : 'HTTP';
  const urlText = document.createElement('span');
  urlText.className = 'task-url';
  urlText.textContent = task.url.slice(0, 90);
  urlText.title = task.url;
  const state = document.createElement('span');
  state.className = 'task-state';
  state.textContent = '创建中';
  head.append(dot, badge, urlText, state);

  const bar = document.createElement('div');
  bar.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  bar.appendChild(fill);

  const meta = document.createElement('div');
  meta.className = 'stats task-meta';
  const mk = (label, key) => {
    const cell = document.createElement('div');
    const l = document.createElement('span');
    l.className = 'stat-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'stat-value';
    v.textContent = '--';
    cell.append(l, v);
    meta.appendChild(cell);
    return v;
  };
  const downloaded = mk('已下载', 'downloaded');
  const total = mk('总大小', 'total');
  const speed = mk('速度', 'speed');
  const eta = mk('预计剩余', 'eta');

  const foot = document.createElement('div');
  foot.className = 'task-foot';
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'btn btn-ghost btn-sm';
  pause.textContent = '暂停';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost btn-sm';
  cancel.textContent = '取消';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'link-btn';
  reveal.textContent = '在文件夹中显示';
  reveal.hidden = true;
  const pathText = document.createElement('span');
  pathText.className = 'task-path';
  pathText.textContent = '';
  foot.append(pause, cancel, reveal, pathText);

  row.append(head, bar, meta, foot);
  els.taskList.appendChild(row);

  task.els = { row, dot, badge, state, fill, downloaded, total, speed, eta, pause, cancel, reveal, pathText };
  pause.addEventListener('click', async () => {
    try {
      if (task.state === 'paused') await api.resumeDownload(task.id);
      else await api.pauseDownload(task.id);
    } catch (err) { toast('操作失败', err.message, 'error'); }
  });
  cancel.addEventListener('click', async () => {
    try { await api.cancelDownload(task.id); }
    catch (err) { toast('取消失败', err.message, 'error'); }
  });
  reveal.addEventListener('click', async () => {
    if (task.filePath) await api.revealFile(task.filePath);
  });
}

const STATE_LABELS = {
  created: '等待中', downloading: '下载中', pausing: '暂停中', paused: '已暂停',
  cancelling: '取消中', cancelled: '已取消', completed: '完成', error: '失败'
};

function setTaskState(task, state, message) {
  task.state = state;
  if (!task.els) return;
  const e = task.els;
  e.state.textContent = message || STATE_LABELS[state] || state;
  e.dot.className = 'status-dot ' + ({
    downloading: 'running', pausing: 'running', paused: 'paused',
    completed: 'done', error: 'error'
  }[state] || '');
  e.fill.className = 'progress-fill' + (state === 'completed' ? ' done' : state === 'error' ? ' error' : '');
  const active = state === 'downloading' || state === 'pausing';
  e.pause.disabled = !(active || state === 'paused');
  e.pause.textContent = state === 'paused' ? '继续' : '暂停';
  e.cancel.disabled = !(active || state === 'paused' || state === 'error');
  updateBadge();
}

function renderTaskProgress(task, downloaded, total, speed) {
  if (!task.els) return;
  const e = task.els;
  const percent = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
  e.fill.style.width = percent + '%';
  e.state.textContent = total ? percent.toFixed(1) + '%' : STATE_LABELS[task.state] || '';
  e.downloaded.textContent = formatBytes(downloaded);
  e.total.textContent = total ? formatBytes(total) : '--';
  e.speed.textContent = formatSpeed(speed);
  e.eta.textContent = total && speed > 0 ? formatEta(Math.max(0, total - downloaded), speed) : '--';
}

async function startTask({ url, sourceType, sourceName, fromWebview, isHls }) {
  if (!els.dir.value.trim()) { toast('无法开始', '请先选择保存目录', 'error'); return; }
  try {
    // HLS 默认填 .mp4：主进程会先合并 ts，再用 bin/ffmpeg.exe 无损封装成 mp4
    const created = await api.createDownload({
      url,
      dir: els.dir.value.trim(),
      filename: sourceName || els.name.value.trim() || 'video',
      extension: els.ext.value.trim(),
      policy: els.policy.value,
      blobFrom: fromWebview ? 'webview' : undefined
    });
    const task = {
      id: created.id, url, sourceType: created.sourceType,
      isHls: !!isHls, filePath: created.filePath, state: 'created', els: null
    };
    tasks.set(task.id, task);
    createTaskRow(task);
    setTaskState(task, 'created');
    task.els.pathText.textContent = created.filePath;
    task.els.reveal.hidden = false;
    await api.startDownload(task.id);
    const kind = created.sourceType === 'blob' ? 'Blob（内置浏览器上下文）' : 'HTTP(S)';
    log(`开始下载 [${kind}]：${url.slice(0, 80)}`);
  } catch (err) {
    toast('启动失败', err.message, 'error');
    log('启动失败：' + err.message, 'error');
  }
}

// 勾选的多个源一起下载
els.downloadSelected.addEventListener('click', async () => {
  const checks = [...els.sourceList.querySelectorAll('.source-check')];
  const picked = checks
    .map((c, i) => (c.checked ? scannedSources[i] : null))
    .filter(Boolean);
  if (!picked.length) { toast('未选择', '请至少勾选一个视频源', 'warn'); return; }
  if (!els.dir.value.trim()) { toast('无法开始', '请先选择保存目录', 'error'); return; }

  const base = els.name.value.trim() || 'video';
  const stamp = Date.now().toString().slice(-6);
  await Promise.all(picked.map((source, index) => {
    const isBlob = source.url.toLowerCase().startsWith('blob:');
    const isHls = /\.m3u8(\?|$)/i.test(source.url);
    // HLS 的 m3u8 名字（如 index）没有意义，用用户填的文件名
    const guessed = isHls ? null : guessName(source.url);
    const suffix = picked.length > 1 ? `-${index + 1}` : '';
    const sourceName = guessed ? guessed.name + suffix : `${base}-${stamp}${suffix}`;
    return startTask({
      url: source.url,
      sourceType: isBlob ? 'blob' : 'http',
      sourceName,
      fromWebview: isBlob && !!webviewId,
      isHls
    });
  }));
  log(`已创建 ${picked.length} 个下载任务`);
});

// 手动地址（单个）
els.url.addEventListener('input', () => { blobFrom = 'renderer'; });
els.start.addEventListener('click', async () => {
  const url = els.url.value.trim();
  if (!url) { toast('无法开始', '请先输入视频地址', 'error'); return; }
  const isBlob = url.toLowerCase().startsWith('blob:');
  const isHls = /\.m3u8(\?|$)/i.test(url);
  await startTask({
    url,
    sourceType: isBlob ? 'blob' : 'http',
    sourceName: (!isHls && guessName(url)) ? guessName(url).name : (els.name.value.trim() || undefined),
    fromWebview: isBlob && blobFrom === 'webview',
    isHls
  });
});

/* --------------------------- 主进程事件处理 --------------------------- */

api.onDownloadEvent((event) => {
  const task = tasks.get(event.id);
  if (!task) return;

  if (event.type === 'progress') {
    lastProgress = { downloaded: event.downloaded, total: event.total, speed: event.speed };
    renderTaskProgress(task, event.downloaded, event.total, event.speed);
    return;
  }
  if (event.type === 'state') {
    setTaskState(task, event.state, event.message);
    if (event.message) log(event.message, event.state === 'error' ? 'error' : '');
    return;
  }
  if (event.type === 'done') {
    task.filePath = event.filePath;
    if (task.els) {
      task.els.pathText.textContent = event.filePath;
      task.els.reveal.hidden = false;
      renderTaskProgress(task, event.size, event.total, lastProgress.speed);
    }
    setTaskState(task, 'completed');
    log(`下载完成：${event.filePath}（${formatBytes(event.size)}）`, 'success');
    toast('下载完成', `${formatBytes(event.size)}\n${event.filePath}`, 'success');
    return;
  }
  if (event.type === 'error') {
    setTaskState(task, 'error');
    toast('下载失败', event.message, 'error');
    log('下载失败：' + event.message, 'error');
  }
});

/* --------------------------- Blob 流式读取实现 -------------------------- */

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function sendChunkWhenReady(id, control, chunk) {
  while ((control.paused || control.backpressure) && !control.cancelled) {
    await sleep(60);
  }
  if (control.cancelled) return;
  const copy = chunk.slice();
  api.blobChunk(id, copy.buffer);
}

async function startBlobStream({ id, url, startByte }) {
  const control = { paused: false, backpressure: false, cancelled: false, reader: null };
  blobStreams.set(id, control);

  try {
    let response;
    try {
      response = await fetch(url);
    } catch (_err) {
      throw new Error('Blob URL 已过期或失效（可能已被释放或页面已刷新）');
    }
    if (!response.ok || !response.body) {
      throw new Error('Blob URL 已过期或失效，无法读取视频数据');
    }

    const total = Number(response.headers.get('content-length')) || null;
    api.blobReady(id, total);
    log(`Blob 数据读取开始${total ? '，总大小 ' + formatBytes(total) : ''}`);

    const reader = response.body.getReader();
    control.reader = reader;
    let skip = startByte || 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (control.cancelled) break;

      if (skip > 0) {
        const take = Math.min(skip, value.byteLength);
        skip -= take;
        if (take === value.byteLength) continue;
        await sendChunkWhenReady(id, control, value.subarray(take));
      } else {
        await sendChunkWhenReady(id, control, value);
      }
    }

    if (!control.cancelled) {
      api.blobEnd(id, total);
      log('Blob 数据已全部发送至写入线程');
    }
  } catch (err) {
    if (!control.cancelled) api.blobError(id, err.message || String(err));
  } finally {
    if (blobStreams.get(id) === control) blobStreams.delete(id);
  }
}

api.onBlobCommand((command) => {
  const control = blobStreams.get(command.id);
  switch (command.command) {
    case 'fetch': startBlobStream(command); break;
    case 'pause-reading': if (control) control.paused = true; break;
    case 'resume-reading': if (control) control.paused = false; break;
    case 'backpressure': if (control) control.backpressure = !!command.active; break;
    case 'cancel':
      if (control) {
        control.cancelled = true;
        if (control.reader) control.reader.cancel().catch(() => {});
      }
      break;
    default: break;
  }
});

/* ------------------------------- 初始化 -------------------------------- */

updateTargetHint();
updateBadge();
log('工具已就绪。勾选多个视频源可一起下载；Blob 在内置浏览器上下文中读取。');
