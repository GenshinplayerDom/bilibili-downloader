'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { once } = require('node:events');
const { validateUrl, cookieHeaders } = require('./security');

function stopped(code = 'CANCELLED') {
  return Object.assign(new Error(code === 'PAUSED' ? '已暂停' : '已取消'), { code });
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

class DownloadControl {
  constructor() { this.paused = false; this.cancelled = false; this.phase = 'download'; this.controllers = new Set(); this.waiters = []; }
  pause() {
    if (this.cancelled || this.phase !== 'download') return false;
    this.paused = true;
    this.controllers.forEach(controller => controller.abort(stopped('PAUSED')));
    return true;
  }
  resume() { this.paused = false; this.waiters.splice(0).forEach(resolve => resolve()); }
  cancel() { this.cancelled = true; this.controllers.forEach(controller => controller.abort(stopped())); this.resume(); }
  async ready() {
    if (this.cancelled) throw stopped();
    while (this.paused) await new Promise(resolve => this.waiters.push(resolve));
    if (this.cancelled) throw stopped();
  }
  async run(fn) {
    for (;;) {
      await this.ready();
      const controller = new AbortController();
      this.controllers.add(controller);
      try { return await fn(controller.signal); }
      catch (error) {
        if (this.cancelled) throw stopped();
        if (!controller.signal.aborted || controller.signal.reason.code !== 'PAUSED') throw error;
      } finally { this.controllers.delete(controller); }
    }
  }
}

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async use(fn, signal) {
    await new Promise((resolve, reject) => {
      const enter = () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(signal.reason); this.drain(); return; }
        this.active++; resolve();
      };
      const abort = () => { this.queue = this.queue.filter(item => item !== enter); reject(signal.reason); };
      if (signal.aborted) return reject(signal.reason);
      if (this.active < this.limit) enter();
      else { this.queue.push(enter); signal.addEventListener('abort', abort, { once: true }); }
    });
    try { return await fn(); } finally { this.active--; this.drain(); }
  }
  drain() { while (this.active < this.limit && this.queue.length) this.queue.shift()(); }
}

