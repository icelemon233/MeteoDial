'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { sources, fieldError, parseIndex } = require('../server/grid-sources.cjs');
const { resolveLiveGrid } = require('../server/live-grids.cjs');
const { findRun, firstGfsIndex } = require('../server/grids.cjs');
const run = '2026-11-20T00:00:00.000Z',
  lead = 24,
  valid = '2026-11-21T00:00:00.000Z';
const providers = [
  sources[0],
  sources.find((s) => s.id === 'ifs'),
  sources.find((s) => s.id === 'gefs'),
];
test('快主镜像只查一次目录，慢镜像不阻塞已有的同批次目录', async () => {
  const peers = [sources[0], sources.find(s => s.id === 'gfs-google')];
  const seen = [];
  const fast = await firstGfsIndex(peers, async p => { seen.push(p.id); }, 5);
  assert.equal(fast.winner, peers[0]);
  await new Promise(r => setTimeout(r, 12));
  assert.deepEqual(seen, ['gfs']);
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const raced = await firstGfsIndex(peers, p => p === peers[0] ? stalled : Promise.resolve(), 2);
  try { assert.equal(raced.winner, peers[1]); } finally { release(); }
  const failed = await firstGfsIndex(peers, async () => { throw fieldError('尚未发布'); }, 2);
  assert.equal(failed.winner, null);
  assert.deepEqual([...failed.errors.keys()], peers.map(p => p.id));
});
test('预取的低地候选不可覆盖高原实测地面气压所选的层', async () => {
  let pressure, predicted;
  const ground = new Promise(resolve => { pressure = resolve; });
  const warmed = new Promise(resolve => { predicted = resolve; });
  const requested = [];
  const result = resolveLiveGrid(run, lead, 'autoTransport', 0, { providers: [sources[0]],
    read: async (source, cycle, hour, layer) => {
      requested.push(layer);
      if (layer === 'surfacePressure') await ground;
      if (layer === 'wind850') predicted();
      return {sourceId:source.id, source:source.name, layer, run:cycle, valid, nx:1, ny:1,
        bbox:[100,30,100,30], step:1, values:[layer === 'surfacePressure' ? 585 : 3], v:[4], terrainMask:[0]};
    } });
  await warmed;
  pressure();
  assert.equal((await result).layer, 'wind500');
  assert.equal(requested.filter(l => l === 'wind850').length, 1);
});
const ps = { values: [1000, 600] },
  wind = { values: [3, 8], v: [4, 6], terrainMask: [0, 0] },
  height = { values: [5620, 5700], terrainMask: [0, 0] };
