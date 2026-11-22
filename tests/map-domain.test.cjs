'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const archive = require('../assets/data/archive-domain.json');
const catalog = require('../assets/data/catalog.json');
const { gridIndex, liveDomain } = require('../shared/levels.mjs');
const { observationTimes } = require('../server/sky.cjs');
const maps = () => import(pathToFileURL(path.join(root, 'ui/cartography.js')).href);
const viewport = (width, height) => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) });

test('首次读取的紧凑底图逐点保留三组源数据、边界范围和日期线分段', async () => {
  const { unpackGeography } = await maps();
  const file = fs.readFileSync(path.join(root, 'assets/data/basemap-v1.bin'));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const geography = unpackGeography(buffer);
  for (const [group, filename] of [['land','land'], ['coast','coastlines'], ['boundary','china-boundaries']]) {
    const original = require('../assets/data/' + filename + '.json');
    assert.equal(geography[group].length, original.length);
    for (const [i, points] of original.entries()) {
      const line = geography[group][i], bounds = [180,90,-180,-90];
      assert.equal(line.points.length, points.length * 2);
      for (const [j,[lon,lat]] of points.entries()) {
        assert.equal(line.points[j*2] / 10000, lon || 0);
        assert.equal(line.points[j*2+1] / 10000, lat || 0);
        bounds[0] = Math.min(bounds[0], lon); bounds[1] = Math.min(bounds[1], lat);
        bounds[2] = Math.max(bounds[2], lon); bounds[3] = Math.max(bounds[3], lat);
      }
      assert.deepEqual(line.bounds, bounds.map(n => n || 0));
    }
  }
  assert.throws(() => unpackGeography(buffer.slice(0, -4)), /不完整|无效/);
});

test('全国红外回放仅使用源目录已公布的观测时刻，保留扫描缺口', () => {
  const xml = '<Layer><Name>Himawari_AHI_Band13_Clean_Infrared</Name>' +
    '<Dimension name="time">2023-12-10T00:00:00Z/2023-12-10T00:20:00Z/PT10M,2023-12-10T00:40:00Z</Dimension></Layer>';
  const result = observationTimes(xml, Date.parse('2023-12-10T01:00:00Z'));
  assert.deepEqual(result.map(f => f.time.slice(11,16)), ['00:00','00:10','00:20','00:40']);
  assert.throws(() => observationTimes('<Layer/>', Date.now()), /红外/);
});

test('默认全国视野完整包含边界和海岛，全国格网覆盖实际显示范围', async () => {
  const { extentFor, nationalView } = await maps();
  const points = require('../assets/data/china-boundaries.json').flat();
  const view = extentFor(viewport(960, 540), nationalView);
  assert.ok(points.length > 1000 && points.some(([lon, lat]) => lon < 74 && lat > 35));
  assert.ok(points.some(([, lat]) => lat < 5) && points.some(([, lat]) => lat > 53));
  for (const [lon, lat] of points)
    assert.ok(lon >= view[0] && lon <= view[2] && lat >= view[1] && lat <= view[3]);
  for (const bounds of [archive, liveDomain.bbox]) {
    assert.ok(bounds[0] <= view[0] && bounds[1] <= view[1] && bounds[2] >= view[2] && bounds[3] >= view[3]);
  }
});

test('地图在日期变更线和两极停止平移，屏幕边缘的取点和经纬网共用投影', async () => {
  const { clampView, panView, extentFor, geoFromPointer } = await maps();
  for (const canvas of [viewport(960, 540), viewport(280, 158), viewport(380, 660)]) {
    for (const [dx, dy] of [[900, 700], [-900, -700]]) {
      const atEdge = panView([80, 15, 120, 50], dx, dy);
      assert.deepEqual(panView(atEdge, dx, dy), atEdge);
      const b = extentFor(canvas, atEdge);
      assert.ok(b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90);
      assert.deepEqual(geoFromPointer(canvas, {clientX: -1000, clientY: -1000}, atEdge), [b[0], b[3]]);
      assert.deepEqual(geoFromPointer(canvas, {clientX: 10000, clientY: 10000}, atEdge), [b[2], b[1]]);
    }
  }
  assert.deepEqual(clampView([-490, -270, 490, 270]), [-180, -90, 180, 90]);
  assert.deepEqual(geoFromPointer(viewport(1600, 900), {clientX: 800, clientY: 450}, [-180, -90, 180, 90]), [0, 0]);
});

test('世界海岸线和闭合陆地环在日期变更线分段，南北极没有横穿全球的伪边', () => {
  const coast = require('../assets/data/coastlines.json');
  const land = require('../assets/data/land.json');
  for (const ring of land) assert.deepEqual(ring[0], ring.at(-1));
  for (const line of [...coast, ...land]) {
    for (let i = 1; i < line.length; i++)
      assert.ok(Math.abs(line[i][0] - line[i - 1][0]) <= 12.001, 'Unexpected edge crossing the date line');
  }
  const coastPoints = coast.flat();
  assert.ok(coastPoints.some(([x,y]) => x > 179.5 && y > 65));
  assert.ok(coastPoints.some(([x,y]) => x < -179.5 && y > 65));
});

test('每个历史时次包含全国原分辨率格点，与同日的全国和局部云图配套', () => {
  for (const c of catalog.filter(entry => entry.leads)) {
    const folder = path.join(root, 'assets/cases', c.id);
    for (const lead of c.leads) {
      const time = new Date(Date.parse(c.run + 'T00:00:00Z') + lead * 36e5).toISOString();
      const date = time.slice(0, 10);
      for (const name of [date, 'national-' + date]) {
        const jpg = fs.readFileSync(path.join(folder, name + '.jpg'));
        assert.equal(jpg.readUInt16BE(0), 0xffd8);
        assert.equal(jpg.readUInt16BE(jpg.length - 2), 0xffd9);
      }
      for (const layer of c.layers.filter(key => !['satellite','track'].includes(key))) {
        const g = JSON.parse(fs.readFileSync(path.join(folder, layer + '-' + lead + '.json')));
        assert.deepEqual(g.bbox, archive);
        assert.equal(g.step, c.step || 1);
        assert.equal(g.valid, time);
        for (const [lon, lat] of [[76, 40], [134, 48], [112, 4], [121, 24]]) {
          const i = gridIndex(g, lon, lat);
          assert.ok(i >= 0 && (Number.isFinite(g.values[i]) || g.terrainMask?.[i] === 1),
            [c.id, layer, time, lon, lat].join(' '));
        }
      }
    }
  }
});
