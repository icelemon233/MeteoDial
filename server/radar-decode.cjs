'use strict';
const proj4 = require('proj4');
// Academia Sinica GIS Center's revised TWD67 definition for regional mapping.
const transform = proj4(
  'EPSG:4326',
  '+proj=longlat +a=6378160 +rf=298.25 +towgs84=-752,-358,-179,-0.0000011698,0.0000018398,0.0000009822,0.00002329 +no_defs',
);
const tag = (s, k) => s.match(new RegExp('<' + k + '>([^<]*)</' + k + '>'))?.[1];
let mapping;
function decodeRadar(xml, valid) {
  const x = Number(tag(xml, 'GridDimensionX')),
    y = Number(tag(xml, 'GridDimensionY')),
    step = Number(tag(xml, 'GridResolution'));
  if (
    tag(xml, 'dataid') !== 'O-A0059-001' ||
    Date.parse(tag(xml, 'DateTime')) !== Date.parse(valid) ||
    tag(xml, 'Reflectivity') !== 'dBZ' ||
    x !== 921 ||
    y !== 881 ||
    step !== 0.0125 ||
    Number(tag(xml, 'StartPointLatitude')) !== 18 ||
    Number(tag(xml, 'StartPointLongitude')) !== 115 ||
    !tag(xml, 'contentDescription')?.includes('TWD67')
  )
    throw Error('CWA 回波时刻、单位或地理坐标不符');
  const start = xml.indexOf('<content>'),
    end = xml.indexOf('</content>', start);
  if (start < 0 || end <= start || end - start > 20 * 1024 ** 2) throw Error('CWA 格点资料不完整');
  const cells = xml
    .slice(start + 9, end)
    .trim()
    .split(',');
  if (cells.length !== x * y) throw Error('CWA 格点数量不符');
  const bbox = [115.05, 18.05, 126.45, 28.95],
    outStep = 0.05,
    nx = 229,
    ny = 219;
  if (!mapping)
    mapping = Array.from({ length: nx * ny }, (_, i) => {
      const [lon, lat] = transform.forward([
        bbox[0] + (i % nx) * outStep,
        bbox[3] - Math.floor(i / nx) * outStep,
      ]);
      return Math.round((lat - 18) / step) * x + Math.round((lon - 115) / step);
    });
  const values = mapping.map((i) => {
    const s = cells[i]?.trim(),
      v = s ? Number(s) : NaN;
    return Number.isFinite(v) && v >= -32 && v <= 100 ? v : null;
  });
  return {
    layer: 'radar',
    type: '雷达观测',
    source: 'CWA · 台湾及近海合成回波',
    valid,
    nx,
    ny,
    step: outStep,
    bbox,
    values,
    resolution: '0.0125°',
    channel: 'CWA O-A0059-001 · TWD67 转 WGS84，区域抽样',
  };
}
module.exports = { decodeRadar };
