package com.dom.bilidownloader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.LinkedHashMap;
import java.util.Map;

public class BiliProxyCookieTest {
    @Test
    public void validCookiesAreJoinedWithoutLeakingIntoHeaders() {
        BiliProxy proxy = new BiliProxy();
        Map<String, String> cookies = new LinkedHashMap<>();
        cookies.put("SESSDATA", "abc%2C123");
        cookies.put("DedeUserID", "42");
        cookies.put("bili_jct", "deadbeef");
        proxy.setUserCookies(cookies);
        assertTrue(proxy.isLogged());
        assertEquals("SESSDATA=abc%2C123; DedeUserID=42; bili_jct=deadbeef", proxy.buildCookie());
    }

    @Test
    public void controlCharactersSemicolonsAndInvalidKeysAreDiscarded() {
        BiliProxy proxy = new BiliProxy();
        Map<String, String> cookies = new LinkedHashMap<>();
        cookies.put("SESSDATA", "ok\r\nX-Evil: injected");
        cookies.put("DedeUserID", "42; admin=1");
        cookies.put("X-Evil", "value");
        cookies.put("bili_jct", "deadbeef");
        proxy.setUserCookies(cookies);
        assertFalse(proxy.isLogged());
        assertEquals("bili_jct=deadbeef", proxy.buildCookie());
        assertFalse(proxy.buildCookie().contains("\r"));
        assertFalse(proxy.buildCookie().contains("\n"));
    }

    @Test
    public void clearingCookiesReturnsAnonymousState() {
        BiliProxy proxy = new BiliProxy();
        Map<String, String> cookies = new LinkedHashMap<>();
        cookies.put("SESSDATA", "abc");
        cookies.put("DedeUserID", "42");
        proxy.setUserCookies(cookies);
        assertTrue(proxy.isLogged());
        proxy.clearUserCookies();
        assertFalse(proxy.isLogged());
        assertEquals("", proxy.buildCookie());
    }
}
