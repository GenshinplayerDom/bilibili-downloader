/* ============================================================
 * 哔哩下载器 · app.js（v2）
 * 链接解析 → 信息获取 → 下载（视频 MP4 / 音频 M4A·MP3）
 *
 * v2 新增 / 变更：
 *   - 多任务并发：可同时下载多个视频 / 音频，每个任务独立进度
 *   - 音频默认 M4A 原版直取（MP3 转码为可选）
 *   - 音频下载不再显示视频清晰度选项
 *   - 下载地址缓存：首次下载获取直链并缓存（6 小时有效），
 *     后续自动复用；可在设置页清除 / 重新获取
 *   - 设置模块：代理方式（自动/本机/自定义）、一键修复、
 *     登录账号（客户端内嵌登录 / 网页版粘贴 Cookie）、使用教程
 *   - 精简主界面：代理状态收敛为头部状态点，设置移入抽屉
 * ============================================================ */

(function () {
  'use strict';
  var nativeFetch = window.fetch.bind(window);
  var tokenMeta = document.querySelector('meta[name="bili-proxy-token"]');
  var effectivePort = null;   // 实际代理端口（Electron 端口自动探测时可能与默认 8123 不同）
  var proxyAuth = window.biliAPI && window.biliAPI.proxyConfig
    ? window.biliAPI.proxyConfig().catch(function () { return null; })
    : Promise.resolve(tokenMeta ? { token: tokenMeta.content, port: Number(location.port) || 8123 } : null);
  proxyAuth.then(function (auth) { if (auth && auth.port) effectivePort = auth.port; });
  function fetch(url, options) {
    var target = new URL(url, location.href);
    if (!/^127\.0\.0\.[123]$|^localhost$/.test(target.hostname)) return nativeFetch(url, options);
    return proxyAuth.then(function (auth) {
      var opts = Object.assign({}, options);
      if (auth && Number(target.port) === auth.port) {
        opts.headers = new Headers(opts.headers || {});
        opts.headers.set('X-Bili-Token', auth.token);
      }
      return nativeFetch(url, opts);
    });
  }

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var inputEl = $('url-input');
  var clearBtn = $('clear-btn');
  var finder = $('finder');
  var statusEl = $('finder-status');
  var resultEl = $('result');
  var typeSeg = $('type-seg');
  var qnSelect = $('qn-select');
  var encSelect = $('enc-select');
  var optEnc = $('opt-enc');
  var afSelect = $('af-select');
  var aqSelect = $('aq-select');
  var optVideo = $('opt-video');
  var optAudio = $('opt-audio');
  var optAq = $('opt-aq');
  var dlBtn = $('dl-btn');
  var dlNote = $('dl-note');
  var pagesPanel = $('pages-panel');
  var pagesList = $('pages-list');
  var threadSelect = $('thread-select');
  var tasksCard = $('tasks-card');
  var tasksList = $('tasks-list');
  var tasksClearDone = $('tasks-clear-done');
  // v1.2 新增
  var fmtSelect = $('fmt-select');
  var clipInput = $('clip-input');
  var timerInput = $('timer-input');
  var timerCheck = $('timer-check');
  var extraDanmaku = $('extra-danmaku');
  var extraSub = $('extra-sub');
  var btnAll = $('btn-all');
  var btnExport = $('btn-export');
  var playerModal = $('player-modal');
  var playerVideo = $('player-video');
  // v1.3：批量下载独立界面
  var batchPanel = $('batch-panel');
  var batchList = $('batch-list');
  var batchStart = $('batch-start');
  var batchBack = $('batch-back');
  var batchSub = $('batch-sub');
  var batchTypeSeg = $('batch-type-seg');
  var batchQn = $('batch-qn');
  var batchEnc = $('batch-enc');
  var batchAf = $('batch-af');
  var batchAq = $('batch-aq');
  var batchThread = $('batch-thread');
  var batchFmt = $('batch-fmt');
  var batchActive = false;
  var batchTasks = [];
  var batchData = null;
  var batchStarted = false;
  var playerClose = $('player-close');
  var playerTitle = $('player-title');
  var favBtn = $('fav-btn');
  var favList = $('fav-list');
  var favNote = $('fav-note');
  var rateLimitInput = $('rate-limit');
  var cacheLock = $('cache-lock');
  var langSelect = $('lang-select');
  var themeSelect = $('theme-select');
  var setExport = $('set-export');
  var setImport = $('set-import');
  var speedtestBtn = $('speedtest-btn');

  // 设置
  var settingsPanel = $('settings-panel');
  var settingsMask = $('settings-mask');
  var settingsBtn = $('settings-btn');
  var settingsClose = $('settings-close');
  var proxyModeSelect = $('proxy-mode');
  var customProxyInput = $('custom-proxy');
  var customProxyBlock = $('custom-proxy-block');
  var proxyPortInput = $('proxy-port');
  var proxyTip = $('proxy-tip');
  var fixBtn = $('fix-btn');
  var fixLogs = $('fix-logs');
  var loginStateEl = $('login-state');
  var loginBadge = $('login-badge');
  var loginBtn = $('login-btn');
  var logoutBtn = $('logout-btn');
  var cookieRow = $('cookie-row');
  var cookieInput = $('cookie-input');
  var cookieSave = $('cookie-save');
  var loginNote = $('login-note');
  var dlCacheCount = $('dl-cache-count');
  var dlCacheClear = $('dl-cache-clear');
  var dlCacheRefresh = $('dl-cache-refresh');
  var dlDirPath = $('dl-dir-path');
  var dlDirPick = $('dl-dir-pick');
  var dlDirOpen = $('dl-dir-open');
  var dlDirNote = $('dl-dir-note');
  var toastEl = $('toast');

  // 下载记录
  var historyBtn = $('history-btn');
  var historyPanel = $('history-panel');
  var historyList = $('history-list');
  var historyBack = $('history-back');
  var historyEmpty = $('history-empty');
  var mainContainer = document.querySelector('main.container');

  // 头部状态
  var proxyDot = $('proxy-dot');
  var proxyState = $('proxy-state');

  /* ---------- 状态 ---------- */
  var current = null;        // 当前解析到的视频信息
  var busy = false;          // 解析中
  var taskSeq = 0;
  var tasks = [];            // 多任务列表
  var dlPathMap = {};        // filename → 实际保存路径（Electron will-download 回传）
  var pendingSaves = {};    // blob URL → 独立的保存任务

  /* ---------- 工具 ---------- */
  var IS_ANDROID = !!(window.biliAPI && typeof window.biliAPI.isAndroid === 'function' && window.biliAPI.isAndroid());
  var androidCbSeq = 0;
  if (IS_ANDROID) {
    // Android 无 ffmpeg：隐藏封装 / 片段 / 定时 / 附带选项
    ['opt-format', 'opt-clip', 'opt-timer', 'opt-extra', 'opt-actions'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return String(n);
  }
  function fmtDur(sec) {
    sec = Number(sec) || 0;
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    function p(v) { return v < 10 ? '0' + v : String(v); }
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'bilibili';
  }
  function setStatus(cls, text) {
    statusEl.className = cls || '';
    statusEl.textContent = text || '';
  }
  function setFinderState(state) {
    finder.classList.remove('scanning', 'done', 'error');
    if (state) finder.classList.add(state);
  }
  function setNote(cls, text) {
    dlNote.className = cls || '';
    dlNote.textContent = text || '';
  }

  /* ---------- 顶部轻提示（不遮挡操作，自动消失） ---------- */
  var toastTimer = null;
  function showToast(msg, type) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = '';
    }, 3200);
  }

  /* ---------- 代理方式 ----------
   * auto   自动：优先本机代理（多地址并发），不可达时尝试自定义地址，再直连兜底
   * local  仅本机代理
   * custom 仅使用自定义代理地址
   */
  var PROXY_HOSTS = ['127.0.0.1', '127.0.0.2', '127.0.0.3'];
  var proxyAlive = null;
  var useProxy = true;

  function proxyMode() {
    return proxyModeSelect ? proxyModeSelect.value : 'auto';
  }
  function customProxyBase() {
    var v = (customProxyInput && customProxyInput.value || '').trim();
    return v || '';
  }
  function proxyBase(host) {
    if (IS_ANDROID) return 'https://appassets.androidplatform.net/proxy';
    var p = parseInt(proxyPortInput && proxyPortInput.value, 10);
    // Electron：优先使用代理实际监听端口（端口自动探测时可能与 8123 不同）
    var port = effectivePort || (tokenMeta ? (Number(location.port) || 8123) : (p > 0 && p < 65536) ? p : 8123);
    if (proxyMode() === 'custom') {
      var c = customProxyBase();
      if (c) return c.replace(/\/+$/, '');
    }
    return 'http://' + (host || '127.0.0.1') + ':' + port;
  }
  function proxyUrl(kind, url) {
    return proxyBase() + '/' + kind + '?url=' + encodeURIComponent(url);
  }

  function updateProxyUi(alive) {
    if (proxyDot && proxyState) {
      if (!useProxy) {
        proxyDot.className = 'proxy-dot off';
        proxyState.textContent = '直连';
      } else if (alive) {
        proxyDot.className = 'proxy-dot ok';
        proxyState.textContent = '已连接';
      } else {
        proxyDot.className = 'proxy-dot bad';
        proxyState.textContent = '未连接';
      }
    }
    if (proxyTip) {
      var tip = '';
      if (!useProxy) {
        proxyTip.className = 'proxy-tip off';
        tip = '已选择直接请求模式：B 站接口默认不允许浏览器跨域直连，若提取失败请改回「自动」并启动本地代理';
      } else if (alive) {
        proxyTip.className = 'proxy-tip ok';
        tip = '代理已连接，可正常提取链接';
      } else {
        proxyTip.className = 'proxy-tip bad';
        tip = '代理未连接：请点击下方「一键修复」，或（网页版）运行 start-server.bat 后重试';
      }
      proxyTip.textContent = tip;
      proxyTip.hidden = false;
    }
  }

  function checkProxy() {
    if (!useProxy) {
      proxyAlive = false;
      updateProxyUi(false);
      return Promise.resolve(false);
    }
    return fetch(proxyBase() + '/status', { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        proxyAlive = !!(j && j.ok);
        updateProxyUi(proxyAlive);
        return proxyAlive;
      })
      .catch(function () {
        proxyAlive = false;
        updateProxyUi(false);
        return false;
      });
  }

  /* ---------- API ---------- */
  function apiGet(url) {
    var doDirect = function () {
      return fetch(url, { credentials: 'omit' }).then(function (res) {
        if (res.status === 412) throw new Error('B 站风控拒绝了直连请求（HTTP 412）。请使用代理重试');
        if (!res.ok) throw new Error('接口请求失败（HTTP ' + res.status + '）');
        return res.json();
      });
    };
    var doProxy = function () {
      return fetch(proxyUrl('api', url), { credentials: 'omit' }).then(function (res) {
        if (res.status === 412) throw new Error('B 站风控拦截了请求（HTTP 412）。代理已自动换新设备身份重试仍被拦截，请稍等 1~2 分钟再试，或换一个视频');
        if (!res.ok) {
          return res.json().then(function (j) {
            throw new Error('代理转发失败：' + (j && j.error ? j.error : ('HTTP ' + res.status)));
          });
        }
        return res.json();
      });
    };

    var p;
    if (useProxy && proxyMode() !== 'custom') {
      p = (proxyAlive === true ? Promise.resolve(true) : checkProxy()).then(function (alive) {
        if (alive) return doProxy();
        // auto：本机代理不可达 → 尝试自定义地址 → 最后直连兜底
        var c = customProxyBase();
        if (proxyMode() === 'auto' && c) {
          return fetch(c + '/api?url=' + encodeURIComponent(url), { credentials: 'omit' }).then(function (res) {
            if (!res.ok) throw new Error('自定义代理转发失败（HTTP ' + res.status + '）');
            return res.json();
          });
        }
        throw new Error('本地代理未连接：请点击设置中的「一键修复」，或（网页版）运行 start-server.bat');
      });
    } else if (proxyMode() === 'custom') {
      var base = proxyBase();
      p = fetch(base + '/api?url=' + encodeURIComponent(url), { credentials: 'omit' }).then(function (res) {
        if (!res.ok) throw new Error('自定义代理转发失败（HTTP ' + res.status + '）');
        return res.json();
      }).catch(function (e) {
        var err = new Error('自定义代理不可达：' + (e && e.message ? e.message : '网络错误') + '，请检查设置中的代理地址');
        throw err;
      });
    } else {
      p = doDirect().catch(function (err) {
        throw new Error('直接请求失败（' + err.message + '）。B 站接口默认不允许浏览器跨域直连，请使用本机代理');
      });
    }

    return p.then(function (json) {
      if (json.code !== 0) {
        throw new Error(json.message || ('接口返回错误 code=' + json.code));
      }
      return json.data;
    });
  }

  function viewByVideo(q) {
    var p = q.bvid ? 'bvid=' + encodeURIComponent(q.bvid) : 'aid=' + encodeURIComponent(q.aid);
    var url = 'https://api.bilibili.com/x/web-interface/view?' + p;
    return apiGet(url).then(function (data) {
      return data;
    }, function (err) {
      if (/412|风控|拦截/i.test(err && err.message || '')) {
        var retryUrl = q.bvid
          ? 'https://api.bilibili.com/x/web-interface/view?aid=' + encodeURIComponent(q.aid || '')
          : 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(q.bvid || '');
        return new Promise(function (resolve) { setTimeout(resolve, 1800); }).then(function () {
          return apiGet(retryUrl).then(function (data) {
            return data;
          }, function (err2) {
            if (!/412|风控|拦截/i.test(err2 && err2.message || '')) throw err2;
            return apiGet('https://api.bilibili.com/x/player/pagelist?' + p).then(function (pl) {
              var first = pl && pl[0];
              if (!first || !first.cid) throw err;
              return {
                bvid: q.bvid || '',
                aid: q.aid || 0,
                cid: first.cid,
                title: first.part || '视频（' + (q.bvid || q.aid) + '）',
                pic: '',
                owner: null,
                duration: first.duration || 0,
                stat: null,
                pubdate: 0,
                pages: pl.map(function (pg) {
                  return { cid: pg.cid, page: pg.page, part: pg.part || ('P' + pg.page), duration: pg.duration };
                }),
                degraded: true
              };
            });
          });
        });
      }
      throw err;
    });
  }
  function viewByEp(epId) {
    return apiGet('https://api.bilibili.com/x/web-interface/view?ep_id=' + encodeURIComponent(epId));
  }
  function viewBySeason(ssId) {
    return apiGet('https://api.bilibili.com/x/web-interface/view?season_id=' + encodeURIComponent(ssId));
  }

  /* ---------- 链接解析 ---------- */
  function parseLink(text) {
    text = String(text || '').trim()
      .replace(/[“”"'‘’《》<>【】]/g, '');
    if (!text) return null;
    var m;
    m = text.match(/(?:^|[^A-Za-z0-9])ss(\d+)/i);
    if (m) return { kind: 'season', ssId: m[1] };
    m = text.match(/(?:^|[^A-Za-z0-9])ep(\d+)/i);
    if (m) return { kind: 'bangumi', epId: m[1] };
    m = text.match(/favlist\?fid=(\d+)/i);
    if (m) return { kind: 'favlist', fid: m[1] };
    m = text.match(/BV[0-9A-Za-z]{10}/);
    if (m) return { kind: 'video', bvid: m[0] };
    m = text.match(/(?:^|[^A-Za-z0-9])(?:av|AV)(\d+)/);
    if (m) return { kind: 'video', aid: m[1] };
    if (/b23\.tv/i.test(text)) {
      var urlMatch = text.match(/https?:\/\/[^\s]+/);
      return { kind: 'short', url: urlMatch ? urlMatch[0] : 'https://' + text.trim() };
    }
    return null;
  }

  function expandShort(url) {
    function viaProxy() {
      return fetch(proxyUrl('expand', url), { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) throw new Error('短链展开失败');
          var finalUrl = j.finalUrl || '';
          if (/bilibili\.com/i.test(finalUrl) && /(BV[0-9A-Za-z]{10}|av\d+|ep\d+|ss\d+)/i.test(finalUrl)) {
            return finalUrl;
          }
          throw new Error('短链未指向哔哩哔哩视频页');
        });
    }
    if (!useProxy) {
      var e0 = new Error('短链展开需要本机代理：请在设置中开启代理后重试；或直接在 B 站打开短链后复制地址栏完整链接粘贴');
      e0.code = 'SHORT_EXPAND_BLOCKED';
      return Promise.reject(e0);
    }
    if (proxyAlive === true) return viaProxy();
    return checkProxy().then(function (alive) {
      if (alive) return viaProxy();
      var e = new Error('短链展开失败：需要本机代理。请在设置中点击「一键修复」，或（网页版）运行 start-server.bat 后重试；或直接在 B 站打开短链复制完整链接粘贴');
      e.code = 'SHORT_EXPAND_BLOCKED';
      throw e;
    });
  }

  /* ---------- 主流程 ---------- */
  function startParse(text) {
    if (busy) return;
    var parsed = parseLink(text);
    if (!parsed) {
      setFinderState('error');
      setStatus('fail', '无法识别的链接，请输入 B 站视频 BV 号 / av 号 / 完整链接或番剧剧集');
      return;
    }
    busy = true;
    setFinderState('scanning');
    setStatus('loading', '正在解析链接…');

    var chain;
    if (parsed.kind === 'short') {
      chain = expandShort(parsed.url).then(parseLink);
    } else {
      chain = Promise.resolve(parsed);
    }

    chain.then(function (p) {
      if (!p) throw new Error('短链展开后未识别到视频');
      if (p.kind === 'season') {
        setStatus('loading', '正在获取番剧信息…');
        return viewBySeason(p.ssId).then(function (data) { return { p: p, data: data }; });
      }
      if (p.kind === 'bangumi') {
        setStatus('loading', '正在获取剧集信息…');
        return viewByEp(p.epId).then(function (data) { return { p: p, data: data }; });
      }
      if (p.kind === 'favlist') {
        setStatus('loading', '正在读取收藏夹视频…');
        return loadFavlistData(p.fid).then(function (data) { return { p: p, data: data }; });
      }
      setStatus('loading', '正在获取视频信息…');
      return viewByVideo(p).then(function (data) { return { p: p, data: data }; });
    }).then(function (res) {
      var data = res.data;
      if (!data) throw new Error('未获取到视频数据');
      if (res.p.kind === 'season') {
        renderSeason(data);
      } else if (res.p.kind === 'favlist') {
        renderFavlist(data);
      } else {
        current = {
          kind: 'video',
          bvid: data.bvid,
          aid: data.aid,
          cid: data.cid,
          title: data.title,
          pic: (data.pic || '').replace(/^http:/i, 'https:'),
          up: data.owner ? data.owner.name : '',
          duration: data.duration || 0,
          stat: data.stat || {},
          pubdate: data.pubdate || 0,
          pages: (data.pages && data.pages.length) ? data.pages : [{ cid: data.cid, page: 1, part: data.title, duration: data.duration }],
          pageIndex: 0,
          degraded: !!data.degraded
        };
        renderCurrent();
        // 异步探测服务端可用清晰度（不阻塞信息展示；失败时保持全档可选）
        probeAcceptQuality().then(fillQnOptions);
      }
      setFinderState('done');
      setStatus('ok', '已识别，请选择下方下载选项');
      resultEl.hidden = false;
    }).catch(function (err) {
      console.warn('[哔哩下载器] 解析失败：', err);
      setFinderState('error');
      setStatus('fail', err && err.message ? err.message : '解析失败，请检查链接后重试');
    }).then(function () {
      busy = false;
    });
  }

  function renderSeason(data) {
    var episodes = (data && data.episodes) || [];
    if (!episodes.length) throw new Error('未获取到番剧剧集列表');
    current = {
      kind: 'bangumi',
      seasonId: data.season_id,
      title: data.title || data.season_title || '',
      pic: ((episodes[0] && episodes[0].pic) || data.pic || '').replace(/^http:/i, 'https:'),
      up: data.up_info ? data.up_info.name : '',
      duration: (episodes[0] && episodes[0].duration) || 0,
      stat: data.stat || {},
      pubdate: 0,
      episodes: episodes,
      pageIndex: 0
    };
    current.title = current.title + '（' + episodes.length + ' 集）';
    renderCard();
    if (btnAll) btnAll.hidden = false;
    pagesPanel.hidden = false;
    pagesList.innerHTML = '';
    episodes.forEach(function (ep, i) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'page-chip' + (i === 0 ? ' active' : '');
      var t = String(ep.title || '');
      var label = /第.+[话集]/.test(t) ? t : (t ? '第 ' + t + ' 话' : '第 ' + (i + 1) + ' 话');
      if (ep.long_title) label += ' · ' + ep.long_title;
      chip.innerHTML = '<span class="page-part">' + escHtml(label) + '</span>' +
        '<span class="page-dur">' + fmtDur(ep.duration || 0) + '</span>';
      chip.addEventListener('click', function () { selectEpisode(i); });
      pagesList.appendChild(chip);
    });
    selectEpisode(0, true);
  }

  function selectEpisode(idx, silent) {
    var ep = current.episodes[idx];
    current.pageIndex = idx;
    current.bvid = ep.bvid;
    current.aid = ep.aid;
    current.cid = ep.cid;
    current.epId = ep.id;
    var chips = pagesList.children;
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('active', i === idx);
    if (!silent) setNote('ok', '已切换到第 ' + (idx + 1) + ' 集');
    probeAcceptQuality().then(fillQnOptions);
  }

  function renderCard() {
    $('v-title').textContent = current.title;
    $('v-up').textContent = current.up;
    $('v-duration').textContent = fmtDur(current.duration);
    var cover = $('v-cover');
    cover.src = current.pic;
    cover.onerror = function () { cover.style.visibility = 'hidden'; };
    var stat = current.stat || {};
    var deg = !!current.degraded;
    $('v-views').textContent = deg ? '—' : fmtCount(stat.view);
    $('v-danmaku').textContent = deg ? '—' : fmtCount(stat.danmaku);
    $('v-likes').textContent = deg ? '—' : fmtCount(stat.like);
    if ($('v-reply')) $('v-reply').textContent = deg ? '—' : fmtCount(stat.reply);
  }

  function renderCurrent() {
    renderCard();
    var hasMulti = current.kind === 'video' ? (current.pages && current.pages.length > 1) : (current.kind === 'bangumi' && current.episodes && current.episodes.length > 1);
    if (btnAll) {
      btnAll.hidden = !hasMulti;
      btnAll.textContent = current.favlist ? ('下载全部 P（' + (current.pages || []).length + ' 个视频）') : '下载全部 P / 集';
    }
    if (current.kind === 'video' && current.pages.length > 1) {
      pagesPanel.hidden = false;
      pagesList.innerHTML = '';
      current.pages.forEach(function (p, i) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'page-chip' + (i === 0 ? ' active' : '');
        chip.innerHTML = '<span class="page-part">P' + escHtml(p.page) + ' · ' + escHtml(p.part) + '</span>' +
          '<span class="page-dur">' + fmtDur(p.duration || 0) + '</span>';
        chip.addEventListener('click', function () { selectPage(i); });
        pagesList.appendChild(chip);
      });
    } else if (current.kind === 'video') {
      pagesPanel.hidden = true;
    }
  }

  function selectPage(idx) {
    var p = current.pages[idx];
    current.pageIndex = idx;
    // 收藏夹 / 合集每个 P 可能是独立视频（独立 bvid），需一并切换
    if (p.bvid) current.bvid = p.bvid;
    if (p.aid) current.aid = p.aid;
    current.cid = p.cid;
    var chips = pagesList.children;
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('active', i === idx);
    setNote('ok', '已切换到 P' + p.page + ' · ' + p.part);
    probeAcceptQuality().then(fillQnOptions);
  }

  /* ---------- 收藏夹网址解析（favlist?fid=xx） ---------- */
  function loadFavlistData(fid) {
    var u = proxyBase() + '/api?url=' + encodeURIComponent('https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + fid + '&pn=1&ps=20');
    return fetch(u, { credentials: 'omit' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.code && j.code !== 0) throw new Error('读取收藏夹失败：' + (j.message || j.code));
      var d = (j && j.data) || {};
      var medias = d.medias || [];
      if (!medias.length) throw new Error('该收藏夹暂无视频');
      return { title: d.info ? d.info.title : ('收藏夹 ' + fid), medias: medias };
    });
  }
  function renderFavlist(data) {
    var medias = data.medias.slice(0, 50);
    var pages = medias.map(function (m, i) {
      return { cid: m.cid, bvid: m.bvid, aid: m.aid, page: i + 1, part: m.title, duration: m.duration || 0, pic: m.pic || '' };
    });
    var first = pages[0];
    current = {
      kind: 'video',
      bvid: first.bvid,
      aid: first.aid,
      cid: first.cid,
      title: data.title + '（收藏夹 · 前 ' + pages.length + ' 个视频）',
      pic: (first.pic || '').replace(/^http:/i, 'https:'),
      up: '',
      duration: first.duration || 0,
      stat: {},
      pubdate: 0,
      pages: pages,
      pageIndex: 0,
      favlist: true
    };
    setFinderState('done');
    setStatus('ok', '收藏夹解析成功，请选择要下载的视频（或点「下载全部 P」）');
    resultEl.hidden = false;
    renderCurrent();
    if (btnAll) { btnAll.hidden = false; btnAll.textContent = '下载全部 P（' + pages.length + ' 个视频）'; }
    probeAcceptQuality().then(fillQnOptions);
  }

  /* ---------- 清晰度档位（原视频无该分辨率 → 灰显禁用） ---------- */
  function probeAcceptQuality() {
    return fetchPlayurl(16).then(function (pd) {
      current.acceptQuality = (pd && pd.accept_quality) || [];
      current.acceptDescription = (pd && pd.accept_description) || [];
    }).catch(function () {
      current.acceptQuality = [];
      current.acceptDescription = [];
    });
  }
  function fillQnOptions() {
    if (!qnSelect) return;
    var aq = (current && Array.isArray(current.acceptQuality) && current.acceptQuality.length) ? current.acceptQuality : null;
    var prev = qnSelect.value;
    qnSelect.innerHTML = '';
    QNS.forEach(function (q) {
      var o = document.createElement('option');
      o.value = q[0];
      var miss = aq && aq.indexOf(q[0]) < 0;
      o.textContent = miss ? q[1] + '（原视频无该分辨率）' : q[1];
      o.disabled = !!miss;
      if (q[0] === 64 && !miss) o.selected = true;
      qnSelect.appendChild(o);
    });
    if (aq) {
      var cur = qnSelect.querySelector('option[value="' + prev + '"]');
      if (cur && cur.disabled) {
        var ok = qnSelect.querySelector('option:not([disabled])');
        if (ok) qnSelect.value = ok.value;
      }
    }
  }

  /* ---------- WBI 签名 ---------- */
  function md5(str) {
    function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
    function add32(x, y) { return (x + y) & 0xffffffff; }
    var s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var K = [];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    var bytes = [];
    for (var c = 0; c < str.length; c++) {
      var code = str.charCodeAt(c);
      if (code < 128) bytes.push(code);
      else if (code < 2048) bytes.push(192 | (code >> 6), 128 | (code & 63));
      else if (code < 55296 || code >= 57344) bytes.push(224 | (code >> 12), 128 | ((code >> 6) & 63), 128 | (code & 63));
      else {
        c++;
        var code2 = str.charCodeAt(c);
        var cp = ((code - 55296) << 10) + (code2 - 56320) + 65536;
        bytes.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
      }
    }
    var bitLen = bytes.length * 8;
    var padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    for (var b = 0; b < 8; b++) padded.push(Math.floor(bitLen / Math.pow(2, 8 * b)) % 256);
    var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
    for (var i2 = 0; i2 < padded.length; i2 += 64) {
      var M = [];
      for (var j = 0; j < 16; j++) M[j] = padded[i2 + j * 4] | (padded[i2 + j * 4 + 1] << 8) | (padded[i2 + j * 4 + 2] << 16) | (padded[i2 + j * 4 + 3] << 24);
      var A = h0, B = h1, C = h2, D = h3;
      for (var j2 = 0; j2 < 64; j2++) {
        var F, g;
        if (j2 < 16) { F = (B & C) | (~B & D); g = j2; }
        else if (j2 < 32) { F = (D & B) | (~D & C); g = (5 * j2 + 1) % 16; }
        else if (j2 < 48) { F = B ^ C ^ D; g = (3 * j2 + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * j2) % 16; }
        var tmp = D;
        D = C; C = B;
        B = add32(B, rotl(add32(add32(A, F), add32(K[j2], M[g])), s[j2]));
        A = tmp;
      }
      h0 = add32(h0, A); h1 = add32(h1, B); h2 = add32(h2, C); h3 = add32(h3, D);
    }
    function hex(n) {
      var h = '';
      for (var x = 0; x < 4; x++) h += ('0' + ((n >>> (x * 8)) & 0xff).toString(16)).slice(-2);
      return h;
    }
    return hex(h0) + hex(h1) + hex(h2) + hex(h3);
  }

  function wbiMixinKey(raw) {
    var order = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
    if (raw.length !== 64) throw new Error('WBI 密钥长度无效');
    return order.map(function (index) { return raw[index]; }).join('');
  }
  var wbiCache = null;
  function fetchWbiKeys() {
    if (wbiCache && Date.now() - wbiCache.t < 3600e3) return Promise.resolve(wbiCache);
    return apiGet('https://api.bilibili.com/x/web-interface/nav').then(function (data) {
      if (!data || !data.wbi_img) throw new Error('获取 WBI 签名密钥失败（nav 返回数据不完整）');
      var img = (data.wbi_img.img_url || '').split('/').pop().split('.')[0];
      var sub = (data.wbi_img.sub_url || '').split('/').pop().split('.')[0];
      if (!img || !sub) throw new Error('WBI 签名密钥为空');
      wbiCache = { key: wbiMixinKey(img + sub), t: Date.now() };
      return wbiCache;
    }, function () {
      return fetch(proxyBase() + '/status', { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var k = j && j.identity && j.identity.wbi_key;
          if (k && k.length === 64) {
            wbiCache = { key: wbiMixinKey(k), t: Date.now() };
            return wbiCache;
          }
          throw new Error('WBI 密钥获取失败');
        });
    });
  }

  function wbiSign(params) {
    return fetchWbiKeys().then(function (cache) {
      var p = {};
      for (var k in params) {
        if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null && params[k] !== '') {
          p[k] = params[k];
        }
      }
      p.wts = Math.floor(Date.now() / 1000);
      var keys = Object.keys(p).sort();
      var query = keys.map(function (k) {
        return k + '=' + encodeURIComponent(p[k]).replace(/[!'()*]/g, '');
      }).join('&');
      p.w_rid = md5(query + cache.key);
      return p;
    });
  }

  function fetchPlayurl(fnval, qn, source) {
    var media = source || current;
    var params = {
      bvid: media.bvid,
      avid: media.aid,
      cid: media.cid,
      qn: qn || qnSelect.value,
      fnval: fnval,
      fourk: 1
    };
    if (!params.bvid) delete params.bvid;
    if (!params.avid) delete params.avid;
    return wbiSign(params).then(function (signed) {
      var q = Object.keys(signed).map(function (k) {
        return k + '=' + encodeURIComponent(signed[k]);
      }).join('&');
      return apiGet('https://api.bilibili.com/x/player/playurl?' + q);
    });
  }

  /* ---------- 下载地址缓存 ----------
   * 首次下载获取直链后缓存（6 小时有效），后续下载自动复用；
   * 设置页可清除全部 / 重新获取当前视频地址。
   */
  var DL_CACHE_TTL = 6 * 3600e3;
  var dlCache = loadDlCache();
  function loadDlCache() {
    try { return JSON.parse(localStorage.getItem('bili_dl_cache') || '{}'); }
    catch (e) { return {}; }
  }
  function saveDlCache() {
    try { localStorage.setItem('bili_dl_cache', JSON.stringify(dlCache)); } catch (e) { }
  }
  function dlCacheKey(bvid, cid, fnval, qn, enc) {
    // 缓存键含登录 UID：未登录时缓存的低清直链，登录后不会复用（反之亦然）；编码偏好不同时缓存隔离
    return bvid + ':' + cid + ':' + fnval + ':' + (qn || 0) + ':' + (enc || '') + ':' + (currentUid || '');
  }
  function getDlCache(key) {
    var e = dlCache[key];
    if (e && Date.now() - e.t < DL_CACHE_TTL) return e;
    return null;
  }
  function setDlCache(key, entry) {
    dlCache[key] = entry;
    saveDlCache();
    updateDlCacheCount();
  }
  function clearDlCache() {
    dlCache = {};
    saveDlCache();
    updateDlCacheCount();
  }
  function updateDlCacheCount() {
    if (dlCacheCount) {
      var n = Object.keys(dlCache).length;
      dlCacheCount.textContent = n + ' 条';
    }
  }

  /* ---------- 下载核心 ---------- */
  function currentThreads() {
    var v = parseInt(threadSelect && threadSelect.value, 10);
    return (v >= 4 && v <= 16) ? v : 8;
  }
  function rotateHost(target, i) {
    // 自定义代理为单地址，不轮换（多线程时受浏览器 6 连接上限影响）
    if (proxyMode() === 'custom') return target;
    var h = PROXY_HOSTS[i % PROXY_HOSTS.length];
    return target.replace(/^http:\/\/127\.0\.0\.1/, 'http://' + h);
  }
  function parseContentRange(v) {
    if (!v) return 0;
    var m = v.match(/\/(\d+)\s*$/);
    return m ? Number(m[1]) : 0;
  }

  function singleDownload(target, onProgress, check, signal) {
    return fetch(target, { credentials: 'omit', signal: signal }).then(function (res) {
      if (!res.ok) {
        var e = new Error('下载失败（HTTP ' + res.status + '）' + (res.status === 403 ? '，视频流受防盗链保护' : ''));
        e.status = res.status;
        throw e;
      }
      var total = Number(res.headers.get('content-length') || 0);
      if (!res.body || !res.body.getReader) {
        return res.blob().then(function (b) { return { blob: b, total: total }; });
      }
      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      function pump() {
        if (check && check()) { try { reader.cancel(); } catch (e) { } return Promise.reject(new Error('已取消')); }
        return reader.read().then(function (r) {
          if (r.done) {
            return { blob: new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' }), total: total };
          }
          chunks.push(r.value);
          received += r.value.length;
          if (onProgress && total > 0) onProgress(received / total);
          return pump();
        });
      }
      return pump();
    });
  }

  function segmentedDownload(targets, total, ctype, onProgress, threadCount, check, signal) {
    var n = threadCount || currentThreads();
    var part = Math.ceil(total / n);
    var chunks = new Array(n);
    var received = new Array(n).fill(0);
    var urls = Array.isArray(targets) && targets.length ? targets : [targets];

    function report() {
      if (!onProgress) return;
      var sum = 0;
      for (var k = 0; k < n; k++) sum += received[k];
      onProgress(Math.min(sum / total, 1));
    }

    function fetchPart(i, retried) {
      if (check && check()) return Promise.reject(new Error('已取消'));
      var start = i * part;
      var end = Math.min(total - 1, (i + 1) * part - 1);
      if (start > end) { chunks[i] = new Uint8Array(0); return Promise.resolve(); }
      // 分片轮换主/备用 CDN 地址（再叠加代理 host 轮换），绕开单节点限速
      received[i] = 0;
      var t = rotateHost(urls[(i + (retried ? 1 : 0)) % urls.length], i);
      return fetch(t, { headers: { Range: 'bytes=' + start + '-' + end }, credentials: 'omit', signal: signal })
        .then(function (res) {
          if (res.status !== 206 || res.headers.get('Content-Range') !== 'bytes ' + start + '-' + end + '/' + total) throw new Error('分段 ' + (i + 1) + ' 返回范围不匹配');
          if (!res.body || !res.body.getReader) {
            return res.arrayBuffer().then(function (ab) {
              received[i] = ab.byteLength;
              report();
              return new Uint8Array(ab);
            });
          }
          var reader = res.body.getReader();
          var bufs = [];
          var got = 0;
          // idle 停滞检测：分片传输中途长时间无数据（TCP 心跳保持连接但数据中断）时中止并触发重试
          var idleTimer = null;
          var idleSince = Date.now();
          function startIdleWatch() {
            idleSince = Date.now();
            if (idleTimer) clearInterval(idleTimer);
            idleTimer = setInterval(function () {
              if (Date.now() - idleSince > 20000) {
                if (idleTimer) clearInterval(idleTimer);
                try { reader.cancel(); } catch (e) { }
              }
            }, 5000);
          }
          function stopIdleWatch() { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } }
          function pump() {
            if (check && check()) { stopIdleWatch(); try { reader.cancel(); } catch (e) { } return Promise.reject(new Error('已取消')); }
            startIdleWatch();
            return reader.read().then(function (r) {
              stopIdleWatch();
              if (r.done) {
                var all = new Uint8Array(got);
                var off = 0;
                for (var b = 0; b < bufs.length; b++) { all.set(bufs[b], off); off += bufs[b].length; }
                return all;
              }
              bufs.push(r.value);
              got += r.value.length;
              received[i] += r.value.length;
              report();
              return pump();
            });
          }
          return pump();
        })
        .then(function (data) { if (data.length !== end - start + 1) throw new Error('分片数据不完整'); chunks[i] = data; })
        .catch(function (err) {
          if (!retried && !(check && check())) return fetchPart(i, true);
          throw err;
        });
    }

    var tasks = [];
    for (var i = 0; i < n; i++) tasks.push(fetchPart(i, false));
    return Promise.all(tasks).then(function () {
      if (check && check()) throw new Error('已取消');
      var totalLen = 0;
      for (var i2 = 0; i2 < n; i2++) totalLen += chunks[i2].length;
      var merged = new Uint8Array(totalLen);
      var off = 0;
      for (var j = 0; j < n; j++) { merged.set(chunks[j], off); off += chunks[j].length; }
      if (onProgress) onProgress(1);
      return { blob: new Blob([merged], { type: ctype }), total: totalLen };
    });
  }

  // 返回 { promise, cancel }，支持取消（AbortController 中断网络 + 各阶段取消检查）
  function fetchStream(url, onProgress, threadCount, isCancelled) {
    var cancelled = false;
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var signal = controller ? controller.signal : undefined;
    var cancelFn = function () {
      cancelled = true;
      if (controller) { try { controller.abort(); } catch (e) { } }
    };
    var check = function () {
      return cancelled || (isCancelled ? isCancelled() : false);
    };

    var targets = Array.isArray(url) && url.length ? url : [url];
    var go = function (targets) {
      var t0 = targets[0];
      return fetch(proxyUrl('stream', t0), { headers: { Range: 'bytes=0-0' }, credentials: 'omit', signal: signal }).then(function (probe) {
        if (check()) throw new Error('已取消');
        var total = parseContentRange(probe.headers.get('content-range'));
        if (probe.status === 206 && total > 0) {
          var ctype = probe.headers.get('content-type') || 'application/octet-stream';
          return segmentedDownload(targets, total, ctype, onProgress, threadCount, check, signal);
        }
        return singleDownload(t0, onProgress, check, signal);
      }).catch(function (err) {
        if (err && err.status) throw err;
        if (check()) throw err;
        return singleDownload(t0, onProgress, check, signal).catch(function () { throw err; });
      });
    };

    var p;
    if (useProxy && proxyMode() !== 'custom') {
      if (proxyAlive === true) p = go(targets);
      else p = checkProxy().then(function (alive) {
        if (alive) return go(targets);
        var c = customProxyBase();
        if (proxyMode() === 'auto' && c) return go(targets.map(function (t) { return c + '/stream?url=' + encodeURIComponent(t); }));
        return go(targets);
      });
    } else if (proxyMode() === 'custom') {
      p = go(targets.map(function (t) { return proxyBase() + '/stream?url=' + encodeURIComponent(t); }));
    } else {
      p = go(targets);
    }
    return { promise: p, cancel: cancelFn };
  }

  function saveBlob(blob, filename, task, meta) {
    var url = URL.createObjectURL(blob);
    var rec = { filename: filename, size: blob.size, type: meta && meta.type, quality: meta && meta.quality };
    if (task && window.biliAPI && window.biliAPI.isElectron) pendingSaves[url] = Object.assign({}, rec, { task: task });
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 800);
    // 下载记录：Electron 等待 will-download 回传精确路径；其他平台先记文件名
    if (!task) return;
    if (!(window.biliAPI && window.biliAPI.isElectron)) {
      addHistoryRecord(rec);
    }
  }

  /* ---------- Android 下载/保存（原生桥 window.biliAPI） ---------- */
  function androidDownload(url, filename, task, meta) {
    var cbId = 'dl' + (++androidCbSeq);
    window.__dlCbs = window.__dlCbs || {};
    window.__dlCbs[cbId] = {
      onProgress: function (frac) {
        if (task.cancelled) return;
        setTaskProgress(task, frac, '下载中 ' + (frac * 100).toFixed(1) + '%');
      },
      onDone: function (ok, msg) {
        delete window.__dlCbs[cbId];
        if (task.cancelled) { setTaskStatus(task, 'cancelled', '已取消'); setTaskNote(task, 'warn', '任务已取消'); return; }
        if (ok) {
          task.path = filename;
          setTaskStatus(task, 'done', '已完成');
          setTaskNote(task, 'ok', msg);
          showToast('✅ ' + msg, 'ok');
          addHistoryRecord({ filename: filename, path: filename, size: 0, type: meta && meta.type, quality: meta && meta.quality });
        } else {
          setTaskStatus(task, 'error', '保存失败');
          setTaskNote(task, 'fail', msg || '保存失败');
          showToast('❌ ' + (msg || '保存失败'), 'fail');
        }
      }
    };
    task.cancelFn = function () {
      // 原生下载无法立即中断网络，标记取消：完成后不落盘展示
      task.cancelled = true;
    };
    window.biliAPI.download(url, filename, cbId);
  }

  function androidSaveBlob(blob, filename, task, baseFrac, meta) {
    var cbId = 'mp3' + (++androidCbSeq);
    window.__dlCbs = window.__dlCbs || {};
    window.__dlCbs[cbId] = {
      onProgress: function (frac) {
        if (!task.cancelled) setTaskProgress(task, baseFrac + frac * (1 - baseFrac), '保存中 ' + (frac * 100).toFixed(0) + '%');
      },
      onDone: function (ok, msg) {
        delete window.__dlCbs[cbId];
        if (task.cancelled) { setTaskStatus(task, 'cancelled', '已取消'); setTaskNote(task, 'warn', '任务已取消'); return; }
        if (ok) {
          task.path = filename;
          setTaskStatus(task, 'done', '已完成');
          setTaskNote(task, 'ok', msg);
          showToast('✅ ' + msg, 'ok');
          addHistoryRecord({ filename: filename, path: filename, size: 0, type: meta && meta.type, quality: meta && meta.quality });
        } else {
          setTaskStatus(task, 'error', '保存失败');
          setTaskNote(task, 'fail', msg || '保存失败');
          showToast('❌ ' + (msg || '保存失败'), 'fail');
        }
      }
    };
    window.biliAPI.saveStart(filename, 1, cbId);
    var CHUNK = 4 * 1024 * 1024;   // 每段 4MB 原始数据（base64 约 5.5MB）
    var reader = new FileReader();
    var offset = 0;
    var size = blob.size;
    function readNext() {
      if (offset >= size) {
        window.biliAPI.saveFinish(cbId, true);
        return;
      }
      var slice = blob.slice(offset, Math.min(offset + CHUNK, size));
      offset += CHUNK;
      reader.onload = function () {
        if (task.cancelled) { window.biliAPI.saveFinish(cbId, false); return; }
        var b64 = String(reader.result).split(',')[1];
        window.biliAPI.saveChunk(b64);
        window.__dlCbs[cbId].onProgress(Math.min(offset / size, 1));
        readNext();
      };
      reader.readAsDataURL(slice);
    }
    readNext();
  }

  /* ---------- 下载历史（Electron 主进程文件 / 其他平台 localStorage） ---------- */
  var HIST_KEY = 'bili_history';
  function histLoad() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function histSave(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 300))); } catch (e) { }
  }
  function histClearLocal() {
    try { localStorage.removeItem(HIST_KEY); } catch (e) { }
  }
  function getHistoryData() {
    if (window.biliAPI && window.biliAPI.getHistory) {
      return window.biliAPI.getHistory().catch(function () { return histLoad(); });
    }
    return Promise.resolve(histLoad());
  }
  function addHistoryRecord(rec) {
    // Electron：主进程持久化；Android/网页：localStorage
    if (window.biliAPI && window.biliAPI.addHistory) {
      window.biliAPI.addHistory(rec).catch(function () { });
    }
    var list = histLoad();
    var item = Object.assign({ id: Date.now() + '-' + Math.floor(Math.random() * 9999), time: Date.now() }, rec || {});
    list.unshift(item);
    histSave(list);
  }
  function removeHistoryRecord(id) {
    var list = histLoad().filter(function (x) { return String(x.id) !== String(id); });
    histSave(list);
    if (window.biliAPI && window.biliAPI.removeHistory) {
      window.biliAPI.removeHistory(id).catch(function () { });
    }
    if (!historyPanel.hidden) renderHistory();
  }

  function fileActionsAvailable() {
    return !!(window.biliAPI && (window.biliAPI.openFile || window.biliAPI.deleteFile));
  }

  function actOpenFile(pathOrName) {
    if (window.biliAPI && window.biliAPI.openFile) {
      window.biliAPI.openFile(pathOrName).then(function (r) {
        if (!r || !r.ok) showToast('❌ ' + ((r && r.error) || '文件不存在'), 'fail');
      });
    } else {
      showToast('当前环境不支持直接打开文件', 'warn');
    }
  }
  function actOpenFolder(pathOrName) {
    if (window.biliAPI && window.biliAPI.openFolder) {
      window.biliAPI.openFolder(pathOrName).then(function (r) {
        if (!r || !r.ok) showToast('❌ ' + ((r && r.error) || '文件不存在'), 'fail');
      });
    } else if (window.biliAPI && window.biliAPI.openFile) {
      // 降级：无定位能力则尝试直接打开
      actOpenFile(pathOrName);
    } else {
      showToast('当前环境不支持定位文件', 'warn');
    }
  }
  function actDeleteFile(pathOrName, id, refreshFn) {
    if (!window.biliAPI || !window.biliAPI.deleteFile) { showToast('当前环境不支持删除文件', 'warn'); return; }
    if (!confirm('确定删除文件「' + (pathOrName.split(/[\\/]/).pop() || pathOrName) + '」吗？删除后不可恢复。')) return;
    window.biliAPI.deleteFile(pathOrName).then(function (r) {
      if (r && r.ok) {
        showToast('🗑 文件已删除', 'ok');
        if (id) removeHistoryRecord(id);
        if (refreshFn) refreshFn();
      } else {
        showToast('❌ ' + ((r && r.error) || '删除失败'), 'fail');
      }
    });
  }

  function renderHistory() {
    getHistoryData().then(function (list) {
      var items = list || [];
      historyList.innerHTML = '';
      historyEmpty.hidden = items.length > 0;
      items.forEach(function (rec) {
        var row = document.createElement('div');
        row.className = 'hist-item';
        var name = rec.filename || rec.path || '未知文件';
        var p = rec.path || '';
        var sizeTxt = rec.size ? fmtSize(rec.size) : '';
        var timeTxt = rec.time ? new Date(rec.time).toLocaleString('zh-CN', { hour12: false }) : '';
        var typeTxt = rec.type || '';
        var icon = rec.type === 'video' ? '🎬' : rec.type === 'audio' ? '🎵' : '📄';
        var hasFile = p || (IS_ANDROID && name);
        var acts = '';
        if (fileActionsAvailable() && hasFile) {
          acts =
            '<button data-f="' + escAttr(p) + '" data-n="' + escAttr(name) + '" data-act="open">打开</button>' +
            '<button data-f="' + escAttr(p) + '" data-n="' + escAttr(name) + '" data-act="folder">所在位置</button>' +
            '<button class="danger" data-f="' + escAttr(p) + '" data-n="' + escAttr(name) + '" data-id="' + escAttr(rec.id) + '" data-act="del">删除文件</button>';
        }
        row.innerHTML =
          '<div class="hist-row1"><span class="hist-icon">' + icon + '</span>' +
          '<span class="hist-name" title="' + escAttr(name) + '">' + escHtml(name) + '</span></div>' +
          '<div class="hist-meta">' +
          (timeTxt ? '<span>' + timeTxt + '</span>' : '') +
          (typeTxt ? '<span>' + escHtml(typeTxt) + '</span>' : '') +
          (sizeTxt ? '<span>' + sizeTxt + '</span>' : '') +
          (p ? '<span class="hist-path" title="' + escAttr(p) + '">' + escHtml(p) + '</span>' : '') +
          '</div>' +
          (acts ? '<div class="hist-actions">' + acts + '</div>' : '');
        historyList.appendChild(row);
      });
      // 绑定操作
      historyList.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var f = btn.getAttribute('data-f');
          var n = btn.getAttribute('data-n');
          var id = btn.getAttribute('data-id');
          var act = btn.getAttribute('data-act');
          var target = f || n;
          if (act === 'open') actOpenFile(target);
          else if (act === 'folder') actOpenFolder(target);
          else if (act === 'del') actDeleteFile(target, id, renderHistory);
        });
      });
    });
  }

  function openHistoryPanel() {
    historyPanel.hidden = false;
    if (mainContainer) mainContainer.hidden = true;
    if (settingsPanel) settingsPanel.hidden = true;
    if (settingsMask) settingsMask.hidden = true;
    renderHistory();
  }
  function closeHistoryPanel() {
    historyPanel.hidden = true;
    if (mainContainer) mainContainer.hidden = false;
  }

  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) {
    return escHtml(s).replace(/'/g, '&#39;');
  }

  /* ---------- MP3 转码 ---------- */
  function floatTo16Slice(input, start, end) {
    var len = end - start;
    var out = new Int16Array(len);
    for (var i = 0; i < len; i++) {
      var s = input[start + i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  function encodeMp3(buffer, kbps, onProgress, isCancelled) {
    return new Promise(function (resolve, reject) {
      var Enc = (typeof lamejs !== 'undefined') && lamejs.Mp3Encoder;
      if (!Enc) { reject(new Error('MP3 编码器未就绪')); return; }
      var channels = buffer.numberOfChannels;
      var sampleRate = buffer.sampleRate;
      var enc;
      try {
        enc = new Enc(channels > 1 ? 2 : 1, sampleRate, kbps);
      } catch (e) { reject(e); return; }
      var leftFloat = buffer.getChannelData(0);
      var rightFloat = channels > 1 ? buffer.getChannelData(1) : null;
      var block = 1152;
      var chunks = [];
      var total = leftFloat.length;
      var i = 0;
      var TARGET_BATCH_MS = 30;
      var blocksPerBatch = 16;
      var MIN_BLOCKS = 4;
      var MAX_BLOCKS = 128;
      var pcmLeft = new Int16Array(block * MAX_BLOCKS);
      var pcmRight = rightFloat ? new Int16Array(block * MAX_BLOCKS) : null;

      var scheduleNext;
      if (typeof MessageChannel !== 'undefined') {
        var mc = new MessageChannel();
        mc.port1.onmessage = function () { processBatch(); };
        scheduleNext = function () { mc.port2.postMessage(null); };
      } else {
        scheduleNext = function () { setTimeout(processBatch, 0); };
      }

      function fillPcm(start, blockCount) {
        for (var c = 0; c < blockCount; c++) {
          var srcIdx = start + c * block;
          var dstIdx = c * block;
          var segLen = Math.min(block, total - srcIdx);
          for (var s = 0; s < segLen; s++) {
            var v = leftFloat[srcIdx + s];
            if (v > 1) v = 1; else if (v < -1) v = -1;
            pcmLeft[dstIdx + s] = v < 0 ? v * 0x8000 : v * 0x7FFF;
          }
          if (pcmRight) {
            for (var s2 = 0; s2 < segLen; s2++) {
              var v2 = rightFloat[srcIdx + s2];
              if (v2 > 1) v2 = 1; else if (v2 < -1) v2 = -1;
              pcmRight[dstIdx + s2] = v2 < 0 ? v2 * 0x8000 : v2 * 0x7FFF;
            }
          }
        }
      }

      function processBatch() {
        try {
          if (isCancelled && isCancelled()) { reject(new Error('已取消')); return; }
          var startTime = performance.now ? performance.now() : Date.now();
          var remaining = total - i;
          if (remaining <= 0) {
            var end = enc.flush();
            if (end && end.length > 0) chunks.push(end);
            if (onProgress) onProgress(1);
            resolve(new Blob(chunks, { type: 'audio/mpeg' }));
            return;
          }
          var batchBlocks = Math.min(blocksPerBatch, Math.ceil(remaining / block));
          fillPcm(i, batchBlocks);
          for (var b = 0; b < batchBlocks; b++) {
            var offset = b * block;
            var srcIdx = i + b * block;
            var segLen = Math.min(block, total - srcIdx);
            var L = pcmLeft.subarray(offset, offset + segLen);
            var d;
            if (pcmRight) {
              d = enc.encodeBuffer(L, pcmRight.subarray(offset, offset + segLen));
            } else {
              d = enc.encodeBuffer(L);
            }
            if (d && d.length > 0) chunks.push(d);
          }
          i += batchBlocks * block;
          var elapsed = (performance.now ? performance.now() : Date.now()) - startTime;
          if (elapsed > 0 && batchBlocks === blocksPerBatch) {
            var factor = Math.max(0.5, Math.min(2, TARGET_BATCH_MS / elapsed));
            blocksPerBatch = Math.max(MIN_BLOCKS, Math.min(MAX_BLOCKS, Math.round(blocksPerBatch * factor)));
          }
          if (onProgress && i - lastTick > sampleRate * 5) {
            lastTick = i;
            onProgress(Math.min(i / total, 1));
          }
          if (i < total) { scheduleNext(); }
          else {
            var end2 = enc.flush();
            if (end2 && end2.length > 0) chunks.push(end2);
            if (onProgress) onProgress(1);
            resolve(new Blob(chunks, { type: 'audio/mpeg' }));
          }
        } catch (e) { reject(e); }
      }

      processBatch();
    });
  }

  function getAudioCtx() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    return Ctor ? new Ctor() : null;
  }

  function decodeAudio(ctx, blob) {
    var toArrayBuffer = function (b) {
      if (b && b.arrayBuffer) return Promise.resolve(b.arrayBuffer());
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error('读取音频数据失败')); };
        fr.readAsArrayBuffer(b);
      });
    };
    return toArrayBuffer(blob).then(function (ab) {
      return new Promise(function (resolve, reject) {
        var ret;
        try {
          ret = ctx.decodeAudioData(ab, function (buf) { if (buf) resolve(buf); }, function (err) {
            reject(err || new Error('音频解码失败'));
          });
        } catch (e) { reject(e); return; }
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
      });
    });
  }

  /* ---------- 多任务管理器 ---------- */
  function createTask(name, badge) {
    taskSeq++;
    var t = {
      id: taskSeq,
      source: JSON.parse(JSON.stringify(current)),
      settings: { qn: Number(qnSelect.value), threads: currentThreads(), enc: encSelect.value || 'auto', format: fmtSelect ? fmtSelect.value : 'mp4', clip: clipInput ? clipInput.value : '', af: afSelect.value, aq: Number(aqSelect.value), danmaku: extraDanmaku ? extraDanmaku.checked : false, subtitle: extraSub ? extraSub.checked : false },
      name: name,
      badge: badge,
      status: 'running',
      cancelled: false,
      cancelFn: null,
      path: null,
      el: null, barEl: null, statusEl: null, noteEl: null, actionsEl: null
    };
    var card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML =
      '<div class="task-head">' +
      '<span class="task-name"></span>' +
      '<span class="task-badge"></span>' +
      '<span class="task-status">准备中</span>' +
      '<button type="button" class="task-pause" hidden>暂停</button>' +
      '<button type="button" class="task-retry" hidden>重试</button>' +
      '<button type="button" class="task-cancel">取消</button>' +
      '</div>' +
      '<div class="task-bar" style="--p:0%"></div>' +
      '<div class="task-note"></div>' +
      '<div class="task-actions"></div>';
    card.querySelector('.task-name').textContent = name;
    card.querySelector('.task-badge').textContent = badge;
    t.el = card;
    t.barEl = card.querySelector('.task-bar');
    t.statusEl = card.querySelector('.task-status');
    t.noteEl = card.querySelector('.task-note');
    t.actionsEl = card.querySelector('.task-actions');
    card.querySelector('.task-cancel').addEventListener('click', function () {
      if (['running', 'paused', 'waiting'].indexOf(t.status) < 0) return;
      if (t.timer) clearTimeout(t.timer);
      t.cancelled = true;
      if (t.cancelFn) t.cancelFn();
      setTaskStatus(t, 'cancelled', '已取消');
      setTaskNote(t, 'warn', '任务已取消');
    });
    t.pauseEl = card.querySelector('.task-pause');
    t.retryEl = card.querySelector('.task-retry');
    t.pauseEl.addEventListener('click', function () {
      var paused = t.status === 'paused';
      t.pauseEl.disabled = true;
      var operation = paused ? window.biliAPI.resumeDownload : window.biliAPI.pauseDownload;
      operation(t.token).then(function (result) {
        if (result.ok && ['running', 'paused'].indexOf(t.status) >= 0) {
          setTaskStatus(t, paused ? 'running' : 'paused', paused ? '继续下载中…' : '已暂停');
          setTaskNote(t, 'warn', paused ? '继续下载剩余分片' : '已完成分片保留，点击继续下载');
        }
      }).catch(function (error) { showToast(error.message, 'fail'); }).finally(function () { t.pauseEl.disabled = false; });
    });
    t.retryEl.addEventListener('click', function () {
      var retry = createTask(t.name, t.badge);
      retry.source = JSON.parse(JSON.stringify(t.source)); retry.settings = Object.assign({}, t.settings);
      retry.type = t.type; retry._part = t._part;
      var prefix = t.source.bvid + ':' + t.source.cid + ':';
      Object.keys(dlCache).forEach(function (key) { if (key.indexOf(prefix) === 0) delete dlCache[key]; });
      saveDlCache(); updateDlCacheCount();
      runTaskByType(retry);
    });
    tasksList.appendChild(card);
    tasksCard.hidden = false;
    // 注册到全局任务列表（进度事件 / 状态遍历依赖此数组）
    tasks.push(t);
    return t;
  }

  /** 任务终态后显示文件操作键（打开 / 所在位置 / 删除），本次使用期间保留 */
  function bindTaskActions(t) {
    if (t.actionsEl) t.actionsEl.innerHTML = '';
    var p = t.path;
    if (!p) return;
    if (!fileActionsAvailable()) return;
    var wrap = document.createElement('div');
    wrap.className = 'task-actions';
    var mk = function (label, cls, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    };
    mk('预览', '', function () { openPreview(p); });
    mk('打开', '', function () { actOpenFile(p); });
    mk('所在位置', '', function () { actOpenFolder(p); });
    mk('删除文件', 'danger', function () { actDeleteFile(p, null, function () { t.actionsEl.innerHTML = ''; }); });
    t.actionsEl.appendChild(wrap);
  }

  function updateTaskControls(t) {
    if (!t.pauseEl) return;
    t.pauseEl.hidden = !(window.biliAPI && window.biliAPI.pauseDownload && t.token && t.phase !== 'merging' && ['running', 'paused'].indexOf(t.status) >= 0);
    t.pauseEl.textContent = t.status === 'paused' ? '继续' : '暂停';
    t.retryEl.hidden = ['error', 'cancelled'].indexOf(t.status) < 0;
    t.el.querySelector('.task-cancel').hidden = ['done', 'error', 'cancelled'].indexOf(t.status) >= 0;
  }
  function setTaskStatus(t, status, text) {
    t.status = status;
    updateTaskControls(t);
    t.statusEl.textContent = text || status;
    t.statusEl.className = 'task-status' +
      (status === 'done' ? ' done' : status === 'error' ? ' error' : status === 'cancelled' ? ' cancelled' : '');
    if (status === 'done' || status === 'error' || status === 'cancelled') {
      // 本次使用期间保留任务记录；有保存路径时展示文件操作键
      if (t.path) bindTaskActions(t);
    }
  }
  function setTaskProgress(t, frac, text, speed) {
    if (t.cancelled || t.status === 'paused') return;
    updateTaskControls(t);
    t.barEl.style.setProperty('--p', Math.max(0, Math.min(100, frac * 100)) + '%');
    if (text) {
      if (speed && speed > 0) {
        text += ' · ' + (speed / 1048576).toFixed(1) + ' MB/s';
      }
      t.statusEl.textContent = text;
    }
  }
  function setTaskNote(t, cls, text) {
    t.noteEl.className = 'task-note' + (cls ? ' ' + cls : '');
    t.noteEl.textContent = text || '';
  }

  /* ---------- 下载执行（多任务并发） ---------- */
  function qnName(qn) {
    var map = { 6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60', 80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K', 125: '杜比视界', 126: '杜比视界', 127: '8K' };
    return map[qn] || '';
  }

  function startDownload() {
    if (!current) return;
    var segBtn = typeSeg.querySelector('.seg-btn.active');
    var type = segBtn ? segBtn.dataset.type : 'video';
    var page = current.pages && current.pages[current.pageIndex];
    var baseName = safeName(current.title) + (page && current.pages.length > 1 ? ' [P' + page.page + ']' : '');
    var t;
    if (type === 'video') {
      t = createTask(baseName + '（视频）', '视频');
    } else {
      t = createTask(baseName + '（音频）', '音频');
    }
    t.type = type;
    var run = function () {
      if (type === 'video') downloadVideo(t);
      else downloadAudio(t);
    };
    // 定时开始（功能9）
    if (timerCheck && timerCheck.checked && timerInput && timerInput.value) {
      var now = new Date();
      var hm = String(timerInput.value).split(':');
      var target = new Date();
      target.setHours(Number(hm[0]), Number(hm[1]), 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      var waitMs = target - now;
      setTaskStatus(t, 'waiting', '等待定时开始（' + timerInput.value + '）');
      setTaskNote(t, 'warn', '已设置定时 ' + timerInput.value + ' 开始下载');
      t.timer = setTimeout(function () { if (!t.cancelled) run(); }, waitMs);
    } else {
      run();
    }
  }

  /** 从 DASH 结果中选择视频档（≤目标 qn 的最高档）与最佳音频档 */
  function pickDash(data, qn, encPref) {
    var vids = (data.dash && data.dash.video) || [];
    var auds = (data.dash && data.dash.audio) || [];
    if (!vids.length) return null;
    // 编码选择：auto=兼容优先（H.264 > H.265 > AV1）；h264/h265/av1=仅指定编码
    // 指定编码不存在时自动顺延到更兼容的编码，并返回实际使用的编码类型
    var codecType = function (c) {
      var s = String(c || '');
      if (s.indexOf('avc1') >= 0) return 'h264';
      if (s.indexOf('hev1') >= 0 || s.indexOf('hvc1') >= 0) return 'h265';
      if (s.indexOf('av01') >= 0) return 'av1';
      return 'other';
    };
    var orderMap = { auto: ['h264', 'h265', 'av1', 'other'], h264: ['h264'], h265: ['h265'], av1: ['av1'] };
    var want = orderMap[encPref] || orderMap.auto;
    var chosen = null;
    var usedCodec = '';
    for (var oi = 0; oi < want.length && !chosen; oi++) {
      var group = [];
      for (var v = 0; v < vids.length; v++) {
        if (codecType(vids[v].codecs) === want[oi]) group.push(vids[v]);
      }
      if (!group.length) continue;
      group.sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
      // 组内取 ≤目标清晰度的最高档；整组都高于目标则取最低档
      var best = group[0];
      for (var gi = 0; gi < group.length; gi++) {
        if (group[gi].id <= qn) best = group[gi];
        else break;
      }
      chosen = best;
      usedCodec = want[oi];
    }
    if (!chosen) return null;
    // 音频：优先 AAC（30216=320k > 30280=192k），其次 FLAC(30232)，杜比类最后
    var aud = null;
    var aRank = function (id) {
      if (id === 30216) return 0;
      if (id === 30280) return 1;
      if (id === 30232) return 2;
      return 3;
    };
    for (var j = 0; j < auds.length; j++) {
      if (!aud) { aud = auds[j]; continue; }
      var ra = aRank(auds[j].id), rb = aRank(aud.id);
      if (ra < rb || (ra === rb && (auds[j].bandwidth || 0) > (aud.bandwidth || 0))) aud = auds[j];
    }
    return { video: chosen, audio: aud, codec: usedCodec };
  }

  function clientStreamDownload(task, urls, filename, meta) {
    task.token = 'stream' + task.id;
    task.cancelFn = function () { window.biliAPI.streamCancel(task.token); };
    updateTaskControls(task);
    return window.biliAPI.streamDownload({ token: task.token, urls: urls, filename: filename, threads: task.settings.threads }).then(function (res) {
      if (task.cancelled) throw new Error('已取消');
      if (!res || !res.ok) throw new Error(res && res.error || '下载失败');
      filename = res.filename || filename;
      task.path = res.path; task.savedFilename = filename;
      setTaskStatus(task, 'done', '已完成');
      setTaskNote(task, 'ok', '已保存：' + filename + '（' + fmtSize(res.size) + '）');
      addHistoryRecord({ filename: filename, path: res.path, size: res.size, type: meta.type, quality: meta.quality });
      showToast('下载完成：' + filename, 'ok');
    }).catch(function (error) { handleTaskError(task, error); });
  }
  function downloadVideo(task) {
    // 先等待高清能力探测完成，避免探测前的点击误走直链降级
    return waitMuxReady().then(function () { return downloadVideoInner(task); });
  }
  function downloadVideoInner(task) {
    var current = task.source;
    if (task.cancelled) return;
    var qn = task.settings.qn;
    var threads = task.settings.threads;
    var encPref = task.settings.enc;
    setTaskStatus(task, 'running', '正在获取视频流…');
    setTaskNote(task, '', '');

    // 高清（>480P）仅存在于 DASH 纯视频流 + 独立音频流；客户端内置 ffmpeg 时可合并下载
    if (muxReady) {
      var dashKey = dlCacheKey(current.bvid, current.cid, 4048, qn, encPref);
      var dCached = getDlCache(dashKey);
      var dashPromise;
      if (dCached && dCached.videoUrl) {
        setTaskNote(task, 'warn', '使用缓存的 DASH 高清地址（' + dCached.qualityName + '）');
        dashPromise = Promise.resolve(dCached);
      } else {
        setTaskStatus(task, 'running', '正在获取高清下载地址…');
        dashPromise = fetchPlayurl(4048, qn, current).then(function (data) {
          if (task.cancelled) throw new Error('已取消');
          var pick = pickDash(data, qn, encPref);
          if (!pick || !pick.video || !pick.video.baseUrl) throw new Error('未获取到 DASH 视频流');
          var vUrl = pick.video.baseUrl || (pick.video.backupUrl && pick.video.backupUrl[0]);
          if (!vUrl) throw new Error('DASH 视频流地址为空');
          var aUrl = pick.audio && (pick.audio.baseUrl || (pick.audio.backupUrl && pick.audio.backupUrl[0]));
          var vUrls = [vUrl];
          if (pick.video.backupUrl && pick.video.backupUrl.length) {
            pick.video.backupUrl.forEach(function (b) { if (b && vUrls.indexOf(b) < 0) vUrls.push(b); });
          }
          var aUrls = [];
          if (aUrl) {
            aUrls.push(aUrl);
            if (pick.audio.backupUrl && pick.audio.backupUrl.length) {
              pick.audio.backupUrl.forEach(function (b) { if (b && aUrls.indexOf(b) < 0) aUrls.push(b); });
            }
          }
          var entry = {
            videoUrl: vUrl,
            videoUrls: vUrls,
            audioUrl: aUrl || '',
            audioUrls: aUrls,
            quality: pick.video.id || 0,
            qualityName: qnName(pick.video.id || 0) || ('档位 ' + (pick.video.id || 0)),
            codecs: pick.video.codecs || '',
            usedCodec: pick.codec || '',
            size: (pick.video.size || 0) + (pick.audio ? (pick.audio.size || 0) : 0),
            t: Date.now()
          };
          setDlCache(dashKey, entry);
          return entry;
        });
      }
      return dashPromise.then(function (entry) {
        if (task.cancelled) throw new Error('已取消');
        var page2 = current.pages && current.pages[current.pageIndex];
        var fmt = task.settings.format === 'mkv' ? 'mkv' : 'mp4';
        var clip = parseClip(task.settings.clip);
        var ext = fmt === 'mkv' ? 'mkv' : 'mp4';
        var part = task._part || (page2 && current.pages.length > 1 ? ' [P' + page2.page + ']' : '');
        var filename = safeName(current.title) + part + '_' + entry.qualityName + '.' + ext;
        var codecTip = '';
        if (entry.codecs && String(entry.codecs).indexOf('avc1') < 0) {
          codecTip = '（编码 ' + (/hev1|hvc1/i.test(entry.codecs) ? 'H.265' : 'AV1') + '，播放器不支持时请用 VLC / PotPlayer）';
        } else if (entry.usedCodec && encPref !== 'auto' && entry.usedCodec !== encPref) {
          codecTip = '（所选编码不可用，已使用 ' + ({ h264: 'H.264', h265: 'H.265', av1: 'AV1' }[entry.usedCodec] || entry.usedCodec) + '）';
        }
        setTaskNote(task, 'warn', '高清（DASH）' + entry.qualityName + (entry.quality < qn ? '，当前账号该清晰度受限' : '') + codecTip + (clip ? '，片段 ' + clipInput.value : ''));
        setTaskStatus(task, 'running', '高清下载中（' + threads + ' 线程，视频流 + 音频流）…');
        task.token = 'mux' + task.id;
        // 多线程并发下载视频流 + 音频流（主进程分段），支持中途取消
        task.cancelFn = function () {
          task.cancelled = true;
          if (window.biliAPI && window.biliAPI.muxCancel) window.biliAPI.muxCancel(task.token);
        };
        window.biliAPI.muxDownload({
          token: task.token,
          videoUrl: entry.videoUrl,
          videoUrls: entry.videoUrls,
          audioUrl: entry.audioUrl,
          audioUrls: entry.audioUrls,
          filename: filename,
          threads: threads,
          format: fmt,
          start: clip ? clip.start : null,
          end: clip ? clip.end : null
        }).then(function (res) {
          if (task.cancelled) throw new Error('已取消');
          if (!res || !res.ok) throw new Error((res && res.error) || '合并失败');
          filename = res.filename || filename;
          task.path = res.path;
          setTaskStatus(task, 'done', '已完成');
          setTaskNote(task, 'ok', '已保存：' + filename + '（' + fmtSize(res.size) + '）');
          showToast('✅ 下载完成：' + filename, 'ok');
          addHistoryRecord({ filename: filename, path: res.path, size: res.size, type: 'video', quality: entry.qualityName });
          downloadExtras(task, filename, page2);
        }).catch(function (err) {
          handleTaskError(task, err);
        });
      }).catch(function (err) {
        handleTaskError(task, err);
      });
      return;
    }
    // 无 ffmpeg 环境（Android/网页）：回落 durl 直链流程
    var cacheKey = dlCacheKey(current.bvid, current.cid, 16, qn);
    var cached = getDlCache(cacheKey);

    var durlPromise;
    if (cached && cached.url) {
      setTaskNote(task, 'warn', '使用缓存的下载地址（' + cached.qualityName + '，' + new Date(cached.t).toLocaleTimeString() + ' 获取）');
      durlPromise = Promise.resolve(cached);
    } else {
      setTaskStatus(task, 'running', '正在获取下载地址…');
      durlPromise = fetchPlayurl(16, qn, current).then(function (data) {
        if (task.cancelled) throw new Error('已取消');
        if (data.durl && data.durl.length) return data;
        // 降级 fnval=1 兼容格式
        return fetchPlayurl(1, qn, current).then(function (d2) {
          if (task.cancelled) throw new Error('已取消');
          if (!(d2.durl && d2.durl.length)) throw new Error('该清晰度暂无可直接下载的 MP4 流，请尝试其他清晰度或使用音频下载');
          d2._degraded = true;
          return d2;
        });
      }).then(function (data) {
        if (task.cancelled) throw new Error('已取消');
        var durl = data.durl && data.durl.length ? data.durl : null;
        var url = durl[0].url || (durl[0].backup_url && durl[0].backup_url[0]);
        if (!url) throw new Error('视频流地址为空');
        var urls = [url];
        if (durl[0].backup_url && durl[0].backup_url.length) {
          durl[0].backup_url.forEach(function (b) { if (b && urls.indexOf(b) < 0) urls.push(b); });
        }
        var entry = {
          url: url,
          urls: urls,
          size: durl[0].size || 0,
          quality: data.quality || 0,
          qualityName: qnName(data.quality || 0) || ('档位 ' + (data.quality || 0)),
          degraded: !!data._degraded,
          t: Date.now()
        };
        setDlCache(cacheKey, entry);
        return entry;
      });
    }

    return durlPromise.then(function (entry) {
      if (task.cancelled) throw new Error('已取消');
      var gotName = entry.qualityName;
      var got = entry.quality || 0;
      setTaskNote(task, 'warn', '服务端实际返回：' + gotName + (got < qn ? '（未登录环境清晰度受限）' : '') + (entry.degraded ? '（已自动切换兼容格式）' : ''));
      var page2 = current.pages && current.pages[current.pageIndex];
      var part = task._part || (page2 && current.pages.length > 1 ? ' [P' + page2.page + ']' : '');
      var filename = safeName(current.title) + part + '_' + gotName + '.mp4';
      var url = entry.url;
      if (IS_ANDROID && window.biliAPI && window.biliAPI.download) {
        // Android：原生流式下载直链（带 Referer/身份，绕开大文件 blob 内存限制）
        setTaskStatus(task, 'running', '开始下载（原生流式）…');
        androidDownload(url, filename, task, { type: 'video', quality: gotName });
        return;
      }
      if (window.biliAPI && window.biliAPI.streamDownload) {
        return clientStreamDownload(task, entry.urls || [entry.url], filename, { type: 'video', quality: gotName }).then(function () {
          if (task.status === 'done') downloadExtras(task, task.savedFilename || filename, page2);
        });
      }
      setTaskStatus(task, 'running', threads + ' 线程下载中（CDN 轮换）');
      var dl = fetchStream(entry.urls || url, function (frac) {
        setTaskProgress(task, frac, threads + ' 线程下载中 ' + (frac * 100).toFixed(1) + '%');
      }, threads, function () { return task.cancelled; });
      task.cancelFn = dl.cancel;
      return dl.promise.then(function (res) {
        if (task.cancelled) throw new Error('已取消');
        setTaskStatus(task, 'done', '下载完成，正在保存…');
        saveBlob(res.blob, filename, task, { type: 'video', quality: gotName });
        setTaskStatus(task, 'done', '已完成');
        setTaskNote(task, 'ok', '已保存：' + filename + '（' + (res.total / 1048576).toFixed(1) + ' MB）');
        showToast('✅ 下载完成：' + filename, 'ok');
        downloadExtras(task, filename, page2);
      });
    }).catch(function (err) {
      handleTaskError(task, err);
    });
  }

  /* ---------- v1.2：附带弹幕 / 字幕下载（功能4） ---------- */
  function fetchSubtitleUrl(current) {
    // 通过代理请求 x/player/v2 取字幕地址（可选；失败返回 null）
    if (!current || !current.bvid || !current.cid) return Promise.resolve(null);
    var params = { bvid: current.bvid, cid: current.cid };
    return wbiSign(params).then(function (signed) {
      var q = Object.keys(signed).map(function (k) { return k + '=' + encodeURIComponent(signed[k]); }).join('&');
      return apiGet('https://api.bilibili.com/x/player/v2?' + q).then(function (j) {
        var subs = (j && j.subtitle && j.subtitle.subtitles) || [];
        return (subs.length && subs[0].subtitle_url) ? subs[0].subtitle_url : null;
      }).catch(function () { return null; });
    }).catch(function () { return Promise.resolve(null); });
  }
  function downloadExtras(task, filename, page) {
    var current = task.source;
    if (!window.biliAPI || !window.biliAPI.fetchDanmaku) return;
    var wantDm = task.settings.danmaku;
    var wantSub = task.settings.subtitle;
    if (!wantDm && !wantSub) return;
    var base = String(filename).replace(/\.[^.]+$/, '');
    var cid = (page && page.cid) ? page.cid : (current ? current.cid : 0);
    if (!cid) return;
    setTaskNote(task, 'warn', '正在下载附带弹幕 / 字幕…');
    var subUrlPromise = wantSub ? fetchSubtitleUrl(current) : Promise.resolve(null);
    subUrlPromise.then(function (subUrl) {
      return window.biliAPI.fetchDanmaku({ cid: cid, filename: base, subUrl: subUrl, danmaku: wantDm });
    }).then(function (r) {
      if (r && r.ok) {
        var parts = [];
        if (r.danmaku) parts.push('弹幕');
        if (r.srt) parts.push('字幕');
        if (parts.length) setTaskNote(task, 'ok', '已附带下载：' + parts.join('、'));
      } else if (r && r.error) {
        setTaskNote(task, 'warn', '附带下载失败：' + r.error);
      }
    }).catch(function () { });
  }

  function downloadAudio(task) {
    var current = task.source;
    if (task.cancelled) return;
    var fmt = task.settings.af;        // m4a（默认原版）/ mp3（转码）
    var aq = task.settings.aq;
    var threads = task.settings.threads;
    setTaskStatus(task, 'running', '正在获取音频流…');
    setTaskNote(task, '', '');

    var cacheKey = dlCacheKey(current.bvid, current.cid, 4048, 0);
    var cached = getDlCache(cacheKey);

    var audioPromise;
    if (cached && cached.url) {
      setTaskNote(task, 'warn', '使用缓存的下载地址（' + cached.bandwidthName + '，' + new Date(cached.t).toLocaleTimeString() + ' 获取）');
      audioPromise = Promise.resolve(cached);
    } else {
      setTaskStatus(task, 'running', '正在获取下载地址…');
      audioPromise = fetchPlayurl(4048, task.settings.qn, current).then(function (data) {
        var dash = data.dash;
        var audio = dash && dash.audio && dash.audio.length ? dash.audio : null;
        if (!audio) throw new Error('未获取到音频流（该视频可能无 DASH 音频）');
        var best = audio[0];
        for (var i = 1; i < audio.length; i++) {
          if ((audio[i].bandwidth || 0) > (best.bandwidth || 0)) best = audio[i];
        }
        var url = best.baseUrl || (best.base_url) || (best.backupUrl && best.backupUrl[0]);
        if (!url) throw new Error('音频流地址为空');
        var urls = [url];
        if (best.backupUrl && best.backupUrl.length) {
          best.backupUrl.forEach(function (b) { if (b && urls.indexOf(b) < 0) urls.push(b); });
        }
        var entry = {
          url: url,
          urls: urls,
          size: 0,
          bandwidth: best.bandwidth || 0,
          bandwidthName: ((best.bandwidth || 0) / 1000 | 0) + 'k',
          t: Date.now()
        };
        setDlCache(cacheKey, entry);
        return entry;
      });
    }

    return audioPromise.then(function (entry) {
      if (task.cancelled) throw new Error('已取消');
      var url = entry.url;
      var page = current.pages && current.pages[current.pageIndex];
      var baseName = safeName(current.title) + (task._part || (page && current.pages.length > 1 ? ' [P' + page.page + ']' : ''));

      if (fmt === 'm4a') {
        var filenameM4a = baseName + '_' + entry.bandwidthName + '.m4a';
        if (IS_ANDROID && window.biliAPI && window.biliAPI.download) {
          setTaskStatus(task, 'running', '开始下载（原生流式）…');
          androidDownload(url, filenameM4a, task, { type: 'audio', quality: entry.bandwidthName });
          return;
        }
        if (window.biliAPI && window.biliAPI.streamDownload) {
          return clientStreamDownload(task, entry.urls || [url], filenameM4a, { type: 'audio', quality: entry.bandwidthName });
        }
        setTaskStatus(task, 'running', threads + ' 线程下载中（CDN 轮换）');
        var dl1 = fetchStream(entry.urls || url, function (frac) {
          setTaskProgress(task, frac, threads + ' 线程下载中 ' + (frac * 100).toFixed(1) + '%');
        }, threads, function () { return task.cancelled; });
        task.cancelFn = dl1.cancel;
        return dl1.promise.then(function (res) {
          if (task.cancelled) throw new Error('已取消');
          setTaskStatus(task, 'done', '下载完成，正在保存…');
          saveBlob(res.blob, filenameM4a, task, { type: 'audio', quality: entry.bandwidthName });
          setTaskStatus(task, 'done', '已完成');
          setTaskNote(task, 'ok', '已保存 M4A 音频：' + filenameM4a + '（' + (res.total / 1048576).toFixed(1) + ' MB）');
          showToast('✅ 音频下载完成：' + filenameM4a, 'ok');
        });
      }

      // MP3：下载 → 解码 → lamejs 转码
      setTaskStatus(task, 'running', threads + ' 线程下载音频源');
      var dl2 = fetchStream(entry.urls || url, function (frac) {
        setTaskProgress(task, frac * 0.55, threads + ' 线程下载音频源 ' + (frac * 100).toFixed(1) + '%');
      }, threads, function () { return task.cancelled; });
      task.cancelFn = dl2.cancel;
      return dl2.promise.then(function (res) {
        if (task.cancelled) throw new Error('已取消');
        setTaskProgress(task, 0.57, '正在解码音频…');
        var ctx = getAudioCtx();
        if (!ctx) throw new Error('当前浏览器不支持 Web Audio 解码');
        return decodeAudio(ctx, res.blob).then(function (buffer) {
          if (task.cancelled) throw new Error('已取消');
          setTaskProgress(task, 0.61, '正在转码 MP3（' + aq + ' Kbps）…');
          return encodeMp3(buffer, aq, function (frac) {
            setTaskProgress(task, 0.61 + frac * 0.38, '转码中 ' + (frac * 100).toFixed(0) + '%');
          }, function () { return task.cancelled; }).then(function (mp3blob) {
            if (ctx.close) { try { ctx.close(); } catch (e) { } }
            if (task.cancelled) throw new Error('已取消');
            var filename = baseName + '_' + aq + 'k.mp3';
            if (IS_ANDROID && window.biliAPI && window.biliAPI.saveStart) {
              setTaskProgress(task, 1, '转码完成，正在保存…');
              androidSaveBlob(mp3blob, filename, task, 0.99, { type: 'audio', quality: aq + 'k' });
              return;
            }
            setTaskProgress(task, 1, '转码完成，正在保存…');
            saveBlob(mp3blob, filename, task, { type: 'audio', quality: aq + 'k' });
            setTaskStatus(task, 'done', '已完成');
            setTaskNote(task, 'ok', '已保存 MP3：' + filename);
            showToast('✅ MP3 转码完成：' + filename, 'ok');
          });
        });
      });
    }).catch(function (err) {
      handleTaskError(task, err);
    });
  }

  /* ---------- v1.2：片段解析（功能15） ---------- */
  function parseClip(raw) {
    if (!raw || !String(raw).trim()) return null;
    var toSec = function (s) {
      var t = String(s).trim().split(':');
      if (t.length === 3) return Number(t[0]) * 3600 + Number(t[1]) * 60 + Number(t[2]);
      if (t.length === 2) return Number(t[0]) * 60 + Number(t[1]);
      return Number(t[0]) || 0;
    };
    var m = String(raw).match(/([\d:]+)\s*[-–~至]\s*([\d:]+)/);
    if (!m) return null;
    var start = toSec(m[1]);
    var end = toSec(m[2]);
    if (isNaN(start) || isNaN(end) || end <= start) return null;
    return { start: start, end: end };
  }

  function handleTaskError(task, err) {
    console.warn('[哔哩下载器] 任务失败：', err);
    if (task.cancelled) { setTaskStatus(task, 'cancelled', '已取消'); return; }
    var msg = err && err.message ? err.message : '下载失败';
    if (/412|访问过于频繁|风控/i.test(msg)) {
      msg = 'B 站风控拦截了本次请求（HTTP 412）。代理已自动换新设备身份重试仍被拦截，通常是因为短时间请求过多，请稍等 1~2 分钟再试。';
    } else if (/已取消|abort|AbortError/i.test(msg)) {
      // 取消后若被后续流程覆盖为 running，恢复为"已取消"状态
      if (task.status === 'running' || task.status === 'error') {
        setTaskStatus(task, 'cancelled', '已取消');
        setTaskNote(task, 'warn', '任务已取消');
      }
      showToast('已取消下载', 'warn');
      return;
    }
    setTaskStatus(task, 'error', '失败');
    setTaskNote(task, 'fail', msg);
    showToast('❌ ' + msg, 'fail');
  }

  /* ---------- 设置：一键修复 ---------- */
  function appendFixLog(text) {
    fixLogs.hidden = false;
    var div = document.createElement('div');
    div.textContent = text;
    fixLogs.appendChild(div);
    fixLogs.scrollTop = fixLogs.scrollHeight;
  }
  function clearFixLogs() {
    fixLogs.innerHTML = '';
    fixLogs.hidden = true;
  }

  function fixProxy() {
    if (fixBtn.disabled) return;
    fixBtn.disabled = true;
    clearFixLogs();
    appendFixLog('开始一键修复…');
    fixBtn.textContent = '修复中…';

    fetch(proxyBase() + '/fix', { method: 'POST', credentials: 'omit' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        var logs = res.j && res.j.logs ? res.j.logs : [];
        logs.forEach(appendFixLog);
        if (res.status !== 200 || !res.j || !res.j.ok) {
          throw new Error(res.j && res.j.error ? res.j.error : '修复失败');
        }
        appendFixLog('✅ 修复完成，正在重新检测代理…');
        return checkProxy();
      })
      .catch(function (err) {
        // 代理本身不可达：客户端版走 IPC 重启内置代理
        if (window.biliAPI && window.biliAPI.restartProxy) {
          appendFixLog('本地代理无响应，尝试通过客户端重启内置代理…');
          return window.biliAPI.restartProxy().then(function (r2) {
            if (r2 && r2.ok) {
              appendFixLog('✅ 已重启内置代理（端口 ' + r2.port + '）');
              return checkProxy();
            }
            throw new Error(r2 && r2.error ? r2.error : '重启失败');
          });
        }
        throw err;
      })
      .catch(function (err2) {
        appendFixLog('❌ 修复失败：' + (err2 && err2.message ? err2.message : '未知错误'));
        if (!window.biliAPI) {
          appendFixLog('（网页版）请确认已运行 start-server.bat 且端口未被占用。');
        }
        updateProxyUi(false);
      })
      .then(function () {
        fixBtn.disabled = false;
        fixBtn.textContent = '🔧 一键修复（无法获取代理时）';
      });
  }

  /* ---------- 设置：登录 ---------- */
  /* ---------- 登录状态 ---------- */
  var currentUid = null;   // 当前登录 UID（用于下载地址缓存隔离）

  function renderLoginState(info) {
    var logged = !!(info && info.logged);
    var uid = info && info.uid ? String(info.uid) : '';
    if (currentUid !== null && uid !== currentUid) {
      // 登录 / 退出切换：清空下载地址缓存，避免复用旧账号（或未登录）的低清直链
      clearDlCache();
      updateDlCacheCount();
    }
    currentUid = uid;
    if (loginStateEl) {
      loginStateEl.textContent = logged ? ('已登录（UID ' + (info.uid || '') + '）') : '未登录';
      loginStateEl.className = 'login-state' + (logged ? ' logged' : '');
    }
    if (loginBadge) {
      loginBadge.textContent = logged ? '已登录' : '未登录';
      loginBadge.className = 'login-badge' + (logged ? ' on' : '');
    }
    if (loginBtn) loginBtn.hidden = logged;
    if (logoutBtn) logoutBtn.hidden = !logged;
    if (cookieRow && !window.biliAPI) cookieRow.hidden = false;
  }

  function refreshLoginState() {
    var q;
    if (window.biliAPI && window.biliAPI.loginState) {
      q = window.biliAPI.loginState().catch(function () { return null; });
    } else {
      q = fetch(proxyBase() + '/login-cookies', { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (j) { return j.login; })
        .catch(function () { return null; });
    }
    return q.then(renderLoginState);
  }

  function doLogin() {
    if (window.biliAPI && window.biliAPI.login) {
      if (loginBtn.disabled) return;
      loginBtn.disabled = true;
      loginNote.textContent = '正在打开登录窗口，请在弹出的窗口中扫码或账号登录…';
      window.biliAPI.login().then(function (res) {
        loginBtn.disabled = false;
        if (res && res.ok) {
          loginNote.className = 'set-note';
          loginNote.textContent = '✅ 登录成功（UID ' + res.uid + '），已解锁更高清晰度；旧下载地址缓存已清除，请重新选择清晰度下载';
          refreshLoginState();
        } else {
          loginNote.className = 'set-note';
          loginNote.textContent = (res && res.error ? res.error : '登录未完成') + '，可重试';
        }
      }).catch(function (e) {
        loginBtn.disabled = false;
        loginNote.textContent = '登录失败：' + (e && e.message ? e.message : '未知错误');
      });
    } else {
      // 网页版 / Android：提示粘贴 Cookie
      loginNote.textContent = IS_ANDROID
        ? 'Android 版请在手机浏览器登录 B 站后，复制 Cookie（需含 SESSDATA）粘贴到上方输入框并保存，可解锁更高清晰度'
        : '网页版请在浏览器登录 B 站后，从开发者工具复制 Cookie（需含 SESSDATA）粘贴到上方输入框并保存';
      cookieRow.hidden = false;
    }
  }

  function doLogout() {
    var q;
    if (IS_ANDROID && window.biliAPI && window.biliAPI.clearCookies) {
      window.biliAPI.clearCookies();
      q = Promise.resolve({ ok: true });
    } else if (window.biliAPI && window.biliAPI.logout) {
      q = window.biliAPI.logout();
    } else {
      q = fetch(proxyBase() + '/login-logout', { credentials: 'omit' }).then(function () { return { ok: true }; });
    }
    q.then(function () {
      loginNote.textContent = '已退出登录';
      refreshLoginState();
    }).catch(function () { loginNote.textContent = '退出失败'; });
  }

  function saveCookiesFromInput() {
    var raw = cookieInput.value.trim();
    var map = {};
    raw.split(/[;\n]/).forEach(function (seg) {
      var i = seg.indexOf('=');
      if (i > 0) {
        var k = seg.slice(0, i).trim();
        var v = seg.slice(i + 1).trim();
        if (k) map[k] = v;
      }
    });
    if (!map.SESSDATA) {
      loginNote.textContent = 'Cookie 中未找到 SESSDATA，请复制完整 Cookie（含 SESSDATA=…）';
      return;
    }
    if (IS_ANDROID && window.biliAPI && window.biliAPI.setCookies) {
      // Android：拦截层无法读取 POST body，改用原生桥直存
      try {
        window.biliAPI.setCookies(JSON.stringify(map));
        loginNote.textContent = '✅ 已保存登录 Cookie，可解锁更高清晰度';
        refreshLoginState();
      } catch (e) {
        loginNote.textContent = '保存失败：' + (e && e.message ? e.message : '未知错误');
      }
      return;
    }
    fetch(proxyBase() + '/login-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: map }),
      credentials: 'omit'
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) {
        loginNote.textContent = '✅ 已保存登录 Cookie，可解锁更高清晰度；旧下载地址缓存已清除';
        refreshLoginState();
      } else {
        loginNote.textContent = '保存失败';
      }
    }).catch(function () { loginNote.textContent = '代理未连接，无法保存 Cookie'; });
  }

  /* ---------- 事件绑定 ---------- */
  inputEl.addEventListener('input', function () {
    var v = inputEl.value.trim();
    clearBtn.hidden = !v;
    if (v.length >= 4) {
      debounceParse(v);
    } else {
      clearTimeout(debounceTimer);
      setFinderState('');
      setStatus('', '');
      resultEl.hidden = true;
      current = null;
    }
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && inputEl.value.trim()) {
      clearTimeout(debounceTimer);
      startParse(inputEl.value.trim());
    }
  });
  clearBtn.addEventListener('click', function () {
    inputEl.value = '';
    clearBtn.hidden = true;
    clearTimeout(debounceTimer);
    setFinderState('');
    setStatus('', '');
    resultEl.hidden = true;
    current = null;
    inputEl.focus();
  });

  var debounceTimer = null;
  function debounceParse(v) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { startParse(v); }, 800);
  }

  typeSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn) return;
    typeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    var type = btn.dataset.type;
    optVideo.hidden = type !== 'video';
    optEnc.hidden = type !== 'video' || IS_ANDROID;
    optAudio.hidden = type !== 'audio';
    optAq.hidden = !(type === 'audio' && afSelect.value === 'mp3');
    ['opt-format', 'opt-clip', 'opt-extra'].forEach(function (id) { var element = $(id); if (element) element.hidden = type !== 'video' || IS_ANDROID; });
  });
  afSelect.addEventListener('change', function () {
    optAq.hidden = afSelect.value !== 'mp3';
  });
  if (IS_ANDROID && optEnc) optEnc.hidden = true;

  var QNS = [[120, '4K 超清'], [112, '1080P 高码率'], [80, '1080P 高清'], [64, '720P 高清'], [32, '480P 清晰'], [16, '360P 流畅']];
  fillQnOptions();

  dlBtn.addEventListener('click', startDownload);

  /* ---------- 首次使用说明弹窗（仅首次打开显示，重点加粗） ---------- */
  (function () {
    var GUIDE_KEY = 'bili_guide_seen_v2';
    var gModal = $('guide-modal');
    var gOk = $('guide-ok');
    if (!gModal || !gOk) return;
    var seen = false;
    try { seen = localStorage.getItem(GUIDE_KEY) === '1'; } catch (e) { }
    if (seen) return;
    var show = function () {
      gModal.hidden = false;
      try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { }
    };
    gOk.addEventListener('click', function () { gModal.hidden = true; });
    // 页面就绪后稍作延迟弹出，保证视觉醒目
    setTimeout(show, 350);
  })();

  // 设置面板
  function openSettings() {
    settingsPanel.hidden = false;
    settingsMask.hidden = false;
    refreshLoginState();
    updateDlCacheCount();
    refreshDlDir();
    checkProxy();
  }
  function closeSettings() {
    settingsPanel.hidden = true;
    settingsMask.hidden = true;
  }
  settingsBtn.addEventListener('click', openSettings);
  settingsClose.addEventListener('click', closeSettings);
  settingsMask.addEventListener('click', closeSettings);
  // ESC 关闭设置面板 / 记录页
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !settingsPanel.hidden) closeSettings();
    if (e.key === 'Escape' && !historyPanel.hidden) closeHistoryPanel();
    if (e.key === 'Escape' && !batchPanel.hidden) closeBatchPanel();
  });

  /* ---------- 下载记录页 ---------- */
  historyBtn.addEventListener('click', openHistoryPanel);
  historyBack.addEventListener('click', closeHistoryPanel);
  if (tasksClearDone) {
    tasksClearDone.addEventListener('click', function () {
      var done = tasks.filter(function (t) { return ['done', 'error', 'cancelled'].indexOf(t.status) >= 0; });
      if (!done.length) { showToast('暂无已完成的任务', 'warn'); return; }
      done.forEach(function (t) { try { t.el.remove(); } catch (e) { } });
      tasks = tasks.filter(function (t) { return ['done', 'error', 'cancelled'].indexOf(t.status) < 0; });
      tasksCard.hidden = tasks.length === 0;
      showToast('✅ 已清除 ' + done.length + ' 条已完成任务', 'ok');
    });
  }
  var historyClearBtn = $('history-clear');
  if (historyClearBtn) {
    historyClearBtn.addEventListener('click', function () {
      if (!confirm('确定要清空全部历史下载记录吗？\n（仅清除记录列表，不会删除已下载的文件）')) return;
      var doClear = function () {
        if (window.biliAPI && window.biliAPI.clearHistory) {
          window.biliAPI.clearHistory().then(function (r) {
            if (r && r.ok) {
              showToast('✅ 历史记录已清空', 'ok');
              renderHistory();
            } else {
              showToast('❌ ' + ((r && r.error) || '清空失败'), 'fail');
            }
          }).catch(function () { showToast('❌ 清空失败', 'fail'); });
        } else {
          histClearLocal();
          showToast('✅ 历史记录已清空', 'ok');
          renderHistory();
        }
      };
      doClear();
    });
  }

  /* ---------- v1.2：主题 / 语言 / 限速 / 缓存锁定（优化10 · 功能11 · 功能14） ---------- */
  var I18N = {
    zh: { appTitle: '哔哩下载器 · Dom', download: '下载', video: '视频', audio: '音频', settings: '设置', history: '下载记录', threads: '线程数', quality: '清晰度', codec: '编码', format: '封装', clip: '片段', timer: '定时', extras: '附带', export: '导出信息', all: '下载全部 P / 集' },
    en: { appTitle: 'Bili Downloader · Dom', download: 'Download', video: 'Video', audio: 'Audio', settings: 'Settings', history: 'History', threads: 'Threads', quality: 'Quality', codec: 'Codec', format: 'Container', clip: 'Clip', timer: 'Timer', extras: 'Extras', export: 'Export Info', all: 'Download All P' }
  };
  var I18N_KEYS = { 'app-title': 'appTitle', 'dl-btn-text': 'download', 'type-seg': null };
  function applyLang(lang) {
    var d = I18N[lang] || I18N.zh;
    var t = $('app-title');
    if (t) t.textContent = d.appTitle;
    document.title = d.appTitle;
    if (dlBtnText) dlBtnText.textContent = d.download;
    try { localStorage.setItem('bili_lang', lang); } catch (e) { }
    showToast('语言已切换：' + (lang === 'en' ? 'English' : '中文'), 'ok');
  }
  var dlBtnText = $('dl-btn-text');
  function loadPrefs() {
    try {
      var th = localStorage.getItem('bili_theme');
      if (th) document.documentElement.setAttribute('data-theme', th);
      var lg = localStorage.getItem('bili_lang');
      if (lg && langSelect) { langSelect.value = lg; applyLang(lg); }
      if (rateLimitInput) {
        var rl = localStorage.getItem('bili_rate_kbps');
        if (rl) { rateLimitInput.value = rl; if (window.biliAPI && window.biliAPI.setRateLimit) window.biliAPI.setRateLimit(Number(rl) || 0); }
      }
      if (cacheLock) {
        cacheLock.checked = localStorage.getItem('bili_cache_lock') === '1';
        if (cacheLock.checked) DL_CACHE_TTL = Infinity;
      }
      var fm = localStorage.getItem('bili_fmt');
      if (fm && fmtSelect) fmtSelect.value = fm;
      var th2 = localStorage.getItem('bili_theme');
      if (th2 && themeSelect) themeSelect.value = th2;
    } catch (e) { }
  }
  if (themeSelect) {
    themeSelect.addEventListener('change', function () {
      document.documentElement.setAttribute('data-theme', themeSelect.value);
      try { localStorage.setItem('bili_theme', themeSelect.value); } catch (e) { }
      showToast('外观已切换', 'ok');
    });
  }
  if (langSelect) {
    langSelect.addEventListener('change', function () { applyLang(langSelect.value); });
  }
  if (rateLimitInput) {
    rateLimitInput.addEventListener('change', function () {
      var v = Math.max(0, Number(rateLimitInput.value) || 0);
      try { localStorage.setItem('bili_rate_kbps', String(v)); } catch (e) { }
      if (window.biliAPI && window.biliAPI.setRateLimit) {
        window.biliAPI.setRateLimit(v).then(function (r) { showToast(r && r.ok ? '✅ 限速已设置' : '❌ 设置失败', r && r.ok ? 'ok' : 'fail'); });
      } else {
        showToast('限速仅客户端版支持', 'warn');
      }
    });
  }
  if (cacheLock) {
    cacheLock.addEventListener('change', function () {
      DL_CACHE_TTL = cacheLock.checked ? Infinity : 6 * 3600e3;
      try { localStorage.setItem('bili_cache_lock', cacheLock.checked ? '1' : '0'); } catch (e) { }
      showToast(cacheLock.checked ? '✅ 地址缓存已锁定' : '缓存恢复 6 小时过期', 'ok');
    });
  }
  if (fmtSelect) {
    fmtSelect.addEventListener('change', function () {
      try { localStorage.setItem('bili_fmt', fmtSelect.value); } catch (e) { }
    });
  }

  /* ---------- v1.2：播放器预览（功能13） ---------- */
  function openPreview(path) {
    if (!playerModal || !playerVideo) return;
    if (!path) { showToast('暂无文件可预览', 'warn'); return; }
    playerVideo.pause();
    playerVideo.removeAttribute('src');
    playerVideo.load();
    // file:// 本地路径（Windows 客户端）；其他平台禁用
    playerVideo.src = 'file:///' + String(path).replace(/\\/g, '/').replace(/^\/+/, '');
    playerModal.hidden = false;
    if (playerTitle) playerTitle.textContent = '预览：' + String(path).split(/[\\/]/).pop();
    playerVideo.play().catch(function () { });
  }
  if (playerClose) playerClose.addEventListener('click', function () {
    playerModal.hidden = true;
    playerVideo.pause();
  });
  if (playerModal) playerModal.addEventListener('click', function (e) {
    if (e.target === playerModal) { playerModal.hidden = true; playerVideo.pause(); }
  });

  /* ---------- v1.3：批量下载独立界面 ---------- */
  function runTaskByType(t) {
    var type = t.type || 'video';
    if (type === 'audio') return downloadAudio(t);
    return downloadVideo(t);
  }
  // 打开批量下载面板（替换主界面），列出全部任务供预览，点击「开始」后顺序执行
  function openBatchPanel() {
    if (!current) return;
    var isSeason = current.kind === 'bangumi';
    var list = isSeason ? (current.episodes || []) : (current.pages || []);
    if (!list.length) { showToast('无可批量下载的 P / 集', 'warn'); return; }
    batchData = { list: list, isSeason: isSeason };
    var sub = (isSeason ? '番剧 ' : '分P / 收藏夹 ') + list.length + ' 个任务，将按顺序逐个下载。批量下载不支持片段裁剪与附带弹幕/字幕。';
    if (batchSub) batchSub.textContent = sub;
    // 同步当前全局清晰度/线程等选项到批量面板
    if (batchQn) {
      batchQn.innerHTML = qnSelect.innerHTML;
      if (qnSelect.value) batchQn.value = qnSelect.value;
    }
    if (batchEnc && encSelect) batchEnc.value = encSelect.value || 'auto';
    if (batchAf && afSelect) batchAf.value = afSelect.value || 'm4a';
    if (batchAq && aqSelect) batchAq.value = aqSelect.value || '192';
    if (batchThread && threadSelect) batchThread.value = threadSelect.value || '8';
    // 渲染任务列表（当前全部待下载）
    renderBatchList(list.map(function () { return { status: 'queued' }; }));
    batchStarted = false;
    if (batchStart) { batchStart.disabled = false; batchStart.textContent = '开始批量下载'; }
    batchPanel.hidden = false;
    if (mainContainer) mainContainer.hidden = true;
    if (settingsPanel) settingsPanel.hidden = true;
    if (settingsMask) settingsMask.hidden = true;
  }
  function closeBatchPanel() {
    batchPanel.hidden = true;
    if (mainContainer) mainContainer.hidden = false;
  }
  function renderBatchList(states) {
    if (!batchList) return;
    batchList.innerHTML = '';
    var list = batchData.list;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var label = batchData.isSeason ? (p.long_title || p.title || '') : ('P' + p.page + ' · ' + p.part);
      var row = document.createElement('div');
      row.className = 'batch-item';
      var name = document.createElement('div');
      name.className = 'batch-item-name';
      name.textContent = label;
      name.title = label;
      var st = document.createElement('div');
      st.className = 'batch-item-state ' + (states[i] ? states[i].status : 'queued');
      var map = { queued: '待下载', running: '下载中…', done: '✅ 完成', error: '❌ 失败', cancelled: '已取消' };
      var key = (states[i] && states[i].status) || 'queued';
      st.textContent = map[key] || key;
      row.appendChild(name);
      row.appendChild(st);
      batchList.appendChild(row);
    }
  }
  // 批量开始：把面板选项同步到全局，再顺序执行
  function startBatch() {
    if (!batchData || batchStarted || batchActive) return;
    var type = (batchTypeSeg.querySelector('.seg-btn.active') || { dataset: { type: 'video' } }).dataset.type || 'video';
    // 同步批量面板选项 → 全局（下载逻辑读取全局控件）
    if (batchQn && qnSelect && type === 'video') qnSelect.value = batchQn.value;
    if (batchEnc && encSelect) encSelect.value = batchEnc.value;
    if (batchAf && afSelect) afSelect.value = batchAf.value;
    if (batchAq && aqSelect) aqSelect.value = batchAq.value;
    if (batchThread && threadSelect) threadSelect.value = batchThread.value;
    if (batchFmt && fmtSelect) fmtSelect.value = batchFmt.value;
    // 类型 seg 同步
    typeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-type') === type);
    });
    optVideo.hidden = type !== 'video';
    optEnc.hidden = type !== 'video' || IS_ANDROID;
    optAudio.hidden = type !== 'audio';
    optAq.hidden = !(type === 'audio' && afSelect.value === 'mp3');
    ['opt-clip', 'opt-extra'].forEach(function (id) { var element = $(id); if (element) element.hidden = type !== 'video' || IS_ANDROID; });

    batchActive = true;
    batchStarted = true;
    if (batchStart) batchStart.disabled = true;
    var list = batchData.list;
    var n = list.length;
    var snap = { bvid: current.bvid, aid: current.aid, cid: current.cid, pageIndex: current.pageIndex };
    var states = list.map(function () { return { status: 'queued' }; });
    renderBatchList(states);
    showToast('⏳ 开始批量下载 ' + n + ' 个任务（顺序执行）', 'warn');
    var i = 0;
    var waitDone = function (t, rowIdx, cb) {
      if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') { cb(); return; }
      var iv = setInterval(function () {
        if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
          clearInterval(iv);
          states[rowIdx] = { status: t.status };
          renderBatchList(states);
          cb();
        }
      }, 300);
    };
    var next = function () {
      if (i >= n) {
        current.bvid = snap.bvid; current.aid = snap.aid; current.cid = snap.cid; current.pageIndex = snap.pageIndex;
        batchActive = false;
        if (batchStart) { batchStart.disabled = false; batchStart.textContent = '全部完成，可返回重新下载'; }
        showToast('✅ 批量下载完成（' + n + ' 个任务）', 'ok');
        return;
      }
      var p = list[i];
      var rowIdx = i;
      i++;
      current.bvid = p.bvid || snap.bvid;
      current.aid = p.aid || snap.aid;
      current.cid = p.cid;
      current.pageIndex = rowIdx;
      var label = batchData.isSeason ? (p.long_title || p.title || '') : ('P' + p.page + ' · ' + p.part);
      var t = createTask(safeName(current.title) + ' [' + label + ']', batchData.isSeason ? '番剧' : '分P');
      t.type = type;
      t._part = ' [' + label + ']';
      t.settings.clip = '';            // 批量不支持片段裁剪
      t.settings.danmaku = false;      // 批量界面无附带选项
      t.settings.subtitle = false;
      t.settings.format = fmtSelect ? fmtSelect.value : 'mp4';
      states[rowIdx] = { status: 'running' };
      renderBatchList(states);
      try {
        runTaskByType(t);
      } catch (e) {
        setTaskStatus(t, 'error', '启动失败');
        setTaskNote(t, 'fail', e && e.message ? e.message : '未知错误');
      }
      waitDone(t, rowIdx, next);
    };
    next();
  }
  if (btnAll) {
    btnAll.addEventListener('click', openBatchPanel);
  }
  if (batchStart) batchStart.addEventListener('click', startBatch);
  if (batchBack) batchBack.addEventListener('click', function () {
    if (batchActive) { showToast('批量下载仍在进行，返回后任务会继续在下载任务列表显示', 'warn'); }
    closeBatchPanel();
  });
  // 批量面板：类型切换显示对应选项
  if (batchTypeSeg) {
    batchTypeSeg.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn) return;
      batchTypeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      var type = btn.dataset.type;
      var v = $('batch-opt-video'), en = $('batch-opt-enc'), fm = $('batch-opt-format'), au = $('batch-opt-audio'), aq = $('batch-opt-aq');
      if (v) v.hidden = type !== 'video';
      if (en) en.hidden = type !== 'video' || IS_ANDROID;
      if (fm) fm.hidden = type !== 'video' || IS_ANDROID;
      if (au) au.hidden = type !== 'audio';
      if (aq) aq.hidden = !(type === 'audio' && batchAf.value === 'mp3');
    });
    if (batchAf) {
      batchAf.addEventListener('change', function () {
        var aq = $('batch-opt-aq');
        if (aq) aq.hidden = batchAf.value !== 'mp3';
      });
    }
  }

  /* ---------- v1.2：导出信息（功能5 · 功能18） ---------- */
  function exportVideoInfo() {
    if (!current) { showToast('请先解析视频', 'warn'); return; }
    var page = current.pages && current.pages[current.pageIndex];
    var info = {
      title: current.title,
      bvid: current.bvid,
      aid: current.aid,
      up: current.up,
      duration: current.duration,
      views: (current.stat && current.stat.view) || 0,
      danmaku: (current.stat && current.stat.danmaku) || 0,
      likes: (current.stat && current.stat.like) || 0,
      pubdate: current.pubdate,
      page: page ? page.page : 1,
      part: page ? page.part : '',
      exportTime: new Date().toISOString(),
      summary: '《' + current.title + '》由 UP 主 ' + current.up + ' 发布于 ' + (current.pubdate ? new Date(current.pubdate * 1000).toLocaleDateString('zh-CN') : '未知') + '，时长 ' + fmtDur(current.duration) + '，播放量 ' + fmtCount((current.stat && current.stat.view) || 0) + '，弹幕 ' + fmtCount((current.stat && current.stat.danmaku) || 0) + '。'
    };
    var fn = safeName(current.title) + '_info';
    if (window.biliAPI && window.biliAPI.exportInfo) {
      window.biliAPI.exportInfo({ filename: fn, info: info, coverUrl: current.pic }).then(function (r) {
        if (r && r.ok) showToast('✅ 已导出信息' + (r.cover ? ' + 封面' : '') + '：' + r.json, 'ok');
        else showToast('❌ ' + ((r && r.error) || '导出失败'), 'fail');
      }).catch(function () { showToast('❌ 导出失败', 'fail'); });
    } else {
      // 网页版：下载 JSON
      saveBlob(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }), fn + '.json', null, {});
      showToast('✅ 已导出信息 JSON', 'ok');
    }
  }
  if (btnExport) btnExport.addEventListener('click', exportVideoInfo);

  /* ---------- v1.2：代理测速（功能7） ---------- */
  if (speedtestBtn) {
    speedtestBtn.addEventListener('click', function () {
      speedtestBtn.disabled = true;
      speedtestBtn.textContent = '测速中…';
      var p = proxyBase();
      var t0 = Date.now();
      fetch(p + '/status', { credentials: 'omit' }).then(function (r) { return r.json(); }).then(function () {
        var ms = Date.now() - t0;
        showToast('✅ 代理延迟：' + ms + ' ms', 'ok');
      }).catch(function () {
        showToast('❌ 代理不可达', 'fail');
      }).finally(function () {
        speedtestBtn.disabled = false;
        speedtestBtn.textContent = '⚡ 代理测速';
      });
    });
  }

  /* ---------- v1.2：收藏夹（功能10，登录后可用） ---------- */
  if (favBtn) {
    favBtn.addEventListener('click', function () {
      favList.innerHTML = '<div class="fav-loading">读取中…</div>';
      var uid = null;
      fetch(proxyBase() + '/login-cookies', { credentials: 'omit' }).then(function (r) { return r.json(); })
        .then(function (j) {
          var lg = (j && j.login) || {};
          if (!lg.logged || !lg.uid) throw new Error('请先登录（设置 → 登录哔哩哔哩）');
          uid = lg.uid;
          var u = proxyBase() + '/api?url=' + encodeURIComponent('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + uid);
          return fetch(u, { credentials: 'omit' });
        }).then(function (r) { return r.json(); })
        .then(function (j) {
          var list = (j && j.data && j.data.list) || [];
          if (j && j.code && j.code !== 0) throw new Error('B 站返回：' + (j.message || j.code));
          if (!list.length) throw new Error('暂无收藏夹');
          favList.innerHTML = '';
          list.slice(0, 10).forEach(function (f) {
            var row = document.createElement('div');
            row.className = 'fav-item';
            // 收藏夹网址（功能：显示并一键复制）
            var favUrl = 'https://space.bilibili.com/' + uid + '/favlist?fid=' + f.id;
            var head = document.createElement('div');
            head.className = 'fav-head';
            head.innerHTML = '<span class="fav-title"></span>';
            head.querySelector('.fav-title').textContent = f.title + '（' + f.media_count + '）';
            row.appendChild(head);
            var urlRow = document.createElement('div');
            urlRow.className = 'fav-url';
            var a = document.createElement('span');
            a.textContent = favUrl;
            a.title = favUrl;
            var cp = document.createElement('button');
            cp.type = 'button';
            cp.className = 'mini-btn';
            cp.textContent = '复制网址';
            cp.addEventListener('click', function (ev) {
              ev.stopPropagation();
              copyText(favUrl);
            });
            urlRow.appendChild(a);
            urlRow.appendChild(cp);
            row.appendChild(urlRow);
            row.title = '点击下载其中前 20 个视频';
            row.addEventListener('click', function () { loadFavVideos(f.id, f.title); });
            favList.appendChild(row);
          });
          if (favNote) favNote.textContent = '共 ' + list.length + ' 个收藏夹，点击条目加载视频（前 10 个显示），点「复制网址」可复制收藏夹链接';
        }).catch(function (e) {
          favList.innerHTML = '<div class="fav-loading" style="color:#c0392b">' + escHtml(e.message) + '</div>';
        });
    });
  }
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { showToast('✅ 网址已复制', 'ok'); }).catch(function () { fallbackCopy(txt); });
    } else {
      fallbackCopy(txt);
    }
  }
  function fallbackCopy(txt) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✅ 网址已复制', 'ok');
    } catch (e) {
      showToast('复制失败，请手动复制', 'fail');
    }
  }
  function loadFavVideos(mediaId, name) {
    favList.innerHTML = '<div class="fav-loading">加载收藏夹视频…</div>';
    var u = proxyBase() + '/api?url=' + encodeURIComponent('https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + mediaId + '&pn=1&ps=20');
    fetch(u, { credentials: 'omit' }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code && j.code !== 0) throw new Error('B 站返回：' + (j.message || j.code));
        var list = (j && j.data && j.data.medias) || [];
        if (!list.length) throw new Error('该收藏夹暂无视频');
        favList.innerHTML = '';
        list.forEach(function (m) {
          var row = document.createElement('div');
          row.className = 'fav-item';
          var bvid = m.bvid;
          row.textContent = m.title;
          row.title = '点击解析并下载';
          row.addEventListener('click', function () {
            inputEl.value = bvid;
            parseUrl();
          });
          favList.appendChild(row);
        });
        if (favNote) favNote.textContent = '收藏夹「' + name + '」前 20 个视频，点击解析下载';
      }).catch(function (e) {
        favList.innerHTML = '<div class="fav-loading" style="color:#c0392b">' + escHtml(e.message) + '</div>';
      });
  }

  /* ---------- v1.2：设置导出 / 导入（功能12） ---------- */
  function collectSettings() {
    return {
      proxyMode: proxyModeSelect ? proxyModeSelect.value : '',
      customProxy: customProxyInput ? customProxyInput.value : '',
      threads: threadSelect ? threadSelect.value : '',
      fmt: fmtSelect ? fmtSelect.value : '',
      lang: langSelect ? langSelect.value : '',
      theme: themeSelect ? themeSelect.value : '',
      rateKbps: rateLimitInput ? rateLimitInput.value : '',
      cacheLock: cacheLock ? cacheLock.checked : false
    };
  }
  if (setExport) {
    setExport.addEventListener('click', function () {
      var s = collectSettings();
      if (window.biliAPI && window.biliAPI.exportSettings) {
        window.biliAPI.exportSettings(s).then(function (r) {
          if (r && r.ok) showToast('✅ 设置已导出：' + r.path, 'ok');
          else if (r && r.canceled) { }
          else showToast('❌ 导出失败', 'fail');
        }).catch(function () { showToast('❌ 导出失败', 'fail'); });
      } else {
        saveBlob(new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }), 'bili-settings.json', null, {});
      }
    });
  }
  // 开源声明：点击 GitHub 仓库链接用系统浏览器打开
  var githubLink = $('github-link');
  if (githubLink) {
    githubLink.addEventListener('click', function () {
      var url = 'https://github.com/GenshinplayerDom/bilibili-downloader';
      if (window.biliAPI && window.biliAPI.openExternal) {
        window.biliAPI.openExternal(url).then(function (ok) {
          if (!ok) window.open(url, '_blank');
        }).catch(function () { window.open(url, '_blank'); });
      } else {
        window.open(url, '_blank');
      }
    });
  }
  if (setImport) {
    setImport.addEventListener('click', function () {
      var apply = function (s) {
        if (!s) return;
        if (proxyModeSelect && s.proxyMode) proxyModeSelect.value = s.proxyMode;
        if (customProxyInput && s.customProxy) customProxyInput.value = s.customProxy;
        if (threadSelect && s.threads) threadSelect.value = s.threads;
        if (fmtSelect && s.fmt) { fmtSelect.value = s.fmt; try { localStorage.setItem('bili_fmt', s.fmt); } catch (e) { } }
        if (langSelect && s.lang) { langSelect.value = s.lang; applyLang(s.lang); }
        if (themeSelect && s.theme) { themeSelect.value = s.theme; document.documentElement.setAttribute('data-theme', s.theme); try { localStorage.setItem('bili_theme', s.theme); } catch (e) { } }
        if (rateLimitInput && s.rateKbps) {
          rateLimitInput.value = s.rateKbps;
          try { localStorage.setItem('bili_rate_kbps', s.rateKbps); } catch (e) { }
          if (window.biliAPI && window.biliAPI.setRateLimit) window.biliAPI.setRateLimit(Number(s.rateKbps) || 0);
        }
        if (cacheLock && typeof s.cacheLock === 'boolean') {
          cacheLock.checked = s.cacheLock;
          DL_CACHE_TTL = s.cacheLock ? Infinity : 6 * 3600e3;
          try { localStorage.setItem('bili_cache_lock', s.cacheLock ? '1' : '0'); } catch (e) { }
        }
        showToast('✅ 设置已导入', 'ok');
      };
      if (window.biliAPI && window.biliAPI.importSettings) {
        window.biliAPI.importSettings().then(function (r) {
          if (r && r.ok) apply(r.settings);
          else if (r && r.canceled) { }
          else showToast('❌ 导入失败', 'fail');
        }).catch(function () { showToast('❌ 导入失败', 'fail'); });
      } else {
        var inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'application/json';
        inp.addEventListener('change', function () {
          if (!inp.files || !inp.files[0]) return;
          var fr = new FileReader();
          fr.onload = function () {
            try { apply(JSON.parse(fr.result)); } catch (e) { showToast('❌ 设置文件无效', 'fail'); }
          };
          fr.readAsText(inp.files[0]);
        });
        inp.click();
      }
    });
  }
  loadPrefs();

  /* ---------- 客户端：文件保存路径回传 + DASH 合并进度 ---------- */
  if (window.biliAPI && window.biliAPI.onDlPath) {
    window.biliAPI.onDlPath(function (d) {
      if (!d || !d.filename) return;
      dlPathMap[d.filename] = d.path;
      var pending = pendingSaves[d.url];
      if (pending) {
        delete pendingSaves[d.url];
        if (d.error) { handleTaskError(pending.task, new Error(d.error)); return; }
        pending.task.path = d.path;
        bindTaskActions(pending.task);
        setTaskNote(pending.task, 'ok', '已保存：' + d.filename);
        addHistoryRecord({ filename: d.filename, path: d.path, size: pending.size, type: pending.type, quality: pending.quality });
      }
    });
  }
  if (window.biliAPI && window.biliAPI.onMuxProgress) {
    window.biliAPI.onMuxProgress(function (d) {
      if (!d || !d.token) return;
      for (var i = 0; i < tasks.length; i++) {
        var tk = tasks[i];
        if (tk.token === d.token && tk.status === 'running') {
          if (d.phase) tk.phase = d.phase;
          setTaskProgress(tk, d.frac || 0, (d.stage || '下载中') + (d.frac >= 1 ? '' : ' ' + ((d.frac || 0) * 100).toFixed(1) + '%'), d.speed);
        }
      }
    });
  }
  // 直链流式下载进度（Electron durl/音频：低内存 + 会话内暂停恢复 + 实时速度）
  if (window.biliAPI && window.biliAPI.onStreamProgress) {
    window.biliAPI.onStreamProgress(function (d) {
      if (!d || !d.token) return;
      for (var i = 0; i < tasks.length; i++) {
        var tk = tasks[i];
        if (tk.token === d.token && tk.status === 'running') {
          setTaskProgress(tk, d.frac || 0, (d.stage || '下载中') + (d.frac >= 1 ? '' : ' ' + ((d.frac || 0) * 100).toFixed(1) + '%'), d.speed);
        }
      }
    });
  }
  // 高清能力探测（ffmpeg 是否随包分发）；null=未定，true=可用，false=不可用
  var muxReady = null;
  if (window.biliAPI && window.biliAPI.muxAvailable) {
    window.biliAPI.muxAvailable().then(function (ok) {
      muxReady = !!ok;
      if (!ok) console.log('[哔哩下载器] 未找到 ffmpeg，高清 DASH 合并不可用，视频走直链降级');
    }).catch(function () { muxReady = false; });
  } else {
    muxReady = false;
  }
  /** 等待高清能力探测完成（最多 3s），避免下载开始时的竞态误走直链 */
  function waitMuxReady() {
    if (muxReady !== null) return Promise.resolve();
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var timer = setInterval(function () {
        if (muxReady !== null || Date.now() - t0 > 3000) { clearInterval(timer); resolve(); }
      }, 40);
    });
  }

  /* ---------- 本地下载目录（客户端版） ---------- */
  function refreshDlDir() {
    if (!dlDirPath) return;
    if (IS_ANDROID) {
      dlDirPath.textContent = '系统「下载」目录';
      if (dlDirPick) dlDirPick.hidden = true;
      if (dlDirOpen) dlDirOpen.hidden = true;
      if (dlDirNote) dlDirNote.textContent = 'Android 版文件自动保存到系统「下载」目录（可在文件管理器中查看）。';
      return;
    }
    if (window.biliAPI && window.biliAPI.getDownloadDir) {
      window.biliAPI.getDownloadDir().then(function (dir) {
        dlDirPath.textContent = dir || '（未设置）';
        dlDirPath.title = dir || '';
      }).catch(function () {
        dlDirPath.textContent = '（读取失败）';
      });
    } else {
      dlDirPath.textContent = '（浏览器默认下载目录）';
      if (dlDirPick) dlDirPick.hidden = true;
      if (dlDirOpen) dlDirOpen.hidden = true;
      if (dlDirNote) dlDirNote.textContent = '网页版由浏览器下载目录决定，无法自定义；请使用客户端版自定义保存位置。';
    }
  }
  function pickDlDir() {
    if (!window.biliAPI || !window.biliAPI.chooseDownloadDir) return;
    window.biliAPI.chooseDownloadDir().then(function (dir) {
      if (dir) {
        refreshDlDir();
        showToast('✅ 下载目录已更改：' + dir, 'ok');
      }
    }).catch(function () {
      showToast('选择目录失败，请重试', 'fail');
    });
  }
  function openDlDir() {
    if (!window.biliAPI || !window.biliAPI.openDownloadDir) return;
    window.biliAPI.openDownloadDir().then(function (ok) {
      if (!ok) showToast('无法打开目录', 'fail');
    }).catch(function () { showToast('无法打开目录', 'fail'); });
  }
  if (dlDirPick) dlDirPick.addEventListener('click', pickDlDir);
  if (dlDirOpen) dlDirOpen.addEventListener('click', openDlDir);

  // 代理方式
  proxyModeSelect.addEventListener('change', function () {
    var m = proxyModeSelect.value;
    if (customProxyBlock) customProxyBlock.hidden = m !== 'custom';
    if (customProxyInput) customProxyInput.hidden = m !== 'custom';
    useProxy = m !== 'direct';
    checkProxy();
  });
  customProxyInput.addEventListener('change', function () {
    checkProxy();
    setNote('warn', '已切换自定义代理：' + (customProxyBase() || '（未填写）'));
  });
  proxyPortInput.addEventListener('change', function () {
    var p = parseInt(proxyPortInput.value, 10);
    if (!(p > 0 && p < 65536)) proxyPortInput.value = 8123;
    checkProxy();
  });

  // 一键修复
  fixBtn.addEventListener('click', fixProxy);

  // 登录
  loginBtn.addEventListener('click', doLogin);
  logoutBtn.addEventListener('click', doLogout);
  cookieSave.addEventListener('click', saveCookiesFromInput);

  // 下载地址缓存管理
  dlCacheClear.addEventListener('click', function () {
    clearDlCache();
    dlCacheCount.textContent = '0 条';
    setNote('ok', '已清除全部下载地址缓存，下次下载将重新获取');
  });
  dlCacheRefresh.addEventListener('click', function () {
    if (!current) {
      setNote('warn', '请先提取一个视频，再刷新其下载地址');
      return;
    }
    var k1 = dlCacheKey(current.bvid, current.cid, 16, Number(qnSelect.value));
    var k2 = dlCacheKey(current.bvid, current.cid, 4048, 0);
    delete dlCache[k1];
    delete dlCache[k2];
    saveDlCache();
    updateDlCacheCount();
    setNote('ok', '已清除当前视频的缓存地址，下次下载将重新获取');
  });

  // 初始化
  if (IS_ANDROID && optThread) optThread.hidden = true;   // Android 原生流式下载，线程数选项不适用
  checkProxy();
  refreshLoginState();
  updateDlCacheCount();
  refreshDlDir();

  // ---- UI 模式切换：精简版（老版 UI）/ 完全版（当前） ----
  var uiSwitch = $('ui-switch');
  var liteEls = document.querySelectorAll('.lite-hide');
  function applyUiMode(mode) {
    var lite = mode === 'lite';
    if (uiSwitch) {
      var btns = uiSwitch.querySelectorAll('.ui-switch-btn');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === mode);
    }
    for (var j = 0; j < liteEls.length; j++) liteEls[j].hidden = lite;
    try { localStorage.setItem('biliUiMode', mode); } catch (e) { }
  }
  if (uiSwitch) {
    uiSwitch.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.ui-switch-btn') : null;
      if (!btn) return;
      applyUiMode(btn.getAttribute('data-mode'));
      showToast(btn.getAttribute('data-mode') === 'lite' ? '已切换到精简版（老版 UI）' : '已切换到完全版（当前）', 'ok');
    });
    var savedMode = 'full';
    try { savedMode = localStorage.getItem('biliUiMode') || 'full'; } catch (e) { }
    applyUiMode(savedMode);
  }

  // 代理自动重连：客户端版代理异步就绪，未连接时每 2 秒自动重检，
  // 连接成功后停止；避免启动初期显示“未连接”需手动刷新
  var proxyRetryTimer = null;
  checkProxy().then(function (alive) {
    if (!alive && !proxyRetryTimer) {
      proxyRetryTimer = setInterval(function () {
        checkProxy().then(function (a2) {
          if (a2 && proxyRetryTimer) {
            clearInterval(proxyRetryTimer);
            proxyRetryTimer = null;
            setNote('ok', '本地代理已连接');
          }
        });
      }, 2000);
    }
  });
})();
