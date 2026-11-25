'use strict';

const fs = require('fs');

/**
 * Blob URL 只能通过浏览器上下文 fetch，因此由渲染进程分块读取后经 IPC 送来，
 * 主进程只负责把每一块顺序写入磁盘 —— 内存中始终只保留一个数据块。
 *
 * 暂停不会结束该 Promise：渲染进程保留 reader，只是停止推送数据块；
 * 取消会 abort()，Promise 以 stopped 结果结束。
 */
function runBlobDownload(task, hooks) {
  return new Promise((resolve, reject) => {
    let writer;
    let settled = false;
    let written = task.downloaded || 0;

    try {
      writer = fs.createWriteStream(task.filePath, { flags: written > 0 ? 'a' : 'w' });
    } catch (err) {
      return reject(new Error('无法创建本地文件：' + err.message));
    }

    writer.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error('写入本地文件失败：' + err.message));
    });

    const api = {
      onReady(total) {
        if (settled) return;
        task.total = total || null;
        hooks.onProgress(written, task.total);
      },

      onChunk(buffer) {
        if (settled) return;
        const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        written += chunk.length;
        task.downloaded = written;
        hooks.onProgress(written, task.total);
        // 背压：通知渲染进程暂缓读取，等磁盘写入排空后恢复
        if (!writer.write(chunk)) {
          hooks.onBackpressure(true);
          writer.once('drain', () => hooks.onBackpressure(false));
        }
      },

      onEnd(total) {
        if (settled) return;
        settled = true;
        if (total) task.total = total;
        writer.end(() => {
          hooks.onProgress(written, task.total);
          resolve({ stopped: false, downloaded: written, total: task.total });
        });
      },

      onError(message) {
        if (settled) return;
        settled = true;
        writer.destroy();
        reject(new Error(message || 'Blob 数据读取失败'));
      },

      abort() {
        if (settled) return;
        settled = true;
        writer.end();
        resolve({ stopped: true, reason: 'cancelled', downloaded: written });
      }
    };

    task._blob = api;
  });
}

module.exports = { runBlobDownload };
