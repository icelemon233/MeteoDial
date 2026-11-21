'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  fs = require('node:fs/promises');
const { startServer, serviceBase } = require('../server/http.cjs');
const { cached, configureCache } = require('../server/network.cjs');
test('共享服务保持桌面端原来的接口和本地离线资源', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guanxiang-service-test-'));
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ query: req.url }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = await startServer(dir, 0, {
    upstream: 'http://127.0.0.1:' + upstream.address().port,
  });
  try {
    const result = await (await fetch(app.url + '/api/forecast?id=371002')).json();
    assert.equal(result.query, '/api/forecast?id=371002');
    const g = await (await fetch(app.url + '/assets/cases/bohai/wind10-30.json')).json();
    assert.equal(g.layer, 'wind10');
    const rules = await fetch(app.url + '/shared/levels.mjs');
    assert.match(rules.headers.get('content-type'), /javascript/);
    assert.match(await rules.text(), /levelChoices/);
    assert.equal((await fetch(app.url + '/shared/private.mjs')).status, 404);
    assert.equal((await fetch(app.url + '/api/unknown')).status, 404);
    assert.throws(() => serviceBase('http://weather.example.com'));
  } finally {
    app.close();
    upstream.close();
    upstream.closeAllConnections();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('相同图层的并发请求复用结果，过期连接失败使用注明日期的缓存', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guanxiang-cache-test-'));
  configureCache(dir);
  let loads = 0;
  try {
    const load = async () => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { value: { sample: 31.2 }, expires: Date.now() - 500 };
    };
    const [a, b] = await Promise.all([
      cached('temperature', 100, load),
      cached('temperature', 100, load),
    ]);
    assert.equal(loads, 1);
    assert.deepEqual(a, b);
    const stale = await cached(
      'temperature',
      10,
      async () => {
        throw Error('offline');
      },
      { stale: 5000 },
    );
    assert.equal(stale.sample, 31.2);
    assert.equal(stale.offline, true);
    assert.ok(stale.cachedAt > 0);
    await assert.rejects(
      cached(
        'temperature',
        10,
        async () => {
          throw Object.assign(Error('permission denied'), { statusCode: 403 });
        },
        { stale: 5000 },
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
