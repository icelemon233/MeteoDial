'use strict';
const path = require('node:path');
const { createStore } = require('./disaster-store.cjs');
const { specificHumidity, makeProfile, divergence } = require('./atmosphere.cjs');
const cfs = require('../assets/data/disaster-columns.json'),
  era = require('../assets/data/disaster-analysis-fields.json');
const directory = (name) => path.join(__dirname, '../assets/cases', name);
const cfsDay = createStore(directory('disaster-columns'), cfs.magic, cfs.fields, cfs.leadFields.length);
const eraDay = createStore(directory('disaster-analysis-fields'), era.magic, era.fields, 0);
const missing = -32768,
  H = 3600000;
const specs = {
  wind700: ['u700', 'v700', 4, 700],
  wind500: ['u500', 'v500', 4, 500],
  wind200: ['u200', 'v200', 4, 200],
  height700: ['z700', null, 1, 700],
  temp850: ['t850', null, 10, 850],
  temp700: ['t700', null, 10, 700],
  temp500: ['t500', null, 10, 500],
  moisture850: ['rh850', null, 2, 850],
  moisture500: ['rh500', null, 2, 500],
  wind925: ['u925', 'v925', 4, 925, 'era'],
  wind600: ['u600', 'v600', 4, 600, 'era'],
  wind400: ['u400', 'v400', 4, 400, 'era'],
  omega700: ['omega700', null, 1000, 700, 'era'],
  height400: ['z400', null, 1, 400, 'era'],
  height300: ['z300', null, 1, 300, 'era'],
  temp600: ['temp600', null, 5, 600, 'era'],
  temp400: ['temp400', null, 5, 400, 'era'],
  moisture600: ['rh600', null, 1, 600, 'era'],
  moisture400: ['rh400', null, 1, 400, 'era'],
};
function slotAt(data, time) {
  const slot = data.slots.indexOf(new Date(time).getUTCHours() / 4);
  if (slot < 0) throw Error('归档中没有该时次');
  return slot;
}
function at(data, key, offset, scale) {
  const v = data.fields[key][offset];
  return v === missing ? null : v / scale;
}
function lead(data, slot, key) {
  return data.leads[slot * cfs.leadFields.length + cfs.leadFields.indexOf(key)];
}
const runFor = (time, h) => new Date(Date.parse(time) - h * H).toISOString();
const cfsName = (run) => (run < '2011-04-01' ? 'NCEP CFSR' : 'NCEP CFSv2');

async function extraGrid(time, layer) {
  if (layer === 'div200') return divergence(await extraGrid(time, 'wind200'));
  const [key, v, scale, p, model] = specs[layer],
    isEra = model === 'era';
  const data = await (isEra ? eraDay : cfsDay)(time),
    slot = slotAt(data, time),
    g = data.shape,
    n = g.nx * g.ny,
    off = slot * n;
  const grid = { ...g, layer, valid: time, values: new Array(n), terrainMask: new Array(n) };
  if (v) grid.v = new Array(n);
  if (isEra) {
    if (!['ECMWF ERA5', 'ECMWF ERA5T'].includes(data.source) || !data.resolution)
      throw Error('再分析格点的来源记录不完整');
    grid.source = data.source;
    grid.type = grid.source.endsWith('T') ? '初步再分析' : '归档再分析';
    grid.resolution = data.resolution;
    grid.channel = data.resolution === '1.5°' ? 'WeatherBench 2 保守重采样' : 'ERA5 公共逐小时归档';
  } else {
    const identity = key.startsWith('rh') ? 't' + p : key;
    grid.lead = lead(data, slot, identity);
    grid.run = runFor(time, grid.lead);
    grid.source = cfsName(grid.run);
    grid.type = grid.lead ? '归档短时预报' : '归档分析';
    grid.resolution = time < '2026-01' ? '2.5°' : '0.5°';
  }
  for (let i = 0; i < n; i++) {
    const j = off + i,
      ps = at(data, 'ps', j, 10),
      below = ps !== null && ps <= p;
    const value = at(data, key, j, scale),
      second = v && at(data, v, j, scale);
    const absent = ps === null || below || value === null || (v && second === null);
    grid.terrainMask[i] = Number(below);
    grid.values[i] = absent ? null : value;
    if (v) grid.v[i] = absent ? null : second;
  }
  return grid;
}
async function referencePressure(time, index, model = 'cfs') {
  const d = await (model === 'era' ? eraDay : cfsDay)(time),
    slot = slotAt(d, time);
  return at(d, 'ps', slot * d.shape.nx * d.shape.ny + index, 10);
}
async function coarseProfile(time, index, core) {
  const aux = await cfsDay(time),
    slot = slotAt(aux, time),
    original = slotAt(core, time),
    g = aux.shape,
    n = g.nx * g.ny;
  const i = slot * n + index,
    j = original * n + index,
    ps = at(aux, 'ps', i, 10),
    t2 = at(core, 't2', j, 10);
  const source = cfsName(runFor(time, lead(aux, slot, 'ps')));
  const levels = [850, 700, 500].map((p) => {
    const temp = at(aux, 't' + p, i, 10),
      rh = p === 700 ? at(core, 'rh', j, 10) : at(aux, 'rh' + p, i, 2);
    return {
      pressure: p,
      temp,
      q: specificHumidity(p, temp, rh),
      run: runFor(time, lead(aux, slot, 't' + p)),
    };
  });
  return {
    ...makeProfile({
      source,
      valid: time,
      type: '归档分析及短时预报',
      lon: g.bbox[0] + (index % g.nx) * g.step,
      lat: g.bbox[3] - Math.floor(index / g.nx) * g.step,
      resolution: g.step + '°',
      surface: {
        pressure: ps,
        temp: t2,
        q: specificHumidity(ps, t2, at(aux, 'rh2', i, 2)),
        run: runFor(time, lead(aux, slot, 'q2')),
      },
      levels,
    }),
    detail: 'basic',
  };
}
async function pointWeather(time, index, core) {
  const [cf, er] = await Promise.all([cfsDay(time), eraDay(time)]),
    g = cf.shape,
    n = g.nx * g.ny;
  const a = slotAt(cf, time) * n + index,
    b = slotAt(er, time) * n + index,
    j = slotAt(core, time) * n + index;
  const row = {
    ps: at(cf, 'ps', a, 10),
    eraPs: at(er, 'ps', b, 10),
    height500: at(core, 'height', j, 1),
    temp2: at(core, 't2', j, 10),
    moisture700: at(core, 'rh', j, 10),
    moisture500: at(cf, 'rh500', a, 2),
    moisture600: at(er, 'rh600', b, 1),
    moisture400: at(er, 'rh400', b, 1),
  };
  for (const c of 'uv') {
    row[c + '850'] = at(core, c + '850', j, 10);
    row[c + '10'] = at(core, c + '10', j, 10);
    for (const p of [700, 500]) row[c + p] = at(cf, c + p, a, 4);
    for (const p of [600, 400]) row[c + p] = at(er, c + p, b, 4);
  }
  return {
    valid: time,
    lon: g.bbox[0] + (index % g.nx) * g.step,
    lat: g.bbox[3] - Math.floor(index / g.nx) * g.step,
    reading: row,
  };
}
module.exports = { specs, extraGrid, referencePressure, coarseProfile, pointWeather };
