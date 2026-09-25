/* ============================================================
 * 哔哩下载器 · Electron 主进程（客户端一体化版 v2）
 * 启动时自动内嵌启动本地代理（127.0.0.1/.2/.3:8123），无需单独
 * 运行 start-server.bat；加载前端页面，功能与网页版完全一致。
 *
 * v2 新增：
 *   - 允许多开（去掉单实例锁；重复实例代理端口被占时自动复用已有实例）
 *   - 设置页内登录 B 站：打开登录窗口 → 抓取 Cookie → 注入代理
 *     （登录后可获取更高清晰度），Cookie 持久化到 userData
 *   - preload 桥（window.biliAPI）：登录 / 登出 / 重启代理
 *   - 一键修复联动：代理不可达时可通过 IPC 重启内置代理
 *
 * 支持烟雾测试：BILI_SMOKE_TEST=1 时自动执行端到端验证并退出
 * （提取 → 播放量 → 下载到临时目录），供打包前自检。
 * ============================================================ */
'use strict';

const { app, BrowserWindow, ipcMain, session, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const childProcess = require('child_process');
const proxy = require('./server.js');

const PROXY_PORT = 8123;
const LOGIN_URL = 'https://passport.bilibili.com/login';
let win = null;
let loginWin = null;
let loginResolve = null;
let loginTimer = null;
let downloadDir = null;   // 本地下载目录（首次取系统下载目录，可设置页更改）

/* ---------- 全局：限速 / 统计 / 错误日志（优化：限速 · 速度统计 · 日志） ---------- */
let globalRateLimit = 0;        // bytes/s，0 = 不限
const dlStats = { bytes: 0, t0: Date.now() };   // 全局累计下载字节（速度统计）
let logStream = null;
function logFile() {
  return path.join(app.getPath('userData'), 'bili.log');
}
function logMsg(kind, msg) {
  try {
    var line = '[' + new Date().toISOString() + '][' + kind + '] ' + msg + '\n';
    fs.appendFileSync(logFile(), line);
    if (kind === 'error') console.error(msg);
    else console.log(msg);
  } catch (e) { }
}
function logError(msg) { logMsg('error', msg); }
/** 限速检查：按全局速率估算是否需要等待 */
async function throttleTick(bytes) {
  if (globalRateLimit <= 0) return;
  dlStats.bytes += bytes;
  var elapsed = (Date.now() - dlStats.t0) / 1000;
  var expected = (globalRateLimit * elapsed);
  if (dlStats.bytes > expected) {
    var wait = (dlStats.bytes - expected) / globalRateLimit * 1000;
    if (wait > 5 && wait < 30000) await new Promise(function (r) { setTimeout(r, wait); });
  }
}

/* ---------- 内置代理 ---------- */
async function startProxy() {
  try {
    proxy.setUserDataDir(app.getPath('userData'));
    await proxy.start(PROXY_PORT);
  } catch (e) {
    // 端口被占（已有实例）时不影响本窗口启动，页面会连到已有实例
    console.error('[哔哩下载器] 内置代理启动异常（端口可能已被另一实例占用，将复用已有代理）：', e && e.message ? e.message : e);
  }
}

async function restartProxy() {
  await proxy.stop();
  await new Promise(function (r) { setTimeout(r, 400); });
  try {
    await proxy.start(PROXY_PORT);
    return { ok: true, port: PROXY_PORT };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : '重启失败' };
  }
}

/* ---------- 登录窗口 ---------- */
function closeLoginWin() {
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
  if (loginWin && !loginWin.isDestroyed()) { loginWin.close(); }
  loginWin = null;
}

