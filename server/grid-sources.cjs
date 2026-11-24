'use strict';
const { cached, request } = require('./network.cjs');
const { pressureLevels, nativeHeightLevels, profileLevels } = require('../shared/levels.mjs');

const googleGfs = { id: 'gfs-google', model: 'gfs', name: 'NOAA GFS', channel: 'NOAA 开放数据 · Google Cloud', resolution: '1p00' };
const sources = [
  { id: 'gfs', model: 'gfs', name: 'NOAA GFS', channel: 'NOAA 开放数据 · AWS', resolution: '1p00' },
  googleGfs,
  { id: 'nomads', model: 'gfs', name: 'NOAA GFS', channel: 'NOAA NOMADS', resolution: '1p00' },
  {
    id: 'ifs',
    model: 'ifs',
    name: 'ECMWF IFS',
    channel: 'ECMWF 开放数据 · AWS',
    resolution: '0p25',
  },
  {
    id: 'ifs-google',
    model: 'ifs',
    name: 'ECMWF IFS',
    channel: 'ECMWF 开放数据 · Google Cloud',
    resolution: '0p25',
  },
  {
    id: 'gefs',
    model: 'gefs',
    name: 'NOAA GEFS 控制成员',
    channel: 'NOAA 开放数据 · AWS',
    resolution: '0p50',
  },
];
const hourlySources = [googleGfs, ...sources.filter(source => source.model === 'gfs' && source !== googleGfs)];
const fields = {
  wind10: [
    ['UGRD', '10 m above ground'],
    ['VGRD', '10 m above ground'],
  ],
  temp2: [['TMP', '2 m above ground']],
  q2: [['SPFH', '2 m above ground']],
  dew2: [['DPT', '2 m above ground']],
  pressure: [['PRMSL', 'mean sea level']],
  rainRate: [['PRATE', 'surface']],
  snowFlag: [['CSNOW', 'surface']],
  surfacePressure: [['PRES', 'surface']],
  omega700: [['VVEL', '700 mb']],
  precipTotal: [['APCP', 'surface']],
  precipPhase: [
    ['CRAIN', 'surface'],
    ['CFRZR', 'surface'],
    ['CICEP', 'surface'],
    ['CSNOW', 'surface'],
  ],
  precipitableWater: [['PWAT', 'entire atmosphere (considered as a single layer)']],
};
for (const p of pressureLevels) {
  const level = p + ' mb';
  fields['wind' + p] = [
    ['UGRD', level],
    ['VGRD', level],
  ];
  fields['temp' + p] = [['TMP', level]];
  fields['moisture' + p] = [['RH', level]];
  fields['omega' + p] = [['VVEL', level]];
  fields['q' + p] = [['SPFH', level]];
  fields['specific' + p] = [['SPFH', level]];
  fields['flux' + p] = [...fields['wind' + p], ['SPFH', level]];
  fields['vort' + p] = fields['wind' + p];
}
for (const p of nativeHeightLevels) fields['height' + p] = [['HGT', p + ' mb']];
for (const p of profileLevels) {
  fields['temp' + p] ??= [['TMP',p+' mb']];
  fields['q' + p] = [['SPFH',p+' mb']];
}

const ecPressure = { u: 'UGRD', v: 'VGRD', t: 'TMP', r: 'RH', gh: 'HGT', w:'VVEL', q:'SPFH' };
const ecSurface = {
  sp: fields.surfacePressure[0],
  msl: fields.pressure[0],
  '2t': fields.temp2[0],
  '2d': fields.dew2[0],
  '10u': fields.wind10[0],
  '10v': fields.wind10[1],
};
function fieldError(message) {
  return Object.assign(Error(message), { code: 'FIELD_MISSING', statusCode: 422 });
}
function gribAddress(source, run, lead, resolution = source.resolution, part = 'a') {
  const iso = new Date(run).toISOString();
  const date = iso.slice(0, 10).replaceAll('-', ''),
    hour = iso.slice(11, 13);
  const fh = String(lead).padStart(3, '0');
  if (source.model === 'ifs') {
    const root =
      source.id === 'ifs-google'
        ? 'https://storage.googleapis.com/ecmwf-open-data/'
        : 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/';
    return (
      root +
      date +
      '/' +
      hour +
      'z/ifs/0p25/oper/' +
      date +
      hour +
      '0000-' +
      lead +
      'h-oper-fc.grib2'
    );
  }
  if (source.model === 'gefs')
    return (
      'https://noaa-gefs-pds.s3.amazonaws.com/gefs.' +
      date +
      '/' +
      hour +
      '/atmos/pgrb2' +
      part +
      'p5/gec00.t' +
      hour +
      'z.pgrb2' +
      part +
      '.0p50.f' +
      fh
    );
  const root =
    source.id === 'nomads'
      ? 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod'
      : source.id === 'gfs-google'
        ? 'https://storage.googleapis.com/global-forecast-system'
      : 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
  return (
    root + '/gfs.' + date + '/' + hour + '/atmos/gfs.t' + hour + 'z.pgrb2.' + resolution + '.f' + fh
  );
}

