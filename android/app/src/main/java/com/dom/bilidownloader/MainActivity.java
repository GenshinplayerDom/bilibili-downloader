package com.dom.bilidownloader;

import android.app.Activity;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 哔哩下载器 · Android 主界面
 * WebView 加载本地页面；shouldInterceptRequest 拦截 127.0.0.1:8123 请求，
 * 由 BiliProxy 完成 B 站 API 代理（绕过 CORS / 风控 / 补全设备身份）。
 * 原生桥（window.biliAPI）：
 *   - isAndroid / download(url, filename, cbId)  大文件流式下载到系统下载目录
 *   - saveStart / saveChunk / saveFinish          小文件（MP3 转码结果）分段保存
 */
public class MainActivity extends Activity {

    private WebView webView;
    private final BiliProxy proxy = new BiliProxy();
    private CookieVault cookieVault;
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cookieVault = new CookieVault(this);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 本地 file 页面允许发起网络请求到本机代理（127.0.0.1:8123），避免 CORS/同源限制
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUserAgentString(s.getUserAgentString() + " BiliDownloader/1.1.4");

        // 控制台日志写入文件，便于真机排查
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                try {
                    java.io.File f = new java.io.File(getExternalFilesDir(null), "webview.log");
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(f, true);
                    fos.write(("[" + cm.messageLevel() + "] " + cm.message() + " (line " + cm.lineNumber() + ")\n")
                            .getBytes(StandardCharsets.UTF_8));
                    fos.close();
                } catch (Exception ignored) { }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().equals(APP_ORIGIN + "/index.html");
            }
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    return intercept(request.getUrl().toString(), request.getMethod(),
                            request.getRequestHeaders(), null);
                } catch (Throwable t) {
                    return null;
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                try {
                    java.io.File f = new java.io.File(getExternalFilesDir(null), "webview.log");
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(f, true);
                    fos.write(("ERROR " + error.getErrorCode() + " " + error.getDescription()
                            + " url=" + request.getUrl() + "\n").getBytes(StandardCharsets.UTF_8));
                    fos.close();
                } catch (Exception ignored) { }
                if (request.isForMainFrame()) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "页面加载失败（" + error.getErrorCode() + "），请截图反馈：Android/data/com.dom.bilidownloader/files/webview.log",
                            Toast.LENGTH_LONG).show());
                }
            }
        });

        // 原生桥挂到 window.biliAPI（与 Electron preload 同名，页面逻辑自动识别）
        webView.addJavascriptInterface(new AndroidBridge(), "biliAPI");

        // 恢复上次登录 Cookie
        try {
            String saved = cookieVault.load();
            if (!saved.isEmpty()) {
                Map<String, String> ck = new LinkedHashMap<>();
                for (String seg : saved.split(";")) {
                    int i = seg.indexOf('=');
                    if (i > 0) ck.put(seg.substring(0, i).trim(), seg.substring(i + 1).trim());
                }
                proxy.setUserCookies(ck);
            }
        } catch (Exception ignored) { }

        // 后台预热设备身份，避免首次 /status 变慢
        new Thread(() -> {
            try { proxy.ensureBuvid(false); } catch (Exception ignored) { }
        }).start();

        // 使用 file:// 加载本地页面（兼容性最佳；已放开 file 页面网络访问）
        webView.loadUrl(APP_ORIGIN + "/index.html");
    }

    /* ---------- 代理拦截 ---------- */
    private WebResourceResponse intercept(String url, String method, Map<String, String> headers, byte[] body) {
        if (!url.startsWith(APP_ORIGIN + "/")) return null;
        String pathQuery = url.substring(APP_ORIGIN.length());
        if (!pathQuery.startsWith("/proxy/")) {
            String asset = pathQuery.substring(1);
            if (!java.util.Arrays.asList("index.html", "app.js", "styles.css", "lame.min.js").contains(asset)) return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            try {
                String mime = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html";
                return new WebResourceResponse(mime, "UTF-8", getAssets().open(asset));
            } catch (IOException error) { return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0])); }
        }
        pathQuery = pathQuery.substring("/proxy".length());
        int q = pathQuery.indexOf('?');
        String path = q < 0 ? pathQuery : pathQuery.substring(0, q);
        String query = q < 0 ? null : pathQuery.substring(q + 1);

        BiliProxy.Result r = proxy.handle(method, path, query, headers, body);
        Map<String, String> outHeaders = new LinkedHashMap<>(r.headers);
        if (!r.isStream) {
            // 普通 JSON 响应（加 CORS 头，页面 fetch 127.0.0.1 跨源可读）
            outHeaders.put("Access-Control-Allow-Origin", APP_ORIGIN);
            outHeaders.put("Access-Control-Allow-Private-Network", "true");
            outHeaders.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            outHeaders.put("Access-Control-Allow-Headers", "Range, Content-Type");
            outHeaders.put("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Bili-Retry");
        }
        if (r.isStream) {
            // 流式响应（媒体分段）；连接在流关闭时由 WebResourceResponse 管理
            InputStream is = r.stream == null ? new ByteArrayInputStream(new byte[0]) : r.stream;
            final HttpURLConnection conn = r.streamConn;
            InputStream wrapped = new InputStream() {
                @Override
                public int read() throws IOException { return is.read(); }
                @Override
                public int read(byte[] b, int off, int len) throws IOException { return is.read(b, off, len); }
                @Override
                public void close() throws IOException {
                    try { is.close(); } finally { if (conn != null) conn.disconnect(); }
                }
            };
            return new WebResourceResponse(
                    r.streamMime != null ? r.streamMime : "application/octet-stream",
                    null, r.status, statusReason(r.status), outHeaders, wrapped);
        }
        // 普通 JSON 响应（加 CORS 头，页面 fetch 127.0.0.1 跨源可读）
        return new WebResourceResponse(
                r.mime != null ? r.mime : "application/json; charset=utf-8",
                null, r.status, statusReason(r.status), outHeaders,
                new ByteArrayInputStream(r.body));
    }

    private static String statusReason(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 412: return "Precondition Failed";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            default: return "Status " + code;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    /* ---------- 原生桥 ---------- */
    private class AndroidBridge {

        @JavascriptInterface
        public boolean isAndroid() { return true; }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        /** 登录 Cookie 直存（拦截层无法读 POST body）：设置并持久化 */
        @JavascriptInterface
        public void setCookies(String json) {
            try {
                BiliProxy.JSON j = BiliProxy.JSON.parse(json);
                Map<String, String> map = new LinkedHashMap<>();
                if (j != null) {
                    for (String k : j.keys()) map.put(k, j.str(k));
                }
                proxy.setUserCookies(map);
                StringBuilder sb = new StringBuilder();
                for (Map.Entry<String, String> e : map.entrySet()) {
                    if (sb.length() > 0) sb.append(';');
                    sb.append(e.getKey()).append('=').append(e.getValue());
                }
                cookieVault.save(sb.toString());
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void clearCookies() {
            proxy.clearUserCookies();
            cookieVault.clear();
        }

        /** 大文件下载：原生流式下载到系统下载目录，进度/完成回调页面 cbId */
        @JavascriptInterface
        public void download(final String url, final String filename, final String cbId) {
            new Thread(() -> {
                HttpURLConnection conn = null;
                try {
                    URL target = UrlPolicy.validate(url, "media");
                    conn = (HttpURLConnection) target.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
                    conn.setRequestProperty("Referer", "https://www.bilibili.com/");
                    String ck = proxy.buildCookie();
                    if (UrlPolicy.api(target) && !ck.isEmpty()) conn.setRequestProperty("Cookie", ck);
                    int status = conn.getResponseCode();
                    if (status != 200) {
                        jsCall(cbId, "onDone", "false", "\"HTTP " + status + "\"");
                        return;
                    }
                    long total = conn.getContentLengthLong();
                    InputStream is = new BufferedInputStream(conn.getInputStream());
                    PendingFile pf = createPendingFile(filename);
                    OutputStream os = getContentResolver().openOutputStream(pf.uri);
                    byte[] buf = new byte[64 * 1024];
                    long got = 0;
                    int n;
                    try {
                        while ((n = is.read(buf)) != -1) {
                            os.write(buf, 0, n);
                            got += n;
                            if (total > 0) {
                                final double frac = (double) got / total;
                                jsCall(cbId, "onProgress", String.valueOf(frac), "");
                            }
                        }
                        os.flush();
                    } finally {
                        os.close();
                        is.close();
                    }
                    if (total >= 0 && got != total) throw new IOException("下载文件不完整");
                    pf.markDone();
                    jsCall(cbId, "onDone", "true", "\"已保存到下载目录：" + filename + "\"");
                } catch (Exception e) {
                    jsCall(cbId, "onDone", "false", "\"" + esc(String.valueOf(e.getMessage())) + "\"");
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }).start();
        }

        /** MP3 转码结果分段保存：开始 */
        private int chunkSeq = 0;
        private OutputStream chunkOs;
        private PendingFile chunkPf;
        private String chunkFilename;

        @JavascriptInterface
        public void saveStart(final String filename, final int totalChunks, final String cbId) {
            try {
                chunkFilename = filename;
                chunkPf = createPendingFile(filename);
                chunkOs = getContentResolver().openOutputStream(chunkPf.uri);
                chunkSeq = 0;
                jsCall(cbId, "onProgress", "0", "");
            } catch (Exception e) {
                jsCall(cbId, "onDone", "false", "\"无法创建文件\"");
            }
        }

        @JavascriptInterface
        public void saveChunk(final String b64) {
            try {
                if (chunkOs == null) return;
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                chunkOs.write(data);
                chunkSeq++;
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void saveFinish(final String cbId, final boolean ok) {
            try {
                if (chunkOs != null) { chunkOs.flush(); chunkOs.close(); chunkOs = null; }
                if (ok && chunkPf != null) chunkPf.markDone();
                jsCall(cbId, "onDone", ok ? "true" : "false", ok ? "\"已保存到下载目录：" + chunkFilename + "\"" : "\"保存失败\"");
            } catch (Exception e) {
                jsCall(cbId, "onDone", "false", "\"保存失败\"");
            }
        }

        /** 打开下载目录中的文件（按文件名，Android 10+ 走 MediaStore） */
        @JavascriptInterface
        public void openFile(final String filename) {
            runOnUiThread(() -> {
                try {
                    Uri uri = findDownloadUri(filename);
                    if (uri == null) {
                        Toast.makeText(MainActivity.this, "文件不存在：" + filename, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(uri, mimeOf(filename));
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(intent, "打开文件"));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "无法打开文件：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 打开文件所在位置：Android 10+ 打开系统「下载」目录；旧版打开目录路径 */
        @JavascriptInterface
        public void openFolder(final String filename) {
            runOnUiThread(() -> {
                try {
                    Intent intent;
                    if (Build.VERSION.SDK_INT >= 29) {
                        intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload"),
                                "vnd.android.document/root");
                    } else {
                        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                        intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(Uri.fromFile(dir), "resource/folder");
                    }
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(intent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "无法打开下载目录", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 删除下载目录中的文件；返回是否成功 */
        @JavascriptInterface
        public boolean deleteFile(final String filename) {
            try {
                UrlPolicy.filename(filename);
                if (!getSharedPreferences("managed_downloads", MODE_PRIVATE).contains(filename)) return false;
                if (Build.VERSION.SDK_INT >= 29) {
                    Uri uri = findDownloadUri(filename);
                    if (uri == null) return false;
                    int n = getContentResolver().delete(uri, null, null);
                    if (n > 0) getSharedPreferences("managed_downloads", MODE_PRIVATE).edit().remove(filename).apply();
                    return n > 0;
                }
                File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), filename);
                boolean removed = f.exists() && f.delete();
                if (removed) getSharedPreferences("managed_downloads", MODE_PRIVATE).edit().remove(filename).apply();
                return removed;
            } catch (Exception ignored) { }
            return false;
        }

        private Uri findDownloadUri(String filename) {
            try { UrlPolicy.filename(filename); } catch (IOException error) { return null; }
            if (!getSharedPreferences("managed_downloads", MODE_PRIVATE).contains(filename)) return null;
            if (Build.VERSION.SDK_INT >= 29) {
                String saved = getSharedPreferences("managed_downloads", MODE_PRIVATE).getString(filename, "");
                return saved.startsWith("content://media/") ? Uri.parse(saved) : null;
            }
            File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), filename);
            return f.exists() ? Uri.fromFile(f) : null;
        }

        /** 待完成文件（Android 10+ 用 MediaStore pending 机制） */
        private class PendingFile {
            final Uri uri;
            final File legacyFile;
            final String name;
            PendingFile(Uri u, File f, String n) { uri = u; legacyFile = f; name = n; }
            void markDone() {
                getSharedPreferences("managed_downloads", MODE_PRIVATE).edit().putString(name, uri.toString()).apply();
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.Downloads.IS_PENDING, 0);
                    try { getContentResolver().update(uri, done, null, null); } catch (Exception ignored) { }
                }
            }
        }

        private PendingFile createPendingFile(String filename) throws IOException {
            UrlPolicy.filename(filename);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                cv.put(MediaStore.Downloads.MIME_TYPE, mimeOf(filename));
                cv.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new IOException("MediaStore insert failed");
                return new PendingFile(uri, null, filename);
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, filename);
            if (!f.createNewFile()) throw new IOException("同名文件已存在，请重命名后下载");
            return new PendingFile(Uri.fromFile(f), f, filename);
        }

        private String mimeOf(String name) {
            String n = name.toLowerCase();
            if (n.endsWith(".mp4")) return "video/mp4";
            if (n.endsWith(".m4a")) return "audio/mp4";
            if (n.endsWith(".mp3")) return "audio/mpeg";
            return "application/octet-stream";
        }

        private void jsCall(final String cbId, final String fn, final String arg1, final String arg2) {
            if (!cbId.matches("[a-zA-Z0-9_]+")) return;
            runOnUiThread(() -> {
                if (webView != null) {
                    String js = "window.__dlCbs && window.__dlCbs['" + cbId + "'] && window.__dlCbs['" + cbId + "']." + fn + "(" + arg1 + (arg2.isEmpty() ? "" : "," + arg2) + ");";
                    webView.evaluateJavascript(js, null);
                }
            });
        }

        private String esc(String s) {
            if (s == null) return "";
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        }
    }
}