function openLoginWindow() {
  return new Promise(function (resolve) {
    loginResolve = resolve;
    loginWin = new BrowserWindow({
      width: 480,
      height: 680,
      title: '登录哔哩哔哩',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    loginWin.loadURL(LOGIN_URL);
    // 自动锁定二维码：页面加载完成后滚动到二维码区域并居中，避免用户自行滑动查找
    loginWin.webContents.on('did-finish-load', function () {
      if (loginWin && !loginWin.isDestroyed()) loginWin.focus();
      setTimeout(function () {
        if (!loginWin || loginWin.isDestroyed()) return;
        loginWin.webContents.executeJavaScript(
          "(function(){var sel='.qrcode-wrap,.qr-login,.login-scan,img[src*=\"qrcode\"],img.login-scan-qrcode,.scan-qr,[class*=\"qr-code\"],[class*=\"qrlogin\"]';" +
          "var q=document.querySelector(sel);" +
          "if(q){q.scrollIntoView({behavior:'instant',block:'center'});return true;}" +
          "return false;})()"
        ).catch(function () { });
      }, 700);
    });
    loginWin.on('closed', function () {
      if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
      loginWin = null;
      if (loginResolve) { loginResolve({ ok: false, error: '登录窗口已关闭' }); loginResolve = null; }
    });

    // 轮询 Cookie：出现 SESSDATA 即视为登录成功（扫码登录会跳转回主站）
    loginTimer = setInterval(function () {
      session.defaultSession.cookies.get({})
        .then(function (cookies) {
          // 同名字段多域并存时，优先取主站 .bilibili.com 的最新值（passport 域可能残留旧值）
          var map = {};
          cookies.forEach(function (c) {
            var d = String(c.domain || '').toLowerCase();
            var name = c.name;
            if (!(name in map) || (d.indexOf('bilibili.com') >= 0 && d.indexOf('passport') < 0)) {
              map[name] = c.value;
            }
          });
          if (map.SESSDATA && map.DedeUserID) {
            clearInterval(loginTimer); loginTimer = null;
            saveLoginCookies(map);
            if (loginWin && !loginWin.isDestroyed()) { loginWin.close(); }
            loginWin = null;
            if (loginResolve) {
              loginResolve({ ok: true, uid: map.DedeUserID });
              loginResolve = null;
            }
          }
        })
        .catch(function () { });
    }, 1000);
  });
}

function safeName(name) {
  return String(name || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function saveLoginCookies(map) {
  // 保留登录相关 Cookie + 浏览器身份（buvid3/buvid4 等，与 SESSDATA 同会话，
  // 覆盖代理匿名身份可避免被 B 站判定异常而限制清晰度）
  var pick = {};
  ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid',
   'buvid3', 'buvid4', 'b_nut', 'b_lsid', 'bili_ticket', 'bili_ticket_expires'
  ].forEach(function (k) {
    if (map[k]) pick[k] = map[k];
  });
  proxy.setUserCookies(pick);
  // 持久化到磁盘（优化13：优先用系统安全存储加密；不支持时退回明文并保持兼容读取）
  try {
    var f = path.join(app.getPath('userData'), 'login_cookies.json');
    var payload = JSON.stringify(pick, null, 1);
    if (process.platform !== 'linux' && safeStorage && safeStorage.isEncryptionAvailable()) {
      var enc = safeStorage.encryptString(payload);
      fs.writeFileSync(f + '.enc', enc);
      try { fs.unlinkSync(f); } catch (e) { }
    } else {
      fs.writeFileSync(f, payload, 'utf8');
    }
  } catch (e) { }
  console.log('[哔哩下载器] 已保存登录账号（UID=' + (map.DedeUserID || '?') + '，身份 buvid3=' + (pick.buvid3 ? '已注入' : '无') + '）');
}

/** 启动时恢复上次登录（持久化的登录 Cookie，支持加密与明文两种格式） */
function restoreLoginCookies() {
  try {
    var f = path.join(app.getPath('userData'), 'login_cookies.json');
    var fe = f + '.enc';
    var j = null;
    if (safeStorage && safeStorage.isEncryptionAvailable() && fs.existsSync(fe)) {
      try { j = JSON.parse(safeStorage.decryptString(fs.readFileSync(fe))); } catch (e) { j = null; }
    }
    if (!j && fs.existsSync(f)) {
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { j = null; }
    }
    if (j && j.SESSDATA) {
      proxy.setUserCookies(j);
      console.log('[哔哩下载器] 已恢复登录态（UID=' + (j.DedeUserID || '?') + '）');
      return true;
    }
  } catch (e) { }
  return false;
}

/* ---------- 本地下载目录 ---------- */
function getDownloadDir() {
  if (downloadDir) return downloadDir;
  // 持久化：优先读取用户之前选择的目录，否则用系统下载目录
  try {
    var f = path.join(app.getPath('userData'), 'download_dir.txt');
    if (fs.existsSync(f)) {
      var saved = fs.readFileSync(f, 'utf8').trim();
      if (saved && fs.existsSync(saved)) {
        downloadDir = saved;
        return downloadDir;
      }
    }
  } catch (e) { }
  downloadDir = app.getPath('downloads');
  return downloadDir;
}

function saveDownloadDir(dir) {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'download_dir.txt'), dir, 'utf8');
  } catch (e) { }
}

