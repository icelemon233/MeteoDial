'use strict';
const path = require('node:path'),
  { Worker } = require('node:worker_threads');
const { cached, request } = require('./network.cjs');
const { satelliteChannels, satelliteBounds, isDaylight } = require('../shared/satellite.mjs');
const root = 'https://www.jma.go.jp/bosai/himawari/data/satimg/',
  H = 3600000;
function jmaTime(s) {
  if (!/^\d{14}$/.test(s)) return NaN;
  const t = Date.parse(
    s.slice(0, 4) +
      '-' +
      s.slice(4, 6) +
      '-' +
      s.slice(6, 8) +
      'T' +
      s.slice(8, 10) +
      ':' +
      s.slice(10, 12) +
      ':' +
      s.slice(12, 14) +
      'Z',
  );
  return Number.isFinite(t) && new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14) === s ? t : NaN;
}
async function currentScans() {
  const a = await cached(
    'jma-full-disk-frames-v2',
    90000,
    async () => {
      const list = await (await request(root + 'targetTimes_fd.json', { timeout: 10000 })).json();
      if (!Array.isArray(list)) throw Error('葵花观测目录格式异常');
      const times = [
        ...new Set(
          list
            .filter((s) => s.basetime === s.validtime && Number.isFinite(jmaTime(s.validtime)))
            .map((s) => s.validtime),
        ),
      ].sort();
      if (!times.length) throw Error('日本气象厅暂未发布观测时次');
      return { value: { scans: times } };
    },
    { stale: 6 * H },
  );
  const now = Date.now();
  return a.scans.filter((s) => jmaTime(s) <= now && now - jmaTime(s) <= 24 * H);
}
async function satelliteTimes(channel = 'satellite', region = 'china', lon = 105, lat = 33) {
  const spec = satelliteChannels[channel];
  if (!spec) throw Error('未知卫星通道');
  const b = satelliteBounds(region, lon, lat),
    x = region === 'local' ? lon : (b[0] + b[2]) / 2,
    y = region === 'local' ? lat : (b[1] + b[3]) / 2;
  let scans;
  try {
    scans = await currentScans();
    if (!scans.length) throw Error('暂无卫星观测');
  } catch (e) {
    if (channel !== 'satellite') throw e;
    const { frames } = await require('./gibs.cjs').publishedInfrared();
    return { frames, latest: frames.at(-1)?.time, channel: spec.code, region };
  }
  const a = scans.filter((s) => !spec.day || isDaylight(jmaTime(s), x, y));
  if (!a.length) throw Error(spec.day ? '近一天未取得该区域的日照观测' : '近一天暂无已发布的葵花观测');
  const frames = a.map((s) => ({ time: new Date(jmaTime(s)).toISOString() }));
  return { frames, latest: frames.at(-1).time, channel: spec.code, region };
}
let worker,
  seq = 0;
