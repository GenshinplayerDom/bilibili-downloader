const fs = require('node:fs');
const path = require('node:path');
for (const file of ['app.js', 'index.html', 'styles.css', 'lame.min.js']) {
  fs.copyFileSync(path.join(__dirname, '..', file), path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', file));
}
const androidAssets = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'assets');
fs.mkdirSync(androidAssets, { recursive: true });
for (const file of ['qr-wechat.png', 'qr-alipay.jpg']) {
  fs.copyFileSync(path.join(__dirname, '..', 'assets', file), path.join(androidAssets, file));
}
console.log('Android web assets synchronized.');
