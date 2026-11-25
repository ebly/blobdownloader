'use strict';

const fs = require('fs');
const path = require('path');

/** 清除 Windows/通用文件系统非法字符，避免创建文件失败 */
function sanitizeFilename(input) {
  let name = String(input == null ? '' : input)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/^\s+|\s+$/g, '')
    .replace(/[. ]+$/g, '');
  if (!name) name = 'video';
  if (name.length > 180) name = name.slice(0, 180);
  return name;
}

/**
 * 解析最终落盘路径。
 * policy = 'rename' 时遇到重名自动追加 (1)、(2)…；'overwrite' 时直接覆盖。
 */
function resolveTargetPath(dir, filename, extension, policy) {
  let base = sanitizeFilename(filename);
  let ext = String(extension || '').trim();
  if (ext && !ext.startsWith('.')) ext = '.' + ext;

  if (ext) {
    if (base.toLowerCase().endsWith(ext.toLowerCase())) {
      // 文件名已带相同扩展名，去掉以免重复
      base = base.slice(0, base.length - ext.length);
    }
  } else {
    const detected = path.extname(base);
    ext = detected || '.mp4';
    if (detected) base = base.slice(0, base.length - detected.length);
  }

  const joinName = (n) => path.join(dir, n + ext);
  const original = joinName(base);
  if (policy === 'overwrite' || !fs.existsSync(original)) return original;

  let index = 1;
  while (index < 10000) {
    const candidate = joinName(`${base} (${index})`);
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
  throw new Error('同名文件过多，无法分配新文件名');
}

function ensureDir(dir) {
  if (!dir) throw new Error('保存目录不能为空');
  fs.mkdirSync(dir, { recursive: true });
}

function removeFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_err) {
    // 清理失败不影响主流程，忽略
  }
}

/**
 * 检查落盘内容是否明显不是视频（网页/JSON/纯文本）。
 * 只做"黑名单"识别，不误伤任何视频编码格式。
 */
function detectNonVideo(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
    if (/^<!doctype\s+html|^<html\b|^<\?xml\b|^<script\b/i.test(head)) {
      return '下载到的是网页文件而非视频。请填入 mp4/webm 等视频直链，或在内置浏览器中扫描后点选 blob 视频源';
    }
    if (head.startsWith('{') || head.startsWith('[')) {
      return '下载到的是数据文件（JSON）而非视频，请检查地址是否为真实视频源';
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes == null || !isFinite(bytes)) return '--';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
}

module.exports = {
  sanitizeFilename,
  resolveTargetPath,
  ensureDir,
  removeFileIfExists,
  detectNonVideo,
  formatBytes
};
