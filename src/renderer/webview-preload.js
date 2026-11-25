'use strict';

// 运行在内置网页视图（guest page）中。Blob 由页面脚本创建，必须在本上下文读取。
// 关键改进：在页面主世界 hook URL.createObjectURL，直接持有 Blob 对象本体，
// 即使站点随后 revoke 掉 URL 也能读；MediaSource 动态流单独识别并提示。

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const streams = new Map();
const recordedSources = [];

const validHttp = (url) => {
  try {
    const host = new URL(url).hostname;
    return !!host && host !== 'undefined' && host !== 'null';
  } catch (_err) {
    return false;
  }
};

/** 扫描页面里可用的视频源，供用户点选后下载 */
function scanSources() {
  const found = [];
  const seen = new Set();
  const counters = { blob: 0, http: 0, hls: 0 };

  // label 只按类型生成通用名称，不暴露 DOM 路径（不同站点结构各异，路径没有通用意义）
  const push = (url, labelOverride) => {
    if (!url || typeof url !== 'string') return;
    if (!/^(blob:|https?:)/i.test(url)) return;
    if (/^https?:/i.test(url) && !validHttp(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const isBlob = /^blob:/i.test(url);
    const isHls = /\.m3u8(\?|$)/i.test(url);
    const type = isBlob ? 'blob' : (isHls ? 'hls' : 'http');
    counters[type] = (counters[type] || 0) + 1;
    const name = isBlob ? 'Blob 视频源' : (isHls ? 'HLS 流（m3u8）' : '视频直链');
    found.push({
      url,
      label: labelOverride || (counters[type] > 1 ? `${name} ${counters[type]}` : name),
      unusable: !!labelOverride
    });
  };

  const scanDoc = (doc, depth) => {
    if (!doc || depth > 4) return;
    doc.querySelectorAll('video').forEach((video) => {
      push(video.src);
      push(video.currentSrc);
      // HLS 播放器常把 m3u8 放在 data 属性里（video 本身是 MSE blob）
      ['data-hls', 'data-url', 'data-src', 'data-source', 'data-m3u8'].forEach((attr) => {
        const value = video.getAttribute(attr);
        if (value && /\.m3u8(\?|$)/i.test(value)) {
          try { push(new URL(value, doc.location ? doc.location.href : location.href).toString()); }
          catch (_err) { push(value); }
        }
      });
    });
    doc.querySelectorAll('video source, audio source').forEach((source) => {
      push(source.src);
    });
    // shadow DOM 与 iframe 里的播放器，都递归进去扫
    doc.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) scanDoc(el.shadowRoot, depth + 1);
    });
    doc.querySelectorAll('iframe, frame').forEach((frame) => {
      try {
        const sub = frame.contentDocument;
        if (sub) scanDoc(sub, depth + 1);
      } catch (_err) {
        // 跨域 iframe 受浏览器隔离，无法从主文档读取
      }
    });
  };

  scanDoc(document, 0);

  // hook 捕获到的 Blob（含已被 revoke 的）也作为候选
  for (const entry of recordedSources) {
    push(entry.url, entry.unusable ? entry.label : undefined);
  }

  // 页面脚本可直接挂一个伪源数组（测试用，绕过 contextBridge 时序）
  try {
    const extras = window.__bdUnusableSources;
    if (Array.isArray(extras)) {
      for (const item of extras) push(item.url, item.label || '测试·不可下载');
    }
  } catch (_err) {}

  try {
    performance.getEntriesByType('resource').forEach((entry) => {
      if (entry.name && /\.(mp4|webm|m4v|mov|mkv|m3u8)(\?|$)/i.test(entry.name)) {
        push(entry.name);
      }
    });
  } catch (_err) {
    // 某些站点禁用 performance API，忽略
  }

  return found;
}

/* ---------------- 暴露给页面主世界调用的桥接函数 ---------------- */

contextBridge.exposeInMainWorld('videoCapture', {
  scanSources,

  recordSource(entry) {
    if (entry && entry.url && !recordedSources.some((item) => item.url === entry.url)) {
      recordedSources.push(entry);
      if (recordedSources.length > 60) recordedSources.shift();
    }
  },

  // 供测试页把"不可下载的伪源"标记进扫描列表（真实站点不会调用）
  markUnusable(url, label) {
    if (!url || typeof url !== 'string') return;
    const existing = recordedSources.find((item) => item.url === url);
    if (existing) {
      // hook 已先登记为普通 blob，这里补上"不可下载"标记
      existing.unusable = true;
      existing.label = label || '测试·不可下载';
    } else {
      recordedSources.push({ url, label: label || '测试·不可下载', unusable: true });
      if (recordedSources.length > 60) recordedSources.shift();
    }
  },

  pushChunk(id, buffer) {
    ipcRenderer.send('blob:chunk', { id, chunk: buffer });
  },

  ready(id, total) {
    ipcRenderer.send('blob:ready', { id, total });
  },

  end(id, total) {
    ipcRenderer.send('blob:end', { id, total });
  },

  fail(id, message) {
    ipcRenderer.send('blob:error', { id, message });
  },

  control(id) {
    const state = streams.get(id);
    return state
      ? { paused: state.paused, backpressure: state.backpressure, cancelled: state.cancelled }
      : { paused: false, backpressure: false, cancelled: true };
  }
});

/* ---------------- 注入页面主世界：hook Blob 并提供读取函数 ---------------- */

