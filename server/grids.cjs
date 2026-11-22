'use strict';
const { cached, cachePresent } = require('./network.cjs');
const {
  sources,
  googleGfs,
  hourlySources,
  fields,
  gribAddress,
  selectEntries,
  published,
  fieldError,
} = require('./grid-sources.cjs');
const { fetchField } = require('./grib-field.cjs');
const { liveDomain } = require('../shared/levels.mjs');
const { availableLead } = require('../shared/timeline.mjs');
const HOUR = 3600000;
const boxes = {
  asia: [55, 5, 165, 75],
  live: liveDomain.bbox,
  national: require('../assets/data/archive-domain.json'),
  bohai: [112, 30, 132, 45],
  beijing: [110, 35, 122, 44],
  henan: [106, 29, 123, 41],
  south: [75, 15, 126, 40],
  coast: [105, 10, 145, 43],
  globe: [0, -88, 358, 88],
};
function address(run, lead, resolution) {
  return gribAddress(sources[0], run, lead, resolution);
}
// Only race the small inventories of two mirrors of the same GFS product. The
// selected mirror supplies its own offsets, GRIB bytes and provenance.
function firstGfsIndex(peers, probe, delay = 300) {
  if (!peers.length) return Promise.resolve({winner: null, errors: new Map()});
  return new Promise(resolve => {
    const errors = new Map();
    let next = 0, done = false, timer;
    function start() {
      if (done || next >= peers.length) return;
      clearTimeout(timer);
      const peer = peers[next++];
      Promise.resolve().then(() => probe(peer)).then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ winner: peer, errors });
      }, error => {
        if (done) return;
        errors.set(peer.id, error);
        if (next < peers.length) start();
        else if (errors.size === peers.length) {
          done = true;
          resolve({ winner: null, errors });
        }
      });
      if (next < peers.length) timer = setTimeout(start, delay);
    }
    start();
  });
}
const newestCycle = now => Math.floor((now - 4 * HOUR) / (6 * HOUR)) * 6 * HOUR;
async function findRun(now, providers = sources, probe = published) {
  const start = newestCycle(now);
  let eligible = providers;
  for (let i = 0; i < 6; i++) {
    const run = start - i * 6 * HOUR;
    const earlier = [];
    const peers = eligible.filter(p => p.id === 'gfs' || p.id === 'gfs-google');
    let failed;
    if (peers.length === 2) {
      const { winner, errors } = await firstGfsIndex(peers, p => probe(p, run, 24));
      if (winner) return { run: new Date(run).toISOString() };
      failed = errors;
    }
    for (const provider of eligible) {
      try {
        if (failed?.has(provider.id)) throw failed.get(provider.id);
        await probe(provider, run, 24);
        return { run: new Date(run).toISOString() };
      } catch (error) {
        if ([403, 404].includes(error.statusCode) || error.code === 'FIELD_MISSING')
          earlier.push(provider);
      }
    }
    if (!earlier.length) break;
    eligible = earlier;
  }
  throw Error('各预报源暂无可读取的起报批次');
}
function latestRun() {
  return cached(
    'gfs-latest-v2', // The persisted record is a cycle time, including in 0.3.0.
    15 * 60000,
    async () => {
      const now = Date.now(), value = await findRun(now), run = Date.parse(value.run);
      // The existing publication policy cannot select a newer cycle before this boundary.
      return { value, expires: run === newestCycle(now) ? run + 10 * HOUR : now + 15 * 60000 };
    },
    { stale: 36 * HOUR },
  );
}
function surfaceValues(source, run, lead, entry, box, step) {
  const extent = box === 'asia' ? box : boxes[box].join(',');
  const key =
    source.id === 'gfs'
      ? ['gfs-ps-v3', entry.url, extent, step].join(':')
      : ['model-ps-v1', entry.url, entry.at, extent, step].join('|');
  return cached(key, 10 * 864e5, async () => ({
    value: await fetchField(source, run, lead, entry, boxes[box], step),
  }));
}
function gridKey(source, url, layer, extent, step) {
  return source.id === 'gfs'
    ? ['gfs-grid-v7', url, layer, extent, step].join(':')
    : ['model-grid-v1', source.id, url, layer, extent, step].join('|');
}
async function liveProviderOrder(run, lead, choice) {
  const providers = lead % 3 ? hourlySources : sources;
  const peers = providers.filter(p => p.id === 'gfs' || p.id === 'gfs-google');
  const resolution = lead % 3 ? '0p25' : '1p00';
  const firstField = Object.hasOwn(fields, choice) ? choice : 'surfacePressure';
  const present = await Promise.all(providers.map(p => p.model === 'gfs' &&
    cachePresent(gridKey(p, gribAddress(p, run, lead, resolution), firstField, liveDomain.bbox.join(','), 1))));
  let winner = providers.find((_, i) => present[i]);
  if (!winner) ({winner} = await firstGfsIndex(peers, p => published(p, run, lead, resolution)));
  return winner ? [winner, ...providers.filter(p => p !== winner)] : providers;
}
async function readProviderGrid(
  source,
  run,
  lead,
  layer,
  box = 'asia',
  resolution = source.resolution,
  step = 1,
) {
  const bbox = boxes[box],
    specs = fields[layer];
  if (!bbox || !specs) throw Error('未知图层');
  if (source.model !== 'gfs' && ['rainRate', 'snowFlag'].includes(layer))
    throw fieldError('该产品未接入同定义的瞬时降水字段');
  const url = gribAddress(source, run, lead, resolution);
  const pressureLevel = /^(\d+) mb$/.exec(specs[0][1]);
  const extent = box === 'asia' ? box : bbox.join(',');
  const key = gridKey(source, url, layer, extent, step);
  const grid = await cached(key, 10 * 864e5, async () => {
    // Resolve all components, including the terrain field, before starting any byte-range reads.
    const entries = await selectEntries(
      source,
      run,
      lead,
      resolution,
      pressureLevel ? [...specs, ...fields.surfacePressure] : specs,
    );
    const arrays = await Promise.all(
      entries.map((entry) =>
        entry.field === 'PRES' && entry.level === 'surface'
          ? surfaceValues(source, run, lead, entry, box, step)
          : fetchField(source, run, lead, entry, bbox, step),
      ),
    );
    let terrainMask;
    if (pressureLevel) {
      const surface = arrays.pop(),
        p = Number(pressureLevel[1]);
      terrainMask = surface.map((ps) => (Number.isFinite(ps) && ps <= p ? 1 : 0));
      for (let i = 0; i < surface.length; i++)
        if (surface[i] === null || terrainMask[i]) for (const a of arrays) a[i] = null;
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
        source: source.name,
        sourceId: source.id,
        channel: source.channel,
        resolution: resolution.replace('p', '.') + '°',
        values: arrays[0],
        v: arrays[1],
        terrainMask,
      },
    };
  });
  if (grid.sourceId || source.id !== 'gfs') return grid;
  // Only this key was written by the single-source GFS reader in 0.3.0.
  if (
    grid.source !== source.name ||
    grid.layer !== layer ||
    Date.parse(grid.run) !== new Date(run).getTime() ||
    Date.parse(grid.valid) !== new Date(run).getTime() + lead * HOUR
  )
    throw Error('缓存网格的来源或时次不匹配');
  return { ...grid, sourceId: source.id, channel: source.channel };
}
// Historical GFS exports retain their original model, resolution and cycle.
async function readGrid(run, lead, layer, box = 'asia', resolution = '1p00', step = 1) {
  try {
    return await readProviderGrid(googleGfs, run, lead, layer, box, resolution, step);
  } catch {
    return readProviderGrid(sources[0], run, lead, layer, box, resolution, step);
  }
}

