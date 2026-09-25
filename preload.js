/* ============================================================
 * 哔哩下载器 · preload.js（渲染进程桥）
 * 通过 contextBridge 向页面暴露最小 API：
 *   window.biliAPI.login()                打开登录窗口（Electron）
 *   window.biliAPI.loginState()           查询登录态
 *   window.biliAPI.logout()               退出登录
 *   window.biliAPI.restartProxy()         重启内置代理（一键修复联动）
 *   window.biliAPI.getDownloadDir()       读取本地下载目录
 *   window.biliAPI.chooseDownloadDir()    弹出目录选择器
 *   window.biliAPI.setDownloadDir(dir)    保存下载目录
 *   window.biliAPI.openDownloadDir()      在资源管理器中打开目录
 *   window.biliAPI.muxAvailable()         DASH 高清合并能力（ffmpeg）
 *   window.biliAPI.muxDownload(cfg)       DASH 高清下载 + 合并（返回 Promise）
 *   window.biliAPI.onMuxProgress(cb)      DASH 合并进度事件
 *   window.biliAPI.getHistory()           读取历史下载记录
 *   window.biliAPI.addHistory(rec)        追加历史下载记录
 *   window.biliAPI.deleteFile(path)       删除文件
 *   window.biliAPI.openFile(path)         打开文件
 *   window.biliAPI.openFolder(path)       打开文件所在位置
 *   window.biliAPI.onDlPath(cb)           收到浏览器下载的最终保存路径
 * 网页版（无 Electron）时 window.biliAPI 不存在，页面自动降级。
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biliAPI', {
  isElectron: true,
  login: function () {
    return ipcRenderer.invoke('bili:login');
  },
  loginState: function () {
    return ipcRenderer.invoke('bili:login-state');
  },
  logout: function () {
    return ipcRenderer.invoke('bili:logout');
  },
  restartProxy: function () {
    return ipcRenderer.invoke('bili:restart-proxy');
  },
  getDownloadDir: function () {
    return ipcRenderer.invoke('bili:get-download-dir').then(function (r) {
      return r && r.dir ? r.dir : null;
    });
  },
  chooseDownloadDir: function () {
    return ipcRenderer.invoke('bili:set-download-dir').then(function (r) {
      return r && r.ok ? r.dir : null;
    });
  },
  openDownloadDir: function () {
    return ipcRenderer.invoke('bili:open-download-dir').then(function (r) {
      return !!(r && r.ok);
    });
  },
  openExternal: function (url) {
    return ipcRenderer.invoke('bili:open-external', url).then(function (r) {
      return !!(r && r.ok);
    });
  },
  /* DASH 高清 */
  muxAvailable: function () {
    return ipcRenderer.invoke('bili:mux-available').then(function (r) {
      return !!(r && r.ok);
    });
  },
  muxDownload: function (cfg) {
    return ipcRenderer.invoke('bili:mux-download', cfg || {});
  },
  muxCancel: function (token) {
    return ipcRenderer.invoke('bili:mux-cancel', token);
  },
  onMuxProgress: function (cb) {
    ipcRenderer.on('bili:mux-progress', function (e, data) {
      if (cb) cb(data);
    });
  },
  /* 下载历史 + 文件 */
  getHistory: function () {
    return ipcRenderer.invoke('bili:get-history');
  },
  addHistory: function (rec) {
    return ipcRenderer.invoke('bili:add-history', rec || {});
  },
  removeHistory: function (id) {
    return ipcRenderer.invoke('bili:remove-history', id);
  },
  clearHistory: function () {
    return ipcRenderer.invoke('bili:clear-history');
  },
  deleteFile: function (p) {
    return ipcRenderer.invoke('bili:delete-file', { path: p });
  },
  openFile: function (p) {
    return ipcRenderer.invoke('bili:open-file', { path: p });
  },
  openFolder: function (p) {
    return ipcRenderer.invoke('bili:open-folder', { path: p });
  },
  onDlPath: function (cb) {
    ipcRenderer.on('bili:dl-path', function (e, data) {
      if (cb) cb(data);
    });
  },
  /* 直链流式下载（低内存 + 断点续传 .part + 实时速度） */
  streamDownload: function (payload) {
    return ipcRenderer.invoke('bili:stream-download', payload || {});
  },
  streamCancel: function (token) {
    ipcRenderer.send('bili:stream-cancel', token);
  },
  onStreamProgress: function (cb) {
    ipcRenderer.on('bili:stream-progress', function (e, data) {
      if (cb) cb(data);
    });
  },
  /* 限速 / 统计 */
  setRateLimit: function (kbps) {
    return ipcRenderer.invoke('bili:set-rate-limit', kbps);
  },
  getDlStats: function () {
    return ipcRenderer.invoke('bili:get-dl-stats');
  },
  /* 视频信息 / 封面导出 */
  exportInfo: function (data) {
    return ipcRenderer.invoke('bili:export-info', data || {});
  },
  /* 弹幕 / 字幕 */
  fetchDanmaku: function (payload) {
    return ipcRenderer.invoke('bili:fetch-danmaku', payload || {});
  },
  /* 设置导出 / 导入 */
  exportSettings: function (data) {
    return ipcRenderer.invoke('bili:export-settings', data || {});
  },
  importSettings: function () {
    return ipcRenderer.invoke('bili:import-settings');
  },
  isElectron: true
});
