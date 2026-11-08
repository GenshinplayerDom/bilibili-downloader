/* 按目标架构准备 Windows 版 ffmpeg.exe（electron-builder 的 extraResources 固定读取
 * node_modules/ffmpeg-static/ffmpeg.exe）。
 *
 * ffmpeg-static 的 npm 包只会安装「当前平台」的二进制：在 Linux 上构建 Windows 时
 * 目录里只有 ffmpeg（ELF），直接打包会失败；而且 ia32 在 b6.1.1 已不再提供，
 * 只能回退到 b6.0 的 ffmpeg-win32-ia32。
 *
 * 用法：node scripts/prepare-win-ffmpeg.cjs [x64|ia32]
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const binDir = path.join(root, 'node_modules', 'ffmpeg-static');
const target = path.join(binDir, 'ffmpeg.exe');
const marker = path.join(binDir, '.win-arch');
const cacheDir = path.join(root, 'build-cache');

const SOURCES = {
  x64: { tag: 'b6.1.1', file: 'ffmpeg-win32-x64.gz' },
  ia32: { tag: 'b6.0', file: 'ffmpeg-win32-ia32.gz' },
};

function download(url, dest, depth = 0) {
  if (depth > 5) throw new Error('重定向次数过多: ' + url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'bili-build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('下载失败 ' + res.statusCode + ': ' + url));
      }
      const out = fs.createWriteStream(dest);
      const timer = setTimeout(() => { req.destroy(); reject(new Error('下载超时: ' + url)); }, 120000);
      res.pipe(out);
      out.on('finish', () => { clearTimeout(timer); out.close(() => resolve(dest)); });
      out.on('error', error => { clearTimeout(timer); reject(error); });
    });
    req.on('error', reject);
  });
}

function size(file) { try { return fs.statSync(file).size; } catch (e) { return 0; } }

async function main() {
  const arch = process.argv[2] || 'x64';
  const source = SOURCES[arch];
  if (!source) throw new Error('不支持的架构: ' + arch + '（仅支持 x64 / ia32）');

  const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  // Windows 上 npm 装好的原生二进制没有标记文件，视为 x64 可用，避免重复下载
  if (fs.existsSync(target) && current === arch) {
    console.log('ffmpeg.exe 已是 ' + arch + '，跳过下载');
    return;
  }
  if (arch === 'x64' && !current && size(target) > 40 * 1024 * 1024) {
    fs.writeFileSync(marker, 'x64');
    console.log('检测到本地 ffmpeg.exe，按 x64 记入标记');
    return;
  }

  const base = 'https://github.com/eugeneware/ffmpeg-static/releases/download/' + source.tag;
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, 'ffmpeg-win32-' + arch + '.gz');
  if (!fs.existsSync(cached) || size(cached) < 10 * 1024 * 1024) {
    console.log('下载 ' + arch + ' 版 ffmpeg（' + source.tag + '）…');
    await download(base + '/' + source.file, cached);
  }

  // gz 解压：优先用系统 gunzip（流式，避免把 80MB 全读进内存）
  const raw = cached.replace(/\.gz$/, '');
  fs.rmSync(raw, { force: true });
  try {
    execFileSync('gunzip', ['-c', cached], { stdio: ['ignore', fs.openSync(raw, 'w'), 'inherit'] });
  } catch (e) {
    throw new Error('gunzip 解压失败：' + e.message);
  }

  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(raw, target);
  for (const ext of ['README', 'LICENSE']) {
    const side = path.join(binDir, 'ffmpeg.exe.' + ext);
    try { await download(base + '/win32-' + arch + '.' + ext, side); } catch (e) { /* 许可文件缺失不阻断构建 */ }
  }
  fs.writeFileSync(marker, arch);
  console.log('已准备 ' + arch + ' 版 ffmpeg.exe（' + (size(target) / 1024 / 1024).toFixed(1) + 'MB）');
}

main().catch(error => { console.error(error.message); process.exit(1); });
