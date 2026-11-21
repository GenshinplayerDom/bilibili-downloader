package com.dom.bilidownloader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.IOException;
import java.net.URL;

public class UrlPolicyTest {
    @Test
    public void acceptsOfficialApiAndCdnHosts() throws Exception {
        assertEquals("api.bilibili.com", UrlPolicy.validate("https://api.bilibili.com/x/web-interface/view", "api").getHost());
        assertEquals("www.bilibili.com", UrlPolicy.validate("https://www.bilibili.com/video/BV1xx", "expand").getHost());
        assertEquals("upos-sz-mirror.bilivideo.com", UrlPolicy.validate("https://upos-sz-mirror.bilivideo.com/video.m4s", "media").getHost());
        assertTrue(UrlPolicy.mediaCookie(new URL("https://upos-sz-mirror.bilivideo.com/video.m4s")));
        assertFalse(UrlPolicy.mediaCookie(new URL("https://edge.mountaintoys.cn:4483/video.m4s")));
    }

    @Test
    public void rejectsLookalikeHostsCredentialsAndNonStandardApiPorts() {
        assertRejected("https://api.bilibili.com.evil.example/x", "api");
        assertRejected("https://api.bilibili.com@evil.example/x", "api");
        assertRejected("https://api.bilibili.com:8443/x", "api");
        assertRejected("http://api.bilibili.com/x", "api");
        assertRejected("https://evil.example/video.mp4", "media");
        assertRejected("ftp://api.bilibili.com/x", "api");
    }

    @Test
    public void mediaAllowsRandomCdnPortsButUpgradesPlainHttp() throws Exception {
        assertEquals("https", UrlPolicy.validate("http://upos-sz-mirror.bilivideo.com/video.m4s", "media").getProtocol());
        assertEquals(4483, UrlPolicy.validate("https://edge.mountaintoys.cn:4483/video.m4s", "media").getPort());
    }

    @Test
    public void onlyDebugBuildAllowsLoopbackForMediaTests() throws Exception {
        if (!BuildConfig.DEBUG) return;
        assertEquals("127.0.0.1", UrlPolicy.validate("http://127.0.0.1:8080/video.mp4", "media").getHost());
        assertRejected("http://127.0.0.1:8080/api", "api");
    }

    @Test
    public void filenamesRejectTraversalAndUnknownExtensions() {
        assertFilename("测试 视频.mp4");
        assertFilename("字幕.srt");
        assertFilename("导出.json");
        assertBadFilename("../escape.mp4");
        assertBadFilename("dir/file.mp4");
        assertBadFilename("payload.exe");
        assertBadFilename("video.mp4.exe");
        assertBadFilename("..mp4");
    }

    private static void assertRejected(String url, String kind) {
        try {
            UrlPolicy.validate(url, kind);
            throw new AssertionError("应当拒绝: " + url);
        } catch (IOException expected) { }
    }

    private static void assertFilename(String name) {
        try { UrlPolicy.filename(name); }
        catch (IOException error) { throw new AssertionError("应当允许: " + name, error); }
    }

    private static void assertBadFilename(String name) {
        try {
            UrlPolicy.filename(name);
            throw new AssertionError("应当拒绝文件名: " + name);
        } catch (IOException expected) { }
    }
}
