'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { gunzipSync } = require('node:zlib');
const { gridIndex, levelChoices, suitable } = require('../shared/levels.mjs');
const { specs, extraGrid, referencePressure, coarseProfile, pointWeather } = require('./disaster-layers.cjs');
const { archiveProfile, hasArchiveProfile } = require('./era5-column.cjs');
const { describeProfile } = require('./atmosphere.cjs');
const places = new Map(require('../assets/data/places.json').map((p) => [p[0], p]));
const chapters = new Map(require('../assets/data/catalog.json').map((c) => [c.id, c]));
const events = new Map(require('../assets/data/disasters.json').events.map((e) => [e.id, e]));
const directory = path.join(__dirname, '../assets/cases/disaster-fields');
const hour = 3600000,
  missing = -32768,
  magic = 'MDCFS4H1';
const components = ['height', 'u850', 'v850', 'rh', 't2', 'msl', 'u10', 'v10', 'terrain', 'rain'];
const layers = {
  height500: { field: 'height', scale: 1, lead: 0, level: 500 },
  wind850: { field: 'u850', v: 'v850', scale: 10, lead: 1, level: 850 },
  moisture700: { field: 'rh', scale: 10, lead: 2, level: 700 },
  temp2: { field: 't2', scale: 10, lead: 3 },
  pressure: { field: 'msl', scale: 10, lead: 4 },
  wind10: { field: 'u10', v: 'v10', scale: 10, lead: 5 },
  rain4h: { field: 'rain', scale: 10 },
};
const store = require('./disaster-store.cjs');
const { gridGeometry } = store;
const readTable = (bytes, month) => store.readTable(bytes, month, magic);
const readDay = (file, day) => store.readDay(file, day, components, 11);
const loadDay = store.createStore(directory, magic, components, 11);
function formatGrid(data, stamp, layer) {
  const t = Date.parse(stamp),
    slot = data.slots.indexOf(new Date(t).getUTCHours() / 4);
  if (slot < 0) throw Error('归档中没有所选时次');
  const spec = layers[layer],
    wet = layer === 'rain4h';
  const geo = wet ? data.rain : data.shape,
    n = geo.nx * geo.ny,
    offset = slot * n;
  const fine = stamp.slice(0, 7) >= '2026-01';
  const gaussian = ['temp2', 'wind10'].includes(layer);
  const resolution =
    wet || (!gaussian && fine)
      ? '0.5°'
      : gaussian
        ? fine
          ? '1760 × 880 高斯格网'
          : '192 × 94 高斯格网'
        : '2.5°';
  const grid = { ...geo, layer, valid: stamp, resolution, values: new Array(n) };
  const lead = wet ? null : data.leads[slot * 11 + spec.lead];
  if (wet) {
    grid.type = '4 小时模式累计';
    grid.intervalStart = new Date(t - 4 * hour).toISOString();
    grid.intervalEnd = stamp;
    grid.sourceRuns = Array.from({ length: 4 }, (_, i) =>
      new Date(t - (3 - i + data.leads[slot * 11 + 7 + i]) * hour).toISOString(),
    );
  } else {
    grid.lead = lead;
    grid.run = new Date(t - lead * hour).toISOString();
    grid.type = lead === 0 ? '归档分析' : '归档短时预报';
  }
  const models = (grid.sourceRuns || [grid.run]).map((run) => (run < '2011-04-01' ? 'CFSR' : 'CFSv2'));
  grid.source = 'NCEP ' + [...new Set(models)].join(' / ');
  if (spec.level) grid.terrainMask = new Array(n);
  if (spec.v) grid.v = new Array(n);
  const field = data.fields[spec.field],
    v = spec.v && data.fields[spec.v];
  const threshold = spec.level === 850 ? 3 : spec.level === 700 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const j = offset + i,
      terrain = spec.level ? data.fields.terrain[j] : 0;
    const underground = Boolean(spec.level && terrain !== missing && terrain < threshold);
    if (spec.level) grid.terrainMask[i] = Number(underground);
    const unavailable = underground || terrain === missing || field[j] === missing || (v && v[j] === missing);
    grid.values[i] = unavailable ? null : field[j] / spec.scale;
    if (v) grid.v[i] = unavailable ? null : v[j] / spec.scale;
  }
  return grid;
}
function eventStamp(id, rawTime, chapter) {
  const event = events.get(id),
    t = Date.parse(rawTime);
  const c = chapter && event?.chapters?.includes(chapter) && chapters.get(chapter);
  const ok = chapter
    ? c && c.leads.includes((t - Date.parse(c.run + 'T00:00Z')) / hour)
    : event &&
      t % (4 * hour) === 0 &&
      t >= Date.parse(event.map.from) - 8 * hour &&
      t < Date.parse(event.map.to) + 16 * hour;
  if (!ok || !Number.isFinite(t)) throw Object.assign(Error('请选择事件收录的有效时次'), { statusCode: 400 });
  return new Date(t).toISOString();
}
function locationFor(id, stamp, point) {
  const p = places.get(events.get(id).map.place),
    xy = point ?? [p[5], p[4]];
  const g = gridGeometry(stamp.slice(0, 7));
  if (
    !Array.isArray(xy) ||
    xy.length !== 2 ||
    !xy.every(Number.isFinite) ||
    xy[0] < g.bbox[0] ||
    xy[0] > g.bbox[2] ||
    xy[1] < g.bbox[1] ||
    xy[1] > g.bbox[3]
  )
    throw Object.assign(Error('请选择全国格点覆盖内的位置'), { statusCode: 422 });
  return { xy, index: gridIndex(g, ...xy) };
}
function fixedGrid(stamp, layer) {
  if (Object.hasOwn(specs, layer) || layer === 'div200') return extraGrid(stamp, layer);
  if (Object.hasOwn(layers, layer)) return loadDay(stamp).then((d) => formatGrid(d, stamp, layer));
  throw Object.assign(Error('请选择归档中已有的图层'), { statusCode: 400 });
}
async function disasterField(id, layer, rawTime, point) {
  const stamp = eventStamp(id, rawTime);
  if (!['autoTransport', 'autoMoisture', 'autoUpper', 'autoNear'].includes(layer)) {
    const g = await fixedGrid(stamp, layer),
      p = places.get(events.get(id).map.place),
      xy = point ?? [p[5], p[4]];
    const i = gridIndex(g, ...xy);
    if (i >= 0) g.pointStatus = g.terrainMask?.[i] ? 'terrain' : g.values[i] === null ? 'missing' : undefined;
    return g;
  }
  const { index } = locationFor(id, stamp, point),
    ps = await referencePressure(stamp, index);
  const choices = levelChoices(layer, ps);
  for (const choice of choices) {
    if (!Object.hasOwn(layers, choice) && !Object.hasOwn(specs, choice)) continue;
    const g = await fixedGrid(stamp, choice);
    if (g.terrainMask?.[index] || g.values[index] == null || (g.v && g.v[index] == null)) continue;
    if (
      specs[choice]?.[4] === 'era' &&
      !suitable(layer, choice, await referencePressure(stamp, index, 'era'))
    )
      continue;
    return {
      ...g,
      autoRole: layer,
      preferredLayer: choices[0],
      selectionPressure: ps,
      selectionPressureSource: cfsNameAt(stamp),
    };
  }
  throw Object.assign(
    Error(
      '这个时次选点上空缺少合适的' +
        { autoTransport: '输送层风场', autoMoisture: '湿度场', autoUpper: '形势场', autoNear: '近地风场' }[
          layer
        ] +
        '，可另选固定层查看周边。',
    ),
    { statusCode: 422 },
  );
}
function cfsNameAt(time) {
  return time < '2011-04-01' ? 'NCEP CFSR' : 'NCEP CFSv2';
}
async function disasterProfile(id, rawTime, point, full = false, chapter = null) {
  const stamp = eventStamp(id, rawTime, chapter),
    { xy, index } = locationFor(id, stamp, point ?? (chapter ? chapters.get(chapter).point : null));
  if (chapter) {
    const home = chapters.get(chapter).point;
    if (xy.every((v, i) => Math.round(v * 4) === Math.round(home[i] * 4))) {
      try {
        const file = path.join(__dirname, '../assets/cases/chapter-profiles', chapter + '.json.gz');
        const bundle = JSON.parse(gunzipSync(await fs.readFile(file))),
          col = bundle.frames?.[stamp];
        if (
          bundle.id === chapter &&
          col?.valid === stamp &&
          col.detail === 'full' &&
          col.lon === Math.round(xy[0] * 4) / 4 &&
          col.lat === Math.round(xy[1] * 4) / 4
        )
          return describeProfile(col);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const p = places.get(events.get(id).map.place);
  if (Math.round(xy[0] * 4) === Math.round(p[5] * 4) && Math.round(xy[1] * 4) === Math.round(p[4] * 4)) {
    try {
      const buf = await fs.readFile(
        path.join(__dirname, '../assets/cases/disaster-profiles', id + '.json.gz'),
      );
      const col = JSON.parse(gunzipSync(buf));
      if (
        col.valid === stamp &&
        col.lon === Math.round(xy[0] * 4) / 4 &&
        col.lat === Math.round(xy[1] * 4) / 4 &&
        col.detail === 'full'
      )
        return describeProfile(col);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const event = events.get(id),
    t = Date.parse(stamp);
  const localTime =
    t % (4 * hour) === 0 &&
    t >= Date.parse(event.map.from) - 8 * hour &&
    t < Date.parse(event.map.to) + 16 * hour;
  if (full || !localTime) return archiveProfile(stamp, ...xy);
  if (await hasArchiveProfile(stamp, ...xy)) {
    try {
      return await archiveProfile(stamp, ...xy);
    } catch {
      /* The local month remains available offline. */
    }
  }
  return coarseProfile(stamp, index, await loadDay(stamp));
}
async function disasterPoint(id, rawTime, point) {
  const stamp = eventStamp(id, rawTime),
    { index } = locationFor(id, stamp, point);
  return pointWeather(stamp, index, await loadDay(stamp));
}
module.exports = {
  disasterField,
  disasterProfile,
  disasterPoint,
  gridGeometry,
  readTable,
  readDay,
  formatGrid,
};