async function readLiveGrid(source, run, lead, layer) {
  if (lead % 3) {
    if (source.model !== 'gfs' || !availableLead(lead)) throw fieldError('该资料没有所选的逐小时时次');
    return readProviderGrid(source, run, lead, layer, 'live', '0p25');
  }
  try {
    return await readProviderGrid(source, run, lead, layer, 'live');
  } catch (error) {
    // Older installations cached an extent ending at 5°N; its reference cells
    // have the same row order. Only read an existing record for this exact time.
    const url = gribAddress(source, run, lead, source.resolution);
    const key = source.id === 'gfs'
      ? ['gfs-grid-v7', url, layer, 'asia', 1].join(':')
      : ['model-grid-v1', source.id, url, layer, 'asia', 1].join('|');
    const old = await cached(key, 0, () => { throw error; });
    const cycle = new Date(run).getTime();
    if (old.source !== source.name || old.layer !== layer || Date.parse(old.run) !== cycle ||
        Date.parse(old.valid) !== cycle + lead * HOUR || old.step !== 1 ||
        old.nx !== liveDomain.nx || old.ny !== 71 || !Array.isArray(old.bbox) ||
        !boxes.asia.every((v, i) => v === old.bbox[i]) || old.values?.length !== old.nx * old.ny)
      throw error;
    const cells = (liveDomain.ny - old.ny) * old.nx;
    const extend = (array, fill) => array && array.concat(Array(cells).fill(fill));
    return { ...old, ...liveDomain, sourceId: source.id, channel: source.channel,
      values: extend(old.values, null), v: extend(old.v, null), terrainMask: extend(old.terrainMask, 0) };
  }
}
module.exports = { fields, boxes, readGrid, readLiveGrid, readProviderGrid, liveProviderOrder,
  latestRun, findRun, firstGfsIndex, address };
