'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { inflateSync } = require('node:zlib');
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
function gridGeometry(month, rain = false) {
  const step = rain || month >= '2026-01' ? 1 : 2.5,
    west = step === 1 ? 53 : 52.5;
  return {
    step,
    bbox: [west, 0, 165, 75],
    nx: Math.round((165 - west) / step) + 1,
    ny: Math.round(75 / step) + 1,
  };
}
function readTable(bytes, month) {
  if (bytes.toString('ascii', 0, 8) !== magic) throw Error('历史格点文件标识不匹配');
  const offset = 12 + bytes.readUInt32LE(8);
  if (offset > bytes.length || offset > 65536) throw Error('历史格点目录长度无效');
  const table = JSON.parse(bytes.toString('ascii', 12, offset));
  if (table.version !== 1 || table.cadence !== 4 || table.month !== month) throw Error('历史格点月份不匹配');
  return { bytes, offset, table };
}
function readDay(file, day) {
  const entry = file.table.days[day];
  if (!entry) throw Error('归档中没有所选日期');
  const [start, size, mask] = entry,
    end = file.offset + start + size;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    size < 1 ||
    end > file.bytes.length ||
    !Number.isInteger(mask) ||
    mask <= 0 ||
    mask >= 64
  )
    throw Error('历史格点分块无效');
  const slots = [0, 1, 2, 3, 4, 5].filter((i) => mask & (1 << i));
  const shape = gridGeometry(file.table.month),
    rain = gridGeometry(file.table.month, true);
  const expected = slots.length * (11 + 2 * (9 * shape.nx * shape.ny + rain.nx * rain.ny));
  const raw = inflateSync(file.bytes.subarray(file.offset + start, end), { maxOutputLength: expected });
  if (raw.length !== expected) throw Error('历史格点数据长度不完整');
  const leads = raw.subarray(0, slots.length * 11),
    fields = {};
  let pos = leads.length;
  for (const key of components) {
    const { nx, ny } = key === 'rain' ? rain : shape,
      cells = nx * ny,
      n = slots.length * cells;
    const a = new Int16Array(n);
    for (let i = 0; i < n; i++)
      a[i] = (raw[pos + i] | (raw[pos + n + i] << 8)) + (i >= cells ? a[i - cells] : 0);
    for (let i = 0; i < n; i += nx) for (let x = i + 1; x < i + nx; x++) a[x] += a[x - 1];
    fields[key] = a;
    pos += 2 * n;
  }
  return { leads, slots, fields, shape, rain };
}
function retain(cache, key, load, limit) {
  let entry = cache.get(key);
  if (entry) cache.delete(key);
  else {
    entry = Promise.resolve()
      .then(load)
      .catch((e) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw e;
      });
  }
  cache.set(key, entry);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return entry;
}
const monthCache = new Map(),
  dayCache = new Map();
function loadDay(stamp) {
  const month = stamp.slice(0, 7),
    day = Number(stamp.slice(8, 10));
  return retain(
    dayCache,
    stamp.slice(0, 10),
    async () => {
      const file = await retain(
        monthCache,
        month,
        async () => readTable(await fs.readFile(path.join(directory, month + '.bin')), month),
        2,
      );
      return readDay(file, day);
    },
    4,
  );
}
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
async function disasterField(id, layer, rawTime) {
  const event = events.get(id),
    t = Date.parse(rawTime);
  if (
    !event ||
    !Object.hasOwn(layers, layer) ||
    !Number.isFinite(t) ||
    t % (4 * hour) !== 0 ||
    t < Date.parse(event.map.from) - 8 * hour ||
    t >= Date.parse(event.map.to) + 16 * hour
  )
    throw Object.assign(Error('请选择事件时段内的有效图层和时次'), { statusCode: 400 });
  const stamp = new Date(t).toISOString();
  return formatGrid(await loadDay(stamp), stamp, layer);
}
module.exports = { disasterField, gridGeometry, readTable, readDay, formatGrid };
