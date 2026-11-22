'use strict';
const { request, cached, cachePresent } = require('./network.cjs');
const { makeProfile, describeProfile } = require('./atmosphere.cjs');
const { originalProfile } = require('./era5-dap.cjs');

const root =
  'https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3/';
const hour = 3600000,
  epoch = Date.UTC(1900, 0, 1),
  day = 24 * hour;
const codec = import('numcodecs/blosc').then(({ default: Blosc }) => new Blosc());
let busy = 0;
const waiting = [];
async function get(url, options, read) {
  if (busy >= 12) await new Promise((resolve) => waiting.push(resolve));
  else busy++;
  try {
    return await read(await request(url, { timeout: 25000, ...options }));
  } finally {
    if (waiting.length) waiting.shift()();
    else busy--;
  }
}
async function range(key, start, end, etag) {
  const headers = { Range: 'bytes=' + start + '-' + end };
  if (etag) headers['If-Match'] = etag;
  return get(root + key, { headers }, async (res) => {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(res.headers.get('content-range') || '');
    if (
      res.status !== 206 ||
      !m ||
      +m[1] !== start ||
      +m[2] !== Math.min(end, +m[3] - 1) ||
      (etag && res.headers.get('etag') !== etag)
    ) {
      await res.body?.cancel();
      throw Error('ERA5 数据分段与请求不符');
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== +m[2] - start + 1) throw Error('ERA5 数据分段不完整');
    return { bytes, total: +m[3], etag: res.headers.get('etag') };
  });
}
async function metadata() {
  return cached(
    'arco-era5-v3-metadata',
    6 * hour,
    async () => ({
      value: await get(root + '.zmetadata', {}, async (r) => (await r.json()).metadata),
    }),
    { stale: 2 * day },
  );
}
async function coordinate(m, name, chunk = 0) {
  return cached('arco-coord-v3:' + name + ':' + chunk, 30 * day, async () => {
    const spec = m[name + '/.zarray'];
    const bytes = await get(
      root + name + '/' + chunk,
      {},
      async (r) => new Uint8Array(await r.arrayBuffer()),
    );
    const out = Buffer.from(spec.compressor ? await (await codec).decode(bytes) : bytes);
    if (!['<f4', '<i8'].includes(spec.dtype)) throw Error('ERA5 坐标类型未知');
    const size = spec.dtype === '<f4' ? 4 : 8;
    if (out.length % size) throw Error('ERA5 坐标不完整');
    return {
      value: Array.from({ length: out.length / size }, (_, i) =>
        size === 4 ? out.readFloatLE(i * 4) : Number(out.readBigInt64LE(i * 8)),
      ),
    };
  });
}
async function points(m, field, timeIndex, levelIndexes, cell, unit) {
  const spec = m[field + '/.zarray'],
    attrs = m[field + '/.zattrs'],
    vertical = levelIndexes !== null;
  const dims = vertical ? 'time,level,latitude,longitude' : 'time,latitude,longitude';
  if (
    attrs?.units !== unit ||
    attrs._ARRAY_DIMENSIONS.join(',') !== dims ||
    spec.dtype !== '<f4' ||
    spec.order !== 'C' ||
    spec.compressor?.id !== 'blosc' ||
    spec.chunks[0] !== 1 ||
    spec.chunks.at(-2) !== 721 ||
    spec.chunks.at(-1) !== 1440 ||
    (vertical && spec.chunks[1] !== 37)
  )
    throw Error('ERA5 要素、单位或格网不符');
  const key = field + '/' + [timeIndex, ...spec.chunks.slice(1).map(() => 0)].join('.');
  const head = await range(key, 0, 4095);
  const size = head.bytes.readUInt32LE(4),
    block = head.bytes.readUInt32LE(8),
    encoded = head.bytes.readUInt32LE(12);
  if (
    head.bytes[3] !== 4 ||
    size !== 4 * spec.chunks.reduce((a, b) => a * b, 1) ||
    block < 4 ||
    block % 4 ||
    encoded !== head.total
  )
    throw Error('ERA5 压缩块尺寸无效');
  const n = Math.ceil(size / block),
    raw = Boolean(head.bytes[2] & 2),
    end = 16 + 4 * n;
  let spans;
  if (!raw) {
    const buf = end <= head.bytes.length ? head.bytes : (await range(key, 0, end - 1, head.etag)).bytes;
    const starts = Array.from({ length: n }, (_, i) => buf.readUInt32LE(16 + 4 * i));
    const sorted = [...starts].sort((a, b) => a - b);
    if (sorted[0] < end || sorted.at(-1) >= encoded || new Set(starts).size !== n)
      throw Error('ERA5 压缩块目录无效');
    const ends = new Map(sorted.map((a, i) => [a, sorted[i + 1] ?? encoded]));
    spans = starts.map((a) => [a, ends.get(a)]);
  }
  const offsets = (levelIndexes ?? [0]).map((i) => 4 * (i * 721 * 1440 + cell));
  const blocks = [...new Set(offsets.map((b) => Math.floor(b / block)))];
  const decoded = new Map(
    await Promise.all(
      blocks.map(async (i) => {
        const len = Math.min(block, size - i * block);
        const [lo, hi] = raw ? [16 + i * block, 16 + i * block + len] : spans[i];
        const payload =
          hi <= head.bytes.length
            ? head.bytes.subarray(lo, hi)
            : (await range(key, lo, hi - 1, head.etag)).bytes;
        if (raw) return [i, payload];
        const single = Buffer.allocUnsafe(20 + payload.length);
        head.bytes.copy(single, 0, 0, 4);
        single.writeUInt32LE(len, 4);
        single.writeUInt32LE(block, 8);
        single.writeUInt32LE(single.length, 12);
        single.writeUInt32LE(20, 16);
        payload.copy(single, 20);
        const b = Buffer.from(await (await codec).decode(single));
        if (b.length !== len) throw Error('ERA5 解压结果不完整');
        return [i, b];
      }),
    ),
  );
  return offsets.map((o) => {
    const v = decoded.get(Math.floor(o / block)).readFloatLE(o % block);
    return Number.isFinite(v) && Math.abs(v) < 1e12 ? v : null;
  });
}

