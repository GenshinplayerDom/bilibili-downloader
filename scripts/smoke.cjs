'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-ui-test-'));
  const downloads = path.join(temp, 'downloads'); fs.mkdirSync(downloads);
  const dataDir = path.join(temp, 'profile'); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'download_dir.txt'), downloads);
  const launchEnv = { ...process.env, BILI_HEADLESS: '1', BILI_DATA_DIR: dataDir };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.BILI_SMOKE_EXECUTABLE || require('electron');
  const application = await electron.launch({ executablePath, args: process.env.BILI_SMOKE_EXECUTABLE ? [] : [root], env: launchEnv });
  let page;
  const errors = [];
  try {
    // Replace only the transport in this isolated app instance. No real Bilibili
    // requests, user credentials, or user download folders are used by this test.
    await application.evaluate(({ app }, rootDir) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const { Readable } = require('stream');
      const { Downloader } = require(app.getAppPath() + '/lib/downloader.js');
      globalThis.smokeFail = false;
      Downloader.prototype.response = async function (url, headers, signal) {
        if (globalThis.smokeFail) throw new Error('模拟网络中断');
        const fixture = globalThis.smokeMedia && globalThis.smokeMedia[new URL(url).pathname];
        const data = fixture ? require('fs').readFileSync(fixture) : Buffer.alloc(64 * 1024, 0x5a);
        const range = /bytes=(\d+)-(\d+)/.exec(headers.Range || '');
        const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : data.length - 1;
        const response = Readable.from((async function* () {
          for (let i = start; i <= end; i += 1024) {
            if (signal.aborted) throw signal.reason;
            if (end > 0) await new Promise(resolve => setTimeout(resolve, 20));
            yield data.subarray(i, Math.min(i + 1024, end + 1));
          }
        })());
        response.statusCode = range ? 206 : 200;
        response.headers = { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${data.length}` };
        response.on('error', () => {});
        return response;
      };
    }, root);
    const context = application.context();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'file:') return route.continue();
      const upstream = new URL(url.searchParams.get('url') || 'https://api.bilibili.com/');
      let body = { ok: true, login: { logged: false }, identity: {} };
      if (url.pathname === '/api') {
        let data = {};
        if (upstream.pathname.endsWith('/nav')) data = { wbi_img: { img_url: 'https://i0.hdslb.com/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/' + 'b'.repeat(32) + '.png' } };
        if (upstream.pathname.endsWith('/view')) data = {
          bvid: 'BV1xx411c7mD', aid: 1, cid: 10, title: '下载体验测试', pic: '', duration: 10, owner: { name: '本地测试' }, stat: { view: 10 },
          pages: [{ page: 1, cid: 10, part: '<img src=x onerror="window.injected=true">', duration: 10 }, { page: 2, cid: 20, part: '第二分 P', duration: 10 }]
        };
        if (upstream.pathname.endsWith('/playurl')) data = { quality: 80, accept_quality: [80, 64, 32], dash: { video: [{ id: 80, baseUrl: 'https://test.bilivideo.com/video', codecs: 'avc1', bandwidth: 1000 }], audio: [{ id: 30280, baseUrl: 'https://test.bilivideo.com/audio', bandwidth: 192000 }] } };
        body = { code: 0, data };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => localStorage.setItem('bili_guide_seen_v2', '1'));
    await page.reload();
    await page.locator('#url-input').fill('BV1xx411c7mD');
    await page.locator('#result').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.page-chip img').count(), 0);
    assert.equal(await page.evaluate(() => !!window.injected), false);
    await page.locator('[data-type="audio"]').click();
    await page.locator('#dl-btn').click();
    const first = page.locator('.task-card').nth(0);
    await first.locator('.task-pause').waitFor({ state: 'visible' });
    await first.locator('.task-pause').click();
    await page.waitForFunction(() => document.querySelector('.task-status').textContent === '已暂停');
    // Clearing completed tasks must preserve paused ones.
    await page.locator('#tasks-clear-done').click();
    assert.equal(await page.locator('.task-card').count(), 1);
    await first.locator('.task-pause').click();
    await first.locator('.task-status.done').waitFor({ timeout: 15000 });
    const original = fs.readdirSync(downloads).find(name => name.endsWith('.m4a'));
    assert.ok(original); assert.equal(fs.statSync(path.join(downloads, original)).size, 65536);
    await page.locator('#dl-btn').click();
    await page.locator('.task-card').nth(1).locator('.task-status.done').waitFor({ timeout: 15000 });
    assert.equal(fs.readdirSync(downloads).filter(name => name.endsWith('.m4a')).length, 2);
    assert.ok(fs.readdirSync(downloads).some(name => name.includes('(1)')));
    await application.evaluate(() => { globalThis.smokeFail = true; });
    await page.locator('#dl-btn').click();
    const failed = page.locator('.task-card').nth(2);
    await failed.locator('.task-status.error').waitFor({ timeout: 15000 });
    await application.evaluate(() => { globalThis.smokeFail = false; });
    await failed.locator('.task-retry').click();
    await page.locator('.task-card').nth(3).locator('.task-status.done').waitFor({ timeout: 15000 });
    // IPC cannot delete an unrelated existing media file, even in Downloads.
    const unrelated = path.join(downloads, 'unrelated.mp4'); fs.writeFileSync(unrelated, 'keep');
    const result = await page.evaluate(file => window.biliAPI.deleteFile(file), unrelated);
    assert.equal(result.ok, false); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    // Exercise actual FFmpeg muxing with synthetic local media, without network access.
    const ffmpeg = require('ffmpeg-static');
    const video = path.join(temp, 'video.mp4'), audio = path.join(temp, 'audio.m4a');
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=12', '-t', '1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { stdio: 'ignore', windowsHide: true });
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:a', 'aac', audio], { stdio: 'ignore', windowsHide: true });
    await application.evaluate((_, media) => { globalThis.smokeMedia = media; }, { '/real-video': video, '/real-audio': audio });
    const merged = await page.evaluate(() => window.biliAPI.muxDownload({ token: 'smoke_mux', videoUrls: ['https://test.bilivideo.com/real-video'], audioUrls: ['https://test.bilivideo.com/real-audio'], filename: 'merged.mp4', threads: 4 }));
    assert.equal(merged.ok, true, merged.error);
    execFileSync(ffmpeg, ['-v', 'error', '-i', merged.path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { stdio: 'pipe', windowsHide: true });
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/smoke-desktop.png'), fullPage: true });
    console.log('PASS: Electron launch, safe title rendering, pause/resume, task preservation, collision protection, retry, IPC file protection and real FFmpeg audio/video mux.');
  } catch (error) {
    if (page) { console.error('Page errors:', errors); console.error(await page.locator('body').innerText().catch(() => '')); }
    throw error;
  } finally {
    await application.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
