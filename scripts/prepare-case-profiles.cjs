'use strict';
// Save the original ERA5 column for each event's reference point and focus hour.
// Other coordinates and hours use exactly the same public reader in the app.
const fs = require('node:fs/promises'),
  path = require('node:path');
const { gunzipSync, gzipSync } = require('node:zlib');
const { configureCache } = require('../server/network.cjs');
const { archiveProfile, hasArchiveProfile } = require('../server/era5-column.cjs');
const { originalProfiles } = require('../server/era5-dap.cjs');
const root = path.join(__dirname, '../assets/cases');
const places = new Map(require('../assets/data/places.json').map((p) => [p[0], p]));
async function main() {
  if (!process.argv[2]) throw Error('Supply the private build cache directory.');
  configureCache(path.resolve(process.argv[2]));
  const events = require('../assets/data/disasters.json').events;
  const out = path.join(root, 'disaster-profiles');
  await fs.mkdir(out, { recursive: true });
  let next = 0,
    done = 0;
  const errors = [];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < events.length) {
        const e = events[next++],
          b = JSON.parse(gunzipSync(await fs.readFile(path.join(root, 'disasters', e.id + '.json.gz')))),
          p = places.get(e.map.place);
        const target = path.join(out, e.id + '.json.gz');
        try {
          let col;
          try {
            col = JSON.parse(gunzipSync(await fs.readFile(target)));
          } catch {}
          if (
            col?.valid !== b.focus ||
            col?.lon !== Math.round(p[5] * 4) / 4 ||
            col?.lat !== Math.round(p[4] * 4) / 4 ||
            col?.detail !== 'full'
          ) {
            col = await archiveProfile(b.focus, p[5], p[4]);
            await fs.writeFile(target + '.part', gzipSync(JSON.stringify(col)));
            await fs.rename(target + '.part', target);
          }
          done++;
          if (done % 10 === 0) console.log('Profiles', done, '/', events.length);
        } catch (err) {
          errors.push(e.id);
          console.error('ERROR', e.id, err.message);
        }
      }
    }),
  );
  console.log('Profiles ready', done, '/', events.length);
  const chapters = require('../assets/data/catalog.json'),
    chapDir = path.join(root, 'chapter-profiles');
  await fs.mkdir(chapDir, { recursive: true });
  for (const chapter of chapters) {
    const target = path.join(chapDir, chapter.id + '.json.gz'),
      [x, y] = chapter.point,
      frames = {};
    let old;
    try {
      old = JSON.parse(gunzipSync(await fs.readFile(target))).frames;
    } catch {}
    const days = new Map();
    for (const lead of chapter.leads) {
      const valid = new Date(Date.parse(chapter.run + 'T00:00:00Z') + lead * 3600000).toISOString(),
        c = old?.[valid];
      if (
        c?.detail === 'full' &&
        c.valid === valid &&
        c.lon === Math.round(x * 4) / 4 &&
        c.lat === Math.round(y * 4) / 4
      )
        frames[valid] = c;
      else if (await hasArchiveProfile(valid, x, y)) frames[valid] = await archiveProfile(valid, x, y);
      else {
        const d = valid.slice(0, 10);
        if (!days.has(d)) days.set(d, []);
        days.get(d).push(valid);
      }
    }
    const pending = [...days.values()];
    let index = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (index < pending.length) {
          const times = pending[index++];
          try {
            for (const col of await originalProfiles(times, Math.round(x * 4), 360 - Math.round(y * 4), 1))
              frames[col.valid] = col;
          } catch {
            for (const valid of times) {
              try {
                frames[valid] = await archiveProfile(valid, x, y);
              } catch (e) {
                errors.push(chapter.id + '/' + valid);
                console.error('ERROR', chapter.id, valid, e.message);
              }
            }
          }
        }
      }),
    );
    if (Object.keys(frames).length === chapter.leads.length) {
      const ordered = Object.fromEntries(
        Object.keys(frames)
          .sort()
          .map((t) => [t, frames[t]]),
      );
      await fs.writeFile(target + '.part', gzipSync(JSON.stringify({ id: chapter.id, frames: ordered })));
      await fs.rename(target + '.part', target);
      console.log('Chapter profiles', chapter.id, chapter.leads.length);
    }
  }
  if (errors.length) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
