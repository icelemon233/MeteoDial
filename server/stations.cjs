'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readCmaStation } = require('./cma-stations.cjs');
const { cached, request } = require('./network.cjs');
const places = require('../assets/data/places.json');
const airports = require('../assets/data/stations.json').map(([id, lat, lon, name]) => ({
  id,
  lat,
  lon,
  name,
}));
const table = fs.readFileSync(
  path.join(__dirname, '../assets/data/cma_national_station_info.dat'),
  'utf8',
);
const national = table
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [province, id, name, grade, lat, lon] = line.split(',');
    return { id, name, grade, province, lat: Number(lat), lon: Number(lon) };
  });
const nationalById = new Map(national.map((s) => [s.id, s]));
const airportById = new Map(airports.map((s) => [s.id, s]));
const provinces = new Set(national.map((s) => s.province));
const forecastPoints = places
  .filter((p) => p[7] === 2)
  .map(([id, , , , lat, lon]) => ({ id, lat, lon }));
const HOUR = 3600000;
const radius = 100;

function distance(lat, lon, site) {
  const rad = Math.PI / 180;
  const chord =
    Math.sin(((site.lat - lat) * rad) / 2) ** 2 +
    Math.cos(lat * rad) * Math.cos(site.lat * rad) * Math.sin(((site.lon - lon) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(chord)));
}
function nearest(sites, lat, lon, count, maxKm = radius) {
  return sites
    .map((site) => ({ id: site.id, km: distance(lat, lon, site) }))
    .filter((site) => site.km <= maxKm)
    .sort((a, b) => a.km - b.km || a.id.localeCompare(b.id))
    .slice(0, count)
    .map(({ id, km }) => ({ id, km: Math.round(km * 10) / 10 }));
}
function stationMatch(lat, lon, province) {
  const limit = provinces.has(province) ? Infinity : radius;
  return {
    national: nearest(national, lat, lon, 1, limit)[0] || null,
    airports: nearest(airports, lat, lon, 4),
  };
}
function matchLocation(lat, lon) {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180)
    throw Object.assign(Error('定位坐标无效'), { statusCode: 400 });
  const point = nearest(forecastPoints, lat, lon, 1, Infinity)[0];
  const match = stationMatch(lat, lon, places.find((p) => p[0] === point.id)[2]);
  if (point.km > radius && (match.national?.km ?? Infinity) > radius)
    throw Object.assign(Error('定位附近没有收录的预报点或国家站，可搜索地点。'), {
      statusCode: 422,
    });
  return { place: point.id, ...match };
}
function matchFromQuery(place, query) {
  if (!query.has('national') && !query.has('airports'))
    return stationMatch(place[4], place[5], place[2]);
  const id = query.get('national');
  const ids = (query.get('airports') || '').split(',').filter(Boolean);
  if (
    (id !== 'none' && !nationalById.has(id)) ||
    ids.length > 4 ||
    new Set(ids).size !== ids.length ||
    ids.some((value) => !airportById.has(value))
  )
    throw Object.assign(Error('站号不在收录的站表内'), { statusCode: 400 });
  return { national: id === 'none' ? null : { id }, airports: ids.map((code) => ({ id: code })) };
}