/* 全局：所有下载统一保存到用户选择的本地目录，并把实际保存路径回传页面 */
function setupGlobalDownload() {
  session.defaultSession.on('will-download', function (e, item) {
    var dir = getDownloadDir();
    var savePath = path.join(dir, item.getFilename());
    item.setSavePath(savePath);
    try {
      var wc = BrowserWindow.getAllWindows()[0];
      if (wc && !wc.isDestroyed()) {
        wc.webContents.send('bili:dl-path', { filename: item.getFilename(), path: savePath });
      }
    } catch (err) { }
  });
}

/* ---------- 下载历史（持久化到 userData/download_history.json，原子写入防损坏） ---------- */
function historyFile() {
  return path.join(app.getPath('userData'), 'download_history.json');
}
function writeHistory(list) {
  try {
    var f = historyFile();
    var tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) { }
}
function getHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile(), 'utf8')) || []; }
  catch (e) { return []; }
}
function addHistory(rec) {
  var list = getHistory();
  var item = Object.assign({ id: Date.now() + '-' + Math.floor(Math.random() * 9999), time: Date.now() }, rec || {});
  list.unshift(item);
  var trimmed = list.slice(0, 500);
  writeHistory(trimmed);
  return item;
}

/* ---------- ffmpeg（DASH 高清音视频合并） ---------- */
function ffmpegPath() {
  // 1) 打包后：resources/ffmpeg.exe
  try {
    var p1 = path.join(process.resourcesPath, 'ffmpeg.exe');
    if (fs.existsSync(p1)) return p1;
  } catch (e) { }
  // 2) 打包后（兼容旧布局）：win-unpacked/ffmpeg.exe
  try {
    var pRoot = path.dirname(process.resourcesPath);
    var p2 = path.join(pRoot, 'ffmpeg.exe');
    if (fs.existsSync(p2)) return p2;
  } catch (e) { }
  // 3) 开发时：node_modules/ffmpeg-static
  try {
    var p3 = path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    if (fs.existsSync(p3)) return p3;
  } catch (e) { }
  return null;
}

function downloadToFile(url, dest, onProgress) {
  return new Promise(function (resolve, reject) {
    var u = require('url').parse(url);
    var headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/',
      'Accept': '*/*'
    };
    try {
      var ck = proxy.buildCookie();
      if (ck) headers['Cookie'] = ck;
    } catch (e) { }
    var req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.path,
      method: 'GET',
      headers: headers
    }, function (res) {
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error('媒体流下载失败（HTTP ' + res.statusCode + '）'));
        return;
      }
      var total = parseInt(res.headers['content-length'] || '0', 10);
      var got = 0;
      var out = fs.createWriteStream(dest);
      res.on('data', function (chunk) {
        got += chunk.length;
        if (total > 0 && onProgress) onProgress(got / total);
        if (globalRateLimit > 0) {
          res.pause();
          throttleTick(chunk.length).then(function () { res.resume(); });
        }
      });
      res.pipe(out);
      out.on('finish', function () {
        if (onProgress) onProgress(1);
        resolve();
      });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---------- 多线程分段下载（高清 DASH 流提速） ---------- */
var muxCancels = {};   // token → true（页面点击取消后置位）

function buildDlHeaders(extra) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': '*/*'
  };
  try {
    var ck = proxy.buildCookie();
    if (ck) headers['Cookie'] = ck;
  } catch (e) { }
  Object.keys(extra || {}).forEach(function (k) { headers[k] = extra[k]; });
  return headers;
}

/** 探测媒体流总大小（Range: bytes=0-0） */
function probeSize(url) {
  return new Promise(function (resolve, reject) {
    var u = require('url').parse(url);
    var req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.path,
      method: 'GET',
      headers: buildDlHeaders({ Range: 'bytes=0-0' })
    }, function (res) {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        reject(new Error('媒体流探测失败（HTTP ' + res.statusCode + '）'));
        return;
      }
      var total = 0;
      var cr = res.headers['content-range'];
      if (cr) {
        var m = String(cr).match(/\/(\d+)/);
        if (m) total = Number(m[1]);
      }
      if (!total) total = parseInt(res.headers['content-length'] || '0', 10);
      res.resume();
      resolve(total);
    });
    req.on('error', reject);
    req.end();
  });
}

