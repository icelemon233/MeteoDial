'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { preferences } = require('../desktop/preferences.cjs');
const { migrateLocationOnce } = require('../desktop/legacy-location.cjs');

test('0.1 随机端口迁移按最近修改且有效的天气地点恢复，保留旧库字节', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guanxiang-legacy-test-'));
  try {
    const dir = path.join(root, 'Local Storage', 'leveldb');
    await fs.mkdir(dir, { recursive: true });
    const db = new ClassicLevel(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await db.open();
    for (const [origin, id, modified] of [
      ['http://127.0.0.1:9999', '110101', 15],
      ['http://127.0.0.1:2001', 'TW63000050', 30],
      ['http://127.0.0.1:3002', '不存在', 40],
      ['https://example.org', '371002', 50],
    ]) {
      await db.put(Buffer.from('META:' + origin), Buffer.from([8, modified, 16, 78]));
      for (const [key, val] of [
        ['guanxiang.place', id],
        ['guanxiang.recent', [id, 'CNH-hekang', id, null]],
      ]) {
        await db.put(
          Buffer.from('_' + origin + '\x00\x01' + key),
          Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(val))])
        );
      }
    }
    await db.compactRange(Buffer.from([0]), Buffer.from([255]));
    await db.close();
    const fingerprint = async () =>
      Promise.all(
        (await fs.readdir(dir)).sort().map(
          async (f) =>
            f +
            ':' +
            createHash('sha256')
              .update(await fs.readFile(path.join(dir, f)))
              .digest('hex')
        )
      );
    const before = await fingerprint(),
      store = preferences(root);
    await migrateLocationOnce(root, store);
    assert.equal(store.get().place, 'TW63000050');
    assert.deepEqual(store.get().recent, ['TW63000050', 'CNH-hekang']);
    store.set({ place: '371002' });
    await migrateLocationOnce(root, store);
    assert.equal(store.get().place, '371002');
    assert.deepEqual(await fingerprint(), before);
    assert.ok(!(await fs.readdir(root)).some((n) => n.startsWith('weather-location-import-')));
  } finally {
    if (
      path.dirname(root) === path.resolve(os.tmpdir()) &&
      path.basename(root).startsWith('guanxiang-legacy-test-')
    ) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