function fresh(time, now) {
  const age = now - time;
  return Number.isFinite(age) && age >= 0 && age <= 3 * HOUR;
}
function nationalReading(payload, id, now = Date.now()) {
  const site = nationalById.get(id);
  if (
    !site ||
    String(payload?.wmo) !== id ||
    !payload.realtime ||
    typeof payload.realtime !== 'object'
  )
    throw Error('国家站站报格式异常');
  const row = payload.realtime;
  function field(key, min, max) {
    const stamp = row.time?.[key],
      value = row[key];
    if (typeof stamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?$/.test(stamp))
      return null;
    const time = Date.parse(stamp.endsWith('Z') ? stamp : stamp + 'Z');
    return Number.isFinite(value) && value >= min && value <= max && fresh(time, now)
      ? { value, time: new Date(time).toISOString() }
      : null;
  }
  const temp = field('T', -95, 65);
  if (!temp) return null;
  return {
    id,
    station: site.name,
    grade: site.grade,
    kind: 'national',
    source: '查天气',
    time: temp.time,
    temp: temp.value,
    fields: {
      rh: field('RH', 0, 100),
      stationPressure: field('P', 250, 1100),
      rain1h: field('R1h', 0, 500),
      wind2m: field('WS2m', 0, 120),
      windDirection2m: field('WD2m', 0, 360),
    },
  };
}
async function readQWeather(match) {
  const payload = await cached(
    'q-weather:realtime:v1:' + match.id,
    5 * 60000,
    async () => {
      const response = await request(
        'https://q-weather.info/api/weather/' + match.id + '/realtime/',
        { timeout: 6500 },
      );
      const value = await response.json();
      nationalReading(value, match.id);
      return { value };
    },
    { stale: 3 * HOUR },
  );
  const station = nationalReading(payload, match.id);
  return station && { ...station, km: match.km ?? null, offline: Boolean(payload.offline) };
}
async function readNational(match, readCma=readCmaStation, readQ=readQWeather) {
  const site=nationalById.get(match.id);
  if (!site) throw Error('站号不在国家站目录中');
  const [official,other]=await Promise.allSettled([readCma(match.id),readQ(match)]);
  const cma=official.status==='fulfilled' && official.value
    ? {...official.value,station:site.name,grade:site.grade,km:match.km??null} : null;
  const q=other.status==='fulfilled'?other.value:null;
  if (cma && (!q || Date.parse(cma.time)>=Date.parse(q.time))) return cma;
  if (q) return cma ? {...q,cma} : q;
  const failure=[official,other].find(r=>r.status==='rejected'&&r.reason?.statusCode!==404);
  if (failure) throw failure.reason;
  return null;
}
async function withCmaReport(result,match) {
  const id=match.national?.id;
  if (!id||result.closest?.id!==id||result.cmaChecked) return result;
  const prior=result.station;
  const q=prior?.kind==='national'&&prior.id===id&&fresh(Date.parse(prior.time),Date.now())?prior:null;
  const station=await readNational(match.national,readCmaStation,async()=>q).catch(()=>null);
  return station?{...result,station,nationalState:'ready',cmaChecked:true}:result;
}
async function readAviation(matches) {
  if (!matches.length) return null;
  const ids = matches.map((s) => s.id).join(',');
  const result = await cached(
    'metar-v2:' + ids,
    20 * 60000,
    async () => {
      const response = await request(
        'https://aviationweather.gov/api/data/metar?ids=' + ids + '&format=json&hours=4',
        { timeout: 7000 },
      );
      const list = response.status === 204 ? [] : await response.json();
      if (!Array.isArray(list)) throw Error('航空站报格式异常');
      return { value: { list } };
    },
    { stale: 3 * HOUR },
  );
  for (const match of matches) {
    const report = result.list
      .filter(
        (r) =>
          r?.icaoId === match.id &&
          Number.isFinite(r.temp) &&
          fresh(Number(r.obsTime) * 1000, Date.now()),
      )
      .sort((a, b) => b.obsTime - a.obsTime)[0];
    if (report)
      return {
        id: match.id,
        station: airportById.get(match.id).name,
        kind: 'aviation',
        source: 'NOAA AWC',
        km: match.km ?? null,
        time: new Date(report.obsTime * 1000).toISOString(),
        temp: report.temp,
        wind: Number.isFinite(report.wspd) ? Math.round(report.wspd * 0.51444 * 10) / 10 : null,
        pressure: Number.isFinite(report.altim) ? report.altim : null,
        direction: Number.isFinite(report.wdir) ? report.wdir : null,
        offline: Boolean(result.offline),
      };
  }
  return null;
}
async function observations(match, readLand = readNational, readAir = readAviation) {
  let nationalState = 'out-of-range';
  const closest = match.national && {
    ...match.national,
    name: nationalById.get(match.national.id).name,
  };
  if (closest) {
    try {
      const station = await readLand(closest);
      if (station) return { station, closest, nationalState: 'ready' };
      nationalState = 'empty';
    } catch (e) {
      nationalState = e.statusCode === 404 ? 'empty' : 'unavailable';
    }
  }
  try {
    return { station: await readAir(match.airports), closest, nationalState };
  } catch {
    return { station: null, closest, nationalState, aviationUnavailable: true };
  }
}
module.exports = { matchLocation, matchFromQuery, observations, nationalReading, readNational, withCmaReport };
