package com.dom.bilidownloader;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 哔哩下载器 · Android 内置代理层（替代 Node server.js）
 *
 * 职责：
 *   - 维护设备身份（buvid3/buvid4 + bili_ticket + WBI 密钥）
 *   - 转发 B 站 API（带身份、≥250ms 节流、412 自动换身份重试）
 *   - 流式转发媒体（透传 Range，供页面多线程分段并发）
 *   - 用户登录 Cookie 存取（设置页粘贴 SESSDATA 等）
 * 与 server.js 端点完全对齐：/status /api /stream /fix /expand /login-cookies /login-logout
 */
public class BiliProxy {

    private static final String UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    private static final String TICKET_KEY = "XgwSnGZ1p";
    private static final int PORT = 8123;
    private static final long TICKET_TTL = 3600_000L;

    private volatile String buvid3 = "";
    private volatile String buvid4 = "";
    private volatile String biliTicket = "";
    private volatile String wbiKey = "";
    private volatile long expireAt = 0L;

    private volatile String userCookie = "";      // 用户登录 Cookie 串（SESSDATA=…; bili_jct=…）
    private volatile String userUid = "";         // DedeUserID

    private final Object gateLock = new Object();
    private long lastGate = 0L;

    /* ---------- 结果封装 ---------- */
    public static class Result {
        public int status = 200;
        public String reason = "OK";
        public String mime = "application/json; charset=utf-8";
        public Map<String, String> headers = new LinkedHashMap<>();
        public byte[] body = new byte[0];          // 小响应
        public InputStream stream = null;           // 大响应（流式）
        public long streamLength = -1;
        public String streamMime = null;
        public boolean isStream = false;
        public HttpURLConnection streamConn = null; // 流式连接（消费完后关闭）
    }

    /* ---------- 登录 Cookie ---------- */
    public synchronized void setUserCookies(Map<String, String> cookies) {
        if (cookies == null) cookies = new HashMap<>();
        StringBuilder sb = new StringBuilder();
        String uid = "";
        for (Map.Entry<String, String> e : cookies.entrySet()) {
            if (e.getValue() == null || e.getValue().isEmpty()) continue;
            if (e.getKey().equalsIgnoreCase("DedeUserID")) uid = e.getValue();
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        userCookie = sb.toString();
        userUid = uid;
    }

    public synchronized void clearUserCookies() {
        userCookie = "";
        userUid = "";
    }

    public boolean isLogged() {
        return !userCookie.isEmpty() && !userUid.isEmpty();
    }

    /* ---------- 身份 ---------- */
    public String buildCookie() {
        StringBuilder sb = new StringBuilder();
        if (!buvid3.isEmpty()) sb.append("buvid3=").append(buvid3).append(';');
        if (!buvid4.isEmpty()) sb.append("buvid4=").append(buvid4).append(';');
        if (!biliTicket.isEmpty()) sb.append("bili_ticket=").append(biliTicket).append(';');
        if (!userCookie.isEmpty()) sb.append(' ').append(userCookie);
        return sb.toString();
    }

    private Map<String, String> baseHeaders(String referer) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", UA);
        h.put("Referer", referer == null ? "https://www.bilibili.com/" : referer);
        h.put("Accept", "*/*");
        h.put("Accept-Language", "zh-CN,zh;q=0.9");
        String ck = buildCookie();
        if (!ck.isEmpty()) h.put("Cookie", ck);
        return h;
    }

    /** GET 请求，返回 (status, headers, body) */
    private static class Resp { int status; Map<String, String> headers; byte[] body; }