function fixture(tables) {
  const calls = [];
  const read = async (source, requestedRun, requestedLead, layer) => {
    calls.push(source.id + ':' + layer);
    assert.equal(requestedRun, run);
    assert.equal(requestedLead, lead);
    const field = tables[source.id]?.[layer];
    if (field instanceof Error) throw field;
    if (!field) throw fieldError('此批次缺字段');
    return {
      layer,
      sourceId: source.id,
      source: source.name,
      bbox: [100, 30, 101, 30],
      nx: 2,
      ny: 1,
      step: 1,
      run,
      valid,
      ...field,
    };
  };
  return {
    calls,
    get: (layer, cell = 0) => resolveLiveGrid(run, lead, layer, cell, { providers, read }),
  };
}
test('同层完整的后备风场优先于相邻层，风分量成对切换，地形遮挡保留', async () => {
  const f = fixture({
    gfs: { surfacePressure: ps, wind850: { ...wind, v: [null, 6] }, wind700: wind },
    ifs: {
      surfacePressure: { values: [1005, 950] },
      wind850: { ...wind, values: [7, 9], v: [2, 4] },
    },
  });
  const g = await f.get('autoTransport');
  assert.equal(g.sourceId, 'ifs');
  assert.equal(g.preferredLayer, 'wind850');
  assert.equal(g.layer, 'wind850');
  assert.equal(g.selectionPressure, 1000);
  assert.deepEqual(g.values, [7, null]);
  assert.deepEqual(g.v, [2, null]);
  assert.deepEqual(g.terrainMask, [0, 1]);
  assert.equal(g.valid, valid);
  assert.ok(!f.calls.includes('gfs:wind700'));
  const below = await f.get('wind850', 1);
  assert.equal(below.pointStatus, 'terrain');
  assert.equal(below.values[1], null);
});
test('缺首选层时仅自动模式尝试同用途的相邻层，近地风可切换离地 10 米', async () => {
  const table = {
    gfs: {
      surfacePressure: ps,
      wind700: wind,
      wind10: { values: [0, 0], v: [0, 0] },
      height400: height,
    },
  };
  const f = fixture(table);
  const transport = await f.get('autoTransport');
  assert.equal(transport.layer, 'wind700');
  assert.equal(transport.preferredLayer, 'wind850');
  assert.ok(f.calls.indexOf('gefs:wind850') < f.calls.indexOf('gfs:wind700'));
  assert.equal((await f.get('autoUpper')).layer, 'height400');
  assert.equal((await f.get('autoNear')).layer, 'wind10');
  await assert.rejects(f.get('wind850'), /850 hPa/);
  await assert.rejects(
    fixture({ gfs: { surfacePressure: ps, wind600: wind } }).get('autoTransport'),
    /850 hPa/,
  );
});
test('后备模式自己的地形和气压必须支持自动用途，资料时次不符则继续查找', async () => {
  const f = fixture({
    gfs: { surfacePressure: ps, wind700: wind },
    ifs: { surfacePressure: { values: [880, 600] }, wind850: wind },
    gefs: { surfacePressure: ps, wind850: { ...wind, valid: run } },
  });
  assert.equal((await f.get('autoTransport')).layer, 'wind700');
  const raw = await f.get('wind850');
  assert.equal(raw.sourceId, 'ifs');
  await assert.rejects(
    fixture({ gfs: { surfacePressure: ps }, ifs: { height500: { ...height, run: valid } } }).get(
      'height500',
    ),
    /此时次/,
  );
});
test('真缺测、静风、地形遮挡和全部离线能独立表达', async () => {
  const f = fixture({
    gfs: { surfacePressure: { values: [1000, 1000] }, wind850: { ...wind, v: [null, 6] } },
  });
  const partial = await f.get('wind850');
  assert.equal(partial.pointStatus, 'missing');
  assert.equal(partial.v[1], 6);
  const calm = fixture({
    gfs: {
      surfacePressure: ps,
      wind850: { ...wind, values: [0, null], v: [0, null], terrainMask: [0, 1] },
    },
  });
  assert.equal((await calm.get('wind850')).v[0], 0);
  assert.ok(!calm.calls.some((c) => c.startsWith('ifs:')));
  assert.equal((await calm.get('wind850', 1)).pointStatus, 'terrain');
  assert.equal(
    (await fixture({ ifs: { wind10: { values: [0, 3], v: [2, 0] } } }).get('autoNear')).layer,
    'wind10',
  );
  await assert.rejects(fixture({}).get('autoUpper'), /地面气压/);
  await assert.rejects(
    fixture({ gfs: { wind850: Error('offline') } }).get('wind850'),
    (e) => e.statusCode === 503,
  );
  await assert.rejects(fixture({}).get('autoUpper', -1), /范围/);
});
test('只选同批同时效的瞬时场和控制成员，保留真实文件偏移', () => {
  const lines = [
    '1:0:d=2026112000:TMP:850 mb:24 hour fcst:ENS=low-res ctl',
    '2:100:d=2026112000:PRATE:surface:0-24 hour ave fcst:ENS=low-res ctl',
    '3:180:d=2026112000:VGRD:850 mb:24 hour fcst:ENS=+1',
    '4:300:d=2026112000:UGRD:850 mb:24 hour fcst:ENS=low-res ctl',
  ].join('\n');
  const a = parseIndex(lines, providers[2], run, 24);
  assert.deepEqual(
    a.map((x) => [x.field, x.at, x.end]),
    [
      ['TMP', 0, 99],
      ['UGRD', 300, null],
    ],
  );
  assert.throws(() => parseIndex(lines, providers[2], valid, 24));
  const meta = {
    domain: 'g',
    class: 'od',
    type: 'fc',
    stream: 'oper',
    date: '20261120',
    time: '0000',
    step: '24',
    levtype: 'pl',
    levelist: '850',
    param: 'u',
    _offset: 35,
    _length: 120,
  };
  const extras = [
    { ...meta, step: '18' },
    { ...meta, type: 'pf' },
    { ...meta, date: '20261119' },
  ];
  const e = parseIndex([meta, ...extras].map(JSON.stringify).join('\n'), providers[1], run, 24);
  assert.deepEqual(e, [{ field: 'UGRD', level: '850 mb', at: 35, end: 154 }]);
});
test('起报探测本身也能切到后备源，已知缺批次时可探测上一次起报', async () => {
  const now = Date.parse(run) + 4 * 36e5,
    seen = [];
  const result = await findRun(now, providers, async (p, t) => {
    seen.push(p.id);
    if (p.id !== 'ifs') throw Error('network');
    assert.equal(t, Date.parse(run));
  });
  assert.deepEqual(seen, ['gfs', 'ifs']);
  assert.equal(result.run, run);
  const prior = await findRun(now, providers, async (p, t) => {
    if (t === Date.parse(run)) throw Object.assign(Error(), { statusCode: 404 });
  });
  assert.equal(Date.parse(prior.run), Date.parse(run) - 6 * 36e5);
});
test('0.3.0 同批 GFS 缓存升级后仍可离线读出，后备源有独立缓存', async (t) => {
  const fs = require('node:fs/promises'),
    path = require('node:path'),
    os = require('node:os'),
    crypto = require('node:crypto');
  const { configureCache, configureTransport } = require('../server/network.cjs');
  const { address, readProviderGrid, latestRun } = require('../server/grids.cjs');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'meteodial-upgrade-grids-'));
  configureCache(folder);
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('offline');
  });
  configureTransport(async () => {
    reads++;
    throw Error('offline');
  });
  const write = (key, value) =>
    fs.writeFile(
      path.join(folder, crypto.createHash('sha256').update(key).digest('hex') + '.json'),
      JSON.stringify({ value, at: Date.now(), expires: Date.now() + 60000 }),
    );
  try {
    const url = address(run, lead, '1p00');
    await write('gfs-latest-v2', { run });
    await write(['gfs-grid-v7', url, 'height500', 'asia', 1].join(':'), {
      ...height,
      bbox: [100, 30, 101, 30],
      nx: 2,
      ny: 1,
      step: 1,
      source: 'NOAA GFS',
      layer: 'height500',
      run,
      valid,
    });
    assert.equal((await latestRun()).run, run);
    const saved = await readProviderGrid(providers[0], run, lead, 'height500');
    assert.equal(saved.sourceId, 'gfs');
    assert.deepEqual(saved.values, height.values);
    assert.equal(reads, 0);
    await assert.rejects(readProviderGrid(providers[1], run, lead, 'height500'), /offline/);
    assert.equal(reads, 1);
  } finally {
    configureTransport(undefined);
    await fs.rm(folder, { recursive: true, force: true });
  }
});
