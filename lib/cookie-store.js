'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only the Electron owner persists cookies. The standalone proxy keeps them in memory.
class CookieStore {
  constructor(dir, storage) { this.dir = dir; this.storage = storage; }
  get encryptedPath() { return path.join(this.dir, 'login_cookies.json.enc'); }
  get legacyPaths() { return ['login_cookies.json', 'bili_cookies.json'].map(name => path.join(this.dir, name)); }
  canEncrypt() {
    return this.storage.isEncryptionAvailable() &&
      (!this.storage.getSelectedStorageBackend || this.storage.getSelectedStorageBackend() !== 'basic_text');
  }
  save(cookies) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!cookies.SESSDATA) { this.clear(); return false; }
    if (!this.canEncrypt()) { this.clear(); return false; }
    const temp = this.encryptedPath + '.tmp';
    fs.writeFileSync(temp, this.storage.encryptString(JSON.stringify(cookies)));
    fs.renameSync(temp, this.encryptedPath);
    this.legacyPaths.forEach(file => fs.rmSync(file, { force: true }));
    return true;
  }
  load() {
    let cookies = null;
    if (this.canEncrypt() && fs.existsSync(this.encryptedPath)) {
      try { cookies = JSON.parse(this.storage.decryptString(fs.readFileSync(this.encryptedPath))); } catch (_) { /* migrate legacy if present */ }
    }
    for (const file of this.legacyPaths) {
      if (!cookies && fs.existsSync(file)) {
        try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); cookies = old.cookies || old; } catch (_) { /* invalid legacy data */ }
      }
    }
    if (cookies) this.save(cookies);
    return cookies || {};
  }
  clear() {
    [this.encryptedPath, this.encryptedPath + '.tmp', ...this.legacyPaths].forEach(file => fs.rmSync(file, { force: true }));
  }
}

module.exports = { CookieStore };
