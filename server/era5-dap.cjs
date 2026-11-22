'use strict';
const { request, cached } = require('./network.cjs');
const { makeProfile, specificHumidity } = require('./atmosphere.cjs');
const H = 3600000,
  base = 'https://tds.gdex.ucar.edu/thredds/dodsC/files/d633000/';
const fields = {
  T: ['130_t', 'K'],
  Q: ['133_q', 'kg kg**-1'],
  SP: ['134_sp', 'Pa'],
  VAR_2T: ['167_2t', 'K'],
  VAR_2D: ['168_2d', 'K'],
};

function arrays(bytes) {
  const mark = Buffer.from('Data:\n'),
    split = bytes.indexOf(mark);
  if (split < 0) throw Error('再分析分段不完整');
  const header = bytes.toString('ascii', 0, split);
  let pos = split + mark.length;
  const values = {};
  for (const [, type, name, dimensions] of header.matchAll(
    /(Float32|Float64|Int32)\s+([\w/.-]+)((?:\[[^\]]+\])+);/g,
  )) {
    const count = [...dimensions.matchAll(/\[(?:\w+\s*=\s*)?(\d+)\]/g)].reduce((n, m) => n * Number(m[1]), 1);
    const size = type === 'Float64' ? 8 : 4;
    if (
      count > 24 * 37 ||
      pos + 8 + count * size > bytes.length ||
      bytes.readUInt32BE(pos) !== count ||
      bytes.readUInt32BE(pos + 4) !== count
    )
      throw Error('再分析坐标或数据长度不符');
    pos += 8;
    values[name] = Array.from({ length: count }, (_, i) =>
      type === 'Float64'
        ? bytes.readDoubleBE(pos + i * 8)
        : type === 'Int32'
          ? bytes.readInt32BE(pos + i * 4)
          : bytes.readFloatBE(pos + i * 4),
    );
    pos += count * size;
  }
  if (pos !== bytes.length) throw Error('再分析字段格式异常');
  return values;
}
async function original(name, times, x, y) {
  const stamp = times[0];
  const t = new Date(stamp),
    ym = stamp.slice(0, 7).replace('-', ''),
    ymd = stamp.slice(0, 10).replaceAll('-', '');
  const pl = name === 'T' || name === 'Q',
    group = 'e5.oper.an.' + (pl ? 'pl' : 'sfc');
  const [code, unit] = fields[name],
    last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  const date = pl ? ymd + '00_' + ymd + '23' : ym + '0100_' + ym + last + '23';
  const url = base + group + '/' + ym + '/' + group + '.128_' + code + '.ll025sc.' + date + '.nc';
  const timeIndex = t.getUTCHours() + (pl ? 0 : (t.getUTCDate() - 1) * 24);
  const step = times.length > 1 ? (Date.parse(times[1]) - Date.parse(stamp)) / H : 1;
  const ts =
    times.length === 1
      ? '[' + timeIndex + ']'
      : '[' + timeIndex + ':' + step + ':' + (timeIndex + (times.length - 1) * step) + ']';
  const projection = name + ts + (pl ? '[17:1:36]' : '') + '[' + y + '][' + x + ']';
  await cached('era5-dap-unit:' + url, 365 * 24 * H, async () => {
    const das = await (await request(url + '.das', { timeout: 16000 })).text();
    const attrs = das.match(new RegExp('(?:^|\\n)\\s*' + name + '\\s*\\{([^}]+)'));
    if (
      !attrs?.[1].includes('String units "' + unit + '"') ||
      !das.includes('hours since 1900-01-01 00:00:00')
    )
      throw Error('再分析字段单位不符');
    return { value: true };
  });
  const r = await request(url + '.dods?' + encodeURIComponent(projection), { timeout: 30000 });
  const a = arrays(Buffer.from(await r.arrayBuffer()));
  if (
    a.time?.length !== times.length ||
    times.some((s, i) => a.time[i] !== (Date.parse(s) - Date.UTC(1900, 0, 1)) / H) ||
    a.latitude?.[0] !== 90 - y / 4 ||
    a.longitude?.[0] !== x / 4 ||
    !Array.isArray(a[name]) ||
    a[name].length !== times.length * (pl ? 20 : 1)
  )
    throw Error('再分析时次或位置不符');
  return {
    values: a[name].map((v) => (Number.isFinite(v) && Math.abs(v) < 1e12 ? v : null)),
    levels: a.level,
  };
}
async function originalProfiles(stamps, x, y, workers = 5) {
  const clock = stamps.map(Date.parse);
  if (
    !clock.length ||
    clock.some(
      (v, i) =>
        !Number.isFinite(v) ||
        v % H ||
        (i && v <= clock[i - 1]) ||
        Math.floor(v / (24 * H)) !== Math.floor(clock[0] / (24 * H)),
    )
  )
    throw Error('按一个 UTC 资料日请求整点廓线');
  const delta = clock.length > 1 ? clock[1] - clock[0] : H;
  const step = clock.every((v, i) => v === clock[0] + i * delta) ? delta : H;
  const times = Array.from({ length: (clock.at(-1) - clock[0]) / step + 1 }, (_, i) =>
    new Date(clock[0] + i * step).toISOString(),
  );
  const keys = Object.keys(fields),
    result = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, keys.length) }, async () => {
      while (next < keys.length) {
        const k = keys[next++];
        result[k] = await original(k, times, x, y);
      }
    }),
  );
  const { T: t, Q: q, SP: ps, VAR_2T: t2, VAR_2D: td } = result;
  if (
    !Array.isArray(t.levels) ||
    t.levels[0] !== 300 ||
    t.levels.at(-1) !== 1000 ||
    t.levels.some((p, i) => p !== q.levels?.[i] || (i && p <= t.levels[i - 1]))
  )
    throw Error('再分析垂直坐标不完整');
  return clock.map((v) => {
    const j = (v - clock[0]) / step,
      stamp = new Date(v).toISOString();
    if ([ps, t2, td].some((a) => a.values[j] === null)) throw Error('再分析地面资料不完整');
    const p = ps.values[j] / 100,
      offset = j * t.levels.length;
    return {
      ...makeProfile({
        source: 'ECMWF ERA5',
        type: '再分析',
        valid: stamp,
        lon: x / 4,
        lat: 90 - y / 4,
        resolution: '0.25°',
        surface: {
          pressure: p,
          temp: t2.values[j] - 273.15,
          q: specificHumidity(p, td.values[j] - 273.15, 100),
        },
        levels: t.levels.map((pressure, i) => ({
          pressure,
          temp: t.values[offset + i] === null ? null : t.values[offset + i] - 273.15,
          q: q.values[offset + i],
        })),
      }),
      channel: 'NSF NCAR GDEX',
      detail: 'full',
    };
  });
}
async function originalProfile(stamp, x, y) {
  return (await originalProfiles([stamp], x, y))[0];
}
module.exports = { originalProfile, originalProfiles };
