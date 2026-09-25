# 哔哩下载器 · GenshinplayerDom

B 站视频 / 音频下载器 —— 支持 Windows 客户端与 Android 端，内置本地代理、多线程分段加速、高清 DASH 音视频无损合并、账号登录解锁高清晰度。**当前版本 v1.2.0**。

> 本项目基于 **MIT License** 开源。请保留署名「GenshinplayerDom」，并遵循协议条款。

---

## ✨ 功能特性

- **链接智能提取**：支持 B 站网页链接、BV 号、av 号、番剧 / 分 P 视频，自动识别标题、UP 主、播放量、时长、分 P 列表
- **视频下载**：清晰度可选（360P ~ 4K，登录后解锁高清晰度）；高清档走 DASH 纯视频流 + 音频流，客户端内置 ffmpeg **无损合并**为 MP4
- **音频下载**：默认 M4A 原版音频直取（优良等级标注），可选 MP3 转码（128k / 192k / 320k）
- **编码偏好**：自动（兼容优先）/ H.264 / H.265 / AV1 可选，保证播放器兼容性的同时按需压缩
- **多线程加速**：4 ~ 16 线程可选，分片并发 + CDN 备用地址轮换（baseUrl / backupUrl），音视频流并行下载，显著提升大文件速率
- **多任务并发**：可同时下载多个视频 / 音频，各自独立进度，支持中途取消
- **下载记录**：历史记录持久保存，可打开文件 / 定位所在位置 / 删除文件 / 一键清空；主界面任务区本次会话保留
- **账号登录**：Windows 客户端应用内扫码登录；Android / 网页版粘贴 Cookie（含 SESSDATA）
- **内置代理**：本地代理统一处理 B 站风控（WBI 签名、buvid 身份、412 退避），Windows 首次启动自动初始化，异常可一键修复
- **断点缓存**：下载地址缓存（约 6 小时有效）自动复用，避免重复请求接口
- **批量下载**：多 P / 番剧多集一键顺序下载
- **附带下载**：弹幕 XML、字幕 SRT 与视频一并下载
- **信息导出**：视频信息 / 封面 / 摘要导出到下载目录（JSON + JPG）
- **视频片段**：按起止时间裁剪下载片段（客户端）
- **MKV 封装**：可选 MP4 / MKV 输出（客户端）
- **定时下载**：指定时间自动开始下载
- **收藏夹下载**：登录后直接读取收藏夹并解析下载（客户端 / 网页版）
- **设置迁移**：设置一键导出 / 导入为 JSON（含代理、线程、语言、主题、限速等）
- **界面语言 / 深色模式**：中英双语切换；浅色 / 深色外观
- **代理测速**：一键检测代理延迟
- **下载限速**：自定义 KB/s 限速（客户端）
- **播放器预览**：下载完成后直接预览视频
- **缓存锁定**：锁定下载地址缓存不过期
- **油猴脚本**：浏览器内直接下载（bilibili-downloader.user.js）

## 📦 平台支持

| 平台 | 形态 | 说明 |
|---|---|---|
| Windows | 安装包 / 便携版 zip | 完整功能（含 DASH 高清合并） |
| Android | APK | 直链下载，落系统「下载」目录；登录支持高清晰度 |

## 🚀 快速开始

### Windows

1. 下载安装包（`BiliDownloader-Setup-x.x.x.exe`）并安装，或解压便携版 zip 直接运行
2. 首次启动自动初始化本地代理（自动关闭多余弹窗）
3. 粘贴 B 站视频链接 → 选择类型 / 清晰度 / 线程数 → 点击下载
4. 需要更高清晰度时：设置 → 登录哔哩哔哩（应用内扫码）

### Android

1. 安装 APK，授予存储权限
2. 粘贴链接 → 选择类型与清晰度 → 下载（保存到系统「下载」目录）
3. 未登录通常仅 360P~480P；设置中粘贴 Cookie（含 SESSDATA）解锁高清晰度

## 🛠 技术架构

```
┌─────────────────────────────────────────────┐
│  前端界面 (HTML/CSS/JS)                      │
│  - 链接解析 · 任务管理 · 进度展示 · 设置     │
└──────────────────────┬──────────────────────┘
                       │ IPC (Electron)
┌──────────────────────┴──────────────────────┐
│  主进程 (Node.js)                            │
│  - 多线程分段下载 (4~16)                     │
│  - CDN 备用地址轮换                          │
│  - ffmpeg DASH 无损合并                      │
│  - 下载历史持久化 (原子写入)                 │
└──────────────────────┬──────────────────────┘
                       │ HTTP 127.0.0.x:8123
┌──────────────────────┴──────────────────────┐
│  本地代理 (Node.js)                          │
│  - WBI 签名 · buvid 身份 · 登录 Cookie 注入  │
│  - 412 风控退避 · Range 流式转发             │
└─────────────────────────────────────────────┘
```

## 🔨 本地构建

```bash
# 安装依赖
npm install

# Windows 打包（asar + NSIS + zip 备用链路）
node_modules/.bin/asar pack src dist/win-unpacked/resources/app.asar
makensis install.nsi
cd dist && zip -r BiliDownloader-win32-x64.zip win-unpacked

# Android
cd android-project
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleRelease
```

## ⚖️ License

[MIT](LICENSE) © GenshinplayerDom

```
MIT License

Copyright (c) 2026 GenshinplayerDom

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
