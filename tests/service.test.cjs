'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  fs = require('node:fs/promises');
const { startServer, serviceBase } = require('../server/http.cjs');
const { cached, configureCache, configureTransport } = require('../server/network.cjs');
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
test('共享服务已核实的缺层保持原层缺测，服务故障或错误时次才改走本机', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meteodial-shared-grid-'));
  let upstreamStatus = 422,
    publicRequests = 0;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        upstreamStatus === 200
          ? { sourceId: 'gfs', layer: 'wind850', run: '2020-01-01T00:00Z' }
          : { error: '同层没有完整风场' },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = await startServer(dir, 0, {
    upstream: 'http://127.0.0.1:' + upstream.address().port,
  });
  configureTransport(async () => {
    publicRequests++;
    return new Response('QA outage', { status: 503 });
  });
  try {
    const run = new Date(Math.floor(Date.now() / 21600000) * 21600000).toISOString();
    const url =
      app.url +
      '/api/grid?' +
      new URLSearchParams({ run, lead: '24', layer: 'wind850', cell: '0' });
    const missing = await fetch(url);
    assert.equal(missing.status, 422);
    assert.match((await missing.json()).error, /同层没有完整风场/);
    assert.equal(publicRequests, 0);
    for (const status of [503, 200]) {
      upstreamStatus = status;
      const unavailable = await fetch(url);
      assert.equal(unavailable.status, 503);
      assert.match((await unavailable.json()).error, /850 hPa/);
    }
    assert.ok(publicRequests > 0);
  } finally {
    configureTransport(undefined);
    app.close();
    upstream.close();
    upstream.closeAllConnections();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
