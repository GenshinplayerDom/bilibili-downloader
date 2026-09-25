const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('app.js', 'utf8');
const context = {};
const md5Start = source.indexOf('  function md5(');
const mixinEnd = source.indexOf('  var wbiCache', md5Start);
vm.runInNewContext(source.slice(md5Start, mixinEnd), context);

test('browser MD5 agrees with Node crypto for ASCII and Unicode queries', () => {
  for (const value of ['', 'abc', 'bvid=BV1xx411c7mD&cid=123&wts=1702204169', '视频标题🎬']) {
    assert.equal(context.md5(value), crypto.createHash('md5').update(value).digest('hex'));
  }
});
test('WBI raw image keys are permuted and truncated before hashing', () => {
  assert.equal(context.wbiMixinKey('7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45'), 'ea1db124af3c7062474693fa704f4ff8');
  assert.throws(() => context.wbiMixinKey('invalid'));
});