const jobs = new Map();
function renderObservation(job) {
  if (!worker) {
    const folder =
      path.basename(path.dirname(__dirname)) === 'app.asar' && process.resourcesPath
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server')
        : __dirname;
    const local = new Worker(path.join(folder, 'satellite-render.cjs'));
    worker = local;
    local.on('message', (m) => {
      const j = jobs.get(m.id);
      if (!j) return;
      jobs.delete(m.id);
      if (m.error) j.reject(Error(m.error));
      else j.resolve(m.grid ?? Buffer.from(m.bytes));
      if (!jobs.size) local.unref();
    });
    const fail = (e) => {
      if (worker !== local) return;
      worker = null;
      for (const v of jobs.values()) v.reject(e instanceof Error ? e : Error('卫星图像处理结束'));
      jobs.clear();
    };
    local.on('error', fail);
    local.on('exit', fail);
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject });
    worker.ref();
    worker.postMessage({ ...job, id });
  });
}
async function publishedTile(key, product, z, x, y) {
  const url = root + key + '/fd/' + key + '/' + product + '/' + z + '/' + x + '/' + y + '.jpg';
  const value = await cached('jma-tile-v1:' + url, 25 * H, async () => {
    const res = await request(url, { timeout: 14000, acceptErrorResponse: true });
    if (res.status === 404) {
      await res.body?.cancel();
      return { value: null, expires: Date.now() + 60000 };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw Error('卫星瓦片服务暂不可用');
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (
      bytes.length < 32 ||
      bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
    )
      throw Error('卫星瓦片不完整');
    return { value: bytes.toString('base64') };
  });
  return value ? Buffer.from(value, 'base64') : null;
}
async function observationTiles(bbox, width, read) {
  // JMA full-disk images publish levels through 5. A missing tile can still
  // have a published parent for the same observation, channel and footprint.
  const preferred = Math.min(
    5,
    Math.max(2, Math.round(Math.log2((width * 360) / (256 * (bbox[2] - bbox[0]))))),
  );
  let partial, error;
  for (let z = preferred; z >= 2; z--) {
    const n = 2 ** z,
      limit = (i) => Math.max(0, Math.min(n - 1, Math.floor(i)));
    const column = (lon) => limit(((lon + 180) / 360) * n);
    const row = (lat) => limit(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    const cx = column((bbox[0] + bbox[2]) / 2),
      cy = row((bbox[1] + bbox[3]) / 2);
    try {
      const centre = await read(z, cx, cy);
      if (!centre) continue;
      const tiles = [{ x: cx, y: cy, bytes: centre }],
        others = [];
      for (let x = column(bbox[0]); x <= column(bbox[2] - 1e-8); x++)
        for (let y = row(bbox[3]); y <= row(bbox[1] + 1e-8); y++)
          if (x !== cx || y !== cy) others.push([x, y]);
      let cursor = 0;
      const loads = await Promise.allSettled(
        Array.from({ length: Math.min(5, others.length) }, async () => {
          while (cursor < others.length) {
            const [x, y] = others[cursor++],
              bytes = await read(z, x, y);
            if (bytes) tiles.push({ x, y, bytes });
          }
        }),
      );
      const failure = loads.find((r) => r.status === 'rejected');
      if (failure) error = failure.reason;
      if (tiles.length === 1 + others.length) return { z, tiles, partial: false };
      partial ??= { z, tiles, partial: true };
    } catch (e) {
      error = e;
    }
  }
  if (partial) return partial;
  throw error || Error('所选区域缺少该时刻的卫星观测');
}
async function satellite(time, channel = 'satellite', region = 'china', lon = 105, lat = 33) {
  const spec = satelliteChannels[channel];
  if (!spec || !Number.isFinite(time)) throw Error('请选择有效卫星观测');
  const bbox = satelliteBounds(region, lon, lat),
    stamp = new Date(time).toISOString();
  const list = await satelliteTimes(channel, region, lon, lat);
  if (!list.frames.some((f) => f.time === stamp))
    throw Error(spec.day ? '所选时次没有当地白天的该通道观测' : '该时次未发布葵花观测');
  try {
    return await cached('jma-geo-v3:' + channel + ':' + stamp + ':' + bbox.join(','), 25 * H, async () => {
      const key = stamp.replace(/[-:T]/g, '').slice(0, 14),
        width = 800,
        height = Math.min(
          720,
          Math.max(200, Math.round((width * (bbox[3] - bbox[1])) / (bbox[2] - bbox[0]))),
        );
      const { tiles, z, partial } = await observationTiles(bbox, width, (z, x, y) =>
        publishedTile(key, spec.product, z, x, y),
      );
      const bytes = await renderObservation({ tiles, bbox, z, width, height, time, day: spec.day });
      return {
        value: {
          image: 'data:image/jpeg;base64,' + bytes.toString('base64'),
          bbox,
          valid: stamp,
          channel: spec.code,
          tileZoom: z,
          partial,
          region,
          type: '卫星观测',
          source: '日本气象厅 · 葵花9号 ' + spec.label,
        },
      };
    });
  } catch (e) {
    if (channel !== 'satellite') throw e;
    return require('./gibs.cjs').infraredImage(time, bbox, region);
  }
}
module.exports = { satellite, satelliteTimes, jmaTime, renderObservation, observationTiles };
