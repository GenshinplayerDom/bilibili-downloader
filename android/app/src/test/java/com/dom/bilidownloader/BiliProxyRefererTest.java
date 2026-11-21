package com.dom.bilidownloader;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.lang.reflect.Method;

public class BiliProxyRefererTest {
    private static String safe(String value) throws Exception {
        Method m = BiliProxy.class.getDeclaredMethod("safePageReferer", String.class);
        m.setAccessible(true);
        return (String) m.invoke(null, value);
    }

    @Test
    public void acceptsOnlyRealBilibiliVideoAndBangumiPages() throws Exception {
        assertEquals("https://www.bilibili.com/video/BV1xx411c7mD", safe("https://www.bilibili.com/video/BV1xx411c7mD"));
        assertEquals("https://www.bilibili.com/bangumi/play/ep123456", safe("https://www.bilibili.com/bangumi/play/ep123456"));
    }

    @Test
    public void rejectsForeignHostsAndHeaderInjection() throws Exception {
        assertEquals("https://www.bilibili.com/", safe(null));
        assertEquals("https://www.bilibili.com/", safe("https://evil.example/video/BV1xx411c7mD"));
        assertEquals("https://www.bilibili.com/", safe("https://www.bilibili.com.evil.example/video/BV1xx411c7mD"));
        assertEquals("https://www.bilibili.com/", safe("https://www.bilibili.com/video/BV1xx411c7mD\r\nCookie: stolen=1"));
        assertEquals("https://www.bilibili.com/", safe("http://www.bilibili.com/video/BV1xx411c7mD"));
        assertEquals("https://www.bilibili.com/", safe("https://www.bilibili.com/search?keyword=x"));
    }
}
