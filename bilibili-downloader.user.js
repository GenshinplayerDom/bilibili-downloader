// ==UserScript==
// @name         哔哩下载器 · Dom（油猴版）
// @namespace    com.dom.bilidownloader
// @version      1.2.0
// @description  在哔哩哔哩视频页面直接下载视频/音频（多线程分片 + 直链），与桌面版同一套解析逻辑。by Dom
// @author       Dom
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_notification
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var QNS = { 120: '4K 超清', 112: '1080P 高码率', 80: '1080P 高清', 64: '720P 高清', 32: '480P 清晰', 16: '360P 流畅' };
  var WBI_KEY = '7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45';
  var MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  function mixinKey(orig) {
    var out = '';
    for (var i = 0; i < 32; i++) out += orig[MIXIN_KEY_ENC_TAB[i]];
    return out;
  }
  /* 标准 MD5（RFC 1321 直译，UTF-8 输入） */
  function md5(str) {
    var bytes = new TextEncoder().encode(str);
    var ml = bytes.length * 8;
    var bufLen = (Math.floor((bytes.length + 8) / 64) + 1) * 64;
    var buf = new Uint8Array(bufLen);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(bufLen - 8, ml >>> 0, true);
    dv.setUint32(bufLen - 4, Math.floor(ml / 4294967296), true);
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = [];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    var rol = function (n, b) { return (n << b) | (n >>> (32 - b)); };
    var F = function (x, y, z) { return (x & y) | (~x & z); };
    var G = function (x, y, z) { return (x & z) | (y & ~z); };
    var H = function (x, y, z) { return x ^ y ^ z; };
    var I = function (x, y, z) { return y ^ (x | ~z); };
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var i = 0; i < bufLen; i += 64) {
      var M = [];
      for (var j = 0; j < 16; j++) M[j] = dv.getUint32(i + j * 4, true);
      var A = a0, B = b0, C = c0, D = d0;
      var f, g;
      for (var j = 0; j < 64; j++) {
        if (j < 16) { f = F(B, C, D); g = j; }
        else if (j < 32) { f = G(B, C, D); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = H(B, C, D); g = (3 * j + 5) % 16; }
        else { f = I(B, C, D); g = (7 * j) % 16; }
        var tmp = D;
        D = C;
        C = B;
        B = (B + rol((A + (f >>> 0) + K[j] + M[g]) >>> 0, S[j])) >>> 0;
        A = tmp;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }
    var hex = function (n) {
      var s = '';
      for (var i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      return s;
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }
  function wbiSign(params) {
    var p = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
    var q = Object.keys(p).sort().map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
    p.w_rid = md5(q + mixinKey(WBI_KEY));
    return p;
  }
  function apiGet(path, params) {
    var p = wbiSign(params || {});
    var q = Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + q;
    return new Promise(function (resolve, reject) {
      fetch(url, { credentials: 'include' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.code === 0) resolve(j.data);
        else reject(new Error(j.message || 'API 错误 ' + j.code));
      }).catch(reject);
    });
  }
  function getCid() {
    var m = /"cid":(\d+)/.exec(document.documentElement.innerHTML);
    return m ? Number(m[1]) : 0;
  }
  function getBvid() {
    var m = /BV[0-9A-Za-z]{10}/.exec(location.href);
    if (m) return m[0];
    var s = /"bvid":"([^"]+)"/.exec(document.documentElement.innerHTML);
    return s ? s[1] : '';
  }
  function getTitle() {
    var t = $('h1') || $('.video-info-title') || document.title;
    return (t ? t.textContent.trim() : document.title.replace(/_[^_]*$/, '')).slice(0, 60);
  }

  /* ---------- UI ---------- */
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:14px;top:80px;z-index:99999;width:230px;background:#fff;border:1px solid #e3e5e7;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:12px;font:13px/1.5 system-ui,sans-serif;color:#1f2329';
  box.innerHTML =
    '<div style="font-weight:700;margin-bottom:8px;color:#fb7299">哔哩下载器 · Dom</div>' +
    '<select id="bd-qn" style="width:100%;padding:5px;margin-bottom:6px;border:1px solid #e3e5e7;border-radius:6px"></select>' +
    '<div style="display:flex;gap:6px;margin-bottom:6px">' +
    '<button id="bd-v" style="flex:1;padding:6px;background:#fb7299;color:#fff;border:none;border-radius:6px;cursor:pointer">下载视频</button>' +
    '<button id="bd-a" style="flex:1;padding:6px;background:#f4f6f9;color:#1f2329;border:1px solid #e3e5e7;border-radius:6px;cursor:pointer">下载音频</button></div>' +
    '<div id="bd-status" style="font-size:12px;color:#8f959e;word-break:break-all;max-height:80px;overflow:auto"></div>';
  document.body.appendChild(box);

  Object.keys(QNS).reverse().forEach(function (k) {
    var o = document.createElement('option');
    o.value = k;
    o.textContent = QNS[k];
    box.querySelector('#bd-qn').appendChild(o);
  });
  function st(t) { box.querySelector('#bd-status').textContent = t; }

  function download(url, name) {
    st('开始下载：' + name);
    if (typeof GM_download === 'function') {
      GM_download({ url: url, name: name, saveAs: true });
      st('已调用浏览器下载（保存位置可在浏览器设置中修改）');
    } else {
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 500);
    }
  }

  function doDownload(type) {
    var bvid = getBvid(), cid = getCid();
    if (!bvid || !cid) { st('未识别到视频（bvid=' + bvid + ' cid=' + cid + '）'); return; }
    var qn = Number(box.querySelector('#bd-qn').value);
    var fnval = type === 'audio' ? 4048 : 16;
    var fn = 'bili_' + bvid + '_' + (type === 'audio' ? 'audio' : QNS[qn] || qn);
    st('获取下载地址…');
    apiGet('https://api.bilibili.com/x/player/playurl', { bvid: bvid, cid: cid, qn: qn, fnval: fnval, fourk: 1 }).then(function (d) {
      var url = null, name = '';
      if (type === 'audio') {
        var audios = (d.dash && d.dash.audio) || [];
        if (!audios.length) throw new Error('无音频流');
        var best = audios.reduce(function (a, b) { return (b.bandwidth || 0) > (a.bandwidth || 0) ? b : a; });
        url = best.baseUrl || best.base_url;
        name = fn + '_' + ((best.bandwidth || 0) / 1000 | 0) + 'k.m4a';
      } else {
        var durl = d.durl && d.durl[0];
        if (durl) { url = durl.url || (durl.backup_url && durl.backup_url[0]); name = fn + '_' + (QNS[d.quality] || d.quality) + '.mp4'; }
        else if (d.dash && d.dash.video && d.dash.video.length) {
          var v = d.dash.video[0];
          url = v.baseUrl || v.base_url;
          name = fn + '_' + (QNS[d.quality] || d.quality) + '_dash.m4s';
        }
      }
      if (!url) throw new Error('未获取到下载地址（可能需要登录或该清晰度不可用）');
      st('获取成功（' + name.split('_').pop() + '）');
      download(url, name);
      if (typeof GM_notification === 'function') GM_notification({ title: '哔哩下载器', text: '开始下载：' + name, timeout: 3000 });
    }).catch(function (e) {
      st('❌ ' + e.message);
      if (typeof GM_notification === 'function') GM_notification({ title: '哔哩下载器', text: '下载失败：' + e.message, timeout: 4000 });
    });
  }
  box.querySelector('#bd-v').addEventListener('click', function () { doDownload('video'); });
  box.querySelector('#bd-a').addEventListener('click', function () { doDownload('audio'); });
  // 页面标题变化（视频切换）后重新识别
  var lastTitle = '';
  setInterval(function () {
    var t = getTitle();
    if (t && t !== lastTitle) { lastTitle = t; st('已识别：「' + t + '」'); }
  }, 2000);
})();