function parseIndex(text, source, run, lead) {
  const dayHour = new Date(run).toISOString().slice(0, 13).replace(/[-T]/g, '');
  const lines = text.trim().split(/\r?\n/);
  if (source.model === 'ifs') {
    const entries = [];
    for (const line of lines) {
      const r = JSON.parse(line);
      if (
        r.domain !== 'g' ||
        r.class !== 'od' ||
        r.stream !== 'oper' ||
        r.type !== 'fc' ||
        r.date + r.time !== dayHour + '00' ||
        String(r.step) !== String(lead)
      )
        continue;
      let spec;
      if (r.levtype === 'pl' && Object.hasOwn(ecPressure, r.param) && /^\d+$/.test(r.levelist))
        spec = [ecPressure[r.param], r.levelist + ' mb'];
      if (r.levtype === 'sfc' && Object.hasOwn(ecSurface, r.param)) spec = ecSurface[r.param];
      if (!spec) continue;
      if (
        !Number.isSafeInteger(r._offset) ||
        r._offset < 0 ||
        !Number.isSafeInteger(r._length) ||
        r._length < 20
      )
        throw Error('IFS 字段索引偏移异常');
      entries.push({
        field: spec[0],
        level: spec[1],
        at: r._offset,
        end: r._offset + r._length - 1,
      });
    }
    if (!entries.length) throw Error('IFS 索引与请求时次不符');
    return entries;
  }
  const rows = lines.map((line) => line.split(':'));
  if (
    !rows.length ||
    rows.some(
      (r, i) =>
        r[2] !== 'd=' + dayHour ||
        !/^\d+$/.test(r[1]) ||
        !Number.isSafeInteger(Number(r[1])) ||
        (i && Number(r[1]) <= Number(rows[i - 1][1])),
    )
  )
    throw Error('NOAA 字段索引与请求不符');
  return rows.flatMap((r, i) => {
    const accum =
      r[3] === 'APCP' && r[4] === 'surface' && r[5] === '0-' + lead + ' hour acc fcst' && lead > 0;
    const instant = r[5] === lead + ' hour fcst' || (lead === 0 && r[5] === 'anl');
    if (r[3] === 'APCP' ? !accum : !instant) return [];
    if (source.model === 'gefs' && !r.some((v) => v === 'ENS=low-res ctl')) return [];
    return [
      {
        field: r[3],
        level: r[4],
        at: Number(r[1]),
        end: i + 1 < rows.length ? Number(rows[i + 1][1]) - 1 : null,
        ...(accum ? { startStep: 0, endStep: lead } : {}),
      },
    ];
  });
}

// A short pause after an upstream failure also covers neighbouring panels and levels.
// Successful grids remain cached independently for each original file and projection.
const failures = new Map();
async function retryLater(key, load) {
  const prior = failures.get(key);
  if (prior && prior.until > Date.now()) throw prior.error;
  try {
    const value = await load();
    failures.delete(key);
    return value;
  } catch (error) {
    if (failures.size >= 200) failures.delete(failures.keys().next().value);
    const retry = error.retryAfter;
    const retryAt =
      retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry || '');
    failures.set(key, {
      until: Math.max(Date.now() + 30000, Number.isFinite(retryAt) ? retryAt : 0),
      error,
    });
    throw error;
  }
}
async function indexFor(source, run, lead, url) {
  const address = source.model === 'ifs' ? url.replace(/\.grib2$/, '.index') : url + '.idx';
  // A newly written index may still be growing; recheck gaps in a recent cycle.
  const ttl = Date.now() - new Date(run).getTime() < 864e5 ? 5 * 60000 : 7 * 864e5;
  return cached('model-index-v2:' + address, ttl, async () => ({
    value: await retryLater(address, async () =>
      parseIndex(
        await (await request(address, { timeout: 7500, preferSystem: true })).text(),
        source,
        run,
        lead,
      ),
    ),
  }));
}
async function selectEntries(source, run, lead, resolution, specs) {
  const url = gribAddress(source, run, lead, resolution);
  const primary = await indexFor(source, run, lead, url);
  const selected = specs.map(([field, level]) => {
    const item = primary.find((r) => r.field === field && r.level === level);
    return item && { ...item, url };
  });
  if (source.model === 'gefs' && selected.some((e) => !e)) {
    const other = gribAddress(source, run, lead, resolution, 'b');
    const supplement = await indexFor(source, run, lead, other);
    for (let i = 0; i < specs.length; i++)
      if (!selected[i]) {
        const [field, level] = specs[i],
          item = supplement.find((r) => r.field === field && r.level === level);
        if (item) selected[i] = { ...item, url: other };
      }
  }
  const absent = selected.findIndex((e) => !e);
  if (absent >= 0) throw fieldError(source.name + ' 此时次未发布 ' + specs[absent].join(' / '));
  return selected;
}
async function published(source, run, lead, resolution = source.resolution) {
  const rows = await indexFor(source, run, lead, gribAddress(source, run, lead, resolution));
  if (!rows.some((r) => ['PRES', 'UGRD', 'TMP', 'HGT'].includes(r.field)))
    throw fieldError('该文件暂无预报字段');
}
module.exports = {
  sources,
  hourlySources,
  googleGfs,
  fields,
  gribAddress,
  parseIndex,
  selectEntries,
  fieldError,
  retryLater,
  published,
};