class Downloader {
  constructor(options = {}) {
    this.request = options.request || https.request;
    this.validate = options.validate || (value => validateUrl(value, 'media'));
    this.cookie = options.cookie || (() => '');
    this.timeout = options.timeout || 30000;
    this.chunkSize = options.chunkSize || 4 * 1024 * 1024;
    this.retryDelay = options.retryDelay === undefined ? 500 : options.retryDelay;
    this.pool = new Semaphore(options.connections || 16);
    this.bytes = 0;
    this.rate = 0;
    this.nextByteTime = 0;
  }
  setRate(kbps) { this.rate = Math.max(0, Number(kbps) || 0) * 1024; this.nextByteTime = Date.now(); }
  async throttle(bytes, signal) {
    this.bytes += bytes;
    if (!this.rate) return;
    const now = Date.now();
    this.nextByteTime = Math.max(now, this.nextByteTime) + bytes / this.rate * 1000;
    await sleep(Math.max(0, this.nextByteTime - now), signal);
  }
  async response(value, headers, signal, depth = 0) {
    if (depth > 5) throw new Error('重定向次数过多');
    const url = this.validate(value);
    const res = await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const req = this.request(url, { headers: {
        'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/',
        'Accept-Encoding': 'identity', ...cookieHeaders(url, this.cookie()), ...headers
      } }, response => { response.on('error', () => {}); resolve(response); });
      // Reject explicitly; passing an error to a just-completed keep-alive socket
      // can emit an unhandled socket error after Node has detached its listeners.
      const abort = () => { reject(signal.reason); req.destroy(); };
      req.on('error', reject);
      req.on('close', () => signal.removeEventListener('abort', abort));
      req.setTimeout(this.timeout, () => req.destroy(new Error('下载连接超时')));
      signal.addEventListener('abort', abort, { once: true });
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      const location = res.headers.location;
      res.destroy();
      if (!location) throw new Error('重定向缺少目标地址');
      return this.response(new URL(location, url).href, headers, signal, depth + 1);
    }
    return res;
  }
  async probe(url, signal) {
    const res = await this.response(url, { Range: 'bytes=0-0' }, signal);
    try {
      if (res.statusCode === 200) {
        const size = Number(res.headers['content-length']);
        return { ranges: false, total: Number.isSafeInteger(size) && size > 0 ? size : 0 };
      }
      const range = /^bytes 0-0\/(\d+)$/.exec(res.headers['content-range'] || '');
      if (res.statusCode !== 206 || !range || !Number.isSafeInteger(Number(range[1])) || Number(range[1]) < 1) {
        throw new Error('媒体流探测失败（HTTP ' + res.statusCode + '）');
      }
      return { ranges: true, total: Number(range[1]) };
    } finally { res.destroy(); }
  }
  async transfer(url, dest, range, total, signal, progress) {
    const res = await this.response(url, range ? { Range: 'bytes=' + range.start + '-' + range.end } : {}, signal);
    let out;
    try {
      if (range) {
        const expected = 'bytes ' + range.start + '-' + range.end + '/' + total;
        if (res.statusCode !== 206 || res.headers['content-range'] !== expected) throw new Error('服务器返回的分片范围不匹配');
      } else if (res.statusCode !== 200) throw new Error('下载失败（HTTP ' + res.statusCode + '）');
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw new Error('不支持压缩后的媒体流');
      const expected = range ? range.end - range.start + 1 : total;
      const declared = res.headers['content-length'];
      if (expected && declared !== undefined && Number(declared) !== expected) throw new Error('分片长度不匹配');
      out = fs.createWriteStream(dest);
      // Keep errors handled even while awaiting network reads; finished is awaited below.
      let writeError;
      out.on('error', error => { writeError = error; res.destroy(error); });
      let received = 0;
      for await (const chunk of res) {
        if (signal.aborted) throw signal.reason;
        received += chunk.length;
        if (expected && received > expected) throw new Error('分片数据超过预期长度');
        if (!out.write(chunk)) await once(out, 'drain');
        await this.throttle(chunk.length, signal);
        if (writeError) throw writeError;
        progress(received);
      }
      if (signal.aborted) throw signal.reason;
      if (expected && received !== expected) throw new Error('分片数据不完整');
      const finished = once(out, 'close');
      out.end();
      await finished;
      if (writeError) throw writeError;
      return received;
    } finally {
      res.destroy();
      if (out && !out.closed) { const closed = once(out, 'close').catch(() => {}); out.destroy(); await closed; }
    }
  }
  async download(urls, dest, options = {}) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(url => this.validate(url).href);
    if (!list.length) throw new Error('下载地址为空');
    const control = options.control || new DownloadControl();
    const threads = Math.max(1, Math.min(Number(options.threads) || 8, 16));
    let info;
    let chosen = 0;
    let lastError;
    for (let i = 0; i < list.length; i++) {
      try { info = await control.run(signal => this.pool.use(() => this.probe(list[i], signal), signal)); chosen = i; break; }
      catch (error) { lastError = error; if (control.cancelled) throw error; }
    }
    if (!info) throw lastError;
    const temp = fs.mkdtempSync(path.join(path.dirname(dest), '.bili-parts-'));
    const parts = [];
    const progress = new Map();
    const started = Date.now();
    let lastNotify = 0;
    const notify = force => {
      if (!options.onProgress || control.paused || control.cancelled) return;
      const now = Date.now();
      if (!force && now - lastNotify < 100) return;
      lastNotify = now;
      const bytes = [...progress.values()].reduce((sum, n) => sum + n, 0);
      options.onProgress(info.total ? Math.min(bytes / info.total, 1) : 0, bytes, bytes / Math.max(1, (now - started) / 1000));
    };
    if (info.ranges) {
      for (let start = 0; start < info.total; start += this.chunkSize) parts.push({ start, end: Math.min(info.total - 1, start + this.chunkSize - 1) });
    } else parts.push(null);
    let next = 0;
    let failed;
    const worker = async () => {
      while (!failed && next < parts.length) {
        const index = next++;
        let completed = false;
        for (let attempt = 0; attempt < Math.max(3, list.length) && !completed && !failed; attempt++) {
          try {
            await control.run(signal => this.pool.use(async () => {
              progress.set(index, 0);
              if (attempt) await sleep(this.retryDelay * attempt, signal);
              await this.transfer(list[(chosen + attempt) % list.length], path.join(temp, String(index)), parts[index], info.total, signal, bytes => {
                progress.set(index, bytes); notify(false);
              });
            }, signal));
            completed = true;
          } catch (error) {
            lastError = error;
            if (control.cancelled) throw error;
          }
        }
        if (!completed && !failed) throw lastError;
      }
    };
    try {
      const workers = Array.from({ length: Math.min(threads, parts.length) }, () => worker().catch(error => { failed = failed || error; }));
      await Promise.all(workers);
      if (failed) throw failed;
      await control.ready();
      const assembled = path.join(temp, 'complete');
      const out = fs.createWriteStream(assembled);
      let writeError;
      out.on('error', error => { writeError = error; });
      try {
        for (let i = 0; i < parts.length; i++) {
          for await (const chunk of fs.createReadStream(path.join(temp, String(i)))) {
            await control.ready();
            if (writeError) throw writeError;
            if (!out.write(chunk)) await once(out, 'drain');
          }
        }
        const closed = once(out, 'close'); out.end(); await closed;
        if (writeError) throw writeError;
      } finally {
        if (!out.closed) { const closed = once(out, 'close').catch(() => {}); out.destroy(); await closed; }
      }
      if (info.total && fs.statSync(assembled).size !== info.total) throw new Error('文件总长度校验失败');
      await control.ready();
      fs.renameSync(assembled, dest);
      notify(true);
      return fs.statSync(dest).size;
    } finally {
      // temp is created by mkdtemp within the destination directory, never from remote input.
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

module.exports = { Downloader, DownloadControl };