/** 下载单个 Range 分片到 dest；返回已下载字节数；支持全局限速 */
function downloadRange(url, start, end, dest) {
  return new Promise(function (resolve, reject) {
    var u = require('url').parse(url);
    var req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.path,
      method: 'GET',
      headers: buildDlHeaders({ Range: 'bytes=' + start + '-' + end })
    }, function (res) {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        reject(new Error('分片下载失败（HTTP ' + res.statusCode + '）'));
        return;
      }
      var out = fs.createWriteStream(dest);
      var got = 0;
      res.on('data', function (chunk) {
        got += chunk.length;
        out.write(chunk);
        if (globalRateLimit > 0) {
          // 限速必须暂停流，等计时器放行后再继续（否则限速不生效）
          res.pause();
          throttleTick(chunk.length).then(function () { res.resume(); });
        }
      });
      res.on('end', function () { out.end(function () { resolve(got); }); });
      res.on('error', reject);
      out.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 多线程分段下载（动态分片调度版）：
 * 1) 探测大小 → 均分分片 → 任务池并发（完成的线程自动领取下一片，消除慢片尾效应）
 * 2) urls 主/备用 CDN 轮换
 * 3) 限速（globalRateLimit，0=不限）
 * 4) 支持取消与单分片重试
 * 5) 目标已存在且完整 → 跳过（断点续传最小实现：.part 完成后原子改名，避免半成品）
 * 6) onProgress(frac, bytes, speed) 实时速度
 */
async function downloadToFileMulti(urls, dest, threads, onProgress, token) {
  var list = Array.isArray(urls) && urls.length ? urls.slice() : [urls];
  var isCancelled = function () { return token && muxCancels[token]; };
  var finalDest = dest;
  var partDest = dest + '.part';
  // 断点续传：若 .part 已存在且完整（与探测大小一致）→ 直接改名完成
  var total = 0;
  var useIdx = 0;
  for (var pi = 0; pi < list.length; pi++) {
    try {
      total = await probeSize(list[pi]);
      useIdx = pi;
      break;
    } catch (e) { }
  }
  if (!total) {
    await downloadToFile(list[0], dest, onProgress);
    return;
  }
  try {
    if (fs.existsSync(partDest) && fs.statSync(partDest).size === total) {
      fs.renameSync(partDest, finalDest);
      if (onProgress) onProgress(1, total, 0);
      return;
    }
  } catch (e) { }
  var t = Math.max(1, Math.min(threads || 8, 16));
  if (total < 4 * 1024 * 1024) t = 1;   // 小文件不分段
  var chunk = Math.ceil(total / t);
  var ranges = [];
  for (var i = 0; i < t; i++) {
    var s = i * chunk;
    if (s >= total) break;
    var e = Math.min(s + chunk - 1, total - 1);
    ranges.push({ s: s, e: e, p: partDest + '.p' + i });
  }
  var got = 0;
  var t0 = Date.now();
  var pull = function (idx) {
    var r = ranges[idx];
    var u = list[(useIdx + idx) % list.length];
    var one = function () {
      if (isCancelled()) return Promise.reject(new Error('已取消'));
      return downloadRange(u, r.s, r.e, r.p).then(function (len) {
        got += len;
        if (onProgress) {
          var secs = (Date.now() - t0) / 1000 || 1;
          onProgress(Math.min(got / total, 1), got, secs > 0 ? got / secs : 0);
        }
      });
    };
    return one().catch(function (err) {
      if (isCancelled()) throw err;
      return one();   // 单分片重试一次
    });
  };
  // 任务池：worker 数 = 线程数，动态领取分片
  var nextIdx = 0;
  var workers = [];
  for (var w = 0; w < t && w < ranges.length; w++) {
    workers.push((async function () {
      while (true) {
        var idx = nextIdx++;
        if (idx >= ranges.length) break;
        await pull(idx);
      }
    })());
  }
  await Promise.all(workers);
  if (isCancelled()) throw new Error('已取消');
  // 顺序拼接分片 → 原子改名
  await new Promise(function (resolve, reject) {
    var out = fs.createWriteStream(partDest);
    var i = 0;
    var next = function () {
      if (i >= ranges.length) { out.end(); resolve(); return; }
      var r = fs.createReadStream(ranges[i++].p);
      r.pipe(out, { end: false });
      r.on('end', next);
      r.on('error', reject);
    };
    out.on('error', reject);
    next();
  });
  ranges.forEach(function (r) { try { fs.unlinkSync(r.p); } catch (e) { } });
  try { fs.renameSync(partDest, finalDest); } catch (e) { }
  if (onProgress) onProgress(1, total, 0);
}

