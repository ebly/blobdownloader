'use strict';

const { webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { runHttpDownload } = require('./http-downloader');
const { runHlsDownload } = require('./hls-downloader');
const { runBlobDownload } = require('./blob-downloader');
const { resolveTargetPath, ensureDir, removeFileIfExists, detectNonVideo } = require('./file-utils');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_NETWORK_RETRIES = 2;

const FFMPEG = path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');

/** 用 bin/ffmpeg.exe 把合并的 ts 无损封装成 mp4（-c copy，不重新编码） */
function remuxTsToMp4(tsPath, mp4Path) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FFMPEG)) return reject(new Error('未找到 bin/ffmpeg.exe，保留 ts 文件'));
    const ff = spawn(FFMPEG, [
      '-y', '-i', tsPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', mp4Path
    ], { windowsHide: true });
    let stderr = '';
    ff.stderr.on('data', (c) => { stderr += c.toString(); });
    ff.on('error', (err) => reject(new Error('ffmpeg 启动失败：' + err.message)));
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 0) resolve();
      else reject(new Error('ffmpeg 转换失败（退出码 ' + code + '）：' + stderr.slice(-300)));
    });
  });
}

class DownloadManager {
  constructor(window) {
    this.window = window;
    this.tasks = new Map();
    this.sequence = 0;
    this.webviewId = null;
  }

  bindWebview(id) {
    this.webviewId = Number(id);
  }

  /** 内置浏览器导航会销毁 guest 上下文，通知相关 Blob 任务失败 */
  notifyWebviewNavigated() {
    for (const task of this.tasks.values()) {
      if (task.sourceType === 'blob' && task.blobFrom === 'webview' &&
          (task.state === 'downloading' || task.state === 'paused')) {
        this._fail(task, new Error('内置浏览器页面已跳转，Blob 上下文失效，请重新打开视频页并扫描'));
      }
    }
  }

  dispose() {
    for (const task of this.tasks.values()) {
      if (task.state === 'downloading' || task.state === 'pausing' || task.state === 'cancelling') {
        if (task._stop) task._stop();
      }
      if (task._blob) task._blob.abort();
      if (task.sourceType === 'blob') this._sendBlobCommand('cancel', task.id);
    }
    this.tasks.clear();
  }

  /* ------------------------------ IPC 事件推送 ------------------------------ */

