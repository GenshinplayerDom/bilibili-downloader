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

console.log('Syntax, Android asset consistency and version consistency checks passed.');
