'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const CONNECT_TIMEOUT = 20000;
const MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL = 120;

/**
 * 打开一个可读取的响应流，自动跟随重定向，并按需携带 Range 请求头。
 * 返回 { req, res, restart, total }。
 *
 * restart = true 表示服务端忽略了 Range（返回 200）或区间无效（416），
 * 此时调用方应从 0 字节重新开始写文件。
 */
function openStream(url, startByte, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_err) {
      return reject(new Error('下载地址无效，请检查 URL 是否完整'));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error('该地址不是 HTTP(S) 直链，Blob 地址请使用 blob: 开头'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'BlobDownloader/1.0' };
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;

    const req = client.get(url, { headers }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('重定向次数过多，已停止下载'));
        const next = new URL(res.headers.location, url).toString();
        return openStream(next, startByte, redirectsLeft - 1).then(resolve, reject);
      }

      // 请求的区间无法满足：文件已经下载完，或源文件被改动
      if (status === 416) {
        res.resume();
        return resolve({ req, res, restart: true, total: null, rangeInvalid: true });
      }

      // 服务端忽略了 Range，返回完整内容 —— 只能从头写
      if (status === 200 && startByte > 0) {
        return resolve({
          req,
          res,
          restart: true,
          total: parseInt(res.headers['content-length'], 10) || null
        });
      }

      if (status === 206) {
        const contentRange = res.headers['content-range'] || '';
        const matched = /\/(\d+)/.exec(contentRange);
        const total = matched ? parseInt(matched[1], 10) : null;
        return resolve({ req, res, restart: false, total });
      }

      if (status >= 400) {
        res.resume();
        return reject(new Error(`服务器返回 HTTP ${status} ${res.statusMessage || ''}`.trim()));
      }

      resolve({
        req,
        res,
        restart: false,
        total: parseInt(res.headers['content-length'], 10) || null
      });
    });

    req.setTimeout(CONNECT_TIMEOUT, () => {
      req.destroy(new Error('连接服务器超时'));
    });
    req.on('error', reject);
  });
}

/**
 * 执行一次 HTTP(S) 流式下载。数据以小块直接写入磁盘，不在内存中缓存整个文件。
 * 返回的 Promise 上，任务对象会挂一个 _stop() 用于暂停/取消时中断流。
 */
function runHttpDownload(task, hooks) {
  return new Promise((resolve, reject) => {
    let req = null;
    let res = null;
    let writer = null;
    let settled = false;
    let startByte = task.downloaded || 0;
    let written = startByte;
    let total = task.total || null;
    let lastReport = 0;

    const closeWriter = (callback) => {
      if (!writer || writer.destroyed) return callback && callback();
      writer.end(callback);
    };

    const finishStopped = (reason) => {
      if (settled) return;
      settled = true;
      if (res && !res.destroyed) res.destroy();
      if (req && !req.destroyed) req.destroy();
      closeWriter();
      resolve({ stopped: true, reason, downloaded: written });
    };

    // 暂停/取消：立即中止网络流，已经落盘的字节保留
    task._stop = () => finishStopped('stopped');

    (async () => {
      try {
        const opened = await openStream(task.url, startByte);
        if (settled) return;
        req = opened.req;
        res = opened.res;

        if (opened.restart || opened.rangeInvalid) {
          startByte = 0;
          written = 0;
          task.downloaded = 0;
          task.total = null;
          if (!opened.rangeInvalid) total = opened.total;
        } else if (opened.total != null) {
          total = startByte + opened.total;
        }
        if (total != null) task.total = total;

        writer = fs.createWriteStream(task.filePath, { flags: startByte > 0 ? 'a' : 'w' });
        writer.on('error', (err) => {
          if (settled) return;
          settled = true;
          if (res && !res.destroyed) res.destroy();
          reject(new Error('写入本地文件失败：' + err.message));
        });

        hooks.onProgress(written, total);

        res.on('data', (chunk) => {
          if (settled) return;
          written += chunk.length;
          task.downloaded = written;
          const now = Date.now();
          if (now - lastReport >= PROGRESS_INTERVAL) {
            lastReport = now;
            hooks.onProgress(written, total);
          }
          // 背压控制：写缓冲区满时暂停读取网络流，避免内存堆积
          if (!writer.write(chunk)) {
            res.pause();
            writer.once('drain', () => {
              if (!settled && res && !res.destroyed) res.resume();
            });
          }
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          writer.end(() => {
            hooks.onProgress(written, total);
            resolve({ stopped: false, downloaded: written, total });
          });
        });

        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          closeWriter();
          reject(new Error('网络传输中断：' + err.message));
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          closeWriter();
          reject(err);
        }
      }
    })();
  });
}

module.exports = { openStream, runHttpDownload };
