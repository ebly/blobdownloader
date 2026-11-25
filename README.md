# BlobDownloader

基于 Electron 的视频资源下载工具，支持 HTTP(S) 直链、Blob URL 与 HLS(m3u8) 流，带内置浏览器用于在视频页面上下文中读取 Blob。

## 功能

- **HTTP(S) 直链**：流式写盘，支持 Range 断点续传、重定向、超时重试、背压控制。
- **Blob URL**：在内置浏览器中打开视频页，递归扫描（含 ShadowRoot / iframe）video 源，在本页上下文分块读取 Blob 后回传主进程写盘；页面 revoke 后仍可读。
- **HLS(m3u8)**：拉取播放列表、下载 ts 分片并顺序合并，默认用 `bin/ffmpeg.exe` 无损封装为 mp4。
- **多任务**：扫描结果复选框多选，多个源并发下载，每个任务独立进度/暂停/取消。
- **安全校验**：拒绝把网页/脚本等非视频内容误存成视频；识别 MediaSource 动态流并给出明确提示。
- 本地保存目录与文件名选择、重名处理、完成/失败提示、实时速度与剩余时间。

## 启动

```bash
npm install
npm start
```

若环境设置了 `ELECTRON_RUN_AS_NODE=1`，需先清除：

```bash
env -u ELECTRON_RUN_AS_NODE npx electron .
```

## HLS 转 mp4

默认扩展名 `.mp4` 时，HLS 下载完成后会调用 `bin/ffmpeg.exe` 将合并的 ts 无损封装为 mp4（`-c copy`，不重新编码）。把 ffmpeg.exe 放到项目根目录的 `bin/` 下即可；没有 ffmpeg 时会保留 `.ts` 文件。填 `.ts` 扩展名则跳过转换。

## 本地测试

```bash
node testdata/testserver.js
```

首次运行需先生成测试素材（用项目自带的 `bin/ffmpeg.exe`，或系统 ffmpeg）：

```bash
mkdir -p testdata/hls
ffmpeg -y -f lavfi -i testsrc2=duration=12:size=640x360:rate=25 -f lavfi -i sine=frequency=440:duration=12 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest testdata/sample.mp4
ffmpeg -y -i testdata/sample.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_filename "testdata/hls/seg_%03d.ts" testdata/hls/index.m3u8
```

然后访问 `http://127.0.0.1:8765/`，测试中心包含：MP4 直链、Blob URL、已 revoke 的 Blob、HLS、ShadowRoot 内嵌 iframe 的 Blob、多视频源、假 MSE/脚本源等场景。测试素材由 ffmpeg 生成（彩条 + 正弦音），为合法素材。二进制素材（sample.mp4、ts 分片）未纳入仓库，按上面命令生成即可。

## 项目结构

```
main.js                      主进程：窗口、IPC、HLS 转码调度
preload.js                   主窗口安全桥接
src/main/
  download-manager.js        任务状态机、并发、事件推送、内容校验
  http-downloader.js         HTTP(S) 流式下载与断点续传
  hls-downloader.js          m3u8 解析、ts 分片下载与合并
  blob-downloader.js         Blob 数据帧写盘
  file-utils.js              文件名清理、重名处理、内容检测
src/renderer/
  index.html / styles.css    界面
  app.js                     多任务 UI、内置浏览器、扫描与下载
  webview-preload.js         guest 页注入：扫描、Blob hook、分块回传
testdata/                    本地测试服务器与素材
verify-e2e.js                端到端回归脚本（Electron）
```

## 说明

Blob URL 与创建它的页面上下文绑定，工具只能在内置浏览器当前页面上下文中读取；跨页面需重新打开并扫描。MediaSource（MSE）动态流不是完整文件，无法直接下载，请使用 m3u8 走 HLS 下载。
