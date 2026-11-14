'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 登录 Cookie 的落盘策略（仅 Electron 主进程负责写入；独立代理只保存在内存）：
// 1. 优先用 safeStorage 加密（Windows DPAPI / macOS Keychain / Linux libsecret）；
// 2. 系统无可用密钥环时（Linux 无 keyring，Electron 退回 basic_text，等同不加密），
//    仍以 0600 权限写明文文件，保证登录态可以跨重启保留——否则每次重启都要重新扫码。
class CookieStore {
  constructor(dir, storage) { this.dir = dir; this.storage = storage; }
  get encryptedPath() { return path.join(this.dir, 'login_cookies.json.enc'); }
  // 无密钥环时的明文回退文件（0600，仅当前用户可读）
  get plainPath() { return path.join(this.dir, 'login_cookies.json'); }
  // 旧版本遗留文件，读到时迁移到当前策略
  get legacyPaths() { return [path.join(this.dir, 'bili_cookies.json')]; }
  canEncrypt() {
    try {
      if (!this.storage || !this.storage.isEncryptionAvailable || !this.storage.isEncryptionAvailable()) return false;
      // basic_text 表示操作系统没有真正的密钥保护，等价于明文，不能当作加密
      return !(this.storage.getSelectedStorageBackend && this.storage.getSelectedStorageBackend() === 'basic_text');
    } catch (_) {
      return false;
    }
  }
  writeFile(file, data) {
    const temp = file + '.tmp';
    // 0600：同机其他用户不应读到登录 Cookie；Windows 上 mode 由 ACL 决定，chmod 为无操作
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); fs.chmodSync(this.dir, 0o700); } catch (_) { /* Windows 忽略 */ }
  }
  removeStale(keep) {
    [this.encryptedPath, this.encryptedPath + '.tmp', this.plainPath, this.plainPath + '.tmp', ...this.legacyPaths]
      .filter(file => file !== keep)
      .forEach(file => fs.rmSync(file, { force: true }));
  }
  save(cookies) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!cookies || !cookies.SESSDATA) { this.clear(); return false; }
    const text = JSON.stringify(cookies);
    if (this.canEncrypt()) {
      this.writeFile(this.encryptedPath, this.storage.encryptString(text));
      this.removeStale(this.encryptedPath);
      return true;
    }
    // 回退：无密钥环时写明文（0600），登录态仍可永久保留
    this.writeFile(this.plainPath, text);
    this.removeStale(this.plainPath);
    return true;
  }
  load() {
    let cookies = null;
    if (this.canEncrypt() && fs.existsSync(this.encryptedPath)) {
      try { cookies = JSON.parse(this.storage.decryptString(fs.readFileSync(this.encryptedPath))); } catch (_) { /* 密钥变化导致无法解密时继续尝试明文/旧文件 */ }
    }
    if (!cookies && fs.existsSync(this.plainPath)) {
      try { cookies = JSON.parse(fs.readFileSync(this.plainPath, 'utf8')); } catch (_) { /* 明文损坏则视为未登录 */ }
    }
    for (const file of this.legacyPaths) {
      if (!cookies && fs.existsSync(file)) {
        try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); cookies = old.cookies || old; } catch (_) { /* invalid legacy data */ }
      }
    }
    if (!cookies || !cookies.SESSDATA) { if (cookies) this.clear(); return {}; }
    // 迁移到当前最优存储：能加密就升级为密文，否则保持明文并清掉旧文件
    this.save(cookies);
    return cookies;
  }
  clear() {
    [this.encryptedPath, this.encryptedPath + '.tmp', this.plainPath, this.plainPath + '.tmp', ...this.legacyPaths].forEach(file => fs.rmSync(file, { force: true }));
  }
}

module.exports = { CookieStore };
