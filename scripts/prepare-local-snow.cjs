'use strict';
const path = require('node:path'),
  fs = require('node:fs/promises');
const { readGrid } = require('../server/grids.cjs'),
  { configureCache } = require('../server/network.cjs');
const root = path.resolve(__dirname, '..');
configureCache(process.env.GUANXIANG_BUILD_CACHE || path.join(root, '.data-cache'));
async function series(c) {
  const run = c.run + 'T00:00:00Z',
    out = [];
  const sample = (g) =>
    g.values[
      Math.round((g.bbox[3] - c.point[1]) / g.step) * g.nx +
        Math.round((c.point[0] - g.bbox[0]) / g.step)
    ];
  for (let s = 3; s <= 72; s += 12) {
    const rows = await Promise.all(
      [s, s + 3, s + 6, s + 9]
        .filter((h) => h <= 72)
        .map(async (lead) => {
          const [rate, snow] = await Promise.all(
            ['rainRate', 'snowFlag'].map((l) => readGrid(run, lead, l, c.box, c.resolution, c.step))
          );
          return { time: rate.valid, lead, rate: sample(rate), snow: sample(snow) };
        })
    );
    out.push(...rows);
  }
  await fs.writeFile(
    path.join(root, 'assets/cases', c.id, 'local.json'),
    JSON.stringify({ run, place: c.tag, point: c.point, source: 'NOAA GFS · 0.50°', rows: out })
  );
  console.log(
    c.id,
    out.length,
    'snow signals',
    out.filter((r) => r.snow > 0.5 && r.rate > 0.01).length
  );
}
(async () => {
  for (const c of require('../assets/data/catalog.json').filter((c) =>
    ['bohai', 'bohai22'].includes(c.id)
  ))
    await series(c);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