  _emit(id, payload) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('download:event', Object.assign({ id }, payload));
    }
  }

  _sendBlobCommand(command, id, extra = {}) {
    const payload = Object.assign({ command, id }, extra);
    const task = this.tasks.get(id);

    // 来自内置浏览器的 Blob：命令必须发回该 guest 页面，否则它上下文里的 reader 收不到
    if (task && task.blobFrom === 'webview' && this.webviewId != null) {
      const guest = webContents.fromId(this.webviewId);
      if (guest && !guest.isDestroyed()) {
        guest.send('blob:command', payload);
        return;
      }
    }

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('blob:command', payload);
    }
  }

  /* ------------------------------- 任务生命周期 ------------------------------ */

  create({ url, dir, filename, extension, policy, blobFrom }) {
    const source = String(url || '').trim();
    if (!source) throw new Error('请输入视频地址');

    const isBlob = source.toLowerCase().startsWith('blob:');
    const isHttp = /^https?:\/\//i.test(source);
    const isHls = /^https?:\/\//i.test(source) && /\.m3u8(\?|$)/i.test(source);
    if (!isBlob && !isHttp) {
      throw new Error('地址需以 http://、https:// 或 blob: 开头');
    }
    if (!dir) throw new Error('请先选择本地保存目录');

    ensureDir(dir);
    let ext = String(extension || '').trim();
    if (ext && !ext.startsWith('.')) ext = '.' + ext;
    // HLS 想要 mp4：先合并成 ts，再由 ffmpeg 无损封装成 mp4
    const wantsMp4 = isHls && (!ext || ext.toLowerCase() === '.mp4') && fs.existsSync(FFMPEG);
    const writeExt = wantsMp4 ? '.ts' : (ext || '.mp4');
    const filePath = resolveTargetPath(dir, filename || 'video', writeExt, policy || 'rename');
    const hlsTargetPath = wantsMp4 ? filePath.replace(/\.ts$/i, '.mp4') : null;
    const id = `dl-${++this.sequence}-${Date.now().toString(36)}`;

    this.tasks.set(id, {
      id,
      url: source,
      dir,
      filePath,
      hlsTargetPath,
      sourceType: isBlob ? 'blob' : 'http',
      isHls,
      blobFrom: isBlob ? (blobFrom || 'renderer') : null,
      state: 'created',
      downloaded: 0,
      total: null,
      speed: 0,
      startTime: 0,
      lastBytes: 0,
      lastTime: 0,
      _stop: null,
      _blob: null
    });

    return { id, filePath: hlsTargetPath || filePath, sourceType: isBlob ? 'blob' : 'http' };
  }

  async start(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('下载任务不存在');
    if (task.state === 'downloading') return false;
    if (task.state === 'paused') return this.resume(id);
    if (task.state === 'completed') throw new Error('该任务已完成，请重新创建下载');

    task.state = 'downloading';
    task.startTime = Date.now();
    task.lastTime = task.startTime;
    task.lastBytes = task.downloaded;
    this._emit(id, { type: 'state', state: task.state });

    this._run(task).catch((err) => this._fail(task, err));
    return true;
  }

  async pause(id) {
    const task = this.tasks.get(id);
    if (!task || task.state !== 'downloading') return false;

    if (task.sourceType === 'http' || task.isHls) {
      task.state = 'pausing';
      if (task._stop) task._stop();
    } else {
      // Blob 保留 renderer 中的 reader，仅停止推送数据块，继续时无需重新 fetch
      task.state = 'paused';
      this._sendBlobCommand('pause-reading', id);
      this._emit(id, { type: 'state', state: task.state, message: '已暂停' });
    }
    return true;
  }

  async resume(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('下载任务不存在');
    if (task.state !== 'paused' && task.state !== 'error') return false;
    // Blob 数据源在渲染进程，一旦失败 reader 已销毁，必须重新创建任务
    if (task.sourceType === 'blob' && task.state === 'error') {
      throw new Error('Blob URL 读取已失败，请重新输入有效地址并新建下载');
    }

    if (task.sourceType === 'blob' && task.state === 'paused') {
      task.state = 'downloading';
      this._sendBlobCommand('resume-reading', id);
      this._emit(id, { type: 'state', state: task.state });
      return true;
    }

    task.state = 'downloading';
    task.lastTime = Date.now();
    task.lastBytes = task.downloaded;
    this._emit(id, { type: 'state', state: task.state });

    this._run(task, true).catch((err) => this._fail(task, err));
    return true;
  }

  async cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state === 'cancelled' || task.state === 'completed') return false;

    // 失败或 HTTP 暂停时没有活动流，直接终结任务
    if (task.state === 'error' || (task.state === 'paused' && (task.sourceType === 'http' || task.isHls))) {
      task.state = 'cancelled';
      removeFileIfExists(task.filePath);
      this._emit(id, { type: 'state', state: task.state, message: '已取消' });
      return true;
    }

    task.state = 'cancelling';
    if (task.sourceType === 'blob') {
      this._sendBlobCommand('cancel', id);
      // abort 会结束 _run 中等待的 Promise，由 _run 统一清理文件
      if (task._blob) task._blob.abort();
    } else if (task._stop) {
      task._stop();
    }
    return true;
  }

  /* ------------------------------- 核心下载流程 ------------------------------ */

  async _run(task, isResume = false) {
    const hooks = {
      onProgress: (downloaded, total) => this._onProgress(task, downloaded, total),
      onBackpressure: (active) => this._sendBlobCommand('backpressure', task.id, { active })
    };

    let result;
    if (task.sourceType === 'http') {
      result = task.isHls
        ? await this._runHttpWithRetry(task, hooks, runHlsDownload)
        : await this._runHttpWithRetry(task, hooks, runHttpDownload);
    } else {
      const pending = runBlobDownload(task, hooks);
      if (!isResume) {
        this._sendBlobCommand('fetch', task.id, {
          url: task.url,
          startByte: task.downloaded || 0
        });
      }
      result = await pending;
    }

    if (task.state === 'cancelling') {
      task.state = 'cancelled';
      removeFileIfExists(task.filePath);
      this._emit(task.id, { type: 'state', state: task.state, message: '已取消' });
      return;
    }

    if (result.stopped) {
      task.state = 'paused';
      this._emit(task.id, { type: 'state', state: task.state, message: '已暂停' });
      return;
    }

    // 内容校验：防止把网页/JSON 等非视频误存成 mp4 并显示"下载完成"
    const contentError = detectNonVideo(task.filePath);
    if (contentError) {
      removeFileIfExists(task.filePath);
      if (task.hlsTargetPath) removeFileIfExists(task.hlsTargetPath);
      throw new Error(contentError);
    }

    // HLS：合并的 ts 无损封装成 mp4，成功后删除中间 ts
    if (task.hlsTargetPath) {
      this._emit(task.id, { type: 'state', state: 'downloading', message: '正在封装为 mp4…' });
      try {
        await remuxTsToMp4(task.filePath, task.hlsTargetPath);
        removeFileIfExists(task.filePath);
        task.filePath = task.hlsTargetPath;
      } catch (err) {
        // 转换失败不影响已下载的 ts，告知用户保留位置
        this._emit(task.id, {
          type: 'state', state: 'downloading',
          message: 'mp4 封装失败，保留 ts 文件：' + err.message
        });
      }
    }

    task.state = 'completed';
    task.downloaded = result.downloaded;
    task.total = result.total || result.downloaded;
    this._emit(task.id, {
      type: 'done',
      filePath: task.filePath,
      size: task.downloaded,
      total: task.total
    });
  }

  async _runHttpWithRetry(task, hooks, runner = runHttpDownload) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt += 1) {
      try {
        return await runner(task, hooks);
      } catch (err) {
        lastError = err;
        if (task.state === 'pausing' || task.state === 'cancelling') throw err;
        if (attempt === MAX_NETWORK_RETRIES) break;
        // 网络抖动自动重试：已从已落盘字节处继续，不会重复下载
        this._emit(task.id, {
          type: 'state',
          state: 'downloading',
          message: `网络异常，${attempt + 1} 秒后重试…`
        });
        await sleep((attempt + 1) * 1000);
      }
    }
    throw lastError;
  }

  _onProgress(task, downloaded, total) {
    const now = Date.now();
    const elapsed = (now - (task.lastTime || task.startTime || now)) / 1000;
    if (elapsed >= 0.4) {
      task.speed = Math.max(0, (downloaded - task.lastBytes) / elapsed);
      task.lastBytes = downloaded;
      task.lastTime = now;
    }
    this._emit(task.id, {
      type: 'progress',
      downloaded,
      total,
      speed: task.speed,
      state: task.state
    });
  }

  _fail(task, err) {
    if (task.state === 'cancelling') {
      task.state = 'cancelled';
      removeFileIfExists(task.filePath);
      this._emit(task.id, { type: 'state', state: task.state, message: '已取消' });
      return;
    }
    // 保留已下载的部分文件，便于用户点“重试”后续传
    task.state = 'error';
    this._emit(task.id, {
      type: 'error',
      state: task.state,
      message: err && err.message ? err.message : String(err)
    });
  }

  /* ----------------------------- Blob 数据帧路由 ----------------------------- */

  onBlobReady({ id, total }) {
    const task = this.tasks.get(id);
    if (task && task._blob) task._blob.onReady(total);
  }

  onBlobChunk({ id, chunk }) {
    const task = this.tasks.get(id);
    if (task && task._blob) task._blob.onChunk(chunk);
  }

  onBlobEnd({ id, total }) {
    const task = this.tasks.get(id);
    if (task && task._blob) task._blob.onEnd(total);
  }

  onBlobError({ id, message }) {
    const task = this.tasks.get(id);
    if (task && task._blob) task._blob.onError(message);
  }
}

module.exports = { DownloadManager };
