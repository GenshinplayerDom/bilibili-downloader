'use strict';

const path = require('node:path');
const fs = require('node:fs');
const API_HOSTS = new Set(['api.bilibili.com', 'passport.bilibili.com']);
const MEDIA_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com', 'biliimg.com', 'mountaintoys.cn', 'biliyungic.com'];
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.m4a', '.mp3', '.flac', '.webm', '.xml', '.srt', '.json', '.jpg', '.png']);

function matchesDomain(host, domain) { return host === domain || host.endsWith('.' + domain); }

function validateUrl(value, kind = 'media') {
  const url = new URL(String(value).replace(/^\/\//, 'https://'));
  if (url.username || url.password) throw new Error('不允许的地址');
  // Older Bilibili API responses still contain http media URLs. Always upgrade them.
  if (url.protocol === 'http:' && kind === 'media') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('仅支持 HTTPS 地址');
  const host = url.hostname.toLowerCase();
  const allowed = kind === 'api' ? API_HOSTS.has(host)
    : kind === 'expand' ? matchesDomain(host, 'bilibili.com') || host === 'b23.tv'
    : API_HOSTS.has(host) || MEDIA_DOMAINS.some(domain => matchesDomain(host, domain));
  if (!allowed) throw new Error('不允许的目标域名');
  // 端口策略：仅 media（CDN 直链）允许非标准端口，如 *.edge.mountaintoys.cn 会带随机端口（4483 等）。
  // API / 短链展开等代理转发目标必须走标准 443，避免被用于探测 B 站域名上的其他端口（SSRF / 端口扫描面）。
  if (kind !== 'media' && url.port && url.port !== '443') throw new Error('不允许的端口');
  return url;
}

function cookieHeaders(url, cookie) {
  return API_HOSTS.has(new URL(url).hostname) && cookie ? { Cookie: cookie } : {};
}

function safeName(value) {
  let name = String(value || 'download').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'download';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const ext = path.extname(name).slice(0, 12);
  return name.slice(0, name.length - path.extname(name).length).slice(0, 150 - ext.length) + ext;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function assertManagedPath(value, roots, records) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('无效文件路径');
  const resolved = fs.realpathSync(value);
  if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase()) || !fs.statSync(resolved).isFile()) throw new Error('不支持的文件类型');
  if (!records.has(path.resolve(value))) throw new Error('只能操作本程序保存的文件');
  if (!roots.some(root => isInside(path.resolve(root), resolved))) throw new Error('文件不在下载目录内');
  return resolved;
}

// 续传目录来自渲染进程，而下载器在失败时会 rm -rf 该目录，
// 因此只接受「下载目录下、由本程序 mkdtemp 生成」的分片目录（前缀 .bili-parts-）。
function assertResumeDir(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  let real;
  try { real = fs.realpathSync(value); } catch (error) { return null; }
  try { if (!fs.statSync(real).isDirectory()) return null; } catch (error) { return null; }
  if (!/^\.bili-parts-/.test(path.basename(real))) return null;
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch (error) { return null; }
  return isInside(rootReal, real) ? real : null;
}

// Reserve using exclusive creation so simultaneous tasks cannot select the same name.
function reserveOutput(dir, filename) {
  const clean = safeName(filename);
  const ext = path.extname(clean);
  if (!MEDIA_EXTENSIONS.has(ext.toLowerCase())) throw new Error('不支持的输出文件类型');
  const stem = clean.slice(0, -ext.length);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10000; i++) {
    const target = path.join(dir, stem + (i ? ' (' + i + ')' : '') + ext);
    try { fs.closeSync(fs.openSync(target, 'wx')); return target; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名文件过多');
}

module.exports = { validateUrl, cookieHeaders, safeName, isInside, assertManagedPath, assertResumeDir, reserveOutput, matchesDomain };
