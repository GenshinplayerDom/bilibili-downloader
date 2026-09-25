const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const file of ['main.js', 'server.js', 'preload.js', 'app.js', 'bilibili-downloader.user.js', ...fs.readdirSync('lib').map(name => path.join('lib', name))]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
for (const file of ['app.js', 'index.html', 'styles.css', 'lame.min.js']) {
  if (!fs.readFileSync(file).equals(fs.readFileSync(path.join(__dirname, '..', '..', '哔哩下载器-android-1.3.0/app/src/main/assets', file)))) throw new Error('Run npm run assets:android: ' + file);
}
console.log('Syntax and Android asset consistency checks passed.');
