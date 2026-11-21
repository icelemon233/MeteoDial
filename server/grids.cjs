'use strict';
const { cached } = require('./network.cjs');
const {
  sources,
  fields,
  gribAddress,
  selectEntries,
  published,
  fieldError,
} = require('./grid-sources.cjs');
const { fetchField } = require('./grib-field.cjs');
const { liveDomain } = require('../shared/levels.mjs');
const HOUR = 3600000;
const boxes = {
  asia: liveDomain.bbox,
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
async function findRun(now, providers = sources, probe = published) {
  const start = Math.floor((now - 4 * HOUR) / (6 * HOUR)) * 6 * HOUR;
  let eligible = providers;
  for (let i = 0; i < 6; i++) {
    const run = start - i * 6 * HOUR;
    const earlier = [];
    for (const provider of eligible) {
      try {
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
    async () => ({ value: await findRun(Date.now()) }),
    { stale: 36 * HOUR },
  );
}
function surfaceValues(source, run, lead, entry, box, step) {
  const key =
    source.id === 'gfs'
      ? ['gfs-ps-v3', entry.url, box, step].join(':')
      : ['model-ps-v1', entry.url, entry.at, box, step].join('|');
  return cached(key, 10 * 864e5, async () => ({
    value: await fetchField(source, run, lead, entry, boxes[box], step),
  }));
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
  const key =
    source.id === 'gfs'
      ? ['gfs-grid-v7', url, layer, box, step].join(':')
      : ['model-grid-v1', source.id, url, layer, box, step].join('|');
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
function readGrid(run, lead, layer, box = 'asia', resolution = '1p00', step = 1) {
  return readProviderGrid(sources[0], run, lead, layer, box, resolution, step);
}
module.exports = { fields, boxes, readGrid, readProviderGrid, latestRun, findRun, address };
