const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Downloader, DownloadControl } = require('../lib/downloader');

async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-download-test-'));
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const downloader = new Downloader({ request: http.request, validate: value => new URL(value), chunkSize: 1024, retryDelay: 1, timeout: 2000, connections: 3 });
  return { dir, base, downloader, dest: path.join(dir, 'result.mp4') };
}
function serve(data, req, res) {
  const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (!range) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
  const start = Number(range[1]), end = Math.min(Number(range[2]), data.length - 1);
  res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}` });
  res.end(data.subarray(start, end + 1));
}
const data = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251));

test('parallel download preserves exact bytes and cleans temporary parts', { timeout: 5000 }, async t => {
  const f = await fixture(t, (req, res) => serve(data, req, res));
  const size = await f.downloader.download([f.base], f.dest, { threads: 8 });
  assert.equal(size, data.length); assert.deepEqual(fs.readFileSync(f.dest), data);
  assert.deepEqual(fs.readdirSync(f.dir), ['result.mp4']);
});
test('server without Range support downloads once as a full stream', { timeout: 5000 }, async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); });
  await f.downloader.download(f.base, f.dest);
  assert.deepEqual(fs.readFileSync(f.dest), data);
});
for (const mode of ['ignored-range', 'wrong-range', 'short-body']) {
  test('rejects ' + mode + ' without committing a corrupt file', { timeout: 5000 }, async t => {
    const f = await fixture(t, (req, res) => {
      if (req.headers.range === 'bytes=0-0') return serve(data, req, res);
      if (mode === 'ignored-range') { res.writeHead(200); res.end(data); }
      else {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
        res.writeHead(206, { 'Content-Range': mode === 'wrong-range' ? 'bytes 1-2/6000' : `bytes ${start}-${end}/6000` });
        res.end('x');
      }
    });
    await assert.rejects(f.downloader.download(f.base, f.dest), /范围|不完整|长度/);
    assert.equal(fs.existsSync(f.dest), false); assert.equal(fs.readdirSync(f.dir).length, 0);
  });
}
test('failed ranges retry against backup CDN', { timeout: 5000 }, async t => {
  let backups = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/bad' && req.headers.range !== 'bytes=0-0') { res.writeHead(503); res.end(); return; }
    if (req.url === '/good') backups++;
    serve(data, req, res);
  });
  await f.downloader.download([f.base + '/bad', f.base + '/good'], f.dest);
  assert.ok(backups > 1); assert.deepEqual(fs.readFileSync(f.dest), data);
});
test('pause stops requests; resume keeps completed chunks', { timeout: 8000 }, async t => {
  const requests = [];
  const f = await fixture(t, (req, res) => {
    requests.push(req.headers.range);
    if (req.headers.range === 'bytes=0-0') return serve(data, req, res);
    const timer = setTimeout(() => serve(data, req, res), 40);
    res.on('close', () => clearTimeout(timer));
  });
  const control = new DownloadControl();
  let paused = false;
  const job = f.downloader.download(f.base, f.dest, { threads: 1, control, onProgress: (_, bytes) => {
    if (!paused && bytes >= 2048) { paused = true; control.pause(); }
  } });
  while (!paused) await new Promise(resolve => setTimeout(resolve, 10));
  const count = requests.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests.length, count);
  control.resume(); await job;
  assert.deepEqual(fs.readFileSync(f.dest), data);
  assert.equal(requests.filter(range => range === 'bytes=0-1023').length, 1);
});
test('cancel interrupts an in-flight request and cleans partial data', { timeout: 5000 }, async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, (req, res) => {
    if (req.headers.range === 'bytes=0-0') return serve(data, req, res);
    began(); // Deliberately never return the body.
  });
  const control = new DownloadControl();
  const job = f.downloader.download(f.base, f.dest, { control });
  const rejected = assert.rejects(job, { code: 'CANCELLED' });
  await started; control.cancel(); await rejected;
  assert.equal(fs.readdirSync(f.dir).length, 0);
});
test('connection timeout cannot leave a task hanging', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => {}); f.downloader.timeout = 30;
  await assert.rejects(f.downloader.download(f.base, f.dest), /超时/);
});
test('redirect destinations are revalidated before connecting', { timeout: 5000 }, async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(302, { Location: 'https://blocked.invalid/file' }); res.end(); });
  f.downloader.validate = value => { const url = new URL(value); if (url.hostname !== '127.0.0.1') throw new Error('blocked host'); return url; };
  await assert.rejects(f.downloader.download(f.base, f.dest), /blocked host/);
});
