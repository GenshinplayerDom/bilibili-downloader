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
            if (end > 0) await new Promise(resolve => setTimeout(resolve, 80));
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
        if (upstream.pathname.endsWith('/x/web-interface/popular')) {
          const palettes = [['#ff8aa0', '#7b6cf6'], ['#4facfe', '#00f2fe'], ['#f6d365', '#fda085'], ['#a18cd1', '#fbc2eb'], ['#43e97b', '#38f9d7']];
          const cover = (i) => {
            const [a, b] = palettes[i % palettes.length];
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="${80 + (i * 37) % 460}" cy="${70 + (i * 29) % 200}" r="120" fill="rgba(255,255,255,.30)"/><circle cx="${560 - (i * 23) % 400}" cy="${300 - (i * 17) % 180}" r="78" fill="rgba(255,255,255,.18)"/><text x="42" y="318" font-family="Arial, sans-serif" font-size="62" font-weight="700" fill="rgba(255,255,255,.92)">HOT ${String(i + 1).padStart(2, '0')}</text></svg>`;
            return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          };
          data = {
            list: Array.from({ length: 20 }, (_, i) => ({
              bvid: 'BV1hot0000' + String(10 + i), aid: 500 + i, cid: 600 + i,
              title: '热门视频 ' + (i + 1), pic: cover(i), duration: 600 + i * 30,
              owner: { name: '热门UP主' + (i + 1) }, stat: { view: 100000 + i * 5000, danmaku: 1000 + i * 100 },
              rcmd_reason: { content: '正在热播' }
            }))
          };
        }
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
        if (upstream.pathname.endsWith('/playurl')) data = { quality: 80, accept_quality: [80, 64, 32], dash: { video: [{ id: 80, baseUrl: 'https://test.bilivideo.com/video', codecs: 'avc1', bandwidth: 1000 }], audio: [{ id: 30216, baseUrl: 'https://test.bilivideo.com/audio-lo', bandwidth: 67169 }, { id: 30280, baseUrl: 'https://test.bilivideo.com/audio', bandwidth: 140764 }] } };
        if (upstream.pathname.startsWith('/pgc/view/web/media')) {
          body = { code: 0, result: { media_id: 22630575, season_id: 48412, title: '免费电影测试', type: 2 } };
        } else if (upstream.pathname.startsWith('/pgc/view/web/season') && upstream.searchParams.get('ep_id') === '900001') {
          body = { code: 0, result: {
            season_id: 48411, type: 2, title: '电影解析测试', season_title: '电影解析测试', cover: 'https://i0.hdslb.com/m.jpg',
            up_info: { uname: '哔哩哔哩电影' }, actors: '甲\\n乙', stat: { views: 100, danmakus: 5, likes: 7, reply: 1 },
            rights: { is_preview: 1, only_vip_download: 1 },
            episodes: [{ ep_id: 900001, aid: 900001, bvid: 'BV1movie1x7', cid: 900001, title: '正片', long_title: '', cover: 'https://i0.hdslb.com/e.jpg', duration: 7182000 }]
          } };
        } else if (upstream.pathname.startsWith('/pgc/view/web/season') &&
                   (upstream.searchParams.get('ep_id') === '900002' || upstream.searchParams.get('season_id') === '48412')) {
          body = { code: 0, result: {
            season_id: 48412, type: 2, title: '免费电影测试', season_title: '免费电影测试', cover: 'https://i0.hdslb.com/m2.jpg',
            up_info: { uname: '哔哩哔哩电影' }, stat: { views: 1 }, rights: { is_preview: 0 },
            episodes: [{ ep_id: 900002, aid: 900002, bvid: 'BV1movie2x7', cid: 900002, title: '正片', cover: 'https://i0.hdslb.com/e2.jpg', duration: 3600000 }]
          } };
        } else if (upstream.pathname.startsWith('/pgc/view/web/season') && upstream.searchParams.get('season_id') === '77001') {
          body = { code: 0, result: {
            season_id: 77001, type: 1, title: '未开播测试', season_title: '未开播测试', cover: 'https://i0.hdslb.com/nc.jpg',
            up_info: { uname: '测试番组' }, stat: {}, episodes: [],
            section: [{ id: 1, title: '预告', episodes: [{ ep_id: 900010, aid: 900010, bvid: 'BV1pre1x7', cid: 900010, title: '预告', cover: 'https://i0.hdslb.com/pv.jpg', duration: 120000 }] }]
          } };
        } else if (upstream.pathname.startsWith('/pgc/view/web/season')) {
          // 番剧季度：3 集，含 ep_id / cid / 毫秒时长
          body = { code: 0, result: {
            season_id: 33145, title: '番剧解析测试', season_title: '番剧解析测试', cover: 'https://i0.hdslb.com/cover.jpg',
            up_info: { name: '测试番组' }, stat: { views: 10, danmakus: 2, likes: 3, reply: 1 },
            episodes: [1, 2, 3].map(i => ({ ep_id: 318440 + i, aid: 1000 + i, bvid: 'BV1xx411c7m' + i, cid: 2000 + i,
              title: '第 ' + i + ' 话', long_title: '[剧集 ' + i + ']', cover: 'https://i0.hdslb.com/ep' + i + '.jpg', duration: [600000, 1200000, 300000][i - 1] }))
          } };
        } else if (upstream.pathname.startsWith('/pgc/player/web/playurl') && upstream.searchParams.get('ep_id') === '900001') {
          // 大会员电影、无权限账号：只给 6 分钟试看
          body = { code: 0, result: { quality: 32, is_preview: 1, durl: [{ url: 'https://test.bilivideo.com/video', length: 360708, size: 65536 }], accept_quality: [112, 80] } };
        } else if (upstream.pathname.startsWith('/pgc/player/web/playurl')) {
          body = { code: 0, result: { quality: 80, accept_quality: [80], durl: [{ url: 'https://test.bilivideo.com/video', size: 65536, length: 60 }],
            dash: { video: [{ id: 80, baseUrl: 'https://test.bilivideo.com/video', codecs: 'avc1', bandwidth: 1000 }],
              audio: [{ id: 30216, baseUrl: 'https://test.bilivideo.com/audio-lo', bandwidth: 67169 },
                      { id: 30280, baseUrl: 'https://test.bilivideo.com/audio', bandwidth: 140764 }] } } };
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
    // 下载任务统一进入右下角队列；冒烟测试需要显式打开浮层才能操作任务按钮。
    const queueCards = () => page.locator('#queue-list .task-card');
    const openQueue = async () => {
      if (await page.locator('#queue-panel').isHidden()) {
        await page.locator('#queue-orb').click();
        await page.locator('#queue-panel').waitFor({ state: 'visible' });
      }
    };
    const closeQueue = async () => {
      if (!(await page.locator('#queue-panel').isHidden())) {
        await page.locator('#queue-back').click();
        assert.equal(await page.locator('#queue-panel').isHidden(), true, '关闭按钮应能收起下载队列');
      }
    };
    const waitQueueCard = async (index, selector, timeout = 15000) => {
      await page.waitForFunction(({ index, selector }) => {
        const card = document.querySelectorAll('#queue-list .task-card')[index];
        return !!(card && card.querySelector(selector));
      }, { index, selector }, { timeout });
    };
    const waitLastQueueCard = async (selector, timeout = 15000) => {
      await page.waitForFunction(selector => {
        const cards = document.querySelectorAll('#queue-list .task-card');
        const card = cards[cards.length - 1];
        return !!(card && card.querySelector(selector));
      }, selector, { timeout });
    };
    await page.locator('#type-seg [data-type="audio"]').click();
    await page.locator('#dl-btn').click();
    await page.waitForFunction(() => {
      const btn = document.querySelector('#queue-list .task-card .task-pause');
      return !!(btn && !btn.hidden);
    }, null, { timeout: 10000 });
    await openQueue();
    const first = queueCards().nth(0);
    // 模拟流只有 ~1.3s，暂停按钮可能在等待『元素稳定』时就随任务完成而消失，故跳过稳定性检查
    await first.locator('.task-pause').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#queue-list .task-status').textContent === '已暂停');
    // 「继续下载」必须是统一样式的任务按钮，不能落回浏览器默认 button 的黑色边框
    const resumeStyle = await first.locator('.task-resume').evaluate(el => {
      const s = getComputedStyle(el);
      return { radius: s.borderRadius, style: s.borderTopStyle, width: s.borderTopWidth, display: s.display };
    });
    assert.equal(resumeStyle.radius, '6px');
    assert.equal(resumeStyle.style, 'solid');
    assert.equal(resumeStyle.width, '1px');
    assert.notEqual(resumeStyle.display, 'none');
    // 没有终态任务时不提供「清除完成」，避免误删正在下载 / 暂停的任务。
    assert.equal(await page.locator('#queue-clear-done').isHidden(), true, '没有已完成任务时清除完成应隐藏');
    assert.equal(await queueCards().count(), 1);
    // 暂停态按钮为 .task-resume（.task-pause 此时是隐藏的）
    await first.locator('.task-resume').click({ force: true });
    await closeQueue();
    await waitQueueCard(0, '.task-status.done');
    const original = fs.readdirSync(downloads).find(name => name.endsWith('.m4a'));
    assert.ok(original); assert.equal(fs.statSync(path.join(downloads, original)).size, 65536);
    await page.locator('#dl-btn').click();
    await waitQueueCard(1, '.task-status.done');
    assert.equal(fs.readdirSync(downloads).filter(name => name.endsWith('.m4a')).length, 2);
    assert.ok(fs.readdirSync(downloads).some(name => name.includes('(1)')));
    await application.evaluate(() => { globalThis.smokeFail = true; });
    await page.locator('#dl-btn').click();
    await waitQueueCard(2, '.task-status.error');
    await application.evaluate(() => { globalThis.smokeFail = false; });
    await openQueue();
    await queueCards().nth(2).locator('.task-retry').click();
    await closeQueue();
    await waitQueueCard(3, '.task-status.done');
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
    // 番剧：ep 链接 → PGC 季度解析 → 独立番剧下载页 → 选集 → 按 PGC 取流下载
    await openQueue();
    await page.locator('#queue-clear-done').click();
    await closeQueue();
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ep318443');
    await page.locator('#url-input').press('Enter');
    await page.locator('#pgc-page').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#pgc-ep-list .pgc-ep').length === 3, null, { timeout: 10000 });
    assert.equal(await page.locator('#pgc-kind').innerText(), '番剧下载');
    assert.equal(await page.locator('#pgc-ep-list .pgc-ep').nth(2).getAttribute('class'), 'pgc-ep active', '应默认选中链接对应的第 3 集');
    // PGC 的 duration 是毫秒：600000ms 必须显示成 10:00，而不是 166 小时
    assert.match(await page.locator('#pgc-ep-list .pgc-ep').first().innerText(), /10:00/, '剧集时长应按秒格式化');
    assert.match(await page.locator('#pgc-selected').innerText(), /05:00/, '默认选中的第 3 集应显示自己的时长');
    // 底部操作栏必须为右下角队列小球让位，且保持紧凑，不能盖住「下载本集」
    const actionBox = await page.locator('.pgc-actionbar').boundingBox();
    const orbBox = await page.locator('#queue-orb').boundingBox();
    assert.ok(actionBox && orbBox, '番剧页底部操作栏与队列小球都应可见');
    assert.ok(actionBox.x + actionBox.width <= orbBox.x - 4 || actionBox.y >= orbBox.y + orbBox.height + 4,
      '底部操作栏不得与右下角队列小球重叠');
    assert.ok(actionBox.height <= 72, '底部操作栏应保持单行紧凑高度，实际 ' + actionBox.height);

    // 切集时旧的分片区间必须失效，否则会按上一集的时间轴去截取
    await page.locator('#pgc-clip').fill('00:01-00:02');
    await page.locator('#pgc-ep-list .pgc-ep').first().click();
    assert.match(await page.locator('#pgc-selected').innerText(), /10:00/, '切集后已选时长必须跟着变');
    assert.equal(await page.locator('#pgc-clip').inputValue(), '', '切集应清空上一集的分片区间');
    await page.locator('#pgc-ep-list .pgc-ep').nth(2).click();
    // 番剧取流复用上面的真实音视频样本，确保 DASH 合流走真实 FFmpeg 路径
    await application.evaluate((_, media) => { globalThis.smokeMedia = Object.assign(globalThis.smokeMedia || {}, media); }, { '/video': video, '/audio': audio });
    await page.locator('#pgc-download').click();
    await waitQueueCard(0, '.task-bar', 5000);
    const episodeTask = queueCards().last();
    // 番剧页是 z-index:75 的全屏覆盖层：下载队列必须同样盖在详情页上方，
    // 打开后能看到新任务的进度，而不是被详情页遮住。
    await openQueue();
    const queueBlur = await page.evaluate(() => {
      const panel = document.getElementById('queue-panel');
      const style = getComputedStyle(panel);
      return style.backdropFilter || style.webkitBackdropFilter || '';
    });
    assert.match(queueBlur, /blur/, '下载队列浮层应使用毛玻璃虚化背景');
    const taskCardVisible = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#queue-list .task-card'));
      const card = cards[cards.length - 1];
      const box = document.getElementById('queue-list');
      if (!card || !box) return false;
      const rect = card.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(24, rect.height / 2));
      return rect.top >= boxRect.top - 1 && rect.bottom <= boxRect.bottom + 1 &&
        !!(hit && hit.closest('.task-card') === card);
    });
    assert.equal(taskCardVisible, true, '番剧下载任务应显示在下载队列中并位于详情页上方');
    assert.ok((await episodeTask.locator('.task-status').textContent()).trim().length > 0, '新任务应显示进度状态');
    assert.ok(await episodeTask.locator('.task-bar').count(), '新任务应显示进度条');
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/pgc-download-progress.png'), fullPage: true });
    await closeQueue();
    await waitQueueCard(0, '.task-status.done', 20000);
    assert.ok(upstreamUrls.some(u => u.includes('/pgc/view/web/season') && u.includes('ep_id=318443')), '应使用 PGC 季度接口解析');
    assert.ok(upstreamUrls.some(u => u.includes('/pgc/player/web/playurl') && u.includes('ep_id=318443')), '剧集取流必须走 PGC playurl 并带 ep_id');
    assert.ok(fs.readdirSync(downloads).some(name => name.endsWith('.mp4')), '番剧应落盘为 mp4');
    // 音频档位必须取最高码率（30280），不能因为 30216 排在前面就选 64k 低档
    assert.equal(upstreamUrls.filter(u => u.includes('audio-lo')).length, 0, '不得请求 64k 低档音频');
    // 整季批量：每集都要带上自己的 ep_id，否则只有第一集会走 PGC 取流
    const mp4Before = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length;
    await page.locator('#pgc-download-all').click();
    await page.locator('#batch-panel').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#batch-start').click();
    // 整季 3 集必须一次性全部入队并同时开跑，不能只启动第 1 集后串行等待
    await page.waitForFunction(() => document.querySelectorAll('#queue-list .task-card').length >= 4, null, { timeout: 5000 });
    await openQueue();
    await page.screenshot({ path: path.join(root, 'artifacts/pgc-batch-concurrent.png'), fullPage: false });
    await closeQueue();
    await page.waitForFunction(() => /批量下载已全部结束/.test(document.body.innerText), null, { timeout: 60000 });
    assert.ok(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length >= mp4Before + 3, '整季批量应下载 3 集');
    assert.equal(new Set(upstreamUrls.filter(u => u.includes('/pgc/player/web/playurl')).map(u => (/ep_id=(\d+)/.exec(u) || [])[1])).size, 3, '三个剧集应分别带自己的 ep_id 取流');
    const pgcBatchNames = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4') && n.startsWith('番剧解析测试 第'));
    assert.ok(pgcBatchNames.some(n => n.startsWith('番剧解析测试 第1集 剧集 1_')), '番剧批量文件名应为「番剧名 第n集 本集名」');
    assert.ok(pgcBatchNames.some(n => n.startsWith('番剧解析测试 第3集 剧集 3_')), '番剧批量文件应使用每集自己的集号');
    assert.equal(pgcBatchNames.some(n => n.includes('[剧集')), false, '番剧批量文件不应再保留 [集名] 标签');
    assert.equal(pgcBatchNames.some(n => n.includes('（3 集）')), false, '番剧批量文件不应带季度集数后缀');
    await page.locator('#batch-back').click();
    await page.locator('#pgc-back').click();
    // 电影（大会员）：能读出来，但试看片段必须拒绝保存，不能当完整影片交付
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ep900001');
    await page.locator('#url-input').press('Enter');
    await page.locator('#pgc-page').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#pgc-kind').innerText(), '电影下载');
    assert.equal(await page.locator('#pgc-title').innerText(), '电影解析测试');
    assert.match(await page.locator('#pgc-meta').innerText(), /哔哩哔哩电影/, '电影制作方应取 up_info.uname');
    assert.match(await page.locator('#pgc-selected').innerText(), /1:59:42/, '电影时长应按毫秒换算');
    // 探测阶段就应提示只有试看权限，而不是等用户点下载才失败
    await page.waitForFunction(() => /试看/.test(document.querySelector('#pgc-note').textContent), null, { timeout: 10000 });
    const movieMp4Before = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length;
    await page.locator('#pgc-download').click();
    const movieTask = queueCards().last();
    await waitLastQueueCard('.task-status.error');
    assert.match(await movieTask.textContent(), /试看|大会员/, '试看片段应明确拒绝并说明原因');
    assert.equal(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length, movieMp4Before, '试看片段不得落盘');

    // 电影（免费）：完整读取并保存
    await page.locator('#pgc-back').click();
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ep900002');
    await page.locator('#url-input').press('Enter');
    await page.locator('#pgc-page').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#pgc-title').innerText(), '免费电影测试');
    assert.equal((await page.locator('#pgc-note').innerText()).includes('试看'), false, '换片后不应残留上一部影片的试看提示');
    await page.locator('#pgc-download').click();
    await waitLastQueueCard('.task-status.done', 20000);
    assert.ok(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length > movieMp4Before, '免费电影应落盘');

    // 未开播季度：episodes 为空但 section 有预告，必须能展示并提示，不能停在空白
    await page.locator('#pgc-back').click();
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/play/ss77001');
    await page.locator('#url-input').press('Enter');
    await page.locator('#pgc-page').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => /暂无正片/.test(document.getElementById('pgc-note').textContent), null, { timeout: 10000 });
    assert.equal(await page.locator('#pgc-title').innerText(), '未开播测试');
    assert.equal(await page.locator('#pgc-ep-list .pgc-ep').count(), 1, '应回落到 section 里的预告');
    assert.equal(await page.locator('#pgc-download-all').isVisible(), false, '只有一条预告时不应显示下载全部');

    // 媒体页（md…）：不含剧集，需 media → season 两级解析；单集电影不该出现「下载全部」
    const mdMp4Before = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length;
    await page.locator('#pgc-back').click();
    await page.locator('#url-input').fill('https://www.bilibili.com/bangumi/media/md22630575');
    await page.locator('#url-input').press('Enter');
    await page.locator('#pgc-page').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#pgc-title').innerText(), '免费电影测试');
    assert.equal(await page.locator('#pgc-download-all').isVisible(), false, '单集电影不应显示下载全部');
    assert.ok(upstreamUrls.some(u => u.includes('/pgc/view/web/media') && u.includes('media_id=22630575')), '应通过 media 接口解析 md 页');
    await page.locator('#pgc-download').click();
    await waitLastQueueCard('.task-status.done', 20000);
    assert.ok(fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length > mdMp4Before, 'md 页应能正常下载');

    await page.locator('#pgc-back').click();
    // 充电专属：解析后明确提示，取流被拒时给出可理解的失败原因
    await page.locator('#url-input').fill('BV1upower1x7');
    await page.locator('#url-input').press('Enter');
    await page.waitForFunction(() => /充电专属/.test(document.body.innerText), null, { timeout: 10000 });
    await page.locator('#dl-btn').click();
    const upowerTask = queueCards().last();
    await waitLastQueueCard('.task-status.error');
    assert.ok(/充电专属/.test(await upowerTask.textContent()), '失败提示应说明是充电专属内容');
    // 右下角下载队列小球：打开 → 可拖动浮层 → 再次点击收起 → 再点击弹出
    const queueOrb = page.locator('#queue-orb');
    await queueOrb.click();
    await page.locator('#queue-panel').waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    assert.equal(await queueOrb.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#queue-orb-icon').innerText(), '✕');
    assert.ok(await page.locator('#queue-list .task-card').count() > 0, '队列浮层应展示任务');
    const queueFirstHeight = await page.locator('#queue-list .task-card').first().evaluate(el => el.getBoundingClientRect().height);
    assert.ok(queueFirstHeight > 20, '已完成任务在队列中不应被折叠为 0 高');
    const queueBox = await page.locator('#queue-panel').boundingBox();
    assert.ok(queueBox.width <= 660, '桌面端队列应为浮动窗，而不是整页全屏');
    assert.ok(queueBox.height > 300 && queueBox.height <= 420, '队列篇幅应受限，靠列表内部滑动查看');
    assert.ok(queueBox.x > 0 && queueBox.y > 0, '队列浮层应位于右下角而非贴满屏幕');
    assert.equal(await page.locator('#queue-clear-done').isVisible(), true, '队列应提供清除完成按钮');
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/queue-compact.png') });
    const dragStart = await page.locator('#queue-drag-handle').boundingBox();
    await page.mouse.move(dragStart.x + 40, dragStart.y + 20);
    await page.mouse.down();
    await page.mouse.move(dragStart.x - 90, dragStart.y + 70, { steps: 6 });
    await page.mouse.up();
    const movedBox = await page.locator('#queue-panel').boundingBox();
    assert.ok(Math.abs(movedBox.x - queueBox.x) > 20, '拖动标题栏应能水平移动队列浮层（受屏幕边界夹取）');
    assert.ok(Math.abs(movedBox.y - queueBox.y) > 20, '拖动标题栏应能垂直移动队列浮层');
    await queueOrb.click();
    assert.equal(await page.locator('#queue-panel').isHidden(), true, '再次点击小球应收起队列');
    assert.equal(await queueOrb.getAttribute('aria-expanded'), 'false');
    await queueOrb.click();
    await page.locator('#queue-panel').waitFor({ state: 'visible' });
    await page.locator('#queue-clear-done').click();
    assert.equal(await page.locator('#queue-list .task-card').count(), 0, '清除完成应移除终态任务');
    await page.locator('#queue-back').click();
    assert.equal(await page.locator('#queue-panel').isHidden(), true, '队列关闭按钮应能收起浮层');
    assert.equal(await queueOrb.getAttribute('aria-expanded'), 'false');

    // 视频批量命名：每个分P只保留本视频 / 分P名称，不再拼接 P 序号与父标题
    await page.locator('.content-tab[data-content="video"]').click();
    await page.locator('#url-input').fill('BV1xx411c7mD');
    await page.locator('#url-input').press('Enter');
    await page.waitForFunction(() => /下载体验测试/.test(document.querySelector('#v-title').textContent), null, { timeout: 10000 });
    await page.locator('#btn-all').click();
    await page.locator('#batch-panel').waitFor({ state: 'visible', timeout: 10000 });
    const videoBatchNames = await page.locator('.batch-item-name').allTextContents();
    assert.deepEqual(videoBatchNames, ['下载体验测试', '第二分 P'], '视频批量列表只显示原视频 / 分P名称');
    const videoBatchBefore = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4')).length;
    await page.locator('#batch-start').click();
    await page.waitForFunction(() => /批量下载已全部结束/.test(document.body.innerText), null, { timeout: 60000 });
    const videoFiles = fs.readdirSync(downloads).filter(n => n.endsWith('.mp4'));
    assert.ok(videoFiles.length >= videoBatchBefore + 2, '视频批量应下载两个分P');
    assert.ok(videoFiles.some(n => n.startsWith('第二分 P_')), '视频批量文件应保留分P原名');
    assert.ok(videoFiles.some(n => n.startsWith('下载体验测试_')), '清理后标题为空的分P应回退原视频名');
    assert.equal(videoFiles.some(n => n.includes('[P')), false, '视频批量文件不应再拼接 [P 序号]');
    await page.locator('#batch-back').click();

    // 热门推荐独立频道：桌面端首次进入自动加载，页面没有搜索栏，刷新按钮重新请求
    await page.locator('.content-tab[data-content="hot"]').click();
    await page.locator('#hot-page').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#hot-grid .hot-card').length === 16, null, { timeout: 15000 });
    assert.equal(await page.locator('#url-input').isVisible(), false, '热门页不应显示搜索栏');
    assert.match(await page.locator('#hot-title').textContent(), /今天大家在看什么/);
    assert.ok((await page.locator('#hot-updated').textContent()).trim().length > 0, '热门页应显示更新时间');
    const hotCard = page.locator('#hot-grid .hot-card').first();
    assert.equal(await hotCard.locator('.hot-cover img').count(), 1, '热门卡片应保留封面');
    assert.ok((await hotCard.locator('.hot-title').textContent()).trim().length > 0, '热门卡片应保留标题');
    assert.equal(await page.locator('#hot-refresh').isVisible(), true, '热门页应有专属刷新按钮');
    // 桌面软件缩放：窗口变窄时列数应跟着减少，而不是固定列宽溢出。
    const hotColumns = () => page.evaluate(() => getComputedStyle(document.getElementById('hot-grid')).gridTemplateColumns.split(' ').filter(Boolean).length);
    // 隐藏窗口的原生 setSize 在 Linux 下不触发重排，这里直接改变内容区宽度，
    // 验证软件缩放时网格会自动增减列数而不是溢出。
    const setHotWidth = async (width) => {
      await page.evaluate(w => {
        const el = document.getElementById('hot-page');
        el.style.width = w + 'px';
        el.style.maxWidth = 'none';
      }, width);
      await page.waitForTimeout(120);
    };
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.waitForTimeout(260);
    assert.equal(await hotColumns(), 4, '宽屏窗口热门网格应为四列');
    await setHotWidth(900);
    assert.equal(await hotColumns(), 3, '900px 内容区热门网格应为三列');
    await setHotWidth(700);
    assert.equal(await hotColumns(), 2, '700px 内容区热门网格应为两列');
    await page.evaluate(() => {
      const el = document.getElementById('hot-page');
      el.style.width = '';
      el.style.maxWidth = '';
    });
    await page.waitForTimeout(160);
    const hotRequestsBefore = upstreamUrls.filter(u => u.includes('/x/web-interface/popular')).length;
    await page.locator('#hot-refresh').click();
    await page.waitForFunction(() => /第 2 页/.test(document.querySelector('#hot-status').textContent), null, { timeout: 15000 });
    assert.ok(upstreamUrls.filter(u => u.includes('/x/web-interface/popular')).length > hotRequestsBefore, '刷新应重新请求热门接口');
    assert.equal(await page.locator('#hot-refresh').isDisabled(), false, '刷新结束后按钮应恢复可用');

    // 点击热门卡片应直接打开内嵌播放 / 下载栏，并在离开频道 / 关闭时彻底停住视频元素。
    await hotCard.click();
    await page.locator('#hot-watch').waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await page.locator('#hot-watch-title').textContent()).includes('热门视频 1'), '热门播放栏应显示所选视频标题');
    assert.equal(await page.locator('#hot-download').isVisible(), true, '热门播放栏应提供下载本视频按钮');
    assert.ok(await page.locator('#hot-qn option').count() > 0, '热门播放栏应同步清晰度选项');
    await page.waitForFunction(() => document.querySelector('#hot-dl-size').textContent.includes('预估'), null, { timeout: 10000 });
    await page.locator('.content-tab[data-content="video"]').click();
    await page.locator('#hot-page').waitFor({ state: 'hidden', timeout: 10000 });
    const stopped = await page.evaluate(() => {
      const v = document.getElementById('hot-video');
      return { paused: v.paused, src: v.getAttribute('src'), loadingHidden: document.getElementById('hot-watch-loading').hidden };
    });
    assert.equal(stopped.paused, true, '离开热门频道后内嵌视频必须暂停');
    assert.equal(stopped.src, null, '离开热门频道后应清空内嵌视频地址，避免后台残留音频');
    assert.equal(stopped.loadingHidden, true, '离开热门频道后应清空加载提示');
    await page.locator('.content-tab[data-content="hot"]').click();
    await page.locator('#hot-watch-close').click();
    assert.equal(await page.locator('#hot-watch').isHidden(), true, '关闭按钮应收起热门播放栏');
    // 等顶部刷新提示自动消失，截图只保留页面本身
    await page.waitForTimeout(1600);
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
