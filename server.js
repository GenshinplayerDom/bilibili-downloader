/* ============================================================
 * 哔哩下载器 · 本地代理 server.js
 * 仅使用 Node 内置模块（https / crypto / http），零第三方依赖。
 * 默认监听 127.0.0.1:8123（可用环境变量 PORT 覆盖）。
 *
 * 作用：纯前端页面（file:// 或第三方域名）受 B 站 CORS 白名单限制，
 * 无法直连 api.bilibili.com；本代理在本机转发请求并：
 *   - 自动补全设备身份（buvid3/buvid4 + bili_ticket + WBI 密钥）
 *   - 遇 HTTP 412 风控自动换全新设备身份重试一次
 *   - 串行化 B 站接口请求并 ≥250ms 节流，降低触发风控概率
 *   - 媒体流转发支持 Range 分段（供前端多线程并发下载）
 *
 * 路由：
 *   GET /status                 代理与设备身份状态
 *   GET /api?url=<b站api>       转发 B 站 API（带身份、节流、412 重试）
 *   GET /expand?url=<短链>      展开 b23.tv 短链
 *   GET /stream?url=<媒体url>   转发媒体流（支持 Range 分段并发）
 * ============================================================ */
'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var urlMod = require('url');
var pathMod = require('path');
var fsMod = require('fs');

var PORT = parseInt(process.env.PORT, 10) || 8123;
var HOST = '127.0.0.1';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ---------- 设备身份 ---------- */
var identity = {
  buvid3: '',
  buvid4: '',
  bili_ticket: '',
  wbiKey: '',
  expireAt: 0
};

/* ---------- 用户登录 Cookie（设置页登录后注入，用于获取更高清晰度） ---------- */
var userCookies = {};          // { SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5, ... }
var userDataDir = null;

function setUserDataDir(dir) {
  userDataDir = dir;
  loadUserCookies();
}

function loadUserCookies() {
  try {
    if (!userDataDir) return;
    var f = pathMod.join(userDataDir, 'bili_cookies.json');
    if (fsMod.existsSync(f)) {
      var j = JSON.parse(fsMod.readFileSync(f, 'utf8'));
      if (j && j.cookies) userCookies = j.cookies;
      console.log('[哔哩下载器] 已加载登录账号 Cookie（' + Object.keys(userCookies).length + ' 项）');
    }
  } catch (e) {
    console.error('[哔哩下载器] 加载登录 Cookie 失败：', e.message);
  }
}

function saveUserCookies() {
  try {
    if (!userDataDir) return;
    var f = pathMod.join(userDataDir, 'bili_cookies.json');
    fsMod.writeFileSync(f, JSON.stringify({ cookies: userCookies, savedAt: Date.now() }, null, 2), 'utf8');
  } catch (e) {
    console.error('[哔哩下载器] 保存登录 Cookie 失败：', e.message);
  }
}

function setUserCookies(cookies) {
  userCookies = cookies || {};
  // 登录窗口的浏览器身份（buvid3/buvid4 等）与 SESSDATA 同属一个会话；
  // 覆盖代理匿名身份，避免"登录 Cookie + 陌生匿名身份"被 B 站判定为异常
  // 组合而只放行低清晰度。
  if (userCookies.buvid3 && userCookies.buvid3 !== identity.buvid3) {
    identity.buvid3 = userCookies.buvid3;
  }
  if (userCookies.buvid4 && userCookies.buvid4 !== identity.buvid4) {
    identity.buvid4 = userCookies.buvid4;
  }
  if (userCookies.bili_ticket) {
    identity.bili_ticket = userCookies.bili_ticket;
  }
  if (userCookies.bili_ticket_expires) {
    var exp = parseInt(userCookies.bili_ticket_expires, 10);
    if (exp > Date.now() / 1000) identity.expireAt = exp * 1000;
  }
  // 若未携带身份字段（网页版粘贴 Cookie），保留代理匿名身份
  saveUserCookies();
}

function getUserLoginInfo() {
  return {
    logged: !!(userCookies.SESSDATA && userCookies.DedeUserID),
    uid: userCookies.DedeUserID || '',
    hasSessdata: !!userCookies.SESSDATA
  };
}

function buildCookie() {
  var c = [];
  if (identity.buvid3) c.push('buvid3=' + identity.buvid3);
  if (identity.buvid4) c.push('buvid4=' + identity.buvid4);
  if (identity.bili_ticket) c.push('bili_ticket=' + identity.bili_ticket);
  // 用户登录 Cookie 覆盖/追加（SESSDATA 等需与匿名身份并存）
  Object.keys(userCookies).forEach(function (k) {
    var v = userCookies[k];
    if (v && k !== 'buvid3' && k !== 'buvid4') c.push(k + '=' + v);
  });
  return c.join('; ');
}

