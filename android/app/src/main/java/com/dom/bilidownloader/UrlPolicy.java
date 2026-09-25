package com.dom.bilidownloader;

import java.io.IOException;
import java.net.URL;

final class UrlPolicy {
    static boolean domain(String host, String domain) { return host.equals(domain) || host.endsWith("." + domain); }
    static boolean api(URL url) { return url.getHost().equals("api.bilibili.com") || url.getHost().equals("passport.bilibili.com"); }
    static URL validate(String value, String kind) throws IOException {
        URL url = new URL(value.startsWith("//") ? "https:" + value : value);
        if (url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)) throw new IOException("不允许的地址");
        if (url.getProtocol().equals("http") && kind.equals("media")) url = new URL("https" + value.substring(4));
        if (!url.getProtocol().equals("https")) throw new IOException("仅支持 HTTPS 地址");
        String host = url.getHost().toLowerCase(java.util.Locale.ROOT);
        boolean allowed = kind.equals("api") ? api(url)
            : kind.equals("expand") ? domain(host, "bilibili.com") || host.equals("b23.tv")
            : api(url) || domain(host, "bilivideo.com") || domain(host, "bilivideo.cn") || domain(host, "bilivideo.net") || domain(host, "hdslb.com") || domain(host, "biliimg.com");
        if (!allowed) throw new IOException("不允许的目标域名");
        return url;
    }
    static void filename(String name) throws IOException {
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..") || !name.matches("(?i).+\\.(mp4|mkv|m4a|mp3|flac|webm|xml|srt|jpg|png|json)")) throw new IOException("无效文件名");
    }
}
