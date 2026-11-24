'use strict';
const { cached, request } = require('./network.cjs');
const H = 3600000,
  nmc = 'https://typhoon.nmc.cn/weatherservice/typhoon/jsons/',
  hko = 'https://www.weather.gov.hk/wxinfo/currwx/';
const stamp = (v) => {
  if (!/^\d{12}$/.test(v)) return NaN;
  const s = String(v),
    t = Date.parse(
      s.slice(0, 4) +
        '-' +
        s.slice(4, 6) +
        '-' +
        s.slice(6, 8) +
        'T' +
        s.slice(8, 10) +
        ':' +
        s.slice(10, 12) +
        ':00Z',
    );
  return Number.isFinite(t) && new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 12) === s ? t : NaN;
};
function jsonp(text, name) {
  const m = text.trim().match(/^([\w$]+)\s*(\(+)(\{[\s\S]*\})(\)+);?$/);
  if (!m || m[1] !== name || m[2].length !== m[4].length) throw Error('中央气象台路径数据格式已变化');
  return JSON.parse(m[3]);
}
function cmaList(text) {
  const a = jsonp(text, 'typhoon_jsons_list_default').typhoonList;
  if (!Array.isArray(a)) throw Error('台风目录缺失');
  return a.map((r) => {
    if (!Array.isArray(r) || !Number.isSafeInteger(r[0]) || !['start', 'stop'].includes(r[7]))
      throw Error('台风目录记录无效');
    return {
      id: 'cma-' + r[0],
      name: r[2] || r[1],
      english: r[1],
      number: r[3] && String(r[3]),
      active: r[7] === 'start',
      source: '中央气象台',
    };
  });
}
const validPos = (lon, lat) =>
  Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 360;
const lon180 = (lon) => (lon > 180 ? lon - 360 : lon);
const value = (n, lo, hi) => (typeof n === 'number' && n >= lo && n <= hi ? n : null);
function cmaTrack(text, id) {
  const a = jsonp(text, 'typhoon_jsons_view_' + id).typhoon;
  if (!Array.isArray(a) || a[0] !== Number(id) || !Array.isArray(a[8])) throw Error('台风编号或路径不符');
  const analyses = [],
    forecasts = [];
  let last;
  for (const r of a[8]) {
    const t = stamp(r[1]);
    if (!Number.isFinite(t) || t !== r[2] || !validPos(r[4], r[5]) || t > Date.now() + 10 * 60000) continue;
    analyses.push({
      time: new Date(t).toISOString(),
      lon: lon180(r[4]),
      lat: r[5],
      pressure: value(r[6], 800, 1100),
      wind: value(r[7], 0, 130),
      grade: r[3],
    });
    if (!last || r[2] >= last[2]) last = r;
  }
  analyses.sort((x, y) => x.time.localeCompare(y.time));
  if (!analyses.length) throw Error('该气旋暂无有效定位');
  if (a[7] === 'start')
    for (const f of last?.[11]?.BABJ || []) {
      if (
        !Number.isFinite(f[0]) ||
        f[0] <= 0 ||
        f[0] > 168 ||
        stamp(f[1]) !== last[2] ||
        !validPos(f[2], f[3])
      )
        continue;
      forecasts.push({
        time: new Date(last[2] + f[0] * H).toISOString(),
        lon: lon180(f[2]),
        lat: f[3],
        pressure: value(f[4], 800, 1100),
        wind: value(f[5], 0, 130),
        grade: f[7],
      });
    }
  return {
    id: 'cma-' + id,
    name: a[2] || a[1],
    number: String(a[3] || ''),
    active: a[7] === 'start',
    analyses,
    forecasts: forecasts.sort((x, y) => x.time.localeCompare(y.time)),
    issued: analyses.at(-1).time,
    source: '中央气象台',
    url: 'https://typhoon.nmc.cn/',
  };
}
const tag = (xml, k) =>
  xml.match(new RegExp('<' + k + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + k + '>', 'i'))?.[1]?.trim() || '';
