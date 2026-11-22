'use strict';
const { profileLevels, liveDomain, validPressure } = require('../shared/levels.mjs');
const { readLiveGrid, liveProviderOrder } = require('./grids.cjs');
const { makeProfile, specificHumidity } = require('./atmosphere.cjs');
const { cached } = require('./network.cjs');
const H = 3600000;
async function liveProfile(run, lead, cell) {
  const key = 'live-profile-v1:' + run + ':' + lead + ':' + cell;
  return cached(key, 3 * H, async () => {
    const providers = await liveProviderOrder(run, lead, 'surfacePressure');
    const valid = new Date(run + lead * H).toISOString(),
      init = new Date(run).toISOString();
    let partial = null;
    for (const src of providers) {
      async function value(layer) {
        try {
          const g = await readLiveGrid(src, run, lead, layer);
          if (
            g.sourceId !== src.id ||
            g.valid !== valid ||
            g.run !== init ||
            g.layer !== layer ||
            g.terrainMask?.[cell]
          )
            return null;
          const v = g.values[cell];
          return Number.isFinite(v) ? v : null;
        } catch {
          return null;
        }
      }
      const ps = await value('surfacePressure');
      if (!validPressure(ps)) continue;
      const [t2, rawQ] = await Promise.all([value('temp2'), value('q2')]);
      let q2 = rawQ;
      if (t2 !== null && q2 === null) {
        const dew = await value('dew2');
        if (dew !== null) q2 = specificHumidity(ps, dew, 100);
      }
      if (t2 === null || q2 === null) continue;
      const pressures = profileLevels.filter((p) => p < ps),
        levels = new Array(pressures.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (next < pressures.length) {
            const i = next++,
              p = pressures[i];
            const [t, raw] = await Promise.all([value('temp' + p), value('q' + p)]);
            // Prefer same-model specific humidity. Report gaps if that source
            // publishes neither specific humidity nor a consistent pair.
            levels[i] = { pressure: p, temp: t, q: raw };
          }
        }),
      );
      const validLevels = levels.filter((r) => r.temp !== null && r.q !== null).length;
      if (!validLevels) continue;
      const profile = makeProfile({
        source: src.name,
        run: init,
        valid,
        type: lead ? '模式预报' : '模式分析',
        resolution: liveDomain.step + '°',
        lon: liveDomain.bbox[0] + (cell % liveDomain.nx) * liveDomain.step,
        lat: liveDomain.bbox[3] - Math.floor(cell / liveDomain.nx) * liveDomain.step,
        surface: { pressure: ps, temp: t2, q: q2 },
        levels,
      });
      if (validLevels === pressures.length) return { value: { ...profile, detail: 'full' } };
      if (!partial || validLevels > partial.n) partial = { profile, n: validLevels };
    }
    if (partial) return { value: { ...partial.profile, detail: 'partial' }, expires: Date.now() + 300000 };
    throw Object.assign(Error('该时次缺少能配对的地面气压、温度和湿度资料'), { statusCode: 503 });
  });
}
module.exports = { liveProfile };
