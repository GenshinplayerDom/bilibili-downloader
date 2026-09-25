# 哔哩下载器 · GenshinplayerDom

B 站视频 / 音频下载器。Windows 使用 Electron，Android 使用原生 WebView 和下载桥，另附油猴脚本。当前开发版本 **1.3.0**，原作者 Dom，MIT License。

> 本项目基于 **MIT License** 开源。请保留署名「GenshinplayerDom」，并遵循协议条款。

- **暂停 / 继续**：桌面端 DASH、直链 MP4 和原版 M4A 下载保留已完成分片，继续时下载剩余部分。
- **一键重试**：失败或取消后重新获取下载地址，保留任务原有的视频、分 P 和设置。
- **同名保护**：桌面端自动追加 `(1)`、`(2)`，并发任务不会覆盖已有文件。
- **下载可靠性**：分片严格校验、备用地址重试、超时、取消和全局连接上限。
- **安全修复**：代理鉴权、请求域名限制、Cookie 加密、标题转义、页面隔离及文件操作限制。

详细变更见 [CHANGELOG.md](CHANGELOG.md)，实际完成范围见 [ROADMAP.md](ROADMAP.md)。

## 现有功能

视频 / 音频解析和下载、分 P 顺序下载、编码与清晰度选择、下载历史、M4A 直存、MP3 转码、字幕 / 弹幕附带下载、封面与信息导出、MP4 / MKV 封装、片段裁剪、定时开始、限速、主题和设置导入导出。

功能与视频源、平台及账号权限有关。登录不意味着可以获取账号本身没有权限观看的内容。

| 能力 | Windows | Android / 浏览器 |
| --- | --- | --- |
| 原版音频、直链视频 | 支持 | 支持 |
| DASH 视频与音轨合并 | 内置 FFmpeg | 尚不支持 |
| 暂停 / 继续 | 下载阶段支持 | 尚不支持 |
| MP3 转码 | 支持，转码阶段不支持暂停 | 取决于 Web Audio 能力 |
| Cookie 持久化 | 系统加密存储 | Android Keystore；独立网页代理仅内存 |
| 收藏夹 | 当前仍只加载首批列表 | 同左 |

暂停状态仅保留到本次应用退出。**跨重启续传尚未实现**。合并阶段可以取消，不能暂停；重试会重新开始任务。浏览器 MP3 转码仍会占用较多内存。

## 本地运行

需要 Node.js **22.12 或更新版本**：

```powershell
npm ci
npm start
```

Windows 启动后粘贴视频链接。桌面端登录位于设置中；原有明文 Cookie 会迁移至加密存储。系统加密服务不可用时，账号只保留在本次进程内，不再写入明文文件。

单独运行网页版：

```powershell
node server.js
```

然后打开 `http://127.0.0.1:8123/`。代理页面会提供本次会话的认证令牌；不要直接双击 `index.html`。独立代理退出后需要重新登录。内置代理端口被其他程序占用时，请关闭冲突的代理实例后在设置中重启代理。

[MIT](LICENSE) © GenshinplayerDom

```powershell
npm test
npm run assets:android
npm run check
npm run smoke
npm run dist:win
```

Copyright (c) 2026 GenshinplayerDom

FFmpeg 会随依赖安装，并复制到打包后的 `resources/`。其二进制许可证及对应源码信息一并附在 `ffmpeg.LICENSE`、`ffmpeg.README`；项目自身的 MIT 协议不替代第三方组件协议。

## Android 构建

需要 JDK 17 或 21、Android SDK Platform 34 和 Build Tools 34。先同步前端文件：

```powershell
npm run assets:android
$env:JAVA_HOME = '你的 JDK 路径'
$env:ANDROID_HOME = '你的 Android SDK 路径'
cd android
.\gradlew.bat :app:assembleDebug
```

调试 APK：`android/app/build/outputs/apk/debug/app-debug.apk`。

Linux / macOS 使用 `bash ./gradlew :app:assembleDebug`。Wrapper 使用 Gradle 8.7，分发包配置了 SHA-256 校验。

发布构建可通过 `BILI_KEYSTORE`、`BILI_STORE_PASSWORD`、`BILI_KEY_ALIAS`、`BILI_KEY_PASSWORD` 提供自己的签名，再运行 `:app:assembleRelease`。未配置时生成未签名的 release APK；仓库不包含签名密钥或密码。

## 代码结构

- `app.js` / `index.html` / `styles.css`：共用前端。
- `main.js` / `preload.js`：Electron 生命周期、IPC 和文件权限。
- `server.js`：带鉴权的本地代理、WBI 和设备身份处理。
- `lib/downloader.js`：分片下载、校验、重试、暂停 / 取消与连接池。
- `lib/security.js` / `lib/cookie-store.js`：地址、文件和凭据边界。
- `android/`：Android 工程；assets 由 `npm run assets:android` 同步。
- `tests/` / `scripts/smoke.cjs`：核心与界面回归验证。

## License

[MIT](LICENSE) © Dom。请保留原作者署名与许可证。