'use strict';
const { createEccodes } = require('@meri-imperiumi/eccodes-wasm');
const { request } = require('./network.cjs');
const { retryLater } = require('./grid-sources.cjs');

const maxBytes = 8 * 1024 * 1024;
const parameters = {
  TMP: [0, 0],
  RH: [1, 1],
  UGRD: [2, 2],
  VGRD: [2, 3],
  HGT: [3, 5],
  PRES: [3, 0],
  PRATE: [1, 7],
  CSNOW: [1, 195],
};
let engine;
function stamp(time) {
  return new Date(time).toISOString().slice(0, 16).replace(/[-T:]/g, '');
}
function checkMessage(h, entry, run, lead, source) {
  const time = (date, hour) => h.getString(date) + String(h.getLong(hour)).padStart(4, '0');
  if (
    time('dataDate', 'dataTime') !== stamp(run) ||
    time('validityDate', 'validityTime') !== stamp(new Date(run).getTime() + lead * 36e5) ||
    h.getString('stepType') !== 'instant'
  )
    throw Error('GRIB 时次或统计时段不匹配');
  const param =
    entry.field === 'PRMSL' ? [3, source.model === 'ifs' ? 0 : 1] : parameters[entry.field];
  if (
    param &&
    (h.getLong('discipline') !== 0 ||
      h.getLong('parameterCategory') !== param[0] ||
      h.getLong('parameterNumber') !== param[1])
  )
    throw Error('GRIB 要素与索引不匹配');
  const level = entry.level,
    type = h.getString('typeOfLevel');
  if (
    (level.endsWith(' mb') &&
      (type !== 'isobaricInhPa' || h.getLong('level') !== parseInt(level, 10))) ||
    (level.includes('above ground') &&
      (type !== 'heightAboveGround' || h.getLong('level') !== parseInt(level, 10))) ||
    (level === 'surface' && type !== 'surface') ||
    (level === 'mean sea level' && type !== 'meanSea')
  )
    throw Error('GRIB 垂直层与索引不匹配');
  if (source.model === 'gefs' && h.getLong('perturbationNumber') !== 0)
    throw Error('GEFS 资料不是控制成员');
  if ((entry.field === 'UGRD' || entry.field === 'VGRD') && h.getLong('uvRelativeToGrid') !== 0)
    throw Error('模式风向坐标无法识别');
}
async function fetchField(source, run, lead, entry, bbox, step) {
  return retryLater(entry.url + '@' + entry.at, async () => {
    if (
      !Number.isSafeInteger(entry.at) ||
      entry.at < 0 ||
      (entry.end !== null && (entry.end - entry.at + 1 > maxBytes || entry.end < entry.at))
    )
      throw Error('气象字段长度异常');
    const response = await request(entry.url, {
      headers: { Range: 'bytes=' + entry.at + '-' + (entry.end ?? '') },
      timeout: 15000,
      preferSystem: true,
    });
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
    const size = range && Number(range[2]) - Number(range[1]) + 1;
    if (
      response.status !== 206 ||
      !range ||
      Number(range[1]) !== entry.at ||
      (entry.end !== null && Number(range[2]) !== entry.end) ||
      Number(range[2]) >= Number(range[3]) ||
      size < 20 ||
      size > maxBytes
    ) {
      await response.body?.cancel();
      throw Error('上游未返回所需 GRIB 分段');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length !== size ||
      bytes.toString('ascii', 0, 4) !== 'GRIB' ||
      bytes[7] !== 2 ||
      bytes.readBigUInt64BE(8) !== BigInt(size) ||
      bytes.toString('ascii', size - 4) !== '7777'
    )
      throw Error('GRIB2 数据不完整');
    return decode(source, run, lead, entry, bytes, bbox, step);
  });
}
async function decode(source, run, lead, entry, bytes, bbox, step) {
  engine ||= createEccodes().catch((error) => {
    engine = undefined;
    throw error;
  });
  const ec = await engine;
  // All ecCodes operations on the shared WASM file below are synchronous.
  ec.writeFile('/work/field.grib', bytes);
  const h = ec.openGrib('/work/field.grib');
  try {
    checkMessage(h, entry, run, lead, source);
    const nx = h.getLong('Ni'),
      ny = h.getLong('Nj');
    const dx = h.getDouble('iDirectionIncrementInDegrees'),
      dy = h.getDouble('jDirectionIncrementInDegrees');
    const firstLon = h.getDouble('longitudeOfFirstGridPointInDegrees');
    const firstLat = h.getDouble('latitudeOfFirstGridPointInDegrees');
    if (
      h.getString('gridType') !== 'regular_ll' ||
      !(dx > 0 && dy > 0) ||
      nx * ny > 2e6 ||
      Math.abs(nx * dx - 360) > 0.01 ||
      Math.abs((ny - 1) * dy - 180) > 0.01 ||
      h.getLong('jPointsAreConsecutive') ||
      h.getLong('alternativeRowScanning')
    )
      throw Error('模式格网格式未识别');
    const lonSign = h.getLong('iScansNegatively') ? -1 : 1,
      latSign = h.getLong('jScansPositively') ? 1 : -1;
    const a = h.getDoubleArray('values'),
      missing = h.getLong('bitmapPresent') ? h.getDouble('missingValue') : NaN;
    if (a.length !== nx * ny) throw Error('模式格网尺寸不完整');
    const out = [];
    for (let lat = bbox[3]; lat >= bbox[1] - 0.001; lat -= step) {
      const row = Math.round(((lat - firstLat) * latSign) / dy);
      for (let lon = bbox[0]; lon <= bbox[2] + 0.001; lon += step) {
        const col = ((Math.round(((lon - firstLon) * lonSign) / dx) % nx) + nx) % nx;
        let v = a[row * nx + col];
        if (!Number.isFinite(v) || v === missing || Math.abs(v) >= 1e10) {
          out.push(null);
          continue;
        }
        if (entry.field === 'TMP') v -= 273.15;
        if (entry.field === 'PRES' || entry.field === 'PRMSL') v /= 100;
        if (entry.field === 'PRATE') v *= 3600;
        const precision = entry.field === 'PRATE' ? 100 : 10;
        out.push(
          Math.abs(v) < 20000 && (entry.field !== 'PRES' || (v >= 250 && v <= 1100))
            ? Math.round(v * precision) / precision
            : null,
        );
      }
    }
    return out;
  } finally {
    h.delete();
  }
}
module.exports = { fetchField };
