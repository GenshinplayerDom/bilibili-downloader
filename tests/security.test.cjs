const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { validateUrl, cookieHeaders, safeName, reserveOutput, assertManagedPath, assertResumeDir } = require('../lib/security');
const { CookieStore } = require('../lib/cookie-store');
const proxy = require('../server');

test('URL policy rejects untrusted hosts, userinfo, ports, schemes and suffix tricks', () => {
  for (const value of ['https://api.bilibili.com.evil.invalid/', 'https://127.0.0.1/', 'file:///etc/passwd', 'https://api.bilibili.com:8443/', 'https://user:pass@api.bilibili.com/', 'http://api.bilibili.com/']) {
    assert.throws(() => validateUrl(value, 'api'));
  }
  assert.equal(validateUrl('https://api.bilibili.com/x/web-interface/nav', 'api').hostname, 'api.bilibili.com');
  assert.equal(validateUrl('http://a.bilivideo.com/video', 'media').protocol, 'https:');
  assert.deepEqual(cookieHeaders('https://a.bilivideo.com/video', 'SESSDATA=fake'), {});
  assert.deepEqual(cookieHeaders('https://unrelated.invalid/', 'SESSDATA=fake'), {});
});
test('names are safe and concurrent reservations never overwrite a file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-path-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = reserveOutput(dir, '../CON.mp4'); fs.writeFileSync(first, 'original');
  const second = reserveOutput(dir, '../CON.mp4');
  assert.notEqual(first, second); assert.equal(fs.readFileSync(first, 'utf8'), 'original');
  assert.equal(path.dirname(first), dir); assert.equal(safeName('CON.mp4'), '_CON.mp4');
  assert.throws(() => reserveOutput(dir, 'run.exe'));
  assert.throws(() => assertManagedPath(first, [dir], new Set()), /本程序/);
  assert.equal(assertManagedPath(first, [dir], new Set([first])), fs.realpathSync(first));
  assert.throws(() => assertManagedPath(first, [path.join(dir, 'other')], new Set([first])));
});
test('resume dirs are confined to part dirs inside the download root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-resume-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parts = fs.mkdtempSync(path.join(root, '.bili-parts-video-'));
  assert.equal(assertResumeDir(parts, root), fs.realpathSync(parts));
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'unrelated-'));
  t.after(() => fs.rmSync(decoy, { recursive: true, force: true }));
  assert.equal(assertResumeDir(decoy, root), null);                       // 目录前缀不符
  const outside = fs.mkdtempSync(path.join(decoy, '.bili-parts-fake-'));
  assert.equal(assertResumeDir(outside, root), null);                      // 不在下载目录内
  assert.equal(assertResumeDir(path.join(root, 'not-exist'), root), null); // 不存在
  assert.equal(assertResumeDir('relative/dir', root), null);
  fs.writeFileSync(path.join(root, '.bili-parts-file'), 'x');
  assert.equal(assertResumeDir(path.join(root, '.bili-parts-file'), root), null); // 不是目录
});
test('legacy cookies migrate to encryption; unavailable encryption never writes plaintext', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-cookie-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = path.join(dir, 'bili_cookies.json');
  fs.writeFileSync(legacy, JSON.stringify({ cookies: { SESSDATA: 'FAKE_TEST_TOKEN' } }));
  const cipher = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a), decryptString: value => Buffer.from(value).map(byte => byte ^ 0x5a).toString() };
  const store = new CookieStore(dir, cipher);
  assert.equal(store.load().SESSDATA, 'FAKE_TEST_TOKEN');
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(store.encryptedPath).includes(Buffer.from('FAKE_TEST_TOKEN')), false);
  assert.equal(store.load().SESSDATA, 'FAKE_TEST_TOKEN');
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.encryptedPath).mode & 0o777, 0o600);
  cipher.isEncryptionAvailable = () => false;
  assert.equal(store.save({ SESSDATA: 'FAKE_TEST_TOKEN' }), false);
  assert.equal(fs.readdirSync(dir).length, 0);
});
test('proxy requires authentication and rejects cross-origin or unrelated targets', async t => {
  const server = http.createServer(proxy.handleRequest); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); proxy.setUserCookies({}); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Bili-Token': proxy.getAccessToken() };
  assert.equal((await fetch(base + '/login-cookies')).status, 401);
  assert.equal((await fetch(base + '/login-cookies', { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
  const blocked = await fetch(base + '/api?url=' + encodeURIComponent('https://unrelated.invalid/collect'), { headers });
  assert.equal(blocked.status, 400);
  assert.equal((await fetch(base + '/login-cookies', { headers })).status, 200);
  const page = await fetch(base + '/'); assert.equal(page.status, 200);
  assert.match(await page.text(), /name="bili-proxy-token"/);
  const post = await fetch(base + '/login-cookies', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies: { SESSDATA: 'FAKE_TEST_TOKEN', DedeUserID: '0' } }) });
  assert.equal(post.status, 200); assert.equal(proxy.getUserLoginInfo().logged, true);
});

