// ==UserScript==
// @name         哔哩下载器 · GenshinplayerDom（油猴版）
// @namespace    com.dom.bilidownloader
// @version      1.3.4
// @description  在哔哩哔哩视频页面直接下载视频/音频（多线程分片 + 直链），与桌面版同一套解析逻辑。by GenshinplayerDom
// @author       GenshinplayerDom
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
  var WBI_KEY = '';
  var wbiExpires = 0;
  function refreshWbiKey() {
    if (WBI_KEY && Date.now() < wbiExpires) return Promise.resolve();
    return fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      .then(function (response) { return response.json(); })
      .then(function (json) {
        var images = json.data && json.data.wbi_img;
        if (!images) throw new Error('无法获取 WBI 密钥');
        WBI_KEY = [images.img_url, images.sub_url].map(function (url) { return url.split('/').pop().split('.')[0]; }).join('');
        if (WBI_KEY.length !== 64) throw new Error('无效的 WBI 密钥');
        wbiExpires = Date.now() + 3600000;
      });
  }
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
    // B 站 WBI 算法要求先剔除参数值中的 !'()* 再做 encode（与桌面版 wbiSignUrl 保持一致）
    var q = Object.keys(p).sort().map(function (k) {
      return k + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''));
    }).join('&');
    p.w_rid = md5(q + mixinKey(WBI_KEY));
    return p;
  }
  function apiGet(path, params) {
    return refreshWbiKey().then(function () {
    var p = wbiSign(params || {});
    var q = Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + q;
    return new Promise(function (resolve, reject) {
      fetch(url, { credentials: 'include' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.code === 0) resolve(j.data);
        else reject(new Error(j.message || 'API 错误 ' + j.code));
      }).catch(reject);
    });
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
  function safeName(v) {
    return String(v || '').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').trim().slice(0, 80) || 'untitled';
  }
  function getTitle() {
    var t = $('h1') || $('.video-info-title') || document.title;
    return (t ? t.textContent.trim() : document.title.replace(/_[^_]*$/, '')).slice(0, 60);
  }
  /* ---------- 番剧（PGC）---------- */
  function getEpId() {
    var m = /\/bangumi\/play\/ep(\d+)/.exec(location.href);
    if (m) return Number(m[1]);
    // 只有番剧播放页才允许从页面 HTML 里兜底取 ep_id；
    // 普通视频页的推荐位也可能出现 "ep_id"，误判会把无关番剧下下来
    if (!/\/bangumi\/play\//.test(location.href)) return 0;
    var s = /"ep_id":(\d+)/.exec(document.documentElement.innerHTML);
    return s ? Number(s[1]) : 0;
  }
  function getSeasonId() {
    var m = /\/bangumi\/play\/ss(\d+)/.exec(location.href);
    return m ? Number(m[1]) : 0;
  }
  /* ss 页：按季度定位第一集（页面里的 ep_id 可能是推荐位，不可信） */
  function resolveSeasonFirstEp(ssId) {
    return apiPgc('https://api.bilibili.com/pgc/view/web/season', { season_id: ssId }).then(function (season) {
      var eps = season.episodes || [];
      if (!eps.length) throw new Error('该季度暂无可下载剧集');
      var e = eps[0];
      return { epId: e.ep_id, bvid: e.bvid, cid: e.cid, title: (e.long_title || e.title || season.title || '番剧'), seasonTitle: season.title };
    });
  }
  function pgcErrorMessage(code, message) {
    if (code === 87007 || /充电|upower/i.test(message || '')) return '该视频为充电专属内容，需先为该 UP 主充电并登录有权限的账号';
    if (code === -10403) return '该内容在当前地区不可用（地区限制）';
    if (code === -404 || code === 62002) return '该内容不存在或已下架';
    return message || ('番剧接口错误 ' + code);
  }
  /* PGC 接口返回体在 result 里，且不需要 WBI 签名 */
  function apiPgc(path, params) {
    var q = Object.keys(params || {}).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return new Promise(function (resolve, reject) {
      fetch(path + (q ? (path.indexOf('?') >= 0 ? '&' : '?') + q : ''), { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.code !== 0) return reject(new Error(pgcErrorMessage(j.code, j.message)));
          if (!j.result) return reject(new Error('番剧接口未返回数据'));
          resolve(j.result);
        })
        .catch(reject);
    });
  }
  /* 当前番剧页 → { epId, bvid, cid, title } */
  function resolveBangumi(epId) {
    return apiPgc('https://api.bilibili.com/pgc/view/web/season', { ep_id: epId }).then(function (season) {
      var eps = season.episodes || [];
      var hit = null;
      eps.forEach(function (e) { if (Number(e.ep_id) === Number(epId)) hit = e; });
      // 找不到就报错，绝不回落到第 1 集（否则用户会下到与页面无关的内容）
      if (!hit) throw new Error('未找到该剧集（可能是预告/花絮或已下架）');
      return { epId: hit.ep_id, bvid: hit.bvid, cid: hit.cid, title: (hit.long_title || hit.title || season.title || '番剧'), seasonTitle: season.title };
    });
  }

  /* cid 兜底：页面文本里找不到时，用 view 接口取第一分 P 的 cid */
  function resolveCid(bvid, cid) {
    if (cid) return Promise.resolve(cid);
    return apiGet('https://api.bilibili.com/x/web-interface/view', { bvid: bvid }).then(function (d) {
      var p = (d.pages && d.pages[0]) || d;
      if (!p || !p.cid) throw new Error('未能解析视频 cid');
      return p.cid;
    });
  }

  /* ---------- UI ---------- */
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:14px;top:80px;z-index:99999;width:230px;background:#fff;border:1px solid #e3e5e7;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:12px;font:13px/1.5 system-ui,sans-serif;color:#1f2329';
  box.innerHTML =
    '<div style="font-weight:700;margin-bottom:8px;color:#fb7299">哔哩下载器 · GenshinplayerDom</div>' +
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
    var epId = getEpId();
    var ssId = getSeasonId();
    var bvid = getBvid();
    if (!bvid && !epId && !ssId) { st('未识别到视频（bvid=' + bvid + '）'); return; }
    var cid = getCid();
    var qn = Number(box.querySelector('#bd-qn').value);
    // 视频用 fnval=1（传统 durl 合流 MP4，自带音频轨）；fnval=16 是 DASH 分离流，
    // 只下视频轨会得到无声文件（桌面版靠 ffmpeg 合流，油猴版无法合流）。
    var fnval = type === 'audio' ? 4048 : 1;
    st('获取下载地址…');
    // 番剧页（bangumi/play/ep…）走 PGC 接口；普通视频仍走 x/player/playurl
    var request;
    if (epId || ssId) {
      request = (epId ? resolveBangumi(epId) : resolveSeasonFirstEp(ssId)).then(function (info) {
        bvid = info.bvid;
        var fn = 'bili_' + safeName(info.seasonTitle || '') + '_' + safeName(info.title) + '_' + (type === 'audio' ? 'audio' : (QNS[qn] || qn));
        box.dataset.fileName = fn;
        return apiPgc('https://api.bilibili.com/pgc/player/web/playurl', { ep_id: info.epId, cid: info.cid, qn: qn, fnval: fnval, fourk: 1 });
      });
    } else {
      var fn = 'bili_' + bvid + '_' + (type === 'audio' ? 'audio' : QNS[qn] || qn);
      box.dataset.fileName = fn;
      // 页面 HTML 里抓不到 cid 时，回退到 view 接口取第一分 P 的 cid，避免整段失败
      request = resolveCid(bvid, cid).then(function (realCid) {
        return apiGet('https://api.bilibili.com/x/player/playurl', { bvid: bvid, cid: realCid, qn: qn, fnval: fnval, fourk: 1 });
      });
    }
    request.then(function (d) {
      // 大会员影视（尤其电影）无权限时只返回试看片段，不能当完整片子下载
      if (d && d.is_preview === 1) {
        var sec = (d.durl && d.durl.length && d.durl[0].length) ? Math.round(Number(d.durl[0].length) / 1000) : 0;
        throw new Error('当前账号只能观看试看片段' + (sec ? '（约 ' + sec + ' 秒）' : '') + '，已取消下载。该影片需要大会员权限');
      }
      var fn = box.dataset.fileName || ('bili_' + (bvid || 'video'));
      var url = null, name = '', dashOnly = false;
      if (type === 'audio') {
        var audios = (d.dash && d.dash.audio) || [];
        if (!audios.length) throw new Error('无音频流');
        var best = audios.reduce(function (a, b) { return (b.bandwidth || 0) > (a.bandwidth || 0) ? b : a; });
        url = best.baseUrl || best.base_url;
        name = fn + '_' + ((best.bandwidth || 0) / 1000 | 0) + 'k.m4a';
      } else {
        // 部分视频（长视频 / 番剧）的 durl 是多段 MP4，只取第一段会得到被截断的文件
        var segs = (d.durl || []).map(function (x) { return x.url || (x.backup_url && x.backup_url[0]); }).filter(Boolean);
        if (segs.length) {
          url = segs[0];
          name = fn + '_' + (QNS[d.quality] || d.quality) + '.mp4';
          if (segs.length > 1) {
            st('该视频分为 ' + segs.length + ' 段，正在逐段下载（如需单文件请手动拼接）');
            segs.forEach(function (seg, i) {
              setTimeout(function () {
                download(seg, fn + '_' + (QNS[d.quality] || d.quality) + '_p' + (i + 1) + '.mp4');
              }, i * 1500);
            });
            if (typeof GM_notification === 'function') GM_notification({ title: '哔哩下载器', text: '该视频分为 ' + segs.length + ' 段，开始逐段下载', timeout: 3000 });
            return;
          }
        }
        else if (d.dash && d.dash.video && d.dash.video.length) {
          var v = d.dash.video[0];
          url = v.baseUrl || v.base_url;
          name = fn + '_' + (QNS[d.quality] || d.quality) + '_dash.m4s';
          dashOnly = true;   // 该视频没有合流 MP4，只能拿到无声的视频轨
        }
      }
      if (!url) throw new Error('未获取到下载地址（可能需要登录或该清晰度不可用）');
      st(dashOnly ? '⚠ 该视频仅提供 DASH 分离流，下载文件不含音轨（需自行合流）' : '获取成功（' + name.split('_').pop() + '）');
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
