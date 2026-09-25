/* Desktop main process: authenticated loopback proxy, encrypted login, managed files, and validated downloads. */
'use strict';

const { app, BrowserWindow, ipcMain, session, dialog, shell, safeStorage } = require('electron');
const path = require('path');
if (process.env.BILI_DATA_DIR) app.setPath('userData', path.resolve(process.env.BILI_DATA_DIR));
const fs = require('fs');
const https = require('https');
const childProcess = require('child_process');
const proxy = require('./server.js');
const security = require('./lib/security');
const { CookieStore } = require('./lib/cookie-store');
const { Downloader, DownloadControl } = require('./lib/downloader');
const { pathToFileURL } = require('url');
const downloader = new Downloader({ cookie: () => proxy.buildCookie() });
const controls = new Map();
let cookieStore, proxyStart;
let managed = [];
const appUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
function trustedSender(event) {
  return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === appUrl;
}
function ipcHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('不允许的页面请求');
    return handler(event, ...args);
  });
}
function rememberFile(file) {
  if (!fs.existsSync(file)) return;
  managed = managed.filter(item => item.path !== file);
  managed.push({ path: path.resolve(file), root: fs.realpathSync(path.dirname(file)) });
  const target = path.join(app.getPath('userData'), 'managed-files.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(managed));
  fs.renameSync(target + '.tmp', target);
}
function checkedFile(file) {
  return security.assertManagedPath(file, managed.map(item => item.root), new Set(managed.map(item => item.path)));
}
function controlFor(token) {
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(token) || controls.has(token)) throw new Error('无效或重复的任务标识');
  const control = new DownloadControl(); controls.set(token, control); return control;
}
function sendProgress(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

const PROXY_PORT = 8123;
const LOGIN_URL = 'https://passport.bilibili.com/login';
let win = null;
let loginWin = null;
let loginResolve = null;
let loginTimer = null;
let downloadDir = null;   // 本地下载目录（首次取系统下载目录，可设置页更改）

/* ---------- 全局：限速 / 统计 / 错误日志（优化：限速 · 速度统计 · 日志） ---------- */
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
/* ---------- 内置代理 ---------- */
async function startProxy() { await proxy.start(PROXY_PORT); }

async function restartProxy() {
  await proxy.stop();
  await new Promise(function (r) { setTimeout(r, 400); });
  try {
    proxyStart = startProxy();
    await proxyStart;
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
    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loginWin.webContents.on('will-navigate', (event, url) => {
      try { if (!security.matchesDomain(new URL(url).hostname, 'bilibili.com') || new URL(url).protocol !== 'https:') event.preventDefault(); }
      catch (_) { event.preventDefault(); }
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
            if (!security.matchesDomain(d.replace(/^\./, ''), 'bilibili.com')) return;
            var name = c.name;
            if (!(name in map) || (d.indexOf('bilibili.com') >= 0 && d.indexOf('passport') < 0)) {
              map[name] = c.value;
            }
          });
          if (map.SESSDATA && map.DedeUserID) {
            clearInterval(loginTimer); loginTimer = null;
            saveLoginCookies(map);
            const success = loginResolve;
            loginResolve = null;
            if (success) success({ ok: true, uid: map.DedeUserID });
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

function safeName(name) { return security.safeName(name); }
function saveLoginCookies(map) { proxy.setUserCookies(map); }
function restoreLoginCookies() {
  cookieStore = new CookieStore(app.getPath('userData'), safeStorage);
  const saved = cookieStore.load();
  proxy.onCookiesChanged(cookies => cookieStore.save(cookies));
  proxy.setUserCookies(saved);
}

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
  session.defaultSession.on('will-download', function (event, item, contents) {
    if (!win || contents !== win.webContents) { event.preventDefault(); return; }
    let savePath;
    try { savePath = security.reserveOutput(getDownloadDir(), item.getFilename()); }
    catch (error) {
      sendProgress('bili:dl-path', { url: item.getURL(), filename: item.getFilename(), error: error.message });
      event.preventDefault(); return;
    }
    item.setSavePath(savePath);
    item.once('done', (_, state) => {
      if (state !== 'completed') {
        fs.rmSync(savePath, { force: true });
        sendProgress('bili:dl-path', { url: item.getURL(), filename: path.basename(savePath), error: '文件保存失败：' + state });
        return;
      }
      rememberFile(savePath);
      sendProgress('bili:dl-path', { url: item.getURL(), filename: path.basename(savePath), path: savePath });
    });
  });
}

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
  const packaged = path.join(process.resourcesPath || __dirname, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(packaged)) return packaged;
  try { const binary = require('ffmpeg-static'); if (binary && fs.existsSync(binary)) return binary; } catch (_) {}
  return null;
}
async function downloadToFile(url, dest, onProgress) {
  await downloader.download([url], dest, { threads: 1, onProgress });
}
function runFfmpeg(args, onProgress, control) {
  return control.run(signal => new Promise((resolve, reject) => {
    const ff = ffmpegPath();
    if (!ff) return reject(new Error('未找到 ffmpeg，请运行 npm ci 后重试'));
    const child = childProcess.spawn(ff, ['-nostdin', '-progress', 'pipe:1', ...args], { windowsHide: true });
    let errorText = '', duration = 0;
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      const match = /out_time_us=(\d+)/.exec(String(data));
      if (match && duration && onProgress) onProgress(Math.min(Number(match[1]) / duration, 1));
    });
    child.stderr.on('data', data => {
      errorText = (errorText + data).slice(-8192);
      const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(errorText);
      if (match) duration = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1e6;
    });
    child.on('error', reject);
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error('ffmpeg 合并失败：' + errorText.slice(-400)));
    });
  }));
}
async function muxDownload(payload) {
  const token = payload.token;
  const control = controlFor(token);
  const dir = getDownloadDir();
  let tmpDir, outPath, complete = false;
  try {
    outPath = security.reserveOutput(dir, payload.filename);
    tmpDir = fs.mkdtempSync(path.join(dir, '.bili-mux-'));
    const video = path.join(tmpDir, 'video.m4s');
    const audio = path.join(tmpDir, 'audio.m4s');
    const progress = { v: 0, a: 0 };
    const videoUrls = payload.videoUrls || [payload.videoUrl];
    const audioUrls = payload.audioUrls || (payload.audioUrl ? [payload.audioUrl] : []);
    const report = (key, fraction, bytes, speed) => {
      progress[key] = fraction;
      sendProgress('bili:mux-progress', { token, frac: .9 * (progress.v + progress.a) / (audioUrls.length ? 2 : 1), speed, stage: '下载中' });
    };
    const jobs = [downloader.download(videoUrls, video, { threads: payload.threads, control, onProgress: (...args) => report('v', ...args) })];
    if (audioUrls.length) jobs.push(downloader.download(audioUrls, audio, { threads: payload.threads, control, onProgress: (...args) => report('a', ...args) }));
    const results = await Promise.allSettled(jobs.map(job => job.catch(error => { control.cancel(); throw error; })));
    const failed = results.find(result => result.status === 'rejected' && result.reason.code !== 'CANCELLED') || results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    await control.ready();
    control.phase = 'merging';
    sendProgress('bili:mux-progress', { token, frac: .9, speed: 0, stage: '正在合并音视频', phase: 'merging' });
    let args = ['-y', '-i', video];
    if (audioUrls.length) args.push('-i', audio);
    const start = Number(payload.start) || 0, end = Number(payload.end) || 0;
    if (start < 0 || end < 0 || (end && end <= start)) throw new Error('无效的片段时间');
    if (start) args.push('-ss', String(start));
    if (end) args.push('-t', String(end - start));
    args.push('-c', 'copy');
    if (path.extname(outPath).toLowerCase() === '.mp4') args.push('-movflags', '+faststart');
    const staged = path.join(tmpDir, 'output' + path.extname(outPath));
    args.push(staged);
    await runFfmpeg(args, fraction => sendProgress('bili:mux-progress', { token, frac: .9 + fraction * .1, stage: '正在合并音视频', phase: 'merging' }), control);
    await control.ready();
    fs.renameSync(staged, outPath); rememberFile(outPath); complete = true;
    return { ok: true, path: outPath, filename: path.basename(outPath), size: fs.statSync(outPath).size };
  } catch (error) {
    return { ok: false, error: error.message, cancelled: error.code === 'CANCELLED' };
  } finally {
    controls.delete(token);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!complete && outPath) fs.rmSync(outPath, { force: true });
  }
}