/** ffmpeg 带进度回调：-progress pipe:1 解析 out_time_us，并解析输入时长 */
function runFfmpeg(args, onProgress) {
  return new Promise(function (resolve, reject) {
    var ff = ffmpegPath();
    if (!ff) { reject(new Error('未找到 ffmpeg')); return; }
    var child = childProcess.spawn(ff, args, { windowsHide: true });
    var errBuf = '';
    var durationUs = 0;
    child.stdout.on('data', function (d) {
      var s = String(d);
      var m = /out_time_us=(\d+)/.exec(s);
      if (m) {
        var us = Number(m[1]);
        if (durationUs > 0 && onProgress) onProgress(Math.min(us / durationUs, 1));
      }
    });
    child.stderr.on('data', function (d) {
      errBuf += String(d);
      if (!durationUs) {
        var dm = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(errBuf);
        if (dm) durationUs = ((Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])) * 1e6);
      }
    });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 合并失败（exit ' + code + '）' + (errBuf ? ' ' + errBuf.slice(-200) : '')));
    });
  });
}

/** DASH 高清：多线程并行下载视频流 + 音频流（CDN 备用地址轮换）→ ffmpeg 无损合并
 *  支持：实时速度统计（优化3）、合并进度（优化8）、视频片段裁剪（功能15）、MKV 输出（功能8） */