test('web pairing binds the token to the approved origin and blocks framing', async t => {
  const origin = 'https://demo-user.github.io';
  const server = http.createServer(proxy.handleRequest); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  // 授权页不可被第三方站点 iframe 嵌套（防点击劫持）
  const pairPage = await fetch(base + '/pair');
  assert.equal(pairPage.headers.get('x-frame-options'), 'DENY');
  assert.match(pairPage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  // 未授权前拿不到 token
  assert.equal((await fetch(base + '/web-token', { headers: { Origin: origin } })).status, 403);

  // 取授权页里的一次性随机数（跨源站点读不到页面内容，因此拿不到 nonce）
  const nonceOf = html => {
    const m = /var PAIR_NONCE=("([a-f0-9]+)")/.exec(html);
    assert.ok(m, '授权页应包含一次性随机数');
    return JSON.parse(m[1]);
  };
  const nonce = nonceOf(await pairPage.text());

  // 缺少 nonce / 跨站 Origin / 非 JSON 类型都必须拒绝（CSRF 防护）
  const approve = (body, headers = { 'Content-Type': 'application/json' }) =>
    fetch(base + '/authorize-web', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await approve({ allow: true, origin })).status, 403);
  assert.equal((await approve({ allow: true, origin, nonce }, { 'Content-Type': 'application/json', Origin: 'https://attacker.github.io' })).status, 403);
  assert.equal((await approve({ allow: true, origin, nonce }, { 'Content-Type': 'text/plain' })).status, 403);

  // 本机授权页提交（同源 / 无 Origin + 正确 nonce），并绑定来源
  assert.equal((await approve({ allow: true, origin, nonce })).status, 200);

  // 绑定来源可取到 token
  const ok = await fetch(base + '/web-token', { headers: { Origin: origin } });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).token, proxy.getAccessToken());

  // 同后缀但不同来源的站点不得复用授权
  const other = await fetch(base + '/web-token', { headers: { Origin: 'https://attacker.github.io' } });
  assert.equal(other.status, 403);

  // 重新配对且不绑定来源（模拟桌面端 file:// 页面 location.origin === 'null'）
  const unboundNonce = nonceOf(await (await fetch(base + '/pair')).text());
  assert.equal((await approve({ allow: true, nonce: unboundNonce })).status, 200);

  // Origin:null（任意站点嵌 sandbox iframe 即可伪造）不得领取 token
  assert.equal((await fetch(base + '/web-token', { headers: { Origin: 'null' } })).status, 403);

  // 未绑定时首次领取即钉死来源
  const firstUse = 'https://demo-user.pages.dev';
  const got = await fetch(base + '/web-token', { headers: { Origin: firstUse } });
  assert.equal(got.status, 200); assert.equal((await got.json()).token, proxy.getAccessToken());
  // 另一个未绑定前的"合法域名"站点随后被拒
  assert.equal((await fetch(base + '/web-token', { headers: { Origin: 'https://other-user.pages.dev' } })).status, 403);
  // 已钉死的来源仍可反复取
  assert.equal((await fetch(base + '/web-token', { headers: { Origin: firstUse } })).status, 200);

  // 清理授权状态，避免影响后续用例（每次授权都需要重新获取 nonce）
  const freshNonce = nonceOf(await (await fetch(base + '/pair')).text());
  assert.equal((await approve({ allow: false, nonce: freshNonce })).status, 200);
});
