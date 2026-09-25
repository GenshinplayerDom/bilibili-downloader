# Android

原生 WebView 客户端，加载本地 HTTPS 资源域名；API 和媒体请求经原生代理处理。登录凭据使用 Android Keystore 加密。

完整运行、构建、签名与功能限制说明见 [根目录 README](../README.md#android-构建)。

先在根目录执行 `npm run assets:android`，再在此目录执行 `gradlew.bat :app:assembleDebug`（Windows）或 `bash ./gradlew :app:assembleDebug`（Linux / macOS）。

前端源文件位于根目录，请勿单独修改 `app/src/main/assets/`。当前不包含原生 DASH 合并，也不包含发布签名密钥。