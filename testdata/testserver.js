'use strict';

// 本地测试服务器：用 ffmpeg 生成的合法测试素材，提供三种场景。
// 启动：node testdata/testserver.js    访问：http://127.0.0.1:8765/

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
};

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>
body{font-family:system-ui,sans-serif;background:#12141c;color:#e6e9f2;padding:24px}
video{width:640px;max-width:100%;background:#000;border-radius:8px}
h1{font-size:18px}p,code{color:#9aa3c0}a{color:#6c8cff}pre{color:#74e0a8;word-break:break-all;font-size:12px}
</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const raw = req.url.split('?');
  const urlPath = decodeURIComponent(raw[0]);
  const query = raw[1] || '';

  try {
    if (urlPath === '/') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(page('视频下载工具 · 测试中心', `
        <p>以下均为本地 ffmpeg 生成的合法测试素材（彩条 + 正弦音）。</p>
        <ul>
          <li><a href="/direct.html">场景 1：MP4 直链</a> — 验证 HTTP 流式下载与断点续传</li>
          <li><a href="/blob.html">场景 2：Blob URL</a> — 验证内置浏览器直接读取 Blob 对象</li>
          <li><a href="/blob.html?revoke=1">场景 2b：Blob 已 revoke</a> — 验证 URL 释放后仍可读</li>
          <li><a href="/hls.html">场景 3：HLS m3u8</a> — 模拟 MediaSource 场景</li>
          <li><a href="/complex.html">场景 4：复杂结构里的 Blob</a> — ShadowRoot 内嵌 iframe，iframe 生成 blob 交给顶层；测试 blob 扫描与下载</li>
          <li><a href="/multi.html">场景 5：多视频源</a> — 一个 HTTP + 一个 blob，测试复选框多选一起下载</li>
          <li><a href="/fake-mse.html">场景 6：假的 MSE blob</a> — 验证"MediaSource 动态生成"提示</li>
          <li><a href="/fake-script.html">场景 7：脚本 blob</a> — 验证"读取到页面文本"拦截</li>
        </ul>`));
    }

    if (urlPath === '/direct.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(page('场景 1 · MP4 直链', `
        <video id="v" controls src="/sample.mp4"></video>
        <p>直链：<code>http://127.0.0.1:${PORT}/sample.mp4</code></p>`));
    }

    if (urlPath === '/blob.html') {
      const revoke = /revoke=1/.test(query);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(page('场景 2 · Blob URL', `
        <video id="v" controls></video>
        <p>本页面通过 fetch 把 sample.mp4 读成 Blob 并生成 blob: 地址赋给 video。</p>
        <p>${revoke ? '当前模式：生成后立刻 revoke URL，验证工具仍能从捕获的 Blob 对象读取。' : '当前模式：保留 blob: URL。'}</p>
        <pre id="out">加载中…</pre>
        <script>
          fetch('/sample.mp4').then(function (r) { return r.blob(); }).then(function (blob) {
            var url = URL.createObjectURL(blob);
            var v = document.getElementById('v');
            v.src = url;
            document.getElementById('out').textContent = url;
            window.__testBlobUrl = url;
            ${revoke ? "setTimeout(function () { URL.revokeObjectURL(url); document.getElementById('out').textContent = url + '  [URL 已 revoke]'; }, 300);" : ''}
          }).catch(function (e) {
            document.getElementById('out').textContent = 'ERROR: ' + e.message;
          });
        </script>`));
    }

    if (urlPath === '/hls.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(page('场景 3 · HLS m3u8', `
        <video id="v" controls data-hls="/hls/index.m3u8"></video>
        <p>播放列表：<code>http://127.0.0.1:${PORT}/hls/index.m3u8</code></p>
        <p>扫描时会被识别为 HLS 源；下载 m3u8 + ts 分片并合并为完整视频。</p>
        <pre id="out">加载中…</pre>
        <script>
          var v = document.getElementById('v');
          var hlsUrl = '/hls/index.m3u8';
          if (v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = hlsUrl;
          }
          // 主动发起一次请求，让 performance 资源列表里出现 m3u8
          fetch(hlsUrl).then(function (r) { return r.text(); }).then(function (t) {
            document.getElementById('out').textContent = '播放列表内容：\\n' + t;
          });
        </script>`));
    }

    if (urlPath === '/fake-mse.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(page('场景 6 · 混入 MSE 伪源', `
        <video id="v" controls></video>
        <p>页面正常播放 sample.mp4（真 blob）。另造一个 MediaSource 伪源加入扫描列表，标为"测试·不可下载"。</p>
        <p>扫描会看到 2 条：真视频 blob（可下载）+ MSE 伪源（点它才提示"由 MediaSource 动态生成"）。</p>
        <pre id="out">加载中…</pre>
        <script>
          fetch('/sample.mp4').then(function (r) { return r.blob(); }).then(function (blob) {
            var url = URL.createObjectURL(blob);
            document.getElementById('v').src = url;
            document.getElementById('out').textContent = '正在播放的真实视频 blob: ' + url;
            try {
              var msUrl = URL.createObjectURL(new MediaSource());
              var mark = function () {
                if (window.videoCapture && window.videoCapture.markUnusable) {
                  window.videoCapture.markUnusable(msUrl, '测试·MSE 伪源（不可下载）');
                  return true;
                }
                return false;
              };
              if (!mark()) { var t = setInterval(function () { if (mark()) clearInterval(t); }, 100); }
            } catch (e) {}
          });
        </script>`));
    }

    if (urlPath === '/fake-script.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(page('场景 7 · 混入脚本伪源', `
        <video id="v" controls></video>
        <p>页面正常播放 sample.mp4（真 blob）。另造一个脚本 blob 伪源加入扫描列表，标为"测试·不可下载"。</p>
        <p>扫描会看到 2 条：真视频 blob（可下载）+ 脚本伪源（点它才提示"读取到的是页面文本"）。</p>
        <pre id="out">加载中…</pre>
        <script>
          fetch('/sample.mp4').then(function (r) { return r.blob(); }).then(function (blob) {
            var url = URL.createObjectURL(blob);
            document.getElementById('v').src = url;
            document.getElementById('out').textContent = '正在播放的真实视频 blob: ' + url;
            var code = '(function(){ window.__injected = true; })();';
            var scriptUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            var mark = function () {
              if (window.videoCapture && window.videoCapture.markUnusable) {
                window.videoCapture.markUnusable(scriptUrl, '测试·脚本伪源（不可下载）');
                return true;
              }
              return false;
            };
            if (!mark()) { var t = setInterval(function () { if (mark()) clearInterval(t); }, 100); }
          });
        </script>`));
    }

    // 静态文件，严格限制在 ROOT 目录内
    const filePath = path.resolve(ROOT, '.' + urlPath);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveFile(req, res, filePath);
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TEST SERVER READY  http://127.0.0.1:${PORT}/`);
});
