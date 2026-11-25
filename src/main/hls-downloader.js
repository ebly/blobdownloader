'use strict';

// HLS(m3u8) 下载：拉取播放列表 -> 解析 ts 分片 -> 逐个流式下载并顺序合并。
// 内存里始终只有一个分片的数据块，不会把整个视频读进内存。

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { openStream } = require('./http-downloader');

const CONNECT_TIMEOUT = 20000;
const MAX_REDIRECTS = 5;

function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (_err) { return reject(new Error('播放列表地址无效：' + url)); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error('HLS 播放列表必须是 http(s) 地址'));
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'BlobDownloader/1.0' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('播放列表重定向次数过多'));
        return fetchText(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject);
      }
      if (status >= 400) {
        res.resume();
        return reject(new Error(`拉取播放列表失败：HTTP ${status}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', (err) => reject(new Error('读取播放列表失败：' + err.message)));
    });
    req.setTimeout(CONNECT_TIMEOUT, () => req.destroy(new Error('拉取播放列表超时')));
    req.on('error', reject);
  });
}

/** 解析 m3u8，返回 { segments, isMaster, variants } */
function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (!lines.some((l) => l === '#EXTM3U')) throw new Error('不是有效的 m3u8 播放列表');
  if (lines.some((l) => l.startsWith('#EXT-X-KEY:'))) {
    throw new Error('该 HLS 流已加密（EXT-X-KEY），暂不支持下载');
  }

  const variants = [];
  const segments = [];
  let pendingBandwidth = null;

  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      const bw = /BANDWIDTH=(\d+)/.exec(line);
      if (line.startsWith('#EXT-X-STREAM-INF') && bw) pendingBandwidth = parseInt(bw[1], 10);
      continue;
    }
    let resolved;
    try { resolved = new URL(line, baseUrl).toString(); }
    catch (_err) { continue; }
    if (pendingBandwidth != null) {
      variants.push({ url: resolved, bandwidth: pendingBandwidth });
      pendingBandwidth = null;
    } else {
      segments.push(resolved);
    }
  }

  if (variants.length && !segments.length) return { segments: [], isMaster: true, variants };
  if (!segments.length) throw new Error('播放列表里没有找到 ts 分片');
  return { segments, isMaster: false, variants };
}

/** 探测分片大小，用于汇总总进度；失败则返回 0（不影响下载） */
function probeSize(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (_err) { return resolve(0); }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'HEAD', headers: { 'User-Agent': 'BlobDownloader/1.0' } }, (res) => {
      res.resume();
      resolve(parseInt(res.headers['content-length'], 10) || 0);
    });
    req.setTimeout(8000, () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

/**
 * 执行 HLS 下载。返回的 Promise 上，task._stop 用于取消/暂停中断当前分片。
 * 支持断点续传：task._hlsSegmentsDone 记录已写入的分片数，恢复时跳过这些分片。
 */
function runHlsDownload(task, hooks) {
  return new Promise((resolve, reject) => {
    let writer = null;
    let currentReq = null;
    let currentRes = null;
    let settled = false;
    let written = task.downloaded || 0;
    let segmentsDone = task._hlsSegmentsDone || 0;
    let total = null;

    const closeWriter = (callback) => {
      if (!writer || writer.destroyed) return callback && callback();
      writer.end(callback);
    };

    const finishStopped = (reason) => {
      if (settled) return;
      settled = true;
      if (currentRes && !currentRes.destroyed) currentRes.destroy();
      if (currentReq && !currentReq.destroyed) currentReq.destroy();
      task._hlsSegmentsDone = segmentsDone;
      closeWriter();
      resolve({ stopped: true, reason, downloaded: written });
    };

    task._stop = () => finishStopped('stopped');

    (async () => {
      try {
        let text = await fetchText(task.url);
        let parsed = parsePlaylist(text, task.url);

        // master playlist：选码率最高的变体再解析
        if (parsed.isMaster) {
          parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
          text = await fetchText(parsed.variants[0].url);
          parsed = parsePlaylist(text, parsed.variants[0].url);
        }

        let segments = parsed.segments;
        if (segmentsDone > 0) segments = segments.slice(segmentsDone);

        // 预估总大小（仅用于进度显示，探测失败不影响下载）
        const sizes = await Promise.all(segments.map(probeSize));
        total = written + sizes.reduce((a, b) => a + b, 0);
        if (total === written) total = null;
        if (total != null) task.total = total;
        hooks.onProgress(written, total);

        writer = fs.createWriteStream(task.filePath, { flags: written > 0 ? 'a' : 'w' });
        writer.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(new Error('写入本地文件失败：' + err.message));
        });

        for (let i = 0; i < segments.length; i += 1) {
          if (settled) return;
          const opened = await openStream(segments[i], 0);
          if (settled) { if (opened.res && !opened.res.destroyed) opened.res.destroy(); return; }
          currentReq = opened.req;
          currentRes = opened.res;

          await new Promise((segResolve, segReject) => {
            let lastReport = 0;
            currentRes.on('data', (chunk) => {
              if (settled) return;
              written += chunk.length;
              task.downloaded = written;
              const now = Date.now();
              if (now - lastReport >= 120) {
                lastReport = now;
                hooks.onProgress(written, total);
              }
              if (!writer.write(chunk)) {
                currentRes.pause();
                writer.once('drain', () => {
                  if (!settled && currentRes && !currentRes.destroyed) currentRes.resume();
                });
              }
            });
            currentRes.on('end', () => { if (!settled) segResolve(); });
            currentRes.on('error', (err) => segReject(new Error('分片下载中断：' + err.message)));
          });

          segmentsDone += 1;
          task._hlsSegmentsDone = segmentsDone;
          currentReq = null;
          currentRes = null;
        }

        if (settled) return;
        settled = true;
        writer.end(() => {
          hooks.onProgress(written, total);
          resolve({ stopped: false, downloaded: written, total });
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

module.exports = { runHlsDownload, parsePlaylist, fetchText };
