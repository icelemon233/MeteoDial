'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { gunzipSync } = require('node:zlib');
const { parseIndex, sources } = require('../server/grid-sources.cjs');
const { phaseCode, phasesFromFlags, waterFlux } = require('../shared/products.mjs');
const { satelliteBounds, isDaylight } = require('../shared/satellite.mjs');
const { divergence, relativeVorticity } = require('../server/atmosphere.cjs');
const { disasterField } = require('../server/disaster-atlas.cjs');
const events = require('../assets/data/disasters.json').events,
  chapters = require('../assets/data/catalog.json');
const root = path.join(__dirname, '../assets');
const unzipJson = (file) => JSON.parse(gunzipSync(fs.readFileSync(path.join(root, file))));
test('累计降水只选与起报相连的真实窗口，混合相态与缺测各自保留', () => {
  const index = [
    '1:0:d=2021072000:APCP:surface:6-9 hour acc fcst:',
    '2:50:d=2021072000:APCP:surface:0-9 hour acc fcst:',
    '3:90:d=2021072000:CSNOW:surface:6-9 hour ave fcst:',
    '4:130:d=2021072000:CSNOW:surface:9 hour fcst:',
  ].join('\n');
  const rows = parseIndex(index, sources[0], '2021-07-20T00:00Z', 9);
  assert.deepEqual(
    rows.map((r) => r.at),
    [50, 130],
  );
  assert.deepEqual([rows[0].startStep, rows[0].endStep], [0, 9]);
  assert.deepEqual(phaseCode([0, 0, 0, 0]), { value: 0, mask: 0 });
  assert.deepEqual(phaseCode([1, 0, 0, 1]), { value: 5, mask: 9 });
  assert.deepEqual(phasesFromFlags(9), ['雨', '雪']);
  assert.equal(phaseCode([0, null, 0, 1]).value, null);
  assert.ok(Math.abs(waterFlux(0.015, 10) - 1.5296) < 0.001);
  assert.equal(waterFlux(null, 0), null);
});
test('风的辐合和旋转分别计算，地形及邻点缺测不会穿过差分', () => {
  const wind = {
    layer: 'wind850',
    nx: 3,
    ny: 3,
    step: 1,
    bbox: [0, -1, 2, 1],
    values: [1, 0, -1, 1, 0, -1, 1, 0, -1],
    v: Array(9).fill(0),
  };
  assert.equal(divergence(wind).layer, 'div850');
  assert.ok(divergence(wind).values[4] < 0);
  assert.equal(relativeVorticity(wind).values[4], 0);
  const rot = { ...wind, values: Array(9).fill(0), v: [-1, 0, 1, -1, 0, 1, -1, 0, 1] };
  assert.ok(relativeVorticity(rot).values[4] > 0);
  rot.v[5] = null;
  assert.equal(relativeVorticity(rot).values[4], null);
});
test('卫星所在地按真实经纬度居中，地方白天与区域预设独立', () => {
  for (const [x, y] of [
    [113.26, 23.13],
    [87.62, 43.83],
    [91.13, 29.65],
  ]) {
    const b = satelliteBounds('local', x, y);
    assert.ok(Math.abs((b[0] + b[2]) / 2 - x) < 0.0001 && Math.abs((b[1] + b[3]) / 2 - y) < 0.0001);
  }
  assert.deepEqual(satelliteBounds('south'), [103, 16, 122, 29]);
  assert.ok(isDaylight(Date.parse('2021-07-20T04:00Z'), 113.26, 23.13));
  assert.equal(isDaylight(Date.parse('2021-07-20T16:00Z'), 113.26, 23.13), false);
});
test('每个全景与专题有效时刻都收录欧亚环流，保留专题的非四小时帧', async () => {
  const saved = new Map();
  function contains(ms) {
    const s = new Date(ms).toISOString(),
      m = s.slice(0, 7);
    let table = saved.get(m);
    if (!table) {
      const buf = fs.readFileSync(path.join(root, 'cases/circulation', m + '.bin'));
      assert.equal(buf.toString('ascii', 0, 8), 'MDEUR501');
      table = JSON.parse(buf.toString('ascii', 12, 12 + buf.readUInt32LE(8)));
      assert.equal(table.cadence, 1);
      saved.set(m, table);
    }
    assert.ok((table.days[Number(s.slice(8, 10))]?.[2] || 0) & (1 << new Date(ms).getUTCHours()), s);
  }
  for (const e of events) {
    const b = unzipJson('cases/disasters/' + e.id + '.json.gz');
    for (let i = 0; i < b.count; i++) contains(Date.parse(b.start) + b.cadence * i * 36e5);
  }
  for (const c of chapters) for (const h of c.leads) contains(Date.parse(c.run + 'T00:00Z') + h * 36e5);
  const wide = await disasterField('2021-c2', 'heightWide500', '2021-07-20T09:00Z', null, 'henan-2021');
  assert.deepEqual(wide.bbox, [10, 0, 180, 80]);
  assert.equal(wide.values.length, 69 * 33);
  assert.ok(wide.values.filter((x) => Number.isFinite(x) && x > 4000).length > 2000);
  await assert.rejects(disasterField('2021-c2', 'heightWide500', '2021-07-20T09:00Z', null, 'ice-2008'));
  const stamp = '2021-07-20T08:00Z';
  const [wind, div, flux] = await Promise.all(
    ['wind850', 'div850', 'flux850'].map((k) => disasterField('2021-c2', k, stamp)),
  );
  assert.deepEqual(div.values, divergence(wind).values);
  assert.ok(flux.values.some(Number.isFinite));
  assert.equal(flux.v.length, wind.values.length);
});
test('郑州红外使用仪器实际扫描及缺口，烟花定位保留日本气象厅原始时次', () => {
  const d = require('../assets/cases/henan-clouds/index.json');
  const t = d.frames.map((f) => Date.parse(f.time));
  assert.equal(d.frames.length, 72);
  assert.deepEqual(d.gaps, ['2021-07-20T02:40:00.000Z']);
  assert.ok(t.every((v, i) => !i || v > t[i - 1]));
  const samples = [];
  for (const f of d.frames) {
    const bytes = gunzipSync(fs.readFileSync(path.join(root, 'cases/henan-clouds', f.file)));
    assert.equal(bytes.length, 2 * d.nx * d.ny);
    const i = Math.round((d.bbox[3] - 34.72) / d.step) * d.nx + Math.round((113.66 - d.bbox[0]) / d.step);
    samples.push(bytes.readInt16LE(i * 2));
  }
  assert.ok(new Set(samples).size > 30);
  assert.ok(Math.min(...samples.filter((v) => v !== -32768)) < -550);
  const storm = unzipJson('data/typhoons/2021.json.gz').find((s) => s.id === '2106');
  assert.equal(storm.name, 'IN-FA');
  assert.ok(
    storm.points.some((p) => p[0] === Date.parse('2021-07-20T00:00Z') / 36e5 && p[1] > 120 && p[1] < 150),
  );
});

test('卫星窄选区只请求已发布的缩放级，缺少细图时用同时同通道的上一级', async () => {
  const { observationTiles } = require('../server/satellite.cjs');
  const box = satelliteBounds('south'),
    calls = [];
  const coarse = await observationTiles(box, 800, async (z, x, y) => {
    calls.push([z, x, y]);
    return z === 5 ? null : Buffer.from([z, x, y]);
  });
  assert.equal(calls[0][0], 5);
  assert.equal(coarse.z, 4);
  assert.equal(coarse.partial, false);
  assert.ok(coarse.tiles.every((t) => t.bytes[0] === 4));
  await assert.rejects(
    observationTiles(box, 800, async () => null),
    /缺少/,
  );
});
