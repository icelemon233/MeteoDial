'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { gunzipSync } = require('node:zlib');
const archive = require('../assets/data/disasters.json'),
  catalog = require('../assets/data/catalog.json');
const { disasterField, readTable, readDay, formatGrid } = require('../server/disaster-atlas.cjs');
const places = new Map(require('../assets/data/places.json').map((p) => [p[0], p]));
const eventsDir = path.resolve(__dirname, '../assets/cases/disasters');
const fieldsDir = path.resolve(eventsDir, '../disaster-fields'),
  H = 3600000;
function meta(e) {
  return JSON.parse(gunzipSync(fs.readFileSync(path.join(eventsDir, e.id + '.json.gz'))));
}
function index(month) {
  const file = fs.openSync(path.join(fieldsDir, month + '.bin'), 'r');
  try {
    const head = Buffer.alloc(12);
    assert.equal(fs.readSync(file, head), 12);
    assert.equal(head.toString('ascii', 0, 8), 'MDCFS4H1');
    const size = head.readUInt32LE(8);
    assert(size > 15 && size < 65536);
    const buf = Buffer.alloc(size);
    assert.equal(fs.readSync(file, buf), size);
    const table = JSON.parse(buf);
    assert.equal(table.month, month);
    assert.equal(table.cadence, 4);
    let total = 12 + size;
    for (const [off, n, mask] of Object.values(table.days)) {
      assert.equal(off, total - 12 - size);
      assert(n > 0 && mask > 0 && mask < 64);
      total += n;
    }
    assert.equal(fs.fstatSync(file).size, total);
    return table.days;
  } finally {
    fs.closeSync(file);
  }
}
test('每起灾害从首日北京时间零时到末日二十时都有连续四小时全国格点', () => {
  assert.equal(fs.readdirSync(eventsDir).length, archive.events.length);
  const months = new Map();
  for (const e of archive.events) {
    const b = meta(e),
      start = Date.parse(e.map.from) - 8 * H,
      end = Date.parse(e.map.to) + 12 * H;
    assert(places.has(e.map.place));
    assert.equal(b.id, e.id);
    assert.equal(b.version, 2);
    assert.equal(b.cadence, 4);
    assert.equal(Date.parse(b.start), start);
    assert.equal(Date.parse(b.end), end);
    assert.equal(b.count, (end - start) / (4 * H) + 1);
    assert.equal(b.series.values.length, b.count);
    const focus = (Date.parse(b.focus) - start) / (4 * H);
    assert(Number.isInteger(focus) && focus >= 0 && focus < b.count);
    for (const key of ['u850', 'v850', 'u10', 'v10', 'moisture700', 'height500', 'temp2']) {
      assert.equal(b.pointWeather[key].length, b.count, e.id + ' ' + key);
      assert.equal(b.pointWeather[key][focus], b.atFocus[key]);
    }
    assert(b.layers.includes('rain4h') && !b.layers.includes('rainDay'));
    assert(b.series.values.every((v) => v === null || Number.isFinite(v)));
    assert(b.series.values.filter(Number.isFinite).length >= 2);
    for (let t = start; t <= end; t += 4 * H) {
      const stamp = new Date(t).toISOString(),
        m = stamp.slice(0, 7),
        d = Number(stamp.slice(8, 10)),
        slot = Number(stamp.slice(11, 13)) / 4;
      if (!months.has(m)) months.set(m, index(m));
      assert(months.get(m)[d]?.[2] & (1 << slot), e.id + ' ' + stamp);
    }
  }
});
test('跨月、跨年、峰值时刻的格点时次和累计边界正确，留存缺测与地形遮挡', async () => {
  for (const id of ['2001-a4', '2008-a1', '2011-s1', '2016-c4', '2021-c2', '2026-i12']) {
    const e = archive.events.find((x) => x.id === id),
      b = meta(e);
    for (const time of [b.start, b.focus, b.end]) {
      const grids = await Promise.all(b.layers.map((l) => disasterField(id, l, time)));
      for (const g of grids) {
        assert.equal(g.valid, time);
        if (id === '2011-s1') assert.equal(g.source, 'NCEP CFSR');
        assert.equal(g.values.length, g.nx * g.ny);
        assert(g.values.some(Number.isFinite));
        assert(g.bbox[0] <= 73 && g.bbox[1] <= 4 && g.bbox[2] >= 135 && g.bbox[3] >= 54);
        if (g.layer.startsWith('wind')) assert.equal(g.v.length, g.values.length);
        if (g.terrainMask) assert(g.terrainMask.every((v, i) => !v || g.values[i] === null));
        if (g.layer === 'rain4h') {
          assert.equal(Date.parse(g.intervalEnd) - Date.parse(g.intervalStart), 4 * H);
          assert.equal(g.intervalEnd, g.valid);
          assert.equal(g.sourceRuns.length, 4);
          assert(g.values.every((v) => v === null || v >= 0));
        } else {
          assert.equal(Date.parse(g.run) + g.lead * H, Date.parse(g.valid));
          assert(g.lead >= 0 && g.lead <= 6);
        }
      }
    }
  }
  await assert.rejects(disasterField('2021-c2', 'rain4h', '2021-07-20T01:00:00Z'));
  await assert.rejects(disasterField('2021-c2', 'rain4h', '2021-08-01T00:00:00Z'));
  await assert.rejects(disasterField('2021-c2', 'rainDay', '2021-07-20T00:00:00Z'));
});
test('归档解码与参考格点解读使用同一时次，损坏的数据块不绘图', async () => {
  const id = '2021-c2',
    e = archive.events.find((x) => x.id === id),
    b = meta(e),
    place = places.get(e.map.place);
  const when = b.focus,
    series = b.series,
    g = await disasterField(id, series.layer, when);
  const x = Math.round((place[5] - g.bbox[0]) / g.step),
    y = Math.round((g.bbox[3] - place[4]) / g.step),
    v = g.values[y * g.nx + x];
  assert.equal(v, series.values[(Date.parse(when) - Date.parse(b.start)) / (4 * H)]);
  assert.equal(v, b.atFocus[series.layer]);
  const next = await disasterField(
    id,
    'rain4h',
    new Date(Date.parse(when) + (when === b.end ? -4 : 4) * H).toISOString(),
  );
  assert.notDeepEqual(next.values, g.values);
  const month = when.slice(0, 7),
    d = Number(when.slice(8, 10)),
    bytes = fs.readFileSync(path.join(fieldsDir, month + '.bin'));
  const table = readTable(bytes, month);
  const frame = readDay(table, d);
  assert.deepEqual(formatGrid(frame, when, 'rain4h').values, g.values);
  bytes[table.offset + table.table.days[d][0] + 4] ^= 255;
  assert.throws(() => readDay(table, d));
});
test('所有独立专题保留真实时次，河南峰值逐小时，专题最大间隔不超过四小时', () => {
  const chapters = archive.events.flatMap((e) => e.chapters || []);
  assert.deepEqual([...chapters].sort(), catalog.map((c) => c.id).sort());
  assert.deepEqual(archive.events.find((e) => e.id === '2022-s3').chapters, ['coldpool', 'front']);
  assert.deepEqual(archive.events.find((e) => e.id === '2023-c3').chapters, ['bohai']);
  for (const c of catalog)
    assert(
      c.leads.every((t, i) => !i || (t > c.leads[i - 1] && t - c.leads[i - 1] <= 4)),
      c.id,
    );
  for (const id of ['beijing-snow', 'bohai22', 'terrain', 'belts']) {
    assert(!chapters.includes(id));
    assert(!fs.existsSync(path.resolve(eventsDir, '..', id)));
  }
});

test('雨量站日累计独立按资料日存放，所有回放日期都可查到对应观测产品', () => {
  const root = path.resolve(eventsDir, '../gauge-days');
  const days = new Set();
  for (const file of fs.readdirSync(root)) {
    const b = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, file))));
    assert.equal(file, b.month + '.json.gz');
    for (const [day, encoded] of Object.entries(b.days)) {
      assert.equal(Buffer.from(encoded, 'base64').length, b.nx * b.ny * 2);
      days.add(b.month + '-' + day.padStart(2, '0'));
    }
  }
  for (const e of archive.events) {
    for (let t = Date.parse(e.map.from); t <= Date.parse(e.map.to); t += 24 * H)
      assert(days.has(new Date(t).toISOString().slice(0, 10)), e.id);
  }
});
