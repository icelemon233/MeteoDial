'use strict';
const { cached, request } = require('./network.cjs');
const { PNG } = require('pngjs');
const H = 3600000,
  tenMinutes = 600000,
  infrared = 'Himawari_AHI_Band13_Clean_Infrared';
const gibs = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
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
    const first = Date.parse(from),
      last = through ? Date.parse(through) : first;
    if (
      !Number.isFinite(first) ||
      !Number.isFinite(last) ||
      last < cutoff ||
      first > now ||
      (through && cadence !== 'PT10M')
    )
      continue;
    const begin = first + Math.max(0, Math.ceil((cutoff - first) / tenMinutes)) * tenMinutes;
    for (let t = begin; t <= Math.min(now, last); t += tenMinutes) times.add(t);
  }
  return [...times].sort((a, b) => a - b).map((t) => ({ time: new Date(t).toISOString() }));
}
async function publishedInfrared() {
  return cached(
    'gibs-himawari13-times-v1',
    5 * 60000,
    async () => {
      const response = await request(gibs + '?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0', {
        timeout: 20000,
        preferSystem: true,
      });
      const frames = observationTimes(await response.text(), Date.now());
      if (!frames.length) throw Error('近一天暂无已发布的后备红外观测');
      return { value: { frames } };
    },
    { stale: 75 * 60000 },
  );
}
async function infraredImage(valid, bbox, region) {
  const utc = new Date(valid).toISOString();
  return cached('gibs-himawari13-geo-v1:' + bbox.join(',') + utc, 24 * H, async () => {
    const { frames } = await publishedInfrared();
    if (!frames.some((frame) => Date.parse(frame.time) === valid))
      throw Error('后备红外源尚未发布所选时次的观测');
    const width = 1024;
    const height = Math.round((width * (bbox[3] - bbox[1])) / (bbox[2] - bbox[0]));
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      REQUEST: 'GetMap',
      VERSION: '1.1.1',
      LAYERS: infrared,
      STYLES: '',
      FORMAT: 'image/png',
      SRS: 'EPSG:4326',
      BBOX: bbox.join(','),
      WIDTH: String(width),
      HEIGHT: String(height),
      TRANSPARENT: 'TRUE',
      TIME: utc.replace('.000Z', 'Z'),
    });
    const response = await request(gibs + '?' + params, { timeout: 20000, preferSystem: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length < 33 ||
      bytes.readUInt32BE(0) !== 0x89504e47 ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== height ||
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND'
    )
      throw Error('后备红外云图不完整');
    const png = PNG.sync.read(bytes);
    if (!png.data.some((val, i) => i % 4 === 3 && val > 0)) throw Error('所选范围和时次没有有效红外像元');
    return {
      value: {
        channel: 'B13',
        region,
        image: 'data:image/png;base64,' + bytes.toString('base64'),
        bbox: bbox,
        valid: utc,
        type: '卫星观测',
        source: '葵花 9 号 · B13 红外 · NASA GIBS',
      },
    };
  });
}
module.exports = { publishedInfrared, infraredImage, observationTimes };
