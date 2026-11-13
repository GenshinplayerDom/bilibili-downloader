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
    const upstreamUrls = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'file:') return route.continue();
      const upstream = new URL(url.searchParams.get('url') || 'https://api.bilibili.com/');
      upstreamUrls.push(url.searchParams.get('url') || '');
      let body = { ok: true, login: { logged: false }, identity: {} };
      if (url.pathname === '/api') {
        let data = {};
        if (upstream.pathname.endsWith('/nav')) data = { wbi_img: { img_url: 'https://i0.hdslb.com/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/' + 'b'.repeat(32) + '.png' } };
        if (upstream.pathname.endsWith('/view') && upstream.searchParams.get('bvid') === 'BV1upower1x7') data = {
          bvid: 'BV1upower1x7', aid: 7, cid: 70, title: '充电专属测试', pic: '', duration: 10, owner: { name: 'UP' },
          stat: { view: 1 }, is_upower_exclusive: true, pages: [{ page: 1, cid: 70, part: '正片', duration: 10 }]
        };
        else if (upstream.pathname.endsWith('/view')) data = {
          bvid: 'BV1xx411c7mD', aid: 1, cid: 10, title: '下载体验测试', pic: '', duration: 10, owner: { name: '本地测试' }, stat: { view: 10 },
          pages: [{ page: 1, cid: 10, part: '<img src=x onerror="window.injected=true">', duration: 10 }, { page: 2, cid: 20, part: '第二分 P', duration: 10 }]
        };
        if (upstream.pathname.endsWith('/playurl') && upstream.searchParams.get('cid') === '70') {
          // 模拟未充电账号取流：错误码 + 服务端文案
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 87007, message: '充电专属视频，请先充电' }) });
          return;
        }
        if (upstream.pathname.endsWith('/playurl')) data = { quality: 80, accept_quality: [80, 64, 32], dash: { video: [{ id: 80, baseUrl: 'https://test.bilivideo.com/video', codecs: 'avc1', bandwidth: 1000 }], audio: [{ id: 30280, baseUrl: 'https://test.bilivideo.com/audio', bandwidth: 192000 }] } };
        if (upstream.pathname.startsWith('/pgc/view/web/season') && upstream.searchParams.get('ep_id') === '900001') {
          body = { code: 0, result: {
            season_id: 48411, type: 2, title: '电影解析测试', season_title: '电影解析测试', cover: 'https://i0.hdslb.com/m.jpg',
            up_info: { uname: '哔哩哔哩电影' }, actors: '甲\\n乙', stat: { views: 100, danmakus: 5, likes: 7, reply: 1 },
            rights: { is_preview: 1, only_vip_download: 1 },
            episodes: [{ ep_id: 900001, aid: 900001, bvid: 'BV1movie1x7', cid: 900001, title: '正片', long_title: '', cover: 'https://i0.hdslb.com/e.jpg', duration: 7182000 }]
          } };
        } else if (upstream.pathname.startsWith('/pgc/view/web/season') && upstream.searchParams.get('ep_id') === '900002') {
          body = { code: 0, result: {
            season_id: 48412, type: 2, title: '免费电影测试', season_title: '免费电影测试', cover: 'https://i0.hdslb.com/m2.jpg',
            up_info: { uname: '哔哩哔哩电影' }, stat: { views: 1 }, rights: { is_preview: 0 },
            episodes: [{ ep_id: 900002, aid: 900002, bvid: 'BV1movie2x7', cid: 900002, title: '正片', cover: 'https://i0.hdslb.com/e2.jpg', duration: 3600000 }]
          } };
        } else if (upstream.pathname.startsWith('/pgc/view/web/season')) {
          // 番剧季度：3 集，含 ep_id / cid / 毫秒时长
          body = { code: 0, result: {
            season_id: 33145, title: '番剧解析测试', season_title: '番剧解析测试', cover: 'https://i0.hdslb.com/cover.jpg',
            up_info: { name: '测试番组' }, stat: { views: 10, danmakus: 2, likes: 3, reply: 1 },
            episodes: [1, 2, 3].map(i => ({ ep_id: 318440 + i, aid: 1000 + i, bvid: 'BV1xx411c7m' + i, cid: 2000 + i,
              title: '第 ' + i + ' 话', long_title: '剧集 ' + i, cover: 'https://i0.hdslb.com/ep' + i + '.jpg', duration: 600000 }))
          } };
        } else if (upstream.pathname.startsWith('/pgc/player/web/playurl') && upstream.searchParams.get('ep_id') === '900001') {
          // 大会员电影、无权限账号：只给 6 分钟试看
          body = { code: 0, result: { quality: 32, is_preview: 1, durl: [{ url: 'https://test.bilivideo.com/video', length: 360708, size: 65536 }], accept_quality: [112, 80] } };
        } else if (upstream.pathname.startsWith('/pgc/player/web/playurl')) {
          body = { code: 0, result: { quality: 80, accept_quality: [80], durl: [{ url: 'https://test.bilivideo.com/video', size: 65536, length: 60 }],
            dash: { video: [{ id: 80, baseUrl: 'https://test.bilivideo.com/video', codecs: 'avc1', bandwidth: 1000 }], audio: [{ id: 30280, baseUrl: 'https://test.bilivideo.com/audio', bandwidth: 192000 }] } } };
        } else {
          body = { code: 0, data };
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => localStorage.setItem('bili_guide_seen_v2', '1'));
    await page.reload();
    await page.locator('#url-input').fill('BV1xx411c7mD');
    // 当前 UI 设计为「手动输入不自动解析」，需回车（或粘贴）才触发解析
    await page.locator('#url-input').press('Enter');
    await page.locator('#result').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.page-chip img').count(), 0);
    assert.equal(await page.evaluate(() => !!window.injected), false);
    await page.locator('#type-seg [data-type="audio"]').click();
    await page.locator('#dl-btn').click();
    const first = page.locator('.task-card').nth(0);
    await first.locator('.task-pause').waitFor({ state: 'visible' });
    // 模拟流只有 ~1.3s，暂停按钮可能在等待『元素稳定』时就随任务完成而消失，故跳过稳定性检查
    await first.locator('.task-pause').click({ force: true });
    await page.waitForFunction(() => document.querySelector('.task-status').textContent === '已暂停');
    // Clearing completed tasks must preserve paused ones.
    await page.locator('#tasks-clear-done').click();
    assert.equal(await page.locator('.task-card').count(), 1);
    // 暂停态按钮为 .task-resume（.task-pause 此时是隐藏的）
    await first.locator('.task-resume').click({ force: true });
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
    // 番剧：ep 链接 → PGC 季度解析 → 选集 → 按 PGC 取流下载
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ep318443');
    await page.locator('#url-input').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.page-chip').length === 3, null, { timeout: 10000 });
    assert.equal(await page.locator('.page-chip').nth(2).getAttribute('class'), 'page-chip active', '应默认选中链接对应的第 3 集');
    // PGC 的 duration 是毫秒：600000ms 必须显示成 10:00，而不是 166 小时
    assert.match(await page.locator('.page-chip').first().innerText(), /10:00/, '剧集时长应按秒格式化');
    await page.locator('#type-seg [data-type="video"]').click();
    // 番剧取流复用上面的真实音视频样本，确保 DASH 合流走真实 FFmpeg 路径
    await application.evaluate((_, media) => { globalThis.smokeMedia = Object.assign(globalThis.smokeMedia || {}, media); }, { '/video': video, '/audio': audio });
    await page.locator('#dl-btn').click();
    const episodeTask = page.locator('.task-card').last();
    await episodeTask.locator('.task-status.done').waitFor({ timeout: 20000 });
    assert.ok(upstreamUrls.some(u => u.includes('/pgc/view/web/season') && u.includes('ep_id=318443')), '应使用 PGC 季度接口解析');
    assert.ok(upstreamUrls.some(u => u.includes('/pgc/player/web/playurl') && u.includes('ep_id=318443')), '剧集取流必须走 PGC playurl 并带 ep_id');
    assert.ok(fs.readdirSync(downloads).some(name => name.endsWith('.mp4')), '番剧应落盘为 mp4');
    // 整季批量：每集都要带上自己的 ep_id，否则只有第一集会走 PGC 取流
    const mp4Before = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length;
    await page.locator('#btn-all').click();
    await page.locator('#batch-panel').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#batch-start').click();
    await page.waitForFunction(() => /批量下载完成/.test(document.body.innerText), null, { timeout: 60000 });
    assert.ok(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length >= mp4Before + 3, '整季批量应下载 3 集');
    assert.equal(new Set(upstreamUrls.filter(u => u.includes('/pgc/player/web/playurl')).map(u => (/ep_id=(\d+)/.exec(u) || [])[1])).size, 3, '三个剧集应分别带自己的 ep_id 取流');
    await page.locator('#batch-back').click();
    // 电影（大会员）：能读出来，但试看片段必须拒绝保存，不能当完整影片交付
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ep900001');
    await page.locator('#url-input').press('Enter');
    await page.waitForFunction(() => /电影/.test(document.body.innerText), null, { timeout: 10000 });
    assert.match(await page.locator('#v-title').innerText(), /（电影）/);
    assert.equal(await page.locator('#v-up').innerText(), '哔哩哔哩电影', '电影 UP 名应取 up_info.uname');
    assert.equal(await page.locator('#v-duration').innerText(), '1:59:42', '电影时长应按毫秒换算');
    const movieMp4Before = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length;
    await page.locator('#dl-btn').click();
    const movieTask = page.locator('.task-card').last();
    await movieTask.locator('.task-status.error').waitFor({ timeout: 15000 });
    assert.match(await movieTask.innerText(), /试看|大会员/, '试看片段应明确拒绝并说明原因');
    assert.equal(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length, movieMp4Before, '试看片段不得落盘');

    // 电影（免费）：完整读取并保存
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ep900002');
    await page.locator('#url-input').press('Enter');
    await page.waitForFunction(() => /免费电影测试/.test(document.body.innerText), null, { timeout: 10000 });
    await page.locator('#dl-btn').click();
    await page.locator('.task-card').last().locator('.task-status.done').waitFor({ timeout: 20000 });
    assert.ok(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length > movieMp4Before, '免费电影应落盘');

    // 充电专属：解析后明确提示，取流被拒时给出可理解的失败原因
    await page.locator('#url-input').fill('BV1upower1x7');
    await page.locator('#url-input').press('Enter');
    await page.waitForFunction(() => /充电专属/.test(document.body.innerText), null, { timeout: 10000 });
    await page.locator('#dl-btn').click();
    const upowerTask = page.locator('.task-card').last();
    await upowerTask.locator('.task-status.error').waitFor({ timeout: 15000 });
    assert.ok(/充电专属/.test(await upowerTask.innerText()), '失败提示应说明是充电专属内容');
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/smoke-desktop.png'), fullPage: true });
    console.log('PASS: Electron launch, safe title rendering, pause/resume, task preservation, collision protection, retry, IPC file protection, real FFmpeg audio/video mux, PGC bangumi download and upower-exclusive handling.');
  } catch (error) {
    if (page) { console.error('Page errors:', errors); console.error(await page.locator('body').innerText().catch(() => '')); }
    throw error;
  } finally {
    await application.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
