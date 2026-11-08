/* Windows 跨平台构建（可在 Linux / macOS 上产出 Windows 目录包、便携 zip 与 NSIS 安装包）。
 *
 * 解决三个既有问题：
 *  1. extraResources 固定读 node_modules/ffmpeg-static/ffmpeg.exe，Linux 上只有 ELF 版 → 构建前按架构准备；
 *  2. nsis / portable 的 artifactName 不含 ${arch}，x64 与 ia32 会互相覆盖 → 输出名带架构；
 *  3. Electron 44 已不支持 ia32（最后支持的是 22.x）→ ia32 用 22.3.27 单独打包。
 *
 * 用法：node scripts/build-win.cjs [x64|ia32]
 * 依赖：makensis（安装包）、zip（便携包）、wine（写入 exe 图标与版本信息，仅 Linux 需要）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const arch = process.argv[2] || 'x64';
if (!['x64', 'ia32'].includes(arch)) throw new Error('不支持的架构: ' + arch);

const electronVersion = arch === 'ia32' ? '22.3.27' : pkg.devDependencies.electron;
const unpackedDir = arch === 'x64' ? 'win-unpacked' : 'win-' + arch + '-unpacked';
const tag = 'BiliDownloader-' + pkg.version + '-' + arch;

function run(command, args, options = {}) {
  console.log('> ' + command + ' ' + args.join(' '));
  execFileSync(command, args, { cwd: options.cwd || root, stdio: 'inherit', env: { ...process.env, ...options.env } });
}

const mirrorEnv = {
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  WINEDEBUG: '-all',
};

run(process.execPath, ['scripts/check.cjs']);
run(process.execPath, ['scripts/prepare-win-ffmpeg.cjs', arch]);

fs.rmSync(path.join(root, 'dist', unpackedDir), { recursive: true, force: true });
run('npx', ['electron-builder', '--win', '--' + arch, '--dir',
  '-c.electronVersion=' + electronVersion, '--publish', 'never'], { env: mirrorEnv });

const setup = path.join('dist', tag + '-Setup.exe');
if (fs.existsSync(path.join(root, 'install.nsi'))) {
  // install.nsi 通过 -DAPP_ARCH 切换安装目录（x64 → $PROGRAMFILES64，ia32 → $PROGRAMFILES）
  try {
    run('makensis', ['-DAPP_ARCH=' + arch, '-DOUT_EXE=' + setup, 'install.nsi']);
  } catch (e) {
    console.warn('makensis 不可用，跳过安装包（便携包仍会生成）');
  }
}

const zipName = path.join('dist', tag + '-portable.zip');
fs.rmSync(path.join(root, zipName), { force: true });
run('zip', ['-qr', path.basename(zipName), unpackedDir], { cwd: path.join(root, 'dist') });

console.log('\n产物：');
for (const item of [setup, zipName]) {
  const full = path.join(root, item);
  if (fs.existsSync(full)) console.log('  ' + item + '  (' + (fs.statSync(full).size / 1024 / 1024).toFixed(0) + 'MB)');
}
