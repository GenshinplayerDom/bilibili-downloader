const fs = require('node:fs');
const path = require('node:path');
for (const file of ['app.js', 'index.html', 'styles.css', 'lame.min.js']) {
  fs.copyFileSync(path.join(__dirname, '..', file), path.join(__dirname, '..', '哔哩下载器-android-1.3.0/app/src/main/assets', file));
}
console.log('Android web assets synchronized.');