/* ---------- 基础 HTTPS 请求（开启连接复用，支持高并发分段下载） ---------- */
var httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 60000
});

function httpsGet(url, headers) {
  return new Promise(function (resolve, reject) {
    var u = urlMod.parse(url);
    var req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.path,
      method: 'GET',
      headers: headers || {},
      agent: httpsAgent
    }, function (res) {
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, headers, body) {
  return new Promise(function (resolve, reject) {
    var u = urlMod.parse(url);
    var req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.path,
      method: 'POST',
      headers: headers || {},
      agent: httpsAgent
    }, function (res) {
      resolve(res);
    });
    req.on('error', reject);
    req.end(body || '');
  });
}

function collectBody(res, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    res.on('data', function (ch) {
      size += ch.length;
      if (limit && size > limit) { reject(new Error('response too large')); res.destroy(); return; }
      chunks.push(ch);
    });
    res.on('end', function () {
      resolve(Buffer.concat(chunks));
    });
    res.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* ---------- B 站接口节流（串行 + ≥250ms 间隔） ---------- */
var gateChain = Promise.resolve();
var lastGate = 0;

function biliGate(fn) {
  var run = gateChain.then(function () {
    var wait = Math.max(0, 250 - (Date.now() - lastGate));
    if (wait > 0) return sleep(wait).then(fn);
    lastGate = Date.now();
    return fn();
  });
  gateChain = run.catch(function () { /* 吞掉，保证队列继续 */ });
  return run;
}

/* ---------- 获取 bili_ticket + WBI 密钥（GenWebTicket） ---------- */
function fetchBiliTicket() {
  var ts = Math.floor(Date.now() / 1000);
  var hexsign = crypto.createHmac('sha256', 'XgwSnGZ1p').update('ts' + ts).digest('hex');
  var url = 'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket' +
    '?key_id=ec02&hexsign=' + hexsign +
    '&context%5Bts%5D=' + ts + '&csrf=';
  return httpsPost(url, {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': 0
  }).then(function (res) {
    return collectBody(res, 1024 * 512).then(function (buf) {
      var j;
      try { j = JSON.parse(buf.toString('utf8')); } catch (e) { return { ticket: '', wbiKey: '' }; }
      var data = (j && j.data) || {};
      var nav = data.nav || {};
      var imgUrl = nav.img_url || nav.img || '';
      var subUrl = nav.sub_url || nav.sub || '';
      var img = String(imgUrl).split('/').pop().split('.')[0];
      var sub = String(subUrl).split('/').pop().split('.')[0];
      var wbiKey = (img && sub) ? (img + sub) : '';
      return { ticket: data.ticket || '', wbiKey: wbiKey };
    });
  }).catch(function () {
    return { ticket: '', wbiKey: '' };
  });
}

/* ---------- 获取/刷新设备身份 ---------- */
function ensureBuvid(force) {
  var now = Date.now();
  if (!force && identity.buvid3 && identity.expireAt > now) {
    return Promise.resolve(identity);
  }
  // 非强制刷新时，优先复用登录会话的浏览器身份（重启后仍保持与 SESSDATA
  // 同会话，高清清晰度判定不被降级）；ticket/WBI 密钥照常刷新。
  if (!force && userCookies.buvid3) {
    identity.buvid3 = userCookies.buvid3;
    identity.buvid4 = userCookies.buvid4 || '';
    if (userCookies.bili_ticket) identity.bili_ticket = userCookies.bili_ticket;
    return fetchBiliTicket().then(function (tk) {
      if (tk.wbiKey) identity.wbiKey = tk.wbiKey;
      identity.expireAt = Date.now() + 3600e3;
      return identity;
    });
  }
  return httpsGet('https://api.bilibili.com/x/frontend/finger/spi', {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/'
  }).then(function (res) {
    return collectBody(res, 1024 * 512).then(function (buf) {
      var j;
      try { j = JSON.parse(buf.toString('utf8')); } catch (e) { j = {}; }
      var d = (j && j.data) || {};
      identity.buvid3 = d.b_3 || '';
      identity.buvid4 = d.b_4 || '';
      return fetchBiliTicket().then(function (tk) {
        if (tk.ticket) identity.bili_ticket = tk.ticket;
        if (tk.wbiKey) identity.wbiKey = tk.wbiKey;
        identity.expireAt = Date.now() + 3600e3;
        return identity;
      });
    });
  });
}

function resetBuvid() {
  identity.buvid3 = '';
  identity.buvid4 = '';
  identity.bili_ticket = '';
  identity.wbiKey = '';
  identity.expireAt = 0;
  return ensureBuvid(true);
}

/* ---------- 转发 B 站 API（带身份 + 412 自动换身份重试） ---------- */
function biliGet(url) {
  return httpsGet(url, {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
    'Cookie': buildCookie()
  }).then(function (res) {
    return collectBody(res, 1024 * 1024 * 4).then(function (buf) {
      return { status: res.statusCode, headers: res.headers, body: buf };
    });
  });
}

function apiForward(url) {
  // 第一次（经节流）
  return biliGate(function () { return biliGet(url); }).then(function (r) {
    if (r.status === 412) {
      // 换全新身份重试一次
      return sleep(1500).then(function () {
        return resetBuvid().then(function () {
          return biliGate(function () { return biliGet(url); }).then(function (r2) {
            r2.retried = true;
            return r2;
          });
        });
      });
    }
    return r;
  });
}

/* ---------- 短链展开 ---------- */
function expandUrl(url, depth) {
  if (depth > 6) return Promise.resolve(url);
  return httpsGet(url, { 'User-Agent': UA }).then(function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      var loc = res.headers.location;
      if (/^https?:\/\//i.test(loc)) return expandUrl(loc, depth + 1);
      var base = urlMod.parse(url);
      return expandUrl(base.protocol + '//' + base.host + loc, depth + 1);
    }
    return collectBody(res, 1024 * 512).then(function () { return url; });
  });
}

