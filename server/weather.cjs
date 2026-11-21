'use strict';
const { cached, request } = require('./network.cjs');
const places = require('../assets/data/places.json');
const byId = new Map(places.map((p) => [p[0], p]));
const H = 36e5;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dayOf = (time) => new Date(Date.parse(time) + 8 * H).toISOString().slice(0, 10);
function symbol(code) {
  const c = (code || '').split('_')[0];
  if (!c) return '暂无';
  const a = c.includes('heavy') ? '强' : c.includes('light') ? '小' : '';
  if (c.includes('thunder')) return c.includes('snow') ? '雷雪' : '雷阵雨';
  if (c.includes('sleet')) return '雨夹雪';
  if (c.includes('snow')) return a + (c.includes('shower') ? '阵雪' : '雪');
  if (c.includes('rain')) return a + (c.includes('shower') ? '阵雨' : '雨');
  return (
    { clearsky: '晴', fair: '晴间多云', partlycloudy: '多云', cloudy: '阴', fog: '雾' }[c] || '云量变化'
  );
}
function normalize(payload) {
  const props = payload?.properties;
  if (!Array.isArray(props?.timeseries) || !props.meta?.updated_at) throw Error('预报数据格式异常');
  const series = props.timeseries
    .map((row) => {
      const d = row.data?.instant?.details || {},
        interval = row.data?.next_1_hours ? 1 : row.data?.next_6_hours ? 6 : null;
      const period = interval ? row.data['next_' + interval + '_hours'] : null;
      return {
        time: row.time,
        temp: num(d.air_temperature),
        wind: num(d.wind_speed),
        direction: num(d.wind_from_direction),
        rh: num(d.relative_humidity),
        pressure: num(d.air_pressure_at_sea_level),
        cloud: num(d.cloud_area_fraction),
        rain: num(period?.details?.precipitation_amount),
        interval,
        code: period?.summary?.symbol_code || null,
        condition: symbol(period?.summary?.symbol_code),
        lo: num(row.data?.next_6_hours?.details?.air_temperature_min),
        hi: num(row.data?.next_6_hours?.details?.air_temperature_max),
      };
    })
    .filter((p) => Number.isFinite(Date.parse(p.time)) && p.temp !== null);
  if (series.length < 2) throw Error('预报时次不足');
  return { issued: props.meta.updated_at, series, source: 'MET Norway · Locationforecast' };
}
function daysFrom(series, startDate) {
  const groups = new Map();
  for (const row of series) {
    const key = dayOf(row.time);
    if (key < startDate) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].slice(0, 10).map(([date, rows]) => {
    const end = Date.parse(date + 'T00:00:00+08:00') + 24 * H;
    const temps = rows.flatMap((r) =>
      (Date.parse(r.time) + 6 * H <= end ? [r.temp, r.lo, r.hi] : [r.temp]).filter(Number.isFinite)
    );
    const withRain = rows.filter(
      (r) => r.rain !== null && r.interval && Date.parse(r.time) + r.interval * H <= end
    );
    const notable = rows
      .filter((r) => r.code)
      .sort((a, b) => (b.rain || 0) / (b.interval || 1) - (a.rain || 0) / (a.interval || 1));
    const count = withRain.reduce((s, r) => s + r.interval, 0);
    const winds = rows.map((r) => r.wind).filter(Number.isFinite);
    return {
      date,
      low: Math.min(...temps),
      high: Math.max(...temps),
      wind: winds.length ? Math.max(...winds) : null,
      rainHours: count,
      rain: withRain.length ? Math.round(withRain.reduce((s, r) => s + r.rain, 0) * 10) / 10 : null,
      partial: count < 24,
      condition: notable[0]?.condition ?? '暂无',
      code: notable[0]?.code,
      rows,
    };
  });
}
async function forecast(id) {
  const p = byId.get(id);
  if (!p) throw Error('地点不存在');
  const value = await cached(
    'met-complete-v2:' + id,
    35 * 60000,
    async () => {
      const url =
        'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=' +
        p[4].toFixed(3) +
        '&lon=' +
        p[5].toFixed(3);
      const res = await request(url),
        expires = Date.parse(res.headers.get('expires') || '') || Date.now() + 35 * 60000;
      return { value: { ...normalize(await res.json()), expiresAt: expires }, expires };
    },
    { stale: 36 * H }
  );
  const hour = Math.floor(Date.now() / H) * H;
  const active = value.series.filter((r) => Date.parse(r.time) >= hour);
  if (!active.length) throw Error('现有预报已经过期');
  return {
    ...value,
    series: undefined,
    place: p,
    current: active[0],
    hourly: active.filter((r) => Date.parse(r.time) < hour + 48 * H),
    daily: daysFrom(value.series, dayOf(new Date().toISOString())),
  };
}
module.exports = { forecast, byId, normalize, daysFrom, symbol };