const profileKey = (stamp, lon, lat) =>
  'era5-profile-v1:' + stamp + ':' + Math.round(lon * 4) + ':' + (360 - Math.round(lat * 4));
const hasArchiveProfile = (stamp, lon, lat) => cachePresent(profileKey(stamp, lon, lat));
async function archiveProfile(valid, lon, lat) {
  const t = Date.parse(valid),
    stamp = new Date(t).toISOString();
  if (
    t % hour !== 0 ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lat < 0 ||
    lat > 75 ||
    lon < 52.5 ||
    lon > 165
  )
    throw Error('请选择全国图范围内的整点');
  const x = Math.round(lon * 4),
    y = 360 - Math.round(lat * 4);
  const result = await cached(
    profileKey(stamp, lon, lat),
    7 * day,
    async () => {
      try {
        const m = await metadata(),
          date = stamp.slice(0, 10),
          attrs = m['.zattrs'];
        if (date < attrs.valid_time_start || date > (attrs.valid_time_stop_era5t || attrs.valid_time_stop))
          throw Error('该时次尚未进入 ERA5 归档');
        const [xs, ys, levels, initial] = await Promise.all(
          ['longitude', 'latitude', 'level', 'time'].map((k) => coordinate(m, k)),
        );
        if (
          xs[x] !== x / 4 ||
          ys[y] !== 90 - y / 4 ||
          !m['time/.zattrs'].units.startsWith('hours since 1900-01-01') ||
          levels.length !== 37
        )
          throw Error('ERA5 时空坐标不符');
        const h = (t - epoch) / hour,
          i = h - initial[0],
          ts = m['time/.zarray'].chunks[0];
        if (i < 0 || (await coordinate(m, 'time', Math.floor(i / ts)))[i % ts] !== h)
          throw Error('归档缺少该有效时次');
        const indexes = levels.map((v, j) => (v >= 300 && v <= 1000 ? j : -1)).filter((j) => j >= 0),
          cell = y * 1440 + x;
        const [temp, q, [ps], [t2], [dew]] = await Promise.all([
          points(m, 'temperature', i, indexes, cell, 'K'),
          points(m, 'specific_humidity', i, indexes, cell, 'kg kg**-1'),
          points(m, 'surface_pressure', i, null, cell, 'Pa'),
          points(m, '2m_temperature', i, null, cell, 'K'),
          points(m, '2m_dewpoint_temperature', i, null, cell, 'K'),
        ]);
        if (!Number.isFinite(ps) || !Number.isFinite(t2) || !Number.isFinite(dew))
          throw Error('ERA5 近地面资料缺测');
        const p = ps / 100,
          td = dew - 273.15,
          e = 6.112 * Math.exp((17.67 * td) / (td + 243.5)),
          preliminary = date > attrs.valid_time_stop;
        const column = makeProfile({
          source: preliminary ? 'ECMWF ERA5T' : 'ECMWF ERA5',
          type: preliminary ? '初步再分析' : '再分析',
          valid: stamp,
          lon: xs[x],
          lat: ys[y],
          resolution: '0.25°',
          surface: { pressure: p, temp: t2 - 273.15, q: (0.622 * e) / (p - 0.378 * e) },
          levels: indexes.map((j, k) => ({
            pressure: levels[j],
            temp: temp[k] === null ? null : temp[k] - 273.15,
            q: q[k],
          })),
        });
        return {
          value: { ...column, channel: 'Google ARCO-ERA5', detail: 'full' },
          expires: Date.now() + (preliminary ? 7 : 365) * day,
        };
      } catch (first) {
        try {
          return { value: await originalProfile(stamp, x, y), expires: Date.now() + 365 * day };
        } catch {
          throw Error(
            '两个 ERA5 归档均未返回此时次的详细廓线。' +
              (first.message.includes('尚未') ? '该日期可能仍在更新。' : ''),
          );
        }
      }
    },
    { stale: 60 * day },
  );
  return describeProfile(result);
}
module.exports = { archiveProfile, hasArchiveProfile };
