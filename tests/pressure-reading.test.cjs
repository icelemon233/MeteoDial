'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { gunzipSync } = require('node:zlib');
const {
  makeProfile,
  relativeHumidity,
  specificHumidity,
  wetBulb,
  divergence,
} = require('../server/atmosphere.cjs');
const { disasterField, disasterProfile, disasterPoint } = require('../server/disaster-atlas.cjs');
const { gridIndex, levelChoices } = require('../shared/levels.mjs');
const ids = require('../assets/data/disasters.json').events,
  root = path.join(__dirname, '../assets/cases');
const when = '2016-01-24T00:00:00.000Z',
  cold = '2016-c4';
test('压力感知的湿球温度与独立热力计算一致，并保留原湿度与缺测', () => {
  // MetPy 1.7.1 wet_bulb_temperature, pressure (hPa), T and Td (Celsius).
  for (const [p, t, td, reference] of [
    [1000, 20, 10, 13.9975],
    [850, 5, 0, 2.6383],
    [600, -3, -7, -4.7536],
    [1000, 25, 15, 18.3537],
  ]) {
    const q = specificHumidity(p, td, 100);
    assert(Math.abs(wetBulb(p, t, q) - reference) < 0.08);
  }
  assert.equal(wetBulb(700, -4, specificHumidity(700, -4, 100)), -4);
  const q = specificHumidity(700, -8, 111);
  assert(relativeHumidity(700, -8, q) > 110);
  assert.equal(wetBulb(700, -8, q), -8);
  assert.equal(wetBulb(850, 0, null), null);
});
test('温湿剖面排除地下层，给出有取样支撑的冷暖层厚度，保留垂直资料缺口', () => {
  const raw = (p, t) => ({ pressure: p, temp: t, q: specificHumidity(p, t, 100) });
  const args = { source: '检验', valid: when, lon: 100, lat: 30, resolution: '1°', surface: raw(810, -1) };
  const p = makeProfile({
    ...args,
    levels: [raw(925, 15), raw(800, -0.8), raw(775, 2), raw(750, 3), raw(700, -2), raw(650, -8)],
  });
  assert.deepEqual(
    p.rows.map((r) => r.pressure),
    [810, 800, 775, 750, 700, 650],
  );
  assert.match(p.depths, /暖层.*厚约/);
  assert.match(p.summary, /可能先融化/);
  assert(p.rows.every((r, i) => !i || r.height > p.rows[i - 1].height));
  const sparse = makeProfile({ ...args, levels: [raw(700, 3), raw(500, -20)] });
  assert.equal(sparse.depths, '');
  assert.match(sparse.summary, /取样最大间隔/);
});
test('200 hPa 水平散度核对球面符号、单位及缺测传播', () => {
  const wind = {
    values: Array(9).fill(0),
    v: Array(9).fill(12),
    nx: 3,
    ny: 3,
    step: 1,
    bbox: [100, 44, 102, 46],
    valid: when,
  };
  const g = divergence(wind);
  assert.equal(g.layer, 'div200');
  assert.equal(g.valid, when);
  assert(Math.abs(g.values[4] + ((12 * Math.tan(Math.PI / 4)) / 6371000) * 1e5) < 0.011);
  assert.equal(g.values[0], null);
  wind.v[1] = null;
  assert.equal(divergence(wind).values[4], null);
});
test('原图各层各有读法，四图候选剔除选点已知地下等压面', async () => {
  const { chartGuide, pressureGuide } = await import('../ui/pressure-guides.js');
  const { chartPeers } = await import('../ui/cma-maps.js');
  const guides = ['000', '925', '850', '700', '500', '200', '100'].map((n) => chartGuide('chart-' + n));
  assert.equal(new Set(guides).size, 7);
  assert.match(guides[3], /切变/);
  assert.match(guides[5], /辐散/);
  assert.match(pressureGuide('omega700'), /负值.*上升/);
  assert(!chartPeers(797).includes('chart-850'));
  assert(!chartPeers(570).includes('chart-700'));
  assert(chartPeers(1006).includes('chart-850'));
  assert(chartPeers(570).includes('chart-000'));
});
test('全景切换高原、盆地和平原的同一时刻使用真实不同风场，风和湿度解读与画面相符', async () => {
  const cases = [
    [[102.833, 24.884], 'wind700'],
    [[101.78, 36.62], 'wind600'],
    [[91.14, 29.65], 'wind500'],
    [[80, 35], 'wind400'],
    [[121.47, 31.23], 'wind850'],
  ];
  for (const [xy, expected] of cases) {
    const [w, r, s, point] = await Promise.all([
      disasterField(cold, 'autoTransport', when, xy),
      disasterField(cold, 'autoMoisture', when, xy),
      disasterField(cold, 'wind850', when, xy),
      disasterPoint(cold, when, xy),
    ]);
    assert.equal(w.layer, expected);
    assert.equal(w.valid, when);
    assert.equal(w.selectionPressure, point.reading.ps);
    const i = gridIndex(w, ...xy),
      level = w.layer.slice(4);
    assert.equal(w.values[i], point.reading['u' + level]);
    assert.equal(w.v[i], point.reading['v' + level]);
    assert.equal(r.values[gridIndex(r, ...xy)], point.reading[r.layer]);
    assert(levelChoices('autoTransport', w.selectionPressure).includes(w.layer));
    if (w.selectionPressure <= 850) assert.equal(s.terrainMask[i], 1);
  }
  const basic = await disasterProfile(cold, when, cases[0][0]);
  const [early, late, upper, near] = await Promise.all([
    disasterField(cold, 'autoTransport', '2016-01-22T12:00Z', [92.5, 37.5]),
    disasterField(cold, 'autoTransport', '2016-01-26T12:00Z', [92.5, 37.5]),
    disasterField(cold, 'autoUpper', when, [80, 35]),
    disasterField(cold, 'autoNear', when, [80, 35]),
  ]);
  assert.deepEqual(
    [early.layer, late.layer, upper.layer, near.layer],
    ['wind600', 'wind500', 'height300', 'wind10'],
  );
  assert.equal(basic.detail, 'basic');
  assert(basic.rows.every((r, i) => !i || r.pressure < basic.rows[0].pressure));
  await assert.rejects(disasterPoint(cold, when, [178, 80]));
});
test('352 起事件均有同时次、同参考点的完整 ERA5 起始解读；补充图覆盖每个四小时时次', () => {
  const names = new Map(require('../assets/data/places.json').map((p) => [p[0], p]));
  const folders = ['disaster-fields', 'disaster-columns', 'disaster-analysis-fields'];
  const tables = new Map();
  function table(month) {
    if (!tables.has(month)) {
      const all = folders.map((d) => {
        const file = fs.openSync(path.join(root, d, month + '.bin'), 'r');
        try {
          const head = Buffer.alloc(12);
          assert.equal(fs.readSync(file, head), 12);
          const n = head.readUInt32LE(8);
          assert(n > 20 && n < 65536);
          const b = Buffer.alloc(n);
          assert.equal(fs.readSync(file, b), n);
          return JSON.parse(b);
        } finally {
          fs.closeSync(file);
        }
      });
      const masks = (x) => Object.fromEntries(Object.entries(x.days).map(([key, a]) => [key, a[2]]));
      assert.deepEqual(masks(all[0]), masks(all[1]));
      assert.deepEqual(masks(all[0]), masks(all[2]));
      for (const aux of all.slice(1)) {
        assert.equal(aux.codec, 'zstd');
        assert(
          Object.values(aux.days).every(
            (entry) =>
              entry.length === 4 && Number.isSafeInteger(entry[3]) && entry[3] >= 0 && entry[3] <= 0xffffffff,
          ),
        );
      }
      tables.set(month, all);
    }
    return tables.get(month)[0];
  }
  for (const e of ids) {
    const b = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'disasters', e.id + '.json.gz'))));
    const c = JSON.parse(
      gunzipSync(fs.readFileSync(path.join(root, 'disaster-profiles', e.id + '.json.gz'))),
    );
    const p = names.get(e.map.place);
    assert.equal(c.valid, b.focus);
    assert.equal(c.detail, 'full');
    assert.deepEqual([c.lon, c.lat], [Math.round(p[5] * 4) / 4, Math.round(p[4] * 4) / 4]);
    assert(c.rows.length >= 5);
    for (const k of [
      'ps',
      'u700',
      'v700',
      'u600',
      'v600',
      'u500',
      'v500',
      'u400',
      'v400',
      'eraPs',
      'moisture600',
      'moisture400',
    ])
      assert.equal(b.pointWeather[k].length, b.count, e.id + ' ' + k);
    for (let t = Date.parse(b.start); t <= Date.parse(b.end); t += 14400000) {
      const s = new Date(t).toISOString();
      assert(table(s.slice(0, 7)).days[Number(s.slice(8, 10))][2] & (1 << (Number(s.slice(11, 13)) / 4)));
    }
  }
});
test('九个专题在自己原有的每一帧都能离线打开参考点的详细廓线', async () => {
  const catalog = require('../assets/data/catalog.json');
  let n = 0;
  for (const c of catalog) {
    const e = ids.find((item) => item.chapters?.includes(c.id));
    const b = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'chapter-profiles', c.id + '.json.gz'))));
    assert.equal(b.id, c.id);
    assert.equal(Object.keys(b.frames).length, c.leads.length);
    for (const h of c.leads) {
      const stamp = new Date(Date.parse(c.run + 'T00:00Z') + h * 3600000).toISOString(),
        g = b.frames[stamp];
      assert.equal(g.valid, stamp);
      assert.equal(g.detail, 'full');
      assert.equal(g.rows.at(-1).pressure, 300);
      n++;
    }
    const sample = await disasterProfile(e.id, Object.keys(b.frames)[1], null, false, c.id);
    assert.equal(sample.detail, 'full');
    assert.equal(sample.lon, Math.round(c.point[0] * 4) / 4);
  }
  assert.equal(n, 309);
});