    private Resp httpsGet(String url, Map<String, String> headers) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            for (Map.Entry<String, String> e : headers.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
            int status = conn.getResponseCode();
            Map<String, String> out = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty())
                    out.put(e.getKey().toLowerCase(), e.getValue().get(0));
            }
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (is != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                is.close();
            }
            Resp r = new Resp();
            r.status = status;
            r.headers = out;
            r.body = bos.toByteArray();
            return r;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private Resp httpsPost(String url, Map<String, String> headers) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST");
            for (Map.Entry<String, String> e : headers.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(0);
            conn.getOutputStream().close();
            int status = conn.getResponseCode();
            Map<String, String> out = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty())
                    out.put(e.getKey().toLowerCase(), e.getValue().get(0));
            }
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (is != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                is.close();
            }
            Resp r = new Resp();
            r.status = status;
            r.headers = out;
            r.body = bos.toByteArray();
            return r;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 获取 bili_ticket + WBI 密钥（GenWebTicket，与 server.js 相同算法） */
    private void fetchBiliTicket() throws IOException {
        long ts = System.currentTimeMillis() / 1000;
        String hexsign = hmacSha256(TICKET_KEY, "ts" + ts);
        String url = "https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket"
                + "?key_id=ec02&hexsign=" + hexsign
                + "&context%5Bts%5D=" + ts + "&csrf=";
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", UA);
        h.put("Referer", "https://www.bilibili.com/");
        h.put("Content-Type", "application/x-www-form-urlencoded");
        try {
            Resp r = httpsPost(url, h);
            String s = new String(r.body, StandardCharsets.UTF_8);
            JSON j = JSON.parse(s);
            JSON data = j != null ? j.obj("data") : null;
            JSON nav = data != null ? data.obj("nav") : null;
            if (data != null && data.str("ticket") != null) biliTicket = data.str("ticket");
            if (nav != null) {
                String imgUrl = nav.str("img_url") != null ? nav.str("img_url") : nav.str("img");
                String subUrl = nav.str("sub_url") != null ? nav.str("sub_url") : nav.str("sub");
                String img = fileBase(imgUrl);
                String sub = fileBase(subUrl);
                if (!img.isEmpty() && !sub.isEmpty()) wbiKey = img + sub;
            }
        } catch (Exception e) {
            // 票据失败不致命，保留已有身份
        }
    }

    private static String fileBase(String url) {
        if (url == null) return "";
        String p = url;
        int q = p.indexOf('?');
        if (q >= 0) p = p.substring(0, q);
        int sl = p.lastIndexOf('/');
        if (sl >= 0) p = p.substring(sl + 1);
        int dot = p.lastIndexOf('.');
        if (dot > 0) p = p.substring(0, dot);
        return p;
    }

    private static String hmacSha256(String key, String msg) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] out = mac.doFinal(msg.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : out) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 确保设备身份就绪（无身份或过期时重新获取） */
    public synchronized void ensureBuvid(boolean force) throws IOException {
        long now = System.currentTimeMillis();
        if (!force && !buvid3.isEmpty() && expireAt > now) return;
        Resp r = httpsGet("https://api.bilibili.com/x/frontend/finger/spi", baseHeaders("https://www.bilibili.com/"));
        JSON j = JSON.parse(new String(r.body, StandardCharsets.UTF_8));
        JSON d = j != null ? j.obj("data") : null;
        if (d != null) {
            if (d.str("b_3") != null) buvid3 = d.str("b_3");
            if (d.str("b_4") != null) buvid4 = d.str("b_4");
        }
        fetchBiliTicket();
        expireAt = now + TICKET_TTL;
    }

    /** 重置设备身份（412 风控 / 一键修复） */
    public synchronized void resetBuvid() throws IOException {
        buvid3 = "";
        buvid4 = "";
        biliTicket = "";
        wbiKey = "";
        expireAt = 0;
        ensureBuvid(true);
    }

    /* ---------- 节流（串行 + ≥250ms） ---------- */
    private void gate() {
        synchronized (gateLock) {
            long wait = 250 - (System.currentTimeMillis() - lastGate);
            if (wait > 0) {
                try { Thread.sleep(wait); } catch (InterruptedException ignored) { }
            }
            lastGate = System.currentTimeMillis();
        }
    }

    /* ---------- 短链展开 ---------- */
    private String expand(String url, int depth) throws IOException {
        if (depth > 6) return url;
        Resp r = httpsGet(url, baseHeaders(null));
        if (r.status >= 300 && r.status < 400 && r.headers.get("location") != null) {
            String loc = r.headers.get("location");
            if (loc.startsWith("http://") || loc.startsWith("https://")) return expand(loc, depth + 1);
            try {
                URL u = new URL(url);
                return expand(u.getProtocol() + "://" + u.getHost() + loc, depth + 1);
            } catch (Exception e) {
                return url;
            }
        }
        return url;
    }

    /* ---------- 主处理入口（shouldInterceptRequest 调用） ---------- */
    public Result handle(String method, String path, String query, Map<String, String> reqHeaders, byte[] postBody) {
        Result res = new Result();
        try {
            if (path == null) path = "/";
            if (path.equals("/status")) {
                // 不阻塞：身份未就绪时异步初始化，立即返回当前状态（页面 2s 自动重检）
                if (buvid3.isEmpty()) {
                    new Thread(() -> {
                        try { ensureBuvid(false); } catch (Exception ignored) { }
                    }).start();
                }
                res.status = 200;
                res.mime = "application/json; charset=utf-8";
                res.body = ("{\"ok\":true,\"port\":" + PORT + ",\"login\":{\"logged\":" + isLogged()
                        + ",\"uid\":\"" + jsonEsc(userUid) + "\",\"hasSessdata\":" + (!userCookie.isEmpty())
                        + "},\"identity\":{\"buvid3\":\"" + shortId(buvid3) + "\",\"buvid4\":\"" + (buvid4.isEmpty() ? "" : "yes")
                        + "\",\"bili_ticket\":\"" + (biliTicket.isEmpty() ? "no" : "yes")
                        + "\",\"wbi_key\":\"" + wbiKey + "\"}}").getBytes(StandardCharsets.UTF_8);
                return res;
            }
            if (path.equals("/login-cookies")) {
                if ("POST".equalsIgnoreCase(method)) {
                    Map<String, String> cookies = new HashMap<>();
                    String s = new String(postBody == null ? new byte[0] : postBody, StandardCharsets.UTF_8);
                    JSON j = JSON.parse(s);
                    JSON c = j != null ? j.obj("cookies") : null;
                    if (c != null) {
                        for (String k : c.keys()) cookies.put(k, c.str(k));
                    }
                    setUserCookies(cookies);
                }
                res.mime = "application/json; charset=utf-8";
                res.body = ("{\"ok\":true,\"login\":{\"logged\":" + isLogged()
                        + ",\"uid\":\"" + jsonEsc(userUid) + "\",\"hasSessdata\":" + (!userCookie.isEmpty()) + "}}")
                        .getBytes(StandardCharsets.UTF_8);
                return res;
            }
            if (path.equals("/login-logout")) {
                clearUserCookies();
                res.mime = "application/json; charset=utf-8";
                res.body = ("{\"ok\":true,\"login\":{\"logged\":false,\"uid\":\"\",\"hasSessdata\":false}}").getBytes(StandardCharsets.UTF_8);
                return res;
            }
            if (path.equals("/fix")) {
                StringBuilder logs = new StringBuilder();
                try {
                    ensureBuvid(false);
                    logs.append("设备身份检查完成（buvid3=").append(shortId(buvid3)).append("，buvid4=").append(buvid4.isEmpty() ? "无" : "有").append("）\\n");
                    resetBuvid();
                    logs.append("已重置设备身份，生成全新 buvid3/buvid4\\n");
                    logs.append("票据检查：bili_ticket=").append(biliTicket.isEmpty() ? "缺失" : "正常")
                            .append("，WBI 密钥=").append(wbiKey.isEmpty() ? "缺失" : "正常").append("\\n");
                    logs.append("修复完成，可重新提取链接");
                    res.mime = "application/json; charset=utf-8";
                    res.body = ("{\"ok\":true,\"logs\":[\"" + logs.toString() + "\"],\"login\":{\"logged\":"
                            + isLogged() + ",\"uid\":\"" + jsonEsc(userUid) + "\",\"hasSessdata\":" + (!userCookie.isEmpty()) + "}}")
                            .getBytes(StandardCharsets.UTF_8);
                } catch (Exception e) {
                    res.status = 500;
                    res.mime = "application/json; charset=utf-8";
                    res.body = ("{\"ok\":false,\"logs\":[\"修复失败：" + jsonEsc(String.valueOf(e.getMessage())) + "\"],\"error\":\"修复失败\"}")
                            .getBytes(StandardCharsets.UTF_8);
                }
                return res;
            }
            if (path.equals("/expand")) {
                String u = queryParam(query, "url");
                if (u == null) { res.status = 400; res.mime = "application/json; charset=utf-8"; res.body = "{\"ok\":false,\"error\":\"缺少 url 参数\"}".getBytes(StandardCharsets.UTF_8); return res; }
                try {
                    String finalUrl = expand(u, 0);
                    res.mime = "application/json; charset=utf-8";
                    res.body = ("{\"ok\":true,\"finalUrl\":\"" + jsonEsc(finalUrl) + "\"}").getBytes(StandardCharsets.UTF_8);
                } catch (Exception e) {
                    res.status = 502;
                    res.mime = "application/json; charset=utf-8";
                    res.body = ("{\"ok\":false,\"error\":\"展开失败\"}").getBytes(StandardCharsets.UTF_8);
                }
                return res;
            }
            if (path.equals("/api")) {
                String u = queryParam(query, "url");
                if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) {
                    res.status = 400;
                    res.mime = "application/json; charset=utf-8";
                    res.body = "{\"ok\":false,\"error\":\"缺少有效的 url 参数\"}".getBytes(StandardCharsets.UTF_8);
                    return res;
                }
                try {
                    ensureBuvid(false);
                    Resp r = biliGet(u);   // 内建 412 递增退避 + 换身份重试
                    res.status = r.status;
                    String ct = r.headers.get("content-type");
                    res.mime = (ct != null ? ct : "application/json") + "; charset=utf-8";
                    res.headers.put("X-Bili-Retry", "1");
                    res.body = r.body;
                } catch (Exception e) {
                    res.status = 502;
                    res.mime = "application/json; charset=utf-8";
                    res.body = ("{\"ok\":false,\"error\":\"转发失败：" + jsonEsc(String.valueOf(e.getMessage())) + "\"}").getBytes(StandardCharsets.UTF_8);
                }
                return res;
            }
            if (path.equals("/stream")) {
                String u = queryParam(query, "url");
                if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) {
                    res.status = 400;
                    res.mime = "application/json; charset=utf-8";
                    res.body = "{\"ok\":false,\"error\":\"缺少有效的 url 参数\"}".getBytes(StandardCharsets.UTF_8);
                    return res;
                }
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(u).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    conn.setInstanceFollowRedirects(false);
                    conn.setRequestMethod("GET");
                    Map<String, String> h = baseHeaders("https://www.bilibili.com/");
                    h.remove("Cookie"); // 媒体流仅带身份 cookie 可能触发风控，保留仍可
                    String ck = buildCookie();
                    if (!ck.isEmpty()) h.put("Cookie", ck);
                    for (Map.Entry<String, String> e : h.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
                    String range = reqHeaders.get("range");
                    if (range != null) conn.setRequestProperty("Range", range);
                    int status = conn.getResponseCode();
                    res.isStream = true;
                    res.status = status;
                    res.stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    res.streamMime = conn.getContentType();
                    res.streamLength = conn.getContentLengthLong();
                    String cr = conn.getHeaderField("Content-Range");
                    if (cr != null) res.headers.put("Content-Range", cr);
                    String ar = conn.getHeaderField("Accept-Ranges");
                    if (ar != null) res.headers.put("Accept-Ranges", ar);
                    // 连接在流关闭时释放：交由 WebResourceResponse 消费 InputStream
                    res.streamConn = conn;
                    return res;
                } catch (Exception e) {
                    res.status = 502;
                    res.mime = "text/plain; charset=utf-8";
                    res.body = ("stream proxy failed: " + jsonEsc(String.valueOf(e.getMessage()))).getBytes(StandardCharsets.UTF_8);
                    return res;
                }
            }
            res.status = 404;
            res.mime = "application/json; charset=utf-8";
            res.body = "{\"ok\":false,\"error\":\"not found\"}".getBytes(StandardCharsets.UTF_8);
            return res;
        } catch (Exception e) {
            res.status = 500;
            res.mime = "application/json; charset=utf-8";
            res.body = ("{\"ok\":false,\"error\":\"" + jsonEsc(String.valueOf(e.getMessage())) + "\"}").getBytes(StandardCharsets.UTF_8);
            return res;
        }
    }

    public HttpURLConnection streamConn;

    private Resp biliGet(String url) throws IOException, InterruptedException {
        Resp r = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            gate();
            r = httpsGet(url, baseHeaders("https://www.bilibili.com/"));
            if (r.status != 412) return r;
            // 412 风控：递增退避 + 换全新设备身份重试（与 server.js 同策略，更强健）
            Thread.sleep(1500L * (attempt + 1));
            resetBuvid();
        }
        return r;
    }

    private static String shortId(String v) {
        if (v == null || v.isEmpty()) return "";
        return v.length() > 10 ? v.substring(0, 8) + "…" : v;
    }

    private static String queryParam(String query, String key) {
        if (query == null) return null;
        String[] parts = query.split("&");
        for (String p : parts) {
            int eq = p.indexOf('=');
            if (eq > 0 && p.substring(0, eq).equals(key)) {
                try {
                    return URLDecoder.decode(p.substring(eq + 1), "UTF-8");
                } catch (Exception e) {
                    return p.substring(eq + 1);
                }
            }
        }
        return null;
    }

    private static String jsonEsc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    /* ---------- 极简 JSON（够用即可，避免外部依赖） ---------- */
    public static class JSON {
        private final Map<String, JSON> objs = new LinkedHashMap<>();
        private final Map<String, String> strs = new LinkedHashMap<>();
        private final java.util.List<String> keysOrder = new java.util.ArrayList<>();

        public JSON obj(String k) { return objs.get(k); }
        public String str(String k) { return strs.get(k); }
        public java.util.List<String> keys() { return keysOrder; }

        public static JSON parse(String s) {
            if (s == null) return null;
            int[] idx = { 0 };
            try {
                Object v = parseValue(s, idx);
                return v instanceof JSON ? (JSON) v : null;
            } catch (Exception e) {
                return null;
            }
        }

        private static Object parseValue(String s, int[] idx) throws Exception {
            skipWs(s, idx);
            char c = s.charAt(idx[0]);
            if (c == '{') return parseObj(s, idx);
            if (c == '[') { skipArr(s, idx); return null; }
            if (c == '"') return parseStr(s, idx);
            // number / true / false / null
            int start = idx[0];
            while (idx[0] < s.length() && ",}]".indexOf(s.charAt(idx[0])) < 0) idx[0]++;
            return s.substring(start, idx[0]).trim();
        }

        private static JSON parseObj(String s, int[] idx) throws Exception {
            JSON o = new JSON();
            idx[0]++; // {
            skipWs(s, idx);
            if (s.charAt(idx[0]) == '}') { idx[0]++; return o; }
            while (true) {
                skipWs(s, idx);
                String k = parseStr(s, idx);
                skipWs(s, idx);
                idx[0]++; // :
                Object v = parseValue(s, idx);
                if (v instanceof JSON) o.objs.put(k, (JSON) v);
                else if (v instanceof String) o.strs.put(k, (String) v);
                o.keysOrder.add(k);
                skipWs(s, idx);
                char cc = s.charAt(idx[0]);
                idx[0]++;
                if (cc == '}') break;
            }
            return o;
        }

        private static void skipArr(String s, int[] idx) {
            int depth = 0;
            while (idx[0] < s.length()) {
                char c = s.charAt(idx[0]);
                if (c == '[') depth++;
                else if (c == ']') { depth--; if (depth == 0) { idx[0]++; return; } }
                else if (c == '"') { try { parseStr(s, idx); continue; } catch (Exception e) { } }
                idx[0]++;
            }
        }

        private static String parseStr(String s, int[] idx) throws Exception {
            idx[0]++; // "
            StringBuilder sb = new StringBuilder();
            while (idx[0] < s.length()) {
                char c = s.charAt(idx[0]);
                if (c == '\\') {
                    idx[0]++;
                    char e = s.charAt(idx[0]);
                    if (e == 'n') sb.append('\n');
                    else if (e == 't') sb.append('\t');
                    else if (e == 'r') sb.append('\r');
                    else if (e == 'u') { sb.append((char) Integer.parseInt(s.substring(idx[0] + 1, idx[0] + 5), 16)); idx[0] += 4; }
                    else sb.append(e);
                } else if (c == '"') {
                    idx[0]++;
                    return sb.toString();
                } else {
                    sb.append(c);
                }
                idx[0]++;
            }
            throw new Exception("unterminated string");
        }

        private static void skipWs(String s, int[] idx) {
            while (idx[0] < s.length() && Character.isWhitespace(s.charAt(idx[0]))) idx[0]++;
        }
    }
}