function registerIpc() {
  ipcHandle('bili:proxy-config', async () => { await proxyStart; return { port: PROXY_PORT, token: proxy.getAccessToken() }; });
  ipcHandle('bili:download-pause', (_, token) => ({ ok: controls.has(token) && controls.get(token).pause() }));
  ipcHandle('bili:download-resume', (_, token) => {
    const control = controls.get(token);
    if (!control) return { ok: false };
    control.resume(); return { ok: true };
  });
  ipcHandle('bili:login', function () {
    if (loginWin) return { ok: false, error: '登录窗口已打开' };
    return openLoginWindow();
  });
  ipcHandle('bili:login-state', function () {
    return proxy.getUserLoginInfo();
  });
  ipcHandle('bili:logout', async function () {
    await session.defaultSession.clearStorageData({ storages: ['cookies'] });
    proxy.setUserCookies({});
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'login_cookies.json')); } catch (e) { }
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'login_cookies.json.enc')); } catch (e) { }
    return { ok: true };
  });
  ipcHandle('bili:restart-proxy', function () {
    return restartProxy();
  });
  ipcHandle('bili:get-download-dir', function () {
    return { dir: getDownloadDir() };
  });
  ipcHandle('bili:set-download-dir', async function () {
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
  ipcHandle('bili:open-download-dir', function () {
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
  ipcHandle('bili:mux-available', function () {
    return { ok: !!ffmpegPath() };
  });
  ipcHandle('bili:mux-download', function (event, payload) {
    return muxDownload(payload || {}, event);
  });
  ipcHandle('bili:mux-cancel', function (event, token) {
    if (controls.has(token)) controls.get(token).cancel();
    return { ok: true };
  });

  /* ---- 直链流式下载（durl / 音频走主进程：低内存 + 会话内暂停恢复 + 实时速度） ---- */
  async function streamDownload(payload) {
    const token = payload.token;
    const control = controlFor(token);
    let dest, complete = false;
    try {
      dest = security.reserveOutput(getDownloadDir(), payload.filename);
      await downloader.download(payload.urls || [payload.url], dest, {
        threads: payload.threads, control,
        onProgress: (frac, bytes, speed) => sendProgress('bili:stream-progress', { token, frac, speed, stage: '下载中 ' + (frac * 100).toFixed(0) + '%' })
      });
      rememberFile(dest); complete = true;
      return { ok: true, path: dest, filename: path.basename(dest), size: fs.statSync(dest).size };
    } catch (error) {
      return { ok: false, error: error.message, cancelled: error.code === 'CANCELLED' };
    } finally {
      controls.delete(token);
      if (!complete && dest) fs.rmSync(dest, { force: true });
    }
  }

  ipcHandle('bili:stream-download', function (event, payload) {
    return streamDownload(payload || {});
  });
  ipcMain.on('bili:stream-cancel', function (event, token) {
    if (!trustedSender(event)) return;
    if (controls.has(token)) controls.get(token).cancel();
  });

  /* ---- 全局限速 / 下载统计（优化：限速 · 统计） ---- */
  ipcHandle('bili:set-rate-limit', function (event, kbps) {
    downloader.setRate(kbps);
    return { ok: true, limit: downloader.rate };
  });
  ipcHandle('bili:get-dl-stats', function () {
    return { bytes: downloader.bytes, rateLimit: downloader.rate };
  });

  /* ---- 视频信息 / 封面导出（功能5 · 功能18） ---- */
  ipcHandle('bili:export-info', async function (event, data) {
    try {
      var dir = getDownloadDir();
      var base = safeName(data.filename || 'video-info');
      var jsonPath = security.reserveOutput(dir, base + '.json');
      fs.writeFileSync(jsonPath, JSON.stringify(data.info || {}, null, 2), 'utf8');
      var coverPath = null;
      if (data.coverUrl) {
        coverPath = security.reserveOutput(dir, base + '.jpg');
        await downloadToFile(data.coverUrl, coverPath, null);
        if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size < 100) { coverPath = null; }
      }
      return { ok: true, json: jsonPath, cover: coverPath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---- 弹幕 XML + 字幕 SRT 下载（功能4） ---- */
  ipcHandle('bili:fetch-danmaku', async function (event, payload) {
    try {
      var dir = getDownloadDir();
      var base = safeName(payload.filename || 'danmaku');
      var dmPath = null;
      if (payload.danmaku !== false) {
        dmPath = security.reserveOutput(dir, base + '.xml');
        await downloadToFile('https://api.bilibili.com/x/v1/dm/list.so?oid=' + encodeURIComponent(payload.cid), dmPath, null);
      }
      var srtPath = null;
      if (payload.subUrl) {
        srtPath = security.reserveOutput(dir, base + '.srt');
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
  ipcHandle('bili:export-settings', async function (event, data) {
    try {
      var r = await dialog.showSaveDialog(win, { title: '导出设置', defaultPath: 'bili-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, JSON.stringify(data || {}, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcHandle('bili:import-settings', async function () {
    try {
      var r = await dialog.showOpenDialog(win, { title: '导入设置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
      var j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      return { ok: true, settings: j };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---- 下载历史 + 文件操作 ---- */
  ipcHandle('bili:get-history', function () {
    return getHistory();
  });
  ipcHandle('bili:add-history', function (event, rec) {
    return addHistory(rec || {});
  });
  ipcHandle('bili:remove-history', function (event, id) {
    try {
      var list = getHistory().filter(function (x) { return String(x.id) !== String(id); });
      writeHistory(list);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcHandle('bili:clear-history', function () {
    try {
      writeHistory([]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcHandle('bili:delete-file', function (event, p) {
    try {
      fs.unlinkSync(checkedFile(p && p.path));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcHandle('bili:open-file', async function (event, p) {
    if (!p || !p.path || !fs.existsSync(p.path)) return { ok: false, error: '文件不存在' };
    var err = await shell.openPath(checkedFile(p.path));
    return { ok: !err, error: err || '' };
  });
  ipcHandle('bili:open-folder', function (event, p) {
    if (!p || !p.path || !fs.existsSync(p.path)) return { ok: false, error: '文件不存在' };
    shell.showItemInFolder(checkedFile(p.path));
    return { ok: true };
  });
}

/* ---------- 主窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    show: process.env.BILI_HEADLESS !== '1',
    width: 900,
    height: 880,
    minWidth: 640,
    minHeight: 640,
    autoHideMenuBar: true,
    title: '哔哩下载器 · GenshinplayerDom',
    backgroundColor: '#f4f6f9',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', function () {
    win = null;
  });
  return win;
}

/* ---------- 应用生命周期 ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(function () {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  try { managed = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'managed-files.json'), 'utf8')); if (!Array.isArray(managed)) managed = []; } catch (_) {}
  proxyStart = startProxy();
  proxyStart.catch(error => logError('代理启动失败：' + error.message));
  registerIpc();
  setupGlobalDownload();
  // 恢复上次登录态（若存在），需在代理启动前注入，保证首次请求即带登录身份
  restoreLoginCookies();
  // 先创建窗口立即显示 UI（避免代理网络初始化阻塞启动、造成卡顿白屏），
  // 代理异步就绪；页面加载后会自行探测并轮询等待代理连接。
  const w = createWindow();


  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  app.quit();
});

app.on('before-quit', function () {
  controls.forEach(control => control.cancel());
  proxy.stop();
});
