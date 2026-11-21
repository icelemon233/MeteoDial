'use strict';
const { request, cached } = require('./network.cjs');
const { createEccodes } = require('@meri-imperiumi/eccodes-wasm');
const HOUR = 3600000;
const origin = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
const boxes = {
  asia: [55, 5, 165, 75],
  bohai: [112, 30, 132, 45],
  beijing: [110, 35, 122, 44],
  henan: [106, 29, 123, 41],
  south: [75, 15, 126, 40],
  coast: [105, 10, 145, 43],
  globe: [0, -88, 358, 88],
};
const fields = {
  wind10: [
    ['UGRD', '10 m above ground'],
    ['VGRD', '10 m above ground'],
  ],
  temp2: [['TMP', '2 m above ground']],
  pressure: [['PRMSL', 'mean sea level']],
  rainRate: [['PRATE', 'surface']],
  snowFlag: [['CSNOW', 'surface']],
  surfacePressure: [['PRES', 'surface']],
};
for (const level of [925, 850, 700, 600, 500, 400, 300]) {
  const isobar = level + ' mb';
  fields['wind' + level] = [['UGRD', isobar], ['VGRD', isobar]];
  fields['temp' + level] = [['TMP', isobar]];
  fields['moisture' + level] = [['RH', isobar]];
}
for (const level of [500, 400, 300]) fields['height' + level] = [['HGT', level + ' mb']];
let engine;
function address(run, lead, resolution) {
  const date = new Date(run).toISOString();
  const ymd = date.slice(0, 10).replaceAll('-', '');
  const hh = date.slice(11, 13);
  return (
    origin +
    '/gfs.' +
    ymd +
    '/' +
    hh +
    '/atmos/gfs.t' +
    hh +
    'z.pgrb2.' +
    resolution +
    '.f' +
    String(lead).padStart(3, '0')
  );
}
async function indexFor(url) {
  return cached('index3:' + url, 7 * 864e5, async () => {
    const txt = await (await request(url + '.idx')).text();
    const rows = txt
      .trim()
      .split('\n')
      .map((line) => line.split(':'));
    if (rows.length < 20 || !rows[0][2].startsWith('d=')) throw Error('模式索引格式异常');
    return {
      value: rows.map((p, i) => ({
        at: Number(p[1]),
        end: i < rows.length - 1 ? Number(rows[i + 1][1]) - 1 : null,
        field: p[3],
        level: p[4],
        period: p[5],
      })),
    };
  });
}
async function latestRun() {
  return cached(
    'gfs-latest-v2',
    30 * 60000,
    async () => {
      const start = Math.floor((Date.now() - 4 * HOUR) / (6 * HOUR)) * 6 * HOUR;
      for (let i = 0; i < 6; i++) {
        const run = start - i * 6 * HOUR;
        try {
          await indexFor(address(run, 24, '1p00'));
          return { value: { run: new Date(run).toISOString() } };
        } catch (e) {
          if (e.statusCode !== 404 && e.statusCode !== 403) throw e;
        }
      }
      throw Error('暂无可用的 GFS 起报批次');
    },
    { stale: 36 * HOUR }
  );
}
async function fetchField(url, item, bbox, step) {
  if (item.end === null || item.end - item.at > 8 * 1024 * 1024) throw Error('气象字段长度异常');
  const res = await request(url, {
    headers: { Range: 'bytes=' + item.at + '-' + item.end },
    timeout: 30000,
  });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw Error('上游未提供所需数据分段');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== 'GRIB' || bytes.length !== item.end - item.at + 1)
    throw Error('气象数据不完整');
  engine ||= createEccodes().catch((e) => {
    engine = undefined;
    throw e;
  });
  const ec = await engine;
  const name = '/work/field.grib';
  ec.writeFile(name, bytes);
  const handle = ec.openGrib(name);
  try {
    const nx = Number(handle.getLong('Ni')),
      ny = Number(handle.getLong('Nj'));
    const dx = Number(handle.getDouble('iDirectionIncrementInDegrees')),
      dy = Number(handle.getDouble('jDirectionIncrementInDegrees'));
    const west = Number(handle.getDouble('longitudeOfFirstGridPointInDegrees'));
    const north = Number(handle.getDouble('latitudeOfFirstGridPointInDegrees'));
    if (Math.abs(north - 90) > 0.1 || west !== 0 || nx * ny <= 0 || nx * ny > 2e6)
      throw Error('模式格网格式未识别');
    const a = handle.getDoubleArray('values');
    const missing = handle.getLong('bitmapPresent') ? Number(handle.getDouble('missingValue')) : NaN;
    const list = [];
    for (let lat = bbox[3]; lat >= bbox[1] - 0.001; lat -= step) {
      const row = Math.round((north - lat) / dy);
      for (let lon = bbox[0]; lon <= bbox[2] + 0.001; lon += step) {
        const col = (Math.round((lon - west) / dx) + nx) % nx;
        let v = a[row * nx + col];
        if (!Number.isFinite(v) || v === missing || Math.abs(v) >= 1e10) { list.push(null); continue; }
        if (item.field === 'TMP') v -= 273.15;
        if (item.field === 'PRMSL' || item.field === 'PRES') v /= 100;
        if (item.field === 'PRES' && (v < 250 || v > 1100)) { list.push(null); continue; }
        if (item.field === 'PRATE') v *= 3600;
        const precision = item.field === 'PRATE' ? 100 : 10;
        list.push(
          Number.isFinite(v) && Math.abs(v) < 20000 ? Math.round(v * precision) / precision : null
        );
      }
    }
    return list;
  } finally {
    handle.delete();
  }
}
async function readGrid(run, lead, layer, box = 'asia', resolution = '1p00', step = 1) {
  const bbox = boxes[box],
    specs = fields[layer];
  if (!bbox || !specs) throw Error('未知图层');
  const url = address(run, lead, resolution);
  return cached(['gfs-grid-v7', url, layer, box, step].join(':'), 10 * 864e5, async () => {
    const index = await indexFor(url);
    const arrays = await Promise.all(
      specs.map(([tag, lev]) => {
        const entry = index.find(
          (e) =>
            e.field === tag &&
            e.level === lev &&
            (!['PRATE', 'CSNOW'].includes(tag) || !/(?:ave|acc) fcst/.test(e.period))
        );
        if (!entry) throw Error('此批次缺少所选字段');
        return layer === 'surfacePressure' ? readSurface(url, entry, box, step) : fetchField(url, entry, bbox, step);
      })
    );
    const pressureLevel = specs[0][1].match(/^(\d+) mb$/);
    let terrainMask;
    if (pressureLevel) {
      const surfaceEntry = index.find((e) => e.field === 'PRES' && e.level === 'surface');
      if (!surfaceEntry) throw Error('缺少地面气压，无法识别地形遮挡');
      const surface = await readSurface(url, surfaceEntry, box, step);
      terrainMask = surface.map((ps) => Number.isFinite(ps) && ps <= Number(pressureLevel[1]) ? 1 : 0);
      for (let i = 0; i < surface.length; i++)
        if (surface[i] === null || terrainMask[i])
          for (const array of arrays) array[i] = null;
    }
    return {
      value: {
        layer,
        bbox,
        step,
        nx: Math.round((bbox[2] - bbox[0]) / step) + 1,
        ny: Math.round((bbox[3] - bbox[1]) / step) + 1,
        run: new Date(run).toISOString(),
        valid: new Date(new Date(run).getTime() + lead * HOUR).toISOString(),
        lead,
        type: lead === 0 ? '模式分析' : '模式预报',
        source: 'NOAA GFS',
        resolution: resolution.replace('p', '.') + '°',
        values: arrays[0],
        v: arrays[1],
        terrainMask,
      },
    };
  });
}
function readSurface(url, entry, box, step) {
  return cached(['gfs-ps-v3', url, box, step].join(':'), 10 * 864e5, async () => ({
    value: await fetchField(url, entry, boxes[box], step),
  }));
}
module.exports = { fields, boxes, readGrid, latestRun, address };
