'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { forecastTimes, forecastFrame, availableLead, nearestFrame, frameStops } = require('../shared/timeline.mjs');
const { resolveLiveGrid } = require('../server/live-grids.cjs');
const { sources, googleGfs, fieldError } = require('../server/grid-sources.cjs');
const H = 3600000, run = '2023-12-10T00:00:00.000Z', start = Date.parse(run);

test('实时预报前120小时逐小时，后期只选原始三小时时效', () => {
  const hours = forecastTimes(run).map(t => (t - start) / H);
  assert.deepEqual(hours.slice(0, 139), Array.from({length: 139}, (_, i) => i - 18));
  assert.deepEqual(hours.slice(139), Array.from({length: 40}, (_, i) => 123 + 3 * i));
  for (const h of [0, 1, 2, 119, 120, 123, 237, 240]) {
    assert.equal(availableLead(h), true);
    assert.deepEqual(forecastFrame(run, start + h * H), {run, lead: h});
  }
  for (const h of [0.5, 121, 122, 241]) assert.equal(forecastFrame(run, start + h * H), null);
  assert.deepEqual(forecastFrame(run, start - H), {run:'2023-12-09T18:00:00.000Z', lead:5});
});

test('时间轴按真实间隔定位，间隔中的指针吸附到最近的真实时次', () => {
  const stops = frameStops([24,216,384,528,552].map(h => start + h * H));
  assert.deepEqual(stops, [0,8,15,21,22]);
  assert.equal(nearestFrame(stops, 4), 0);
  assert.equal(nearestFrame(stops, 5), 1);
  assert.equal(nearestFrame(stops, 18), 2);
  assert.equal(nearestFrame(stops, 20), 3);
  assert.deepEqual(frameStops([0,3,6,9]), [0,1,2,3]);
  assert.deepEqual(frameStops([start]), [0]);
  assert.deepEqual(frameStops([]), []);
});

test('逐小时时次只接受同批、同一有效时刻的模式场', async () => {
  const calls = [];
  const get = (time) => resolveLiveGrid(run, 1, 'temp2', null, {
    providers: [sources.find(v => v.id === 'ifs'), sources[0], googleGfs],
    read: async (source, cycle, lead, layer) => {
      calls.push([source.id, lead]);
      if (source.id === 'gfs') throw fieldError('字段暂缺');
      return { sourceId: source.id, layer, run: cycle, valid: new Date(time).toISOString(),
        nx:1, ny:1, bbox:[100,30,100,30], step:1, values:[3] };
    },
  });
  assert.equal((await get(start + H)).sourceId, 'gfs-google');
  assert.deepEqual(calls, [['gfs',1],['gfs-google',1]]);
  await assert.rejects(get(start), /未取得/);
});

test('北京初雪离线逐小时归档在午夜前后连续，五个模式图层与原生时次一致', () => {
  const c = require('../assets/data/catalog.json').find(item => item.id === 'beijing-snow');
  assert.deepEqual(c.leads, Array.from({length:28}, (_, i) => i));
  const layers = c.layers.filter(layer => layer !== 'satellite');
  assert.equal(layers.length, 5);
  for (const h of c.leads) {
    for (const layer of layers) {
      const file = path.join(__dirname, '../assets/cases', c.id, layer + '-' + h + '.json');
      const grid = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(grid.run, run);
      assert.equal(grid.lead, h);
      assert.equal(Date.parse(grid.valid), start + h * H);
      assert.equal(grid.resolution, '0.25°');
      assert.equal(grid.step, 0.5);
    }
  }
});
