'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { daysFrom, normalize, byId } = require('../server/weather.cjs');
const { positions } = require('../server/sky.cjs');
const { address } = require('../server/grids.cjs');
const root = path.join(__dirname, '..');
test('跨北京时间零点的六小时累计量不算到前一天', () => {
  const rows = [
    {
      time: '2024-01-01T06:00Z',
      temp: 4,
      rain: 2,
      interval: 6,
      wind: 2,
      hi: 6,
      lo: 1,
      condition: '雨',
      code: 'rain',
    },
    {
      time: '2024-01-01T12:00Z',
      temp: 3,
      rain: 9,
      interval: 6,
      wind: 3,
      hi: 7,
      lo: -3,
      condition: '雨',
      code: 'rain',
    },
    {
      time: '2024-01-01T18:00Z',
      temp: -2,
      rain: 0,
      interval: 6,
      wind: null,
      hi: 0,
      lo: -3,
      condition: '晴',
      code: 'clearsky_night',
    },
  ];
  const [day, next] = daysFrom(rows, '2024-01-01');
  assert.equal(day.date, '2024-01-01');
  assert.equal(day.rain, 2);
  assert.equal(day.rainHours, 6);
  assert.equal(day.low, 1);
  assert.equal(next.date, '2024-01-02');
  assert.equal(next.wind, null);
});
test('没有降水资料的时次与预报零降水分开', () => {
  const meta = { updated_at: '2024-01-01T00:00Z' };
  const build = (time, details, period) => ({ time, data: { instant: { details }, ...period } });
  const series = normalize({
    properties: {
      meta,
      timeseries: [
        build(
          '2024-01-01T00:00Z',
          { air_temperature: 0 },
          {
            next_1_hours: {
              details: { precipitation_amount: 0 },
              summary: { symbol_code: 'clearsky_night' },
            },
          }
        ),
        build('2024-01-01T01:00Z', { air_temperature: -1 }, {}),
      ],
    },
  }).series;
  assert.equal(series[0].temp, 0);
  assert.equal(series[0].rain, 0);
  assert.equal(series[1].rain, null);
  assert.equal(series[1].interval, null);
});
test('HKO 经纬度带方位，路径排除没有观测时刻的插值点', () => {
  const xml =
    '<PastInformation><Time>2023-07-28T00:00:00+00:00</Time><Latitude>24.8N</Latitude><Longitude>118.7E</Longitude></PastInformation><PastInformation><Latitude>25N</Latitude><Longitude>119E</Longitude></PastInformation>';
  assert.deepEqual(
    positions(xml, 'PastInformation').map((p) => [p.lat, p.lon]),
    [[24.8, 118.7]]
  );
});
test('全国地点索引、案例帧和真实资料归档完整', () => {
  const places = [...byId.values()];
  assert.ok(places.length >= 3600);
  for (const p of places) {
    assert.ok(Number.isFinite(p[4]) && Number.isFinite(p[5]));
    assert.ok(p[4] > 0 && p[5] > 70);
  }
  for (const c of require('../assets/data/catalog.json')) {
    if (c.climate) {
      for (const m of [0, 3, 6, 9]) {
        const d = require('../assets/cases/belts/climate-' + m + '.json');
        assert.equal(d.values.length, d.nx * d.ny);
        assert.equal(d.months.length, 3);
      }
      continue;
    }
    for (const h of c.leads) {
      const time = new Date(Date.parse(c.run + 'T00:00:00Z') + h * 3600000).toISOString();
      for (const layer of c.layers) {
        const dir = path.join(root, 'assets', 'cases', c.id);
        if (layer === 'satellite')
          assert.equal(
            fs.readFileSync(path.join(dir, time.slice(0, 10) + '.jpg')).readUInt16BE(0),
            0xffd8
          );
        else if (layer === 'track')
          assert.ok(
            JSON.parse(fs.readFileSync(path.join(dir, 'track.json'))).storms[0].analyses.length > 8
          );
        else {
          const g = JSON.parse(fs.readFileSync(path.join(dir, layer + '-' + h + '.json')));
          assert.equal(g.valid, time);
          assert.equal(g.values.length, g.nx * g.ny);
          if (g.v) assert.equal(g.v.length, g.values.length);
          assert.ok(g.values.some(Number.isFinite));
        }
      }
    }
  }
});
test('归档使用起报批次与预报时效共同定位', () => {
  assert.match(
    address('2023-12-19T12:00:00Z', 42, '0p50'),
    /gfs\.20231219\/12\/atmos\/gfs\.t12z\.pgrb2\.0p50\.f042$/
  );
});