function positions(xml, k) {
  const coord = (s) => (/^\d+(?:\.\d+)?[NSEW]$/i.test(s) ? parseFloat(s) * (/[WS]$/i.test(s) ? -1 : 1) : NaN);
  return [...xml.matchAll(new RegExp('<' + k + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + k + '>', 'gi'))].flatMap(
    (m) => {
      const lat = coord(tag(m[1], 'Latitude')),
        lon = coord(tag(m[1], 'Longitude')),
        t = Date.parse(tag(m[1], 'Time') || tag(m[1], 'ValidTime')),
        s = tag(m[1], 'MaximumWind');
      if (!validPos(lon, lat) || !Number.isFinite(t)) return [];
      return [
        {
          lat,
          lon: lon180(lon),
          time: new Date(t).toISOString(),
          wind: /km\/h/i.test(s) ? Math.round((parseFloat(s) / 3.6) * 10) / 10 : null,
          grade: tag(m[1], 'Intensity'),
          pressure: null,
        },
      ];
    },
  );
}
async function listCyclones() {
  const now = Date.now();
  try {
    const d = await cached('tc-cma-list-v1', 5 * 60000, async () => ({
      value: {
        items: cmaList(await (await request(nmc + 'list_default', { timeout: 8500 })).text()),
        checked: new Date().toISOString(),
        source: '中央气象台',
      },
    }));
    return { ...d, delayed: now - Date.parse(d.checked) > 30 * 60000 };
  } catch {
    return cached('tc-hko-list-v3', 8 * 60000, async () => {
      const xml = await (await request(hko + 'tc_list.xml', { timeout: 10000 })).text();
      if (!/<TropicalCycloneList\b/.test(xml)) throw Error('当前台风监测源暂不可用，可查看离线最佳路径');
      const refs = [...new Set(xml.match(/hko_tctrack_\d{4}\.xml/gi) || [])];
      if (!refs.length && /<TropicalCyclone\b/i.test(xml)) throw Error('天文台目录未提供可读取的路径');
      return {
        value: {
          items: refs.map((s) => ({
            id: 'hko-' + s.match(/\d{4}/)[0],
            name: '气旋 ' + s.match(/\d{4}/)[0],
            active: true,
          })),
          checked: new Date().toISOString(),
          source: '香港天文台',
          backup: true,
        },
      };
    });
  }
}
async function cyclone(id) {
  if (!/^(?:cma-\d{1,9}|hko-\d{4})$/.test(id || ''))
    throw Object.assign(Error('未知台风编号'), { statusCode: 400 });
  return cached(
    'tc-track-v3:' + id,
    10 * 60000,
    async () => {
      if (id.startsWith('cma-')) {
        const n = id.slice(4);
        return { value: cmaTrack(await (await request(nmc + 'view_' + n, { timeout: 12000 })).text(), n) };
      }
      const xml = await (
        await request(hko + 'hko_tctrack_' + id.slice(4) + '.xml', { timeout: 12000 })
      ).text();
      const analyses = [...positions(xml, 'PastInformation'), ...positions(xml, 'AnalysisInformation')].sort(
        (a, b) => a.time.localeCompare(b.time),
      );
      if (!analyses.length || !xml.includes('tcid="' + id.slice(4) + '"'))
        throw Error('天文台未返回对应定位');
      const issued = Date.parse(tag(xml, 'BulletinTime'));
      if (!Number.isFinite(issued)) throw Error('天文台路径缺少发布时间');
      const active = Date.now() - issued < 30 * H;
      return {
        value: {
          id,
          name: tag(xml, 'TropicalCycloneName') || id,
          active,
          issued: new Date(issued).toISOString(),
          analyses,
          forecasts: active
            ? positions(xml, 'ForecastInformation').filter((p) => p.time > analyses.at(-1).time)
            : [],
          source: '香港天文台',
          url: 'https://www.hko.gov.hk/en/wxinfo/currwx/tc_pos.htm',
        },
      };
    },
    { stale: 2 * H },
  );
}
async function cyclones() {
  const list = await listCyclones();
  return {
    storms: await Promise.all(list.items.filter((s) => s.active).map((s) => cyclone(s.id))),
    checked: list.checked,
    source: list.source,
  };
}
module.exports = { listCyclones, cyclone, cyclones, cmaList, cmaTrack, positions };