const INJECT_SCRIPT = [
  '(function () {',
  '  if (window.__bdBlobHook) return;',
  '  window.__bdBlobHook = true;',
  '  var store = new Map();',
  '  var MAX = 40;',
  '  var api = window.videoCapture;',
  '  var origCreate = URL.createObjectURL.bind(URL);',
  '  URL.createObjectURL = function (obj) {',
  '    var url = origCreate(obj);',
  '    try {',
  '      var kind = "unknown";',
  '      if (obj instanceof Blob) kind = "blob";',
  '      else if (obj && obj.constructor && obj.constructor.name === "MediaSource") kind = "mediasource";',
  '      store.set(url, { obj: obj, kind: kind });',
  '      if (store.size > MAX) store.delete(store.keys().next().value);',
  '      if (api && api.recordSource) api.recordSource({ url: url, label: kind });',
  '    } catch (_e) {}',
  '    return url;',
  '  };',
  '  var origRevoke = URL.revokeObjectURL.bind(URL);',
  '  URL.revokeObjectURL = function (url) {',
  // 故意不从 store 删除：站点 revoke 后我们仍持有对象引用
  '    return origRevoke(url);',
  '  };',
  '  window.__bdStreamBlob = async function (id, url, startByte) {',
  '    try {',
  '      var entry = store.get(url);',
  '      var blob;',
  '      if (entry && entry.kind === "mediasource") {',
  '        throw new Error("该地址由 MediaSource 动态生成，不是完整文件；请在扫描结果中选择 mp4/webm 等真实网络视频地址");',
  '      }',
  '      if (entry && entry.obj instanceof Blob) {',
  '        blob = entry.obj;',
  '      } else {',
  '        try {',
  '          var res = await fetch(url);',
  '          if (!res.ok) throw new Error("not ok");',
  '          blob = await res.blob();',
  '        } catch (e) {',
  '          var v = document.querySelector("video");',
  '          var cur = v && (v.currentSrc || v.src);',
  '          if (!cur || !/^blob:/i.test(cur)) throw e;',
  '          var ce = store.get(cur);',
  '          if (ce && ce.kind === "mediasource") throw e;',
  '          if (ce && ce.obj instanceof Blob) {',
  '            blob = ce.obj;',
  '          } else {',
  '            var res2 = await fetch(cur);',
  '            if (!res2.ok) throw e;',
  '            blob = await res2.blob();',
  '          }',
  '          api.recordSource({ url: cur, label: "auto-recovered" });',
  '        }',
  '      }',
  '      var mime = (blob.type || "").toLowerCase();',
  '      var looksHtml = /html|xml|json|javascript|text\\//i.test(mime) ||',
  '        (blob.size < 2048 && /^\\s*</.test(await blob.slice(0, 16).text()));',
  '      if (looksHtml) {',
  '        throw new Error("读取到的不是视频数据，而是页面文本（" + (mime || "未知类型") + "）。请打开视频页、等视频加载后重新扫描，再点选列表中的 blob 源");',
  '      }',
  '      if (blob.size < 1024) {',
  '        throw new Error("读取到的数据过小（" + blob.size + " 字节），不是有效视频。请重新扫描当前页面里的 video blob 源");',
  '      }',
  '      var total = blob.size || null;',
  '      api.ready(id, total);',
  '      var reader;',
  '      try { reader = blob.stream().getReader(); }',
  '      catch (e) { throw new Error("该 Blob 无法作为完整文件读取，可能由播放器动态生成"); }',
  '      var skip = startByte || 0;',
  '      while (true) {',
  '        var state = api.control(id);',
  '        if (state.cancelled) { await reader.cancel().catch(function () {}); return; }',
  '        if (state.paused || state.backpressure) { await new Promise(function (r) { setTimeout(r, 60); }); continue; }',
  '        var chunk = await reader.read();',
  '        if (chunk.done) break;',
  '        var value = chunk.value;',
  '        if (skip > 0) {',
  '          var take = Math.min(skip, value.byteLength);',
  '          skip -= take;',
  '          if (take >= value.byteLength) continue;',
  '          value = value.subarray(take);',
  '        }',
  '        api.pushChunk(id, value.slice().buffer);',
  '      }',
  '      api.end(id, total);',
  '    } catch (err) {',
  '      api.fail(id, err && err.message ? err.message : String(err));',
  '    }',
  '  };',
  '})();'
].join('\n');

const injection = webFrame.executeJavaScript(INJECT_SCRIPT).catch(() => {});

/** 通过主世界的 __bdStreamBlob 读取，数据块经 contextBridge 回传主进程 */
async function streamBlob({ id, url, startByte }) {
  const state = { paused: false, backpressure: false, cancelled: false };
  streams.set(id, state);
  try {
    await injection;
    await webFrame.executeJavaScript(
      'window.__bdStreamBlob(' + JSON.stringify(id) + ',' + JSON.stringify(url) + ',' + Number(startByte || 0) + ')'
    );
  } catch (err) {
    if (!state.cancelled) {
      ipcRenderer.send('blob:error', {
        id,
        message: '读取 Blob 失败：' + (err && err.message ? err.message : String(err)) +
          '。请重新打开视频页，加载完成后立即扫描并下载。'
      });
    }
  } finally {
    if (streams.get(id) === state) streams.delete(id);
  }
}

// 命令监听必须在 preload 阶段就注册
ipcRenderer.on('blob:command', (_event, command) => {
  const state = streams.get(command.id);

  switch (command.command) {
    case 'fetch':
      streamBlob(command);
      break;
    case 'pause-reading':
      if (state) state.paused = true;
      break;
    case 'resume-reading':
      if (state) state.paused = false;
      break;
    case 'backpressure':
      if (state) state.backpressure = !!command.active;
      break;
    case 'cancel':
      if (state) state.cancelled = true;
      break;
    default:
      break;
  }
});

ipcRenderer.on('blob:reset', () => {
  for (const state of streams.values()) state.cancelled = true;
  streams.clear();
});
