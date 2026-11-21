'use strict';
const path = require('node:path'),
  fs = require('node:fs/promises');
const root = path.join(__dirname, '..'),
  target = path.join(root, 'assets/cases');
const catalog = require('../assets/data/catalog.json');
const { configureCache, request } = require('../server/network.cjs');
const { readGrid } = require('../server/grids.cjs');
configureCache(process.env.GUANXIANG_BUILD_CACHE || path.join(root, '.data-cache'));
const H = 36e5;
async function writeIfMissing(file, fn, force = false) {
  if (!force) {
    try {
      await fs.access(file);
      return;
    } catch {}
  }
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const data = await fn();
      await fs.writeFile(file + '.part', data);
      await fs.rename(file + '.part', file);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
function gibsUrl(date, bbox) {
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    STYLES: '',
    FORMAT: 'image/jpeg',
    SRS: 'EPSG:4326',
    BBOX: bbox.join(','),
    WIDTH: '840',
    HEIGHT: String(Math.max(220, Math.round((840 * (bbox[3] - bbox[1])) / (bbox[2] - bbox[0])))),
    TIME: date,
  });
  return 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?' + q;
}
async function prepare(c) {
  const folder = path.join(target, c.id);
  await fs.mkdir(folder, { recursive: true });
  if (c.climate) {
    const url =
      'https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.derived/surface/slp.mon.ltm.1991-2020.nc.ascii?slp';
    for (const month of [0, 3, 6, 9]) {
      await writeIfMissing(
        path.join(folder, 'climate-' + month + '.json'),
        async () => {
          const months = [(month + 11) % 12, month, (month + 1) % 12];
          const fields = await Promise.all(
            months.map(async (m) => {
              const txt = await (
                await request(url + '[' + m + ':1:' + m + '][0:1:72][0:1:143]')
              ).text();
              const rows = [...txt.matchAll(/^\[0\]\[(\d+)\], ([^\r\n]+)$/gm)].map((r) =>
                r[2].split(', ').map(Number)
              );
              if (rows.length !== 73 || rows.some((row) => row.length !== 144))
                throw Error('气候态维度错误');
              return rows.flatMap((row) => [...row.slice(72), ...row.slice(0, 72)]);
            })
          );
          const vals = fields[0].map(
            (_, i) => Math.round(((fields[0][i] + fields[1][i] + fields[2][i]) * 10) / 3) / 10
          );
          return JSON.stringify({
            layer: 'climate',
            bbox: [-180, -90, 177.5, 90],
            step: 2.5,
            nx: 144,
            ny: 73,
            values: vals,
            months: months.map((m) => m + 1),
            type: '气候季平均',
            source: 'NOAA PSL · NCEP/NCAR',
            period: '1991—2020',
          });
        },
        process.argv.includes('--refresh-grids')
      );
    }
    return;
  }
  const run = c.run + 'T00:00:00Z';
  const jobs = [];
  for (const lead of c.leads) {
    for (const layer of c.layers.filter((l) => c.dataMode !== 'reanalysis' && !['track', 'satellite'].includes(l))) {
      jobs.push(() =>
        writeIfMissing(
          path.join(folder, layer + '-' + lead + '.json'),
          async () =>
            JSON.stringify(
              await readGrid(run, lead, layer, c.box, c.resolution || '1p00', c.step || 1)
            ),
          process.argv.includes('--refresh-grids')
        )
      );
    }
  }
  const dates = [
    ...new Set(c.leads.map((h) => new Date(Date.parse(run) + h * H).toISOString().slice(0, 10))),
  ];
  for (const date of dates)
    jobs.push(() =>
      writeIfMissing(path.join(folder, date + '.jpg'), async () => {
        const r = await request(gibsUrl(date, c.bbox), { timeout: 45000 });
        const b = Buffer.from(await r.arrayBuffer());
        if (b[0] !== 255 || b[1] !== 216) throw Error('卫星图格式错误');
        return b;
      })
    );
  for (let start = 0; start < jobs.length; start += 4)
    await Promise.all(jobs.slice(start, start + 4).map((j) => j()));
}
(async () => {
  for (const c of catalog) {
    await prepare(c);
    console.log('Ready:', c.id);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