/* ---------- HTTP 服务 ---------- */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Bili-Retry');
}

function sendJson(res, status, obj) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

/* 多 loopback 地址监听：浏览器对同一地址并发连接上限为 6（HTTP/1.1），
 * 分段并发超过 6 线程时会被浏览器排队。这里同时监听 127.0.0.1/.2/.3，
 * 前端分段下载按索引轮换地址，等效把并发上限提升到 3×6=18。 */
var LISTEN_HOSTS = ['127.0.0.1', '127.0.0.2', '127.0.0.3'];

function handleRequest(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  var u = urlMod.parse(req.url, true);
  var q = u.query;

  /* ---- /status ---- */
  if (u.pathname === '/status') {
    return ensureBuvid(false).then(function () {
      sendJson(res, 200, {
        ok: true,
        port: PORT,
        login: getUserLoginInfo(),
        identity: {
          buvid3: identity.buvid3 ? identity.buvid3.slice(0, 8) + '…' : '',
          buvid4: identity.buvid4 ? 'yes' : '',
          bili_ticket: identity.bili_ticket ? 'yes' : 'no',
          wbi_key: identity.wbiKey || ''
        }
      });
    }).catch(function (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : '身份初始化失败' });
    });
  }

  /* ---- /login-cookies（登录态查询 / 网页版粘贴 Cookie） ---- */
  if (u.pathname === '/login-cookies') {
    if (req.method === 'POST') {
      var body = '';
      req.on('data', function (ch) { body += ch; });
      req.on('end', function () {
        try {
          var j = JSON.parse(body || '{}');
          if (j.cookies && typeof j.cookies === 'object') {
            setUserCookies(j.cookies);
          }
          sendJson(res, 200, { ok: true, login: getUserLoginInfo() });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: 'Cookie 格式错误' });
        }
      });
      return;
    }
    return sendJson(res, 200, { ok: true, login: getUserLoginInfo() });
  }

  /* ---- /login-logout（退出登录） ---- */
  if (u.pathname === '/login-logout') {
    setUserCookies({});
    return sendJson(res, 200, { ok: true, login: getUserLoginInfo() });
  }

  /* ---- /fix（一键修复：重置设备身份 → 重取票据与 WBI 密钥） ---- */
  if (u.pathname === '/fix') {
    var logs = [];
    return ensureBuvid(false).then(function () {
      logs.push('设备身份检查完成（buvid3=' + (identity.buvid3 ? identity.buvid3.slice(0, 8) + '…' : '无') + '，buvid4=' + (identity.buvid4 ? '有' : '无') + '）');
      // 强制重置身份（规避被风控标记的旧身份）
      return resetBuvid().then(function () {
        logs.push('已重置设备身份，生成全新 buvid3/buvid4');
        return ensureBuvid(true);
      }).then(function () {
        logs.push('票据检查：bili_ticket=' + (identity.bili_ticket ? '正常' : '缺失') + '，WBI 密钥=' + (identity.wbiKey ? '正常' : '缺失'));
        // 重建 HTTPS 连接池（清除异常连接）
        try { httpsAgent.destroy(); } catch (e) { }
        logs.push('已重建 HTTPS 连接池');
        logs.push('修复完成，可重新提取链接');
        return sendJson(res, 200, { ok: true, logs: logs, login: getUserLoginInfo() });
      });
    }).catch(function (e) {
      logs.push('修复失败：' + (e && e.message ? e.message : '未知错误'));
      return sendJson(res, 500, { ok: false, logs: logs, error: e && e.message ? e.message : '修复失败' });
    });
  }

  /* ---- /expand ---- */
  if (u.pathname === '/expand') {
    if (!q.url) return sendJson(res, 400, { ok: false, error: '缺少 url 参数' });
    return expandUrl(q.url, 0).then(function (finalUrl) {
      sendJson(res, 200, { ok: true, finalUrl: finalUrl });
    }).catch(function (e) {
      sendJson(res, 502, { ok: false, error: e && e.message ? e.message : '展开失败' });
    });
  }

  /* ---- /api ---- */
  if (u.pathname === '/api') {
    if (!q.url || !/^https?:\/\//i.test(q.url)) {
      return sendJson(res, 400, { ok: false, error: '缺少有效的 url 参数' });
    }
    return ensureBuvid(false).then(function () {
      return apiForward(q.url);
    }).then(function (r) {
      res.setHeader('Content-Type', (r.headers['content-type'] || 'application/json') + '; charset=utf-8');
      if (r.retried) res.setHeader('X-Bili-Retry', '1');
      res.statusCode = r.status;
      res.end(r.body);
    }).catch(function (e) {
      sendJson(res, 502, { ok: false, error: e && e.message ? e.message : '转发失败' });
    });
  }

  /* ---- /stream ---- */
  if (u.pathname === '/stream') {
    if (!q.url || !/^https?:\/\//i.test(q.url)) {
      return sendJson(res, 400, { ok: false, error: '缺少有效的 url 参数' });
    }
    var hdrs = {
      'User-Agent': UA,
      'Referer': 'https://www.bilibili.com/'
    };
    if (req.headers.range) hdrs.Range = req.headers.range;
    // 流请求不做节流（保证多线程并发下载不被串行拖慢）
    return httpsGet(q.url, hdrs).then(function (up) {
      res.statusCode = up.statusCode;
      ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(function (h) {
        if (up.headers[h]) res.setHeader(h, up.headers[h]);
      });
      up.pipe(res);
    }).catch(function (e) {
      res.statusCode = 502;
      res.end('stream proxy failed: ' + (e && e.message ? e.message : 'unknown'));
    });
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

/* ---------- 启动（模块化：Electron 主进程内嵌调用） ----------
 * 同时监听多个 loopback 地址，配合前端分段轮换地址，
 * 突破浏览器单地址 6 连接上限，让高线程数真正提速。 */
var servers = [];

function start(port) {
  port = port || PORT;
  return Promise.all(LISTEN_HOSTS.map(function (host) {
    return new Promise(function (resolve, reject) {
      var s = http.createServer(handleRequest);
      s.once('error', function (e) {
        if (e.code === 'EADDRINUSE') {
          console.error('地址 ' + host + ':' + port + ' 已被占用（可能有旧实例在运行）');
        } else {
          console.error('代理启动失败（' + host + '）：', e.message);
        }
        reject(e);
      });
      s.listen(port, host, function () {
        servers.push(s);
        resolve(s);
      });
    });
  })).then(function (list) {
    console.log('哔哩下载器内置代理已启动（' + LISTEN_HOSTS.join(' / ') + ':' + port + '）');
    return list;
  });
}

function stop() {
  return Promise.all(servers.map(function (s) {
    return new Promise(function (resolve) {
      try { s.close(function () { resolve(); }); } catch (e) { resolve(); }
    });
  })).then(function () { servers = []; });
}

module.exports = {
  start: start,
  stop: stop,
  LISTEN_HOSTS: LISTEN_HOSTS,
  setUserDataDir: setUserDataDir,
  setUserCookies: setUserCookies,
  getUserLoginInfo: getUserLoginInfo,
  getProxyPort: function () { return PORT; },
  buildCookie: buildCookie,
  ensureBuvid: ensureBuvid,
  resetBuvid: resetBuvid
};

if (require.main === module) {
  start().catch(function () { process.exit(1); });
}
