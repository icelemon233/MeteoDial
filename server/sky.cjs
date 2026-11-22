'use strict';
const { cached, request } = require('./network.cjs');
const H = 3600000;
const tenMinutes = 10 * 60000;
const gibs = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const infrared = 'Himawari_AHI_Band13_Clean_Infrared';
const archiveBounds = require('../assets/data/archive-domain.json');
const jmaRoot = 'https://www.data.jma.go.jp/mscweb/data/himawari/img/';
const regionBounds = {
  jpn: [115, 22, 155, 48],
  ca1: [70, 25, 120, 55],
  se2: [105, 0, 140, 30],
  se1: [80, 0, 115, 30],
};
function observationTimes(xml, now) {
  const start = xml.indexOf('<Name>' + infrared + '</Name>');
  if (start < 0) throw Error('卫星服务没有公布红外通道');
  const layer = xml.slice(start, xml.indexOf('</Layer>', start));
  const published = layer.match(/<Dimension\b[^>]*\bname="time"[^>]*>([^<]+)<\/Dimension>/i)?.[1];
  if (!published) throw Error('卫星服务没有公布观测时次');
  const times = new Set();
  const cutoff = now - 24 * H;
  for (const entry of published.split(',')) {
    const [from, through, cadence] = entry.trim().split('/');
    const first = Date.parse(from), last = through ? Date.parse(through) : first;
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < cutoff || first > now ||
        (through && cadence !== 'PT10M')) continue;
    const begin = first + Math.max(0, Math.ceil((cutoff - first) / tenMinutes)) * tenMinutes;
    for (let t = begin; t <= Math.min(now, last); t += tenMinutes) times.add(t);
  }
  return [...times].sort((a,b) => a-b).map(t => ({ time: new Date(t).toISOString() }));
}
async function satelliteTimes() {
  return cached('gibs-himawari13-times-v1', 5 * 60000, async () => {
    const response = await request(gibs + '?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0',
      { timeout: 20000, preferSystem: true });
    const frames = observationTimes(await response.text(), Date.now());
    if (!frames.length) throw Error('近一天暂无已发布的全国红外云图');
    return { value: { frames } };
  }, { stale: 75 * 60000 });
}
async function nationalSatellite(valid, utc) {
  return cached('gibs-himawari13-cn-v1:' + utc, 24 * H, async () => {
    const { frames } = await satelliteTimes();
    if (!frames.some(frame => Date.parse(frame.time) === valid))
      throw Error('全国红外云图在所选时次没有观测');
    const width = 1024;
    const height = Math.round(width * (archiveBounds[3] - archiveBounds[1]) / (archiveBounds[2] - archiveBounds[0]));
    const params = new URLSearchParams({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.1.1',
      LAYERS: infrared, STYLES: '', FORMAT: 'image/png', SRS: 'EPSG:4326', BBOX: archiveBounds.join(','),
      WIDTH: String(width), HEIGHT: String(height), TRANSPARENT: 'TRUE', TIME: utc.replace('.000Z', 'Z') });
    const response = await request(gibs + '?' + params, { timeout: 20000, preferSystem: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47 ||
        bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height ||
        bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw Error('全国红外云图不完整');
    return { value: { image: 'data:image/png;base64,' + bytes.toString('base64'), bbox: archiveBounds,
      valid: utc, type: '卫星观测', source: '葵花 9 号 · B13 红外 · NASA GIBS' } };
  });
}
async function satellite(time, region, fallback) {
  if (region !== 'china' && !Object.hasOwn(regionBounds, region)) throw Error('未知卫星观测区域');
  const valid = Math.floor(time / (10 * 60000)) * (10 * 60000);
  if (region === 'china' && valid !== time) throw Error('所选时刻没有对应的十分钟红外观测');
  if (valid > Date.now() - 15 * 60000 || Date.now() - valid > 23.5 * H)
    throw Error('该时刻暂无卫星观测，请选择最近一天的过去时刻');
  const utc = new Date(valid).toISOString();
  if (region === 'china') {
    try { return await nationalSatellite(valid, utc); }
    catch (error) {
      if (!Object.hasOwn(regionBounds, fallback)) throw error;
      const local = await satellite(time, fallback);
      return { ...local, source: local.source + '（区域原图）' };
    }
  }
  const hhmm = utc.slice(11, 16).replace(':', '');
  return cached('jma-ir2:' + region + ':' + utc, 23 * H, async () => {
    const res = await request(jmaRoot + region + '/' + region + '_b13_' + hhmm + '.jpg');
    const stamp = Date.parse(res.headers.get('last-modified') || '');
    if (!Number.isFinite(stamp) || Math.abs(stamp - valid) > 3 * H) {
      await res.body?.cancel();
      throw Error('这个时次的卫星图还未归档');
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes[0] !== 255 || bytes[1] !== 216) throw Error('卫星图格式错误');
    return {
      value: {
        image: 'data:image/jpeg;base64,' + bytes.toString('base64'),
        valid: utc,
        type: '卫星观测',
        source: '日本气象厅 · 葵花红外 B13',
        region,
        bbox: regionBounds[region],
        externalImage: true,
      },
    };
  });
}
const textOf = (xml, key) =>
  xml.match(new RegExp('<' + key + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + key + '>', 'i'))?.[1]?.trim() || '';
function positions(xml, tag) {
  return [...xml.matchAll(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi'))]
    .map((m) => {
      const x = m[1];
      const coordinate = (s) => parseFloat(s) * (/[SW]$/i.test(s) ? -1 : 1);
      const lat = coordinate(textOf(x, 'Latitude')),
        lon = coordinate(textOf(x, 'Longitude'));
      const time = textOf(x, 'Time') || textOf(x, 'ValidTime');
      return { lat, lon, time, wind: textOf(x, 'MaximumWind') || textOf(x, 'MaxWindSpeed') };
    })
    .filter((p) => p.lat > 0 && p.lon >= 90 && p.lon <= 180 && p.time);
}
async function cyclones() {
  return cached(
    'hko-tc-v2',
    20 * 60000,
    async () => {
      const root = 'https://www.weather.gov.hk/wxinfo/currwx/';
      const xml = await (await request(root + 'tc_list.xml')).text();
      if (!/<TropicalCycloneList\b/.test(xml)) throw Error('台风目录格式异常');
      const refs = [...new Set(xml.match(/hko_tctrack_\d{4}\.xml/gi) || [])].slice(0, 8);
      if (!refs.length && /<TropicalCyclone(?:\s|>)/i.test(xml))
        throw Error('气旋目录已更新，请查阅香港天文台发布页');
      const storms = await Promise.all(
        refs.map(async (ref) => {
          const details = await (await request(root + ref)).text();
          return {
            issued: textOf(details, 'BulletinTime'),
            name: textOf(details, 'TropicalCycloneName') || textOf(details, 'Name') || ref,
            analyses: [
              ...positions(details, 'PastInformation'),
              ...positions(details, 'AnalysisInformation'),
            ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)),
            forecasts: positions(details, 'ForecastInformation'),
          };
        })
      );
      return { value: { storms, checked: new Date().toISOString(), source: '香港天文台' } };
    },
    { stale: 2 * H }
  );
}
async function radarIndex() {
  return cached(
    'cwa-region-index-v1',
    4 * 60000,
    async () => {
      const txt = await (
        await request('https://www.cwa.gov.tw/Data/js/obs_img/Observe_radar.js', { timeout: 14000 })
      ).text();
      const frames = [...new Set([...txt.matchAll(/\bCV1_1000_(\d{12})\.png\b/g)].map((m) => m[1]))]
        .sort()
        .map((stamp) => {
          const time =
            stamp.slice(0, 4) +
            '-' +
            stamp.slice(4, 6) +
            '-' +
            stamp.slice(6, 8) +
            'T' +
            stamp.slice(8, 10) +
            ':' +
            stamp.slice(10, 12) +
            ':00+08:00';
          return { stamp, time: new Date(time).toISOString() };
        });
      if (!frames.length) throw Error('当前区域雷达索引暂无时次');
      return { value: { frames } };
    },
    { stale: 75 * 60000 }
  );
}
async function radar(time) {
  const { frames } = await radarIndex();
  const f = frames.find((x) => Date.parse(x.time) === time);
  if (!f) throw Error('所选时刻没有归档雷达图，近期观测可在观测回放中查看');
  return cached('cwa-region-png:' + f.stamp, 24 * H, async () => {
    const r = await request('https://www.cwa.gov.tw/Data/radar/CV1_1000_' + f.stamp + '.png');
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.readUInt32BE(0) !== 0x89504e47) throw Error('雷达图格式异常');
    return {
      value: {
        image: 'data:image/png;base64,' + bytes.toString('base64'),
        externalImage: true,
        valid: f.time,
        source: 'CWA · 台湾及邻近海域',
        type: '雷达观测',
      },
    };
  });
}
module.exports = { satellite, satelliteTimes, observationTimes, cyclones, radar, radarIndex, positions };