async function muxDownload(payload, event) {
  var token = payload.token || '';
  var threads = Math.max(4, Math.min(payload.threads || 8, 16));
  if (muxCancels[token]) delete muxCancels[token];
  var sendProg = function (frac, stage, speed) {
    try {
      var wc = BrowserWindow.getAllWindows()[0];
      if (wc && !wc.isDestroyed()) {
        wc.webContents.send('bili:mux-progress', { token: token, frac: frac, stage: stage || '', speed: speed || 0 });
      }
    } catch (e) { }
  };
  var isCancelled = function () { return token && muxCancels[token]; };
  var dir = getDownloadDir();
  var tmpDir = path.join(app.getPath('temp'), 'bili-dl-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  var vPath = path.join(tmpDir, 'video.m4s');
  var aPath = path.join(tmpDir, 'audio.m4s');
  var fmt = payload.format === 'mkv' ? 'mkv' : 'mp4';
  var outPath = path.join(dir, payload.filename);
  var vUrls = (payload.videoUrls && payload.videoUrls.length) ? payload.videoUrls : [payload.videoUrl];
  var aUrls = (payload.audioUrls && payload.audioUrls.length) ? payload.audioUrls : (payload.audioUrl ? [payload.audioUrl] : []);
  try {
    sendProg(0.02, threads + ' 线程并行下载音视频…', 0);
    var prog = { v: 0, a: 0, spd: 0 };
    var report = function () {
      var f = 0.02 + 0.9 * ((prog.v + prog.a) / 2);
      var stage = (aUrls.length ? ('视频流 ' + (prog.v * 100).toFixed(0) + '% · 音频流 ' + (prog.a * 100).toFixed(0) + '%') : '视频流 ' + (prog.v * 100).toFixed(0) + '%');
      sendProg(f, threads + ' 线程 ' + stage, prog.spd);
    };
    // 视频流 + 音频流并行下载（各自多线程分段 + CDN 轮换 + 实时速度）
    var jobs = [];
    if (vUrls.length) {
      jobs.push(downloadToFileMulti(vUrls, vPath, threads, function (f, bytes, spd) { prog.v = f; if (spd) prog.spd = spd; report(); }, token));
    }
    if (aUrls.length) {
      jobs.push(downloadToFileMulti(aUrls, aPath, threads, function (f, bytes, spd) { prog.a = f; if (spd) prog.spd = spd; report(); }, token));
    }
    await Promise.all(jobs);
    if (isCancelled()) throw new Error('已取消');
    sendProg(0.94, '正在合并音视频…', 0);
    var args = ['-y', '-probesize', '50000000', '-analyzeduration', '20000000'];
    // 视频片段裁剪（功能15）：-ss 在输入前（快速 seek），-to 复制
    if (payload.start) args = args.concat(['-ss', String(payload.start)]);
    if (payload.end) args = args.concat(['-to', String(payload.end)]);
    args = args.concat(['-i', vPath]);
    if (fs.existsSync(aPath) && fs.statSync(aPath).size > 0) args.push('-i', aPath);
    args = args.concat(['-c', 'copy']);
    if (fmt === 'mp4') args.push('-movflags', '+faststart');
    args.push(outPath);
    await runFfmpeg(args, function (mf) {
      sendProg(0.94 + mf * 0.06, '正在合并音视频… ' + (mf * 100).toFixed(0) + '%', 0);
    });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
    sendProg(1, '合并完成', 0);
    return { ok: true, path: outPath, size: fs.statSync(outPath).size };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
    if (token) delete muxCancels[token];
    if (err && err.message === '已取消') return { ok: false, error: '已取消', cancelled: true };
    logError('muxDownload: ' + (err && err.message));
    return { ok: false, error: err.message || '合并失败' };
  }
}

/* ---------- IPC（渲染进程 → 主进程） ---------- */
function registerIpc() {
  ipcMain.handle('bili:login', function () {
    if (loginWin) return { ok: false, error: '登录窗口已打开' };
    return openLoginWindow();
  });
  ipcMain.handle('bili:login-state', function () {
    return proxy.getUserLoginInfo();
  });
  ipcMain.handle('bili:logout', function () {
    proxy.setUserCookies({});
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'login_cookies.json')); } catch (e) { }
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'login_cookies.json.enc')); } catch (e) { }
    return { ok: true };
  });
  ipcMain.handle('bili:restart-proxy', function () {
    return restartProxy();
  });
  ipcMain.handle('bili:get-download-dir', function () {
    return { dir: getDownloadDir() };
  });
  ipcMain.handle('bili:set-download-dir', async function () {
    var r = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      defaultPath: getDownloadDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    downloadDir = r.filePaths[0];
    saveDownloadDir(downloadDir);
    return { ok: true, dir: downloadDir };
  });
  ipcMain.handle('bili:open-download-dir', function () {
    var dir = getDownloadDir();
    try {
      shell.openPath(dir);
    } catch (e) { }
    return { ok: true, dir: dir };
  });

  /* ---- 用系统默认浏览器打开外部链接（开源仓库等） ---- */
  ipcMain.handle('bili:open-external', function (event, url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false };
    try {
      shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  /* ---- DASH 高清合并 ---- */
  ipcMain.handle('bili:mux-available', function () {
    return { ok: !!ffmpegPath() };
  });
  ipcMain.handle('bili:mux-download', function (event, payload) {
    return muxDownload(payload || {}, event);
  });
  ipcMain.handle('bili:mux-cancel', function (event, token) {
    if (token) muxCancels[token] = true;
    return { ok: true };
  });

  /* ---- 直链流式下载（durl / 音频走主进程：低内存 + 断点续传 .part + 实时速度） ---- */
  async function streamDownload(payload) {
    var token = payload.token || ('s' + Date.now());
    var threads = Math.max(4, Math.min(payload.threads || 8, 16));
    var dir = getDownloadDir();
    var dest = path.join(dir, safeName(payload.filename || 'download'));
    var urls = (payload.urls && payload.urls.length) ? payload.urls : [payload.url];
    var sendProg = function (frac, speed, stage) {
      try {
        var wc = BrowserWindow.getAllWindows()[0];
        if (wc && !wc.isDestroyed()) {
          wc.webContents.send('bili:stream-progress', { token: token, frac: frac, speed: speed || 0, stage: stage || '' });
        }
      } catch (e) { }
    };
    try {
      await downloadToFileMulti(urls, dest, threads, function (f, bytes, spd) {
        sendProg(f, spd, '下载中 ' + (f * 100).toFixed(0) + '%');
      }, token);
      sendProg(1, 0, '完成');
      return { ok: true, path: dest, size: fs.statSync(dest).size };
    } catch (err) {
      if (token) delete muxCancels[token];
      if (err && err.message === '已取消') return { ok: false, error: '已取消', cancelled: true };
      logError('streamDownload: ' + (err && err.message));
      return { ok: false, error: err.message || '下载失败' };
    }
  }
  ipcMain.handle('bili:stream-download', function (event, payload) {
    return streamDownload(payload || {});
  });
  ipcMain.on('bili:stream-cancel', function (event, token) {
    if (token) muxCancels[token] = true;
  });

  /* ---- 全局限速 / 下载统计（优化：限速 · 统计） ---- */
  ipcMain.handle('bili:set-rate-limit', function (event, kbps) {
    globalRateLimit = Math.max(0, Number(kbps) || 0) * 1024;
    dlStats.t0 = Date.now();
    return { ok: true, limit: globalRateLimit };
  });
  ipcMain.handle('bili:get-dl-stats', function () {
    return { bytes: dlStats.bytes, rateLimit: globalRateLimit };
  });

  /* ---- 视频信息 / 封面导出（功能5 · 功能18） ---- */
  ipcMain.handle('bili:export-info', async function (event, data) {
    try {
      var dir = getDownloadDir();
      var base = safeName(data.filename || 'video-info');
      var jsonPath = path.join(dir, base + '.json');
      fs.writeFileSync(jsonPath, JSON.stringify(data.info || {}, null, 2), 'utf8');
      var coverPath = null;
      if (data.coverUrl) {
        coverPath = path.join(dir, base + '.jpg');
        await downloadToFile(data.coverUrl, coverPath, null);
        if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size < 100) { coverPath = null; }
      }
      return { ok: true, json: jsonPath, cover: coverPath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---- 弹幕 XML + 字幕 SRT 下载（功能4） ---- */
  ipcMain.handle('bili:fetch-danmaku', async function (event, payload) {
    try {
      var dir = getDownloadDir();
      var base = safeName(payload.filename || 'danmaku');
      var dmPath = path.join(dir, base + '.xml');
      await downloadToFile('https://api.bilibili.com/x/v1/dm/list.so?oid=' + payload.cid, dmPath, null);
      var srtPath = null;
      if (payload.subUrl) {
        srtPath = path.join(dir, base + '.srt');
        try {
          await downloadToFile(payload.subUrl, srtPath, null);
          var txt = fs.readFileSync(srtPath, 'utf8').trim();
          var j = null;
          try { j = JSON.parse(txt); } catch (e) { }
          if (j && Array.isArray(j.body)) {
            var lines = j.body.map(function (b, i) {
              var fmt = function (t) {
                var d = new Date(Number(t) * 1000);
                return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' +
                  String(d.getUTCSeconds()).padStart(2, '0') + ',' + String(d.getUTCMilliseconds()).padStart(3, '0');
              };
              return (i + 1) + '\n' + fmt(b.from || 0) + ' --> ' + fmt(b.to || 0) + '\n' + String(b.content || '') + '\n';
            });
            fs.writeFileSync(srtPath, lines.join('\n'), 'utf8');
          } else if (/^\d+$/.test(txt)) {
            // 纯数字 = 弹幕 ID 而非字幕，删除
            fs.unlinkSync(srtPath);
            srtPath = null;
          }
        } catch (e) { srtPath = null; }
      }
      return { ok: true, danmaku: dmPath, srt: srtPath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---- 设置导出 / 导入（功能12 替代：本地文件同步） ---- */
  ipcMain.handle('bili:export-settings', async function (event, data) {
    try {
      var r = await dialog.showSaveDialog(win, { title: '导出设置', defaultPath: 'bili-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, JSON.stringify(data || {}, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('bili:import-settings', async function () {
    try {
      var r = await dialog.showOpenDialog(win, { title: '导入设置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
      var j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      return { ok: true, settings: j };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---- 下载历史 + 文件操作 ---- */
  ipcMain.handle('bili:get-history', function () {
    return getHistory();
  });
  ipcMain.handle('bili:add-history', function (event, rec) {
    return addHistory(rec || {});
  });
  ipcMain.handle('bili:remove-history', function (event, id) {
    try {
      var list = getHistory().filter(function (x) { return String(x.id) !== String(id); });
      writeHistory(list);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('bili:clear-history', function () {
    try {
      writeHistory([]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('bili:delete-file', function (event, p) {
    try {
      if (p && p.path && fs.existsSync(p.path)) fs.unlinkSync(p.path);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('bili:open-file', async function (event, p) {
    if (!p || !p.path || !fs.existsSync(p.path)) return { ok: false, error: '文件不存在' };
    var err = await shell.openPath(p.path);
    return { ok: !err, error: err || '' };
  });
  ipcMain.handle('bili:open-folder', function (event, p) {
    if (!p || !p.path || !fs.existsSync(p.path)) return { ok: false, error: '文件不存在' };
    shell.showItemInFolder(p.path);
    return { ok: true };
  });
}

/* ---------- 主窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 880,
    minWidth: 640,
    minHeight: 640,
    autoHideMenuBar: true,
    title: '哔哩下载器 · Dom',
    backgroundColor: '#f4f6f9',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', function () {
    win = null;
  });
  return win;
}

/* ---------- 应用生命周期 ---------- */
app.whenReady().then(function () {
  registerIpc();
  setupGlobalDownload();
  // 恢复上次登录态（若存在），需在代理启动前注入，保证首次请求即带登录身份
  restoreLoginCookies();
  // 先创建窗口立即显示 UI（避免代理网络初始化阻塞启动、造成卡顿白屏），
  // 代理异步就绪；页面加载后会自行探测并轮询等待代理连接。
  const w = createWindow();
  startProxy();

  if (process.env.BILI_SMOKE_TEST) {
    runSmokeTest(w);
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  app.quit();
});

app.on('before-quit', function () {
  proxy.stop();
});

/* ---------- 烟雾测试（打包前自检） ---------- */
function runSmokeTest(w) {
  const { webContents } = w;
  const exec = require('child_process').execSync;
  const log = function (m) { console.log('[smoke] ' + m); };
  const tmpFile = '/tmp/bili_smoke_download.mp4';

  setTimeout(function () {
    (async function () {
      try {
        // 1. 代理状态
        const st = await (await fetch('http://127.0.0.1:' + PROXY_PORT + '/status')).json();
        log('proxy status: ' + JSON.stringify(st));

        // 2. 注册下载保存路径（headless 下不弹保存框）
        webContents.session.on('will-download', function (e, item) {
          item.setSavePath(tmpFile);
        });

        // 3. 页面内提取（真实渲染进程执行 app.js）
        await webContents.executeJavaScript(`
          (async function () {
            var input = document.getElementById('url-input');
            input.value = 'BV1GJ411x7h7';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(function (r) { setTimeout(r, 6000); });
            var st = document.getElementById('finder-status');
            var dl = document.getElementById('result');
            return {
              status: st ? st.textContent : '',
              resultHidden: dl ? dl.hidden : true,
              title: document.getElementById('v-title') ? document.getElementById('v-title').textContent : '',
              views: document.getElementById('v-views') ? document.getElementById('v-views').textContent : ''
            };
          })()
        `).then(function (r) {
          log('extract: ' + JSON.stringify(r));
          if (r.resultHidden || !/已识别/.test(r.status)) throw new Error('提取未完成: ' + r.status);
        });

        // 4. 选 360P 下载
        await webContents.executeJavaScript(`
          (async function () {
            var qn = document.getElementById('qn-select');
            if (qn) { qn.value = '16'; qn.dispatchEvent(new Event('change')); }
            document.getElementById('dl-btn').click();
            await new Promise(function (r) { setTimeout(r, 3000); });
            var tasks = document.querySelectorAll('.task-card');
            var last = tasks.length ? tasks[tasks.length - 1] : null;
            return last ? (last.querySelector('.task-status') || {}).textContent : 'no-task';
          })()
        `).then(function (r) {
          log('download started, task status: ' + r);
        });

        // 5. 等待下载完成（轮询临时文件）
        var ok = false;
        for (var i = 0; i < 60; i++) {
          await new Promise(function (r) { setTimeout(r, 1000); });
          if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) { ok = true; break; }
        }
        log('download finished: ' + ok + ', file: ' + tmpFile + ' ' + (fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0) + ' bytes');
        if (!ok) throw new Error('下载未完成');

        // 6. 验证多任务：再次点击下载（第二个任务应正常启动）
        await webContents.executeJavaScript(`
          (async function () {
            document.getElementById('dl-btn').click();
            await new Promise(function (r) { setTimeout(r, 2000); });
            return document.querySelectorAll('.task-card').length;
          })()
        `).then(function (n) {
          log('multi-task check: ' + n + ' tasks');
        });

        log('RESULT={\\"status\\":true}');
      } catch (e) {
        log('RESULT={\\"status\\":false,\\"error\\":' + JSON.stringify(e && e.message ? e.message : String(e)) + '}');
      } finally {
        app.exit();
      }
    })();
  }, 1500);
}
