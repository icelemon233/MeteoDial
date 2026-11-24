'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { forecastTimes, forecastFrame, availableLead, nearestFrame, frameStops } = require('../shared/timeline.mjs');
const { resolveLiveGrid } = require('../server/live-grids.cjs');
const { sources, googleGfs, fieldError } = require('../server/grid-sources.cjs');
const H = 3600000, run = '2023-12-10T00:00:00.000Z', start = Date.parse(run);

test('切换倍速按本帧剩余时间重新计时，暂停会释放当前等待', async (t) => {
  const { playbackClock } = await import('../ui/playback-clock.js');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({apis:['setTimeout']});
  const advance = async (ms) => { now += ms; t.mock.timers.tick(ms); await Promise.resolve(); };
  const clock = playbackClock();
  let advances = 0;
  clock.wait().then(() => advances++);
  await advance(250);
  clock.setRate(2);
  await advance(249);
  assert.equal(advances, 0);
  await advance(1);
  assert.equal(advances, 1);
  clock.setRate(4);
  clock.wait().then(() => advances++);
  await advance(50);
  clock.setRate(0.5);
  await advance(1099);
  assert.equal(advances, 1);
  await advance(1);
  assert.equal(advances, 2);
  clock.wait().then(() => advances++);
  clock.cancel();
  await advance(3000);
  assert.equal(advances, 3);
});

test('播放切换图数复用进行中的请求，只预读可见图层的下一时次', async () => {
  const { playbackBuffer } = await import('../ui/playback-buffer.js');
  const requests = new Map();
  const fields = playbackBuffer((layer, time, group) => {
    const id = layer + time;
    assert.ok(!requests.has(id), '重复读取 ' + id);
    return new Promise((resolve, reject) => {
      requests.set(id, {resolve, signal:group.controller.signal});
      group.controller.signal.addEventListener('abort', () => reject(Error('cancelled')), {once:true});
    });
  });
  const [first] = fields.plan(['wind'], 1, 2);
  const four = fields.plan(['wind','pressure','temp','height'], 1, 2);
  assert.equal(four[0], first);
  requests.get('temp1').resolve(12);
  await four[2];
  assert.ok(requests.has('temp2'));
  assert.ok(!requests.has('wind2'));
  const single = fields.plan(['wind'], 1, 2);
  assert.equal(single[0], first);
  assert.ok(requests.get('temp2').signal.aborted);
  assert.ok(requests.get('pressure1').signal.aborted);
  assert.ok(!requests.get('wind1').signal.aborted);
  requests.get('wind1').resolve(8);
  assert.deepEqual(await first, {status:'fulfilled',value:8});
  assert.ok(requests.has('wind2'));
  const [next] = fields.plan(['wind'], 2, 3);
  fields.clear();
  assert.equal((await next).status, 'rejected');
  assert.ok(!requests.has('wind3'));
});

test('实时预报前120小时逐小时，后期只选原始三小时时效', () => {
  const hours = forecastTimes(run).map(t => (t - start) / H);
  assert.deepEqual(
    hours.slice(0, 145),
    Array.from({ length: 145 }, (_, i) => i - 24),
  );
  assert.deepEqual(
    hours.slice(145),
    Array.from({ length: 40 }, (_, i) => 123 + 3 * i),
  );
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

test('河南暴雨专题在峰值期连续逐小时，四个模式图层与原生时次一致', () => {
  const c = require('../assets/data/catalog.json').find(item => item.id === 'henan-2021');
  const run=c.run+'T00:00:00.000Z', start=Date.parse(run);
  assert.deepEqual(c.leads.filter(h=>h>=36&&h<=63), Array.from({length:28}, (_, i) => 36+i));
  const layers = c.layers.filter(layer => layer !== 'satellite');
  assert.equal(layers.length, 4);
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
