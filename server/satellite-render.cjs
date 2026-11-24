'use strict';
const jpeg = require('jpeg-js');
const { parentPort } = require('node:worker_threads');
const { solarTerms } = require('../shared/satellite.mjs');
const mercY = (lat) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
function render({ tiles, bbox, z, width, height, day, time }) {
  const world = 256 * 2 ** z,
    cache = new Map(),
    output = Buffer.alloc(width * height * 4),
    r = Math.PI / 180,
    { decl, noonAngle } = solarTerms(time);
  for (const t of tiles) {
    const im = jpeg.decode(Buffer.from(t.bytes), {
      useTArray: true,
      maxResolutionInMP: 1,
      maxMemoryUsageInMB: 32,
    });
    if (im.width !== 256 || im.height !== 256) throw Error('葵花瓦片尺寸异常');
    cache.set(t.x + ',' + t.y, im.data);
  }
  const xs = Array.from({ length: width }, (_, i) => {
    const lon = bbox[0] + ((i + 0.5) / width) * (bbox[2] - bbox[0]);
    const n = Math.floor(((lon + 180) / 360) * world);
    return [Math.floor(n / 256), n % 256, Math.cos(noonAngle + lon * r)];
  });
  let visible = 0,
    lo = 255,
    hi = 0;
  for (let j = 0; j < height; j++) {
    const lat = bbox[3] - ((j + 0.5) / height) * (bbox[3] - bbox[1]),
      n = Math.max(0, Math.min(world - 1, Math.floor(mercY(lat) * world))),
      ty = Math.floor(n / 256),
      row = n % 256;
    const a = Math.sin(lat * r) * Math.sin(decl),
      b = Math.cos(lat * r) * Math.cos(decl);
    for (let i = 0; i < width; i++) {
      const [tx, col, cos] = xs[i],
        px = cache.get(tx + ',' + ty),
        at = (j * width + i) * 4,
        from = (row * 256 + col) * 4;
      if (px && (!day || a + b * cos > 0)) {
        output[at] = px[from];
        output[at + 1] = px[from + 1];
        output[at + 2] = px[from + 2];
        visible++;
        lo = Math.min(lo, px[from]);
        hi = Math.max(hi, px[from]);
      } else {
        output[at] = 31;
        output[at + 1] = 45;
        output[at + 2] = 55;
      }
      output[at + 3] = 255;
    }
  }
  if (!visible || hi - lo < 2) throw Error('所选通道在该范围没有可辨识的观测信号');
  return Buffer.from(jpeg.encode({ data: output, width, height }, 84).data);
}
if (parentPort)
  parentPort.on('message', (job) => {
    try {
      if (job.kind === 'radar') {
        const grid = require('./radar-decode.cjs').decodeRadar(job.xml, job.valid);
        parentPort.postMessage({ id: job.id, grid });
      } else parentPort.postMessage({ id: job.id, bytes: render(job) });
    } catch (e) {
      parentPort.postMessage({ id: job.id, error: e.message });
    }
  });
module.exports = { render };
