'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const loadModule = (file) => import(pathToFileURL(path.join(root, 'ui', file)).href);
const catalog = require('../assets/data/catalog.json');
const archive = require('../assets/data/disasters.json');

test('按同一时次选平原和高原三层，地形和未知气压不能变成低空气象值', async () => {
  const { levelFor, gridIndex } = await loadModule('levels.js');
  const roles = ['autoUpper', 'autoTransport', 'autoNear'];
  assert.deepEqual(
    roles.map((r) => levelFor(r, 1005)),
    ['height500', 'wind850', 'wind925'],
  );
  assert.deepEqual(
    roles.map((r) => levelFor(r, 585)),
    ['height400', 'wind500', 'wind10'],
  );
  assert.deepEqual(
    roles.map((r) => levelFor(r, 535)),
    ['height300', 'wind400', 'wind10'],
  );
  const ps = { values: [1005, 585], bbox: [100, 30, 101, 30], nx: 2, ny: 1, step: 1 };
  assert.equal(levelFor('autoTransport', ps.values[gridIndex(ps, 101, 30)]), 'wind500');
  assert.equal(levelFor('wind850', 585), 'wind850');
  assert.equal(levelFor('autoUpper', null), null);
  assert.equal(levelFor('autoNear', null), 'wind10');
});
test('地形掩膜、矢量缺测与图外点分别处理', async () => {
  const { sample } = await loadModule('cartography.js');
  const grid = {
    bbox: [90, 30, 92, 30],
    nx: 3,
    ny: 1,
    step: 1,
    values: [null, 3, 0],
    v: [null, null, 0],
    terrainMask: [1, 0, 0],
  };
  assert.equal(sample(grid, 90, 30).belowGround, true);
  assert.equal(sample(grid, 91, 30).value, null);
  assert.equal(sample(grid, 91, 30).belowGround, false);
  assert.equal(sample(grid, 92, 30).value, 0);
  assert.equal(sample(grid, 100, 40), null);
});
test('归档保留真实等压面掩膜，离线再分析、模式预报和站点实况可区分', () => {
  let terrainCells = 0;
  for (const c of catalog.filter((c) => c.leads)) {
    for (const lead of c.leads) {
      for (const layer of c.layers.filter((l) => /\d{3}$/.test(l))) {
        const grid = require(path.join(root, 'assets/cases', c.id, layer + '-' + lead + '.json'));
        assert.equal(grid.terrainMask.length, grid.values.length);
        grid.terrainMask.forEach((masked, i) => {
          if (masked) {
            terrainCells++;
            assert.equal(grid.values[i], null);
            if (grid.v) assert.equal(grid.v[i], null);
          }
        });
        if (c.dataMode === 'reanalysis') {
          assert.equal(grid.type, '再分析');
          assert.equal(grid.run, undefined);
        } else assert.ok(grid.run);
      }
    }
  }
  assert.ok(terrainCells > 100);
  const find = (id) => catalog.find((c) => c.id === id);
  assert.equal(find('bohai').run, '2023-12-19');
  assert.ok(find('henan-2021').outcomeSource);
  assert.equal(find('henan-2021').dataMode, undefined);
});
test('逐年灾害记录可追溯，指定事件均有地图回放', () => {
  assert.equal(new Set(archive.events.map((e) => e.id)).size, archive.events.length);
  const years = Object.keys(archive.years)
    .map(Number)
    .sort((a, b) => a - b);
  assert.deepEqual(
    years,
    Array.from({ length: Number(archive.through.slice(0, 4)) - 2000 }, (_, i) => 2001 + i),
  );
  for (const year of years) assert.ok(archive.events.some((e) => e.year === year));
  for (const e of archive.events) {
    assert.ok(e.fact && e.analysis && e.kind && e.title);
    assert.equal(new URL(e.source || archive.years[e.year].source).protocol, 'https:');
    if (e.extraSource) assert.equal(new URL(e.extraSource).protocol, 'https:');
    for (const id of e.chapters||[]) assert.ok(catalog.some(c => c.id === id));
  }
  for (const c of catalog) assert.equal(archive.events.filter(e => e.chapters?.includes(c.id)).length,1);
});
