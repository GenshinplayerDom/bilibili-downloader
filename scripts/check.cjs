/* 静态检查：语法 + Android 资产一致性 + 三端版本号一致性。
 * 所有路径基于仓库根目录（__dirname 上级）解析，避免依赖调用时的 cwd。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file));

const syntaxFiles = [
  'main.js', 'server.js', 'preload.js', 'app.js', 'bilibili-downloader.user.js',
  ...fs.readdirSync(path.join(root, 'lib')).map(name => path.join('lib', name))
];
for (const file of syntaxFiles) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
}

const assets = ['app.js', 'index.html', 'styles.css', 'lame.min.js'];
for (const file of assets) {
  if (!read(file).equals(fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'assets', file)))) {
    throw new Error('Run npm run assets:android: ' + file);
  }
}

// 三端版本号一致性（app.js / package.json / install.nsi）
const pkgVersion = JSON.parse(read('package.json').toString('utf8')).version;
const appVersion = /var APP_VERSION = '([^']+)'/.exec(read('app.js').toString('utf8'))[1];
const nsiVersion = /!define APP_VERSION "([^"]+)"/.exec(read('install.nsi').toString('utf8'))[1];
if (pkgVersion !== appVersion || pkgVersion !== nsiVersion) {
  throw new Error('版本号不一致：package.json=' + pkgVersion + ' app.js=' + appVersion + ' install.nsi=' + nsiVersion);
}

// 版本号漂移防护：README 必须与 package.json 同版本；Android / 油猴各自版本号也必须存在，
// 且 Android UA 后缀不允许再写死常量（必须读 BuildConfig.VERSION_NAME）
const readmeVersion = /当前版本[^\n]*?(\d+\.\d+\.\d+)/.exec(read('README.md').toString('utf8'));
if (!readmeVersion || readmeVersion[1] !== pkgVersion) {
  throw new Error('README 版本与 package.json 不一致：README=' + (readmeVersion && readmeVersion[1]) + ' package=' + pkgVersion);
}
const gradleVersion = /versionName\s+"([^"]+)"/.exec(read('android/app/build.gradle').toString('utf8'));
if (!gradleVersion || !gradleVersion[1]) throw new Error('android/app/build.gradle 缺少 versionName');
const scriptVersion = /@version\s+(\S+)/.exec(read('bilibili-downloader.user.js').toString('utf8'));
if (!scriptVersion || !scriptVersion[1]) throw new Error('油猴脚本缺少 @version');
const activity = read('android/app/src/main/java/com/dom/bilidownloader/MainActivity.java').toString('utf8');
if (!/BiliDownloader\/"\s*\+\s*BuildConfig\.VERSION_NAME/.test(activity)) {
  throw new Error('MainActivity UA 后缀必须读取 BuildConfig.VERSION_NAME');
}

console.log('Syntax, Android asset consistency and version consistency checks passed.');
