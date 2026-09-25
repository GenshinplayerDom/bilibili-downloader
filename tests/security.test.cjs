const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { validateUrl, cookieHeaders, safeName, reserveOutput, assertManagedPath } = require('../lib/security');
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
