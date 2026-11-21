import { get, fmtNum, layerUnit, clockTime } from './base.js';
import { gridIndex } from './levels.js';
let geography;
const textures = new WeakMap(),
  images = new Map();
export function loadLand() {
  return (geography ||= get('/assets/data/land.json')
    .then((rings) =>
      rings.map((points) => {
        const bounds = [180, 90, -180, -90];
        for (const [a, b] of points) {
          bounds[0] = Math.min(bounds[0], a);
          bounds[1] = Math.min(bounds[1], b);
          bounds[2] = Math.max(bounds[2], a);
          bounds[3] = Math.max(bounds[3], b);
        }
        return { points, bounds };
      })
    )
    .catch((e) => {
      geography = undefined;
      throw e;
    }));
}
const palettes = {
  wind: [
    [0, [24, 48, 83]],
    [4, [32, 69, 104]],
    [8, [35, 105, 130]],
    [14, [70, 145, 153]],
    [22, [198, 174, 115]],
    [36, [180, 106, 87]],
  ],
  temp: [
    [-40, [74, 58, 121]],
    [-20, [69, 83, 147]],
    [-5, [58, 130, 165]],
    [4, [103, 173, 170]],
    [14, [198, 193, 133]],
    [25, [212, 156, 98]],
    [38, [180, 91, 89]],
  ],
  height: [
    [4900, [62, 56, 113]],
    [5300, [63, 95, 149]],
    [5530, [55, 132, 153]],
    [5720, [114, 170, 151]],
    [5830, [193, 180, 115]],
    [5900, [208, 146, 94]],
    [6020, [180, 109, 99]],
  ],
  pressure: [
    [965, [105, 68, 118]],
    [990, [96, 102, 147]],
    [1005, [69, 134, 151]],
    [1015, [116, 159, 146]],
    [1025, [177, 177, 128]],
    [1045, [193, 147, 108]],
    [1070, [167, 103, 85]],
  ],
  rh: [
    [0, [54, 65, 88]],
    [25, [67, 93, 116]],
    [50, [68, 129, 141]],
    [75, [106, 166, 160]],
    [100, [199, 214, 185]],
  ],
  rain: [
    [0, [31, 52, 71]],
    [0.1, [59, 92, 115]],
    [0.5, [64, 140, 157]],
    [2, [111, 189, 164]],
    [5, [213, 187, 111]],
    [12, [206, 118, 95]],
    [25, [171, 85, 127]],
  ],
};
function palette(layer) {
  if (layer === 'height400' || layer === 'height300') {
    const offset = layer === 'height400' ? 1650 : 3650;
    return palettes.height.map(([value, rgb]) => [value + offset, rgb]);
  }
  if (layer.startsWith('temp') && Number(layer.slice(4)) >= 300) {
    const offset = { 925: 4, 850: 0, 700: -8, 600: -15, 500: -23, 400: -35, 300: -44 }[layer.slice(4)] || 0;
    return palettes.temp.map(([value, rgb]) => [value + offset, rgb]);
  }
  if (layer === 'wind300' || layer === 'wind400')
    return palettes.wind.map(([value, rgb]) => [value * 2, rgb]);
  return layer.startsWith('wind')
    ? palettes.wind
    : layer.startsWith('temp')
      ? palettes.temp
      : layer === 'height500'
        ? palettes.height
        : layer.startsWith('moisture')
          ? palettes.rh
          : layer === 'rainRate'
            ? palettes.rain
            : palettes.pressure;
}
function color(stops, v) {
  let b = stops.findIndex((p) => p[0] >= v);
  if (b <= 0) return stops[b < 0 ? stops.length - 1 : 0][1];
  let a = stops[b - 1],
    z = stops[b],
    t = (v - a[0]) / (z[0] - a[0]);
  return a[1].map((val, i) => Math.round(val + (z[1][i] - val) * t));
}
export function legend(layer) {
  const p = palette(layer),
    low = p[0][0],
    high = p.at(-1)[0];
  return {
    gradient:
      'linear-gradient(to right,' +
      p
        .map((s) => 'rgb(' + s[1].join(',') + ') ' + ((s[0] - low) / (high - low)) * 100 + '%')
        .join(',') +
      ')',
    low,
    high,
    unit: layerUnit[layer],
  };
}
function scalar(g, i) {
  if (!Number.isFinite(g.values[i]) || (g.v && !Number.isFinite(g.v[i]))) return null;
  return g.v ? Math.hypot(g.values[i], g.v[i]) : g.values[i];
}
function texture(g) {
  if (textures.has(g)) return textures.get(g);
  const c = document.createElement('canvas');
  c.width = g.nx;
  c.height = g.ny;
  const t = c.getContext('2d'),
    pixels = t.createImageData(g.nx, g.ny),
    p = palette(g.layer);
  let coverage;
  for (let i = 0; i < g.values.length; i++) {
    let val = scalar(g, i);
    if (val === null) {
      coverage ||= t.createImageData(g.nx, g.ny);
      coverage.data.set(g.terrainMask?.[i] ? [111, 113, 116, 255] : [32, 60, 84, 255], 4 * i);
      continue;
    }
    let rgb = color(p, val);
    pixels.data.set([...rgb, 255], 4 * i);
  }
  t.putImageData(pixels, 0, 0);
  const result = { field: c, coverage: null };
  if (coverage) {
    result.coverage = c.cloneNode();
    result.coverage.getContext('2d').putImageData(coverage, 0, 0);
  }
  textures.set(g, result);
  return result;
}
function imageFor(src) {
  if (!images.has(src)) {
    let img = new Image();
    const p = new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => {
        images.delete(src);
        reject(Error('云图图像无法读取'));
      };
    });
    img.src = src;
    images.set(src, p);
    if (images.size > 28) images.delete(images.keys().next().value);
  }
  return images.get(src);
}
export function sample(g, lon, lat) {
  const k = gridIndex(g, lon, lat);
  if (k < 0) return null;
  const x = k % g.nx, y = Math.floor(k / g.nx);
  return {
    value: scalar(g, k),
    belowGround: Boolean(g.terrainMask?.[k]),
    u: g.values[k],
    v: g.v?.[k],
    lon: g.bbox[0] + x * g.step,
    lat: g.bbox[3] - y * g.step,
  };
}
export function extentFor(c, bbox) {
  const r = c.getBoundingClientRect(),
    cx = (bbox[0] + bbox[2]) / 2,
    cy = (bbox[1] + bbox[3]) / 2;
  if (!r.width || !r.height) return bbox;
  const ratio = r.width / r.height / Math.max(0.3, Math.cos((cy * Math.PI) / 180));
  let dw = bbox[2] - bbox[0],
    dh = bbox[3] - bbox[1];
  if (dw / dh < ratio) dh = dw / ratio;
  else dw = dh * ratio;
  return [cx - dw / 2, cy - dh / 2, cx + dw / 2, cy + dh / 2];
}
function frame(c, bbox) {
  const r = c.getBoundingClientRect(),
    w = r.width,
    h = r.height;
  if (!w || !h) return null;
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(w * d),
    ch = Math.round(h * d);
  if (c.width !== cw || c.height !== ch) {
    c.width = cw;
    c.height = ch;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const x = (a) => ((a - bbox[0]) / (bbox[2] - bbox[0])) * w,
    y = (b) => ((bbox[3] - b) / (bbox[3] - bbox[1])) * h;
  return {
    ctx,
    w,
    h,
    x,
    y,
    lon: (x) => bbox[0] + (x / w) * (bbox[2] - bbox[0]),
    lat: (y) => bbox[3] - (y / h) * (bbox[3] - bbox[1]),
  };
}
function coastline(f, rings, bbox, fill) {
  const { ctx, x, y } = f;
  ctx.beginPath();
  for (const r of rings) {
    if (
      r.bounds[2] < bbox[0] ||
      r.bounds[0] > bbox[2] ||
      r.bounds[3] < bbox[1] ||
      r.bounds[1] > bbox[3]
    )
      continue;
    let first = true,
      px = -1000,
      py = -1000;
    for (const p of r.points) {
      const xx = x(p[0]),
        yy = y(p[1]);
      if (!first && Math.abs(xx - px) + Math.abs(yy - py) < 1) continue;
      if (first) {
        ctx.moveTo(xx, yy);
        first = false;
      } else ctx.lineTo(xx, yy);
      px = xx;
      py = yy;
    }
    ctx.closePath();
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = 'rgba(217,234,238,.72)';
  ctx.lineWidth = 0.85;
  ctx.stroke();
}
function graticule(f, b) {
  const { ctx, x, y, w, h } = f;
  const inc = b[2] - b[0] > 200 ? 30 : b[2] - b[0] > 50 ? 10 : b[2] - b[0] > 15 ? 5 : 2;
  ctx.strokeStyle = 'rgba(230,244,246,.20)';
  ctx.lineWidth = 0.65;
  ctx.setLineDash([2, 5]);
  ctx.beginPath();
  for (let l = Math.ceil(b[0] / inc) * inc; l <= b[2]; l += inc) {
    ctx.moveTo(x(l), 0);
    ctx.lineTo(x(l), h);
  }
  for (let l = Math.ceil(b[1] / inc) * inc; l <= b[3]; l += inc) {
    ctx.moveTo(0, y(l));
    ctx.lineTo(w, y(l));
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(232,243,247,.78)';
  ctx.font = '9px Segoe UI';
  for (let l = Math.ceil(b[0] / inc) * inc; l < b[2]; l += inc)
    if (x(l) > 26 && x(l) < w - 32)
      ctx.fillText(Math.abs(l) + '°' + (l < 0 ? 'W' : 'E'), x(l) + 3, h - 7);
  for (let l = Math.ceil(b[1] / inc) * inc; l < b[3]; l += inc)
    if (y(l) > 22 && y(l) < h - 22) ctx.fillText(Math.abs(l) + '°' + (l < 0 ? 'S' : 'N'), 5, y(l) - 3);
}
function windLines(f, g) {
  const { ctx, w, h, lon, lat } = f;
  const spacing = Math.max(15, Math.min(22, w / 31));
  ctx.lineWidth = 0.85;
  for (let sy = -spacing, j = 0; sy < h + spacing; sy += spacing, j++)
    for (let sx = -spacing, k = 0; sx < w + spacing; sx += spacing, k++) {
      const seed = Math.sin((j + 1) * 78.233 + (k + 1) * 12.9898) * 43758.5453,
        rand = seed - Math.floor(seed);
      let xx = sx + (rand - 0.5) * spacing,
        yy = sy + Math.sin(k * 4 + j) * 0.36 * spacing;
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      let vx = 0,
        vy = 0,
        valid = false;
      for (let p = 0; p < 8 + Math.floor(rand * 7); p++) {
        const s = sample(g, lon(xx), lat(yy));
        if (!s || s.value < 0.4) break;
        const lx = (s.u / Math.max(0.3, Math.cos((lat(yy) * Math.PI) / 180))) * (f.x(1) - f.x(0)),
          ly = s.v * (f.y(1) - f.y(0)),
          mag = Math.hypot(lx, ly);
        if (!mag) break;
        vx = lx / mag;
        vy = ly / mag;
        xx += vx * 2.25;
        yy += vy * 2.25;
        ctx.lineTo(xx, yy);
        valid = true;
      }
      if (valid && (k + j) % 3 === 0) {
        ctx.lineTo(xx - vx * 3 - vy * 1.55, yy - vy * 3 + vx * 1.55);
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx - vx * 3 + vy * 1.55, yy - vy * 3 - vx * 1.55);
      }
      ctx.strokeStyle = 'rgba(222,244,241,' + (0.32 + 0.35 * rand) + ')';
      ctx.stroke();
    }
}
function contours(f, g, bbox) {
  const inc =
    g.layer.startsWith('height') ? 40 : g.layer.startsWith('temp') ? 4 : g.layer.startsWith('moisture') ? 15 : 4;
  const { ctx, x, y } = f;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(247,250,242,.57)';
  ctx.lineWidth = 0.8;
  const labels = [],
    highlight = new Path2D();
  for (
    let row = Math.max(0, Math.floor((g.bbox[3] - bbox[3]) / g.step) - 1);
    row < Math.min(g.ny - 1, Math.ceil((g.bbox[3] - bbox[1]) / g.step) + 1);
    row++
  ) {
    for (
      let col = Math.max(0, Math.floor((bbox[0] - g.bbox[0]) / g.step) - 1);
      col < Math.min(g.nx - 1, Math.ceil((bbox[2] - g.bbox[0]) / g.step) + 1);
      col++
    ) {
      const i = row * g.nx + col,
        v = [g.values[i], g.values[i + 1], g.values[i + 1 + g.nx], g.values[i + g.nx]];
      if (v.some((n) => n == null)) continue;
      const xx = x(g.bbox[0] + col * g.step),
        yy = y(g.bbox[3] - row * g.step),
        dx = x(g.step) - x(0),
        dy = y(-g.step) - y(0);
      const pts = [
        [xx, yy],
        [xx + dx, yy],
        [xx + dx, yy + dy],
        [xx, yy + dy],
      ];
      for (let level = Math.ceil(Math.min(...v) / inc) * inc; level <= Math.max(...v); level += inc) {
        const hit = [];
        for (let n = 0; n < 4; n++) {
          let m = (n + 1) % 4;
          if (v[n] < level === v[m] < level) continue;
          let p = (level - v[n]) / (v[m] - v[n]);
          hit.push([pts[n][0] + (pts[m][0] - pts[n][0]) * p, pts[n][1] + (pts[m][1] - pts[n][1]) * p]);
        }
        for (let n = 1; n < hit.length; n += 2) {
          ctx.moveTo(...hit[n - 1]);
          ctx.lineTo(...hit[n]);
          if (g.layer === 'height500' && level === 5880) {
            highlight.moveTo(...hit[n - 1]);
            highlight.lineTo(...hit[n]);
          }
        }
        if (hit.length >= 2 && (row + col) % 4 === 0) {
          const px = (hit[0][0] + hit[1][0]) / 2,
            py = (hit[0][1] + hit[1][1]) / 2;
          if (
            px > 39 &&
            px < f.w - 40 &&
            py > 24 &&
            py < f.h - 30 &&
            labels.length < 9 &&
            !labels.some((l) => Math.abs(l[0] - px) < 125 && Math.abs(l[1] - py) < 61)
          )
            labels.push([px, py, level]);
        }
      }
    }
  }
  ctx.stroke();
  ctx.strokeStyle = '#ffe599';
  ctx.lineWidth = 1.4;
  ctx.stroke(highlight);
  ctx.font = '10px Consolas,monospace';
  ctx.textAlign = 'center';
  for (const [px, py, level] of labels) {
    const s = String(level),
      tw = ctx.measureText(s).width;
    ctx.fillStyle = 'rgba(27,49,65,.74)';
    ctx.fillRect(px - tw / 2 - 2, py - 9, tw + 4, 12);
    ctx.fillStyle = '#eff5f1';
    ctx.fillText(s, px, py);
  }
  ctx.textAlign = 'start';
}
const cities = [
  [116.4, 39.9, '北京'],
  [121.47, 31.23, '上海'],
  [118.8, 32.05, '南京'],
  [114.3, 30.6, '武汉'],
  [113.26, 23.13, '广州'],
  [104.07, 30.67, '成都'],
  [126.6, 45.8, '哈尔滨'],
  [108.94, 34.34, '西安'],
  [117.0, 36.67, '济南'],
  [120.38, 36.07, '青岛'],
  [121.4, 37.46, '烟台'],
  [121.62, 38.92, '大连'],
  [126.98, 37.56, '首尔'],
  [139.69, 35.68, '东京'],
  [91.13, 29.65, '拉萨'],
  [87.62, 43.83, '乌鲁木齐'],
  [120.15, 30.27, '杭州'],
  [114.17, 22.28, '香港'],
];
function markers(f, point, tag, annot, showCities) {
  const { ctx, w, h, x, y } = f;
  const used = [];
  function mark(lon, lat, txt, special) {
    let xx = x(lon),
      yy = y(lat);
    if (xx < 5 || yy < 10 || xx > w - 5 || yy > h - 18) return;
    if (!special && used.some((p) => Math.abs(p[4] - xx) < 55 && Math.abs(p[5] - yy) < 18)) return;
    ctx.font = (special ? '600 12px ' : '10px ') + '"Microsoft YaHei UI",sans-serif';
    const tw = ctx.measureText(txt).width;
    const fits = ([left, base]) => left >= 2 && left + tw < w - 2 && base >= 13 && base < h - 1 &&
      used.every((box) => left > box[2] + 3 || left + tw < box[0] - 3 || base < box[1] - 2 || base - 12 > box[3] + 2);
    const candidates = [yy + 4, yy - 9, yy + 18].flatMap((base) => [[xx + 9, base], [xx - tw - 9, base]]);
    const label = candidates.find(fits);
    if (!label && !special) return;
    const [tx, ty] = label || [Math.max(2, Math.min(w - tw - 2, xx + 9)), yy + 4];
    used.push([tx, ty - 12, tx + tw, ty, xx, yy]);
    ctx.fillStyle = special ? '#ffdeb1' : '#e7f2f1';
    ctx.beginPath();
    ctx.arc(xx, yy, special ? 3.6 : 1.9, 0, Math.PI * 2);
    ctx.fill();
    if (special) {
      ctx.strokeStyle = 'rgba(255,221,162,.76)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(xx, yy, 7.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(22,44,64,.85)';
    ctx.strokeText(txt, tx, ty);
    ctx.fillText(txt, tx, ty);
  }
  if (point && tag && !(annot && point[0] === annot[0] && point[1] === annot[1]))
    mark(point[0], point[1], tag, true);
  if (annot) mark(annot[0], annot[1], annot[2], true);
  if (showCities) for (const p of cities) mark(...p, false);
}
function drawTrack(f, track, valid) {
  const { ctx, x, y } = f;
  let until = Date.parse(valid);
  for (const s of track.storms || []) {
    let pts = s.analyses.filter((p) => Date.parse(p.time) <= until);
    const fc = (!s.issued || Date.parse(s.issued) <= until ? s.forecasts || [] : []).filter(
      (p) => Date.parse(p.time) > Date.parse(pts.at(-1)?.time || 0)
    );
    for (const [list, predicted] of [
      [pts, false],
      [pts.length ? [pts.at(-1), ...fc] : fc, true],
    ]) {
      ctx.setLineDash(predicted ? [5, 5] : []);
      ctx.beginPath();
      list.forEach((p, i) => (i ? ctx.lineTo(x(p.lon), y(p.lat)) : ctx.moveTo(x(p.lon), y(p.lat))));
      ctx.strokeStyle = predicted ? '#f1debe' : '#ffce85';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of list) {
        ctx.beginPath();
        ctx.arc(x(p.lon), y(p.lat), 2.8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd29a';
        ctx.fill();
      }
    }
    const last = pts.at(-1);
    if (last) markers(f, [last.lon, last.lat], s.name, null, false);
  }
}
function zonal(f, g) {
  const { ctx, w, h } = f;
  const vals = [];
  for (let row = 0; row < g.ny; row++) {
    const a = g.values.slice(row * g.nx, (row + 1) * g.nx).filter(Number.isFinite);
    vals.push(a.reduce((s, n) => s + n, 0) / a.length);
  }
  const min = Math.floor(Math.min(...vals) / 5) * 5,
    max = Math.ceil(Math.max(...vals) / 5) * 5;
  const xx = (i) => 30 + ((w - 58) * i) / (vals.length - 1),
    yy = (v) => 25 + ((h - 58) * (max - v)) / (max - min);
  ctx.fillStyle = '#203951';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '11px Segoe UI';
  ctx.fillStyle = '#d7e8ef';
  for (let v = min; v <= max; v += 10) {
    ctx.strokeStyle = '#455b70';
    ctx.beginPath();
    ctx.moveTo(27, yy(v));
    ctx.lineTo(w - 15, yy(v));
    ctx.stroke();
    ctx.fillText(v, 3, yy(v) - 2);
  }
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(xx(i), yy(v)) : ctx.moveTo(xx(i), yy(v))));
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = '#88ded2';
  ctx.stroke();
  ['90°N', '45°N', '赤道', '45°S', '90°S'].forEach((s, i) => ctx.fillText(s, xx(i * 18) - 12, h - 11));
}
export async function drawMap(canvas, data, options = {}) {
  const token = Symbol();
  canvas.paintToken = token;
  const rings = await loadLand();
  const img = data?.image ? await imageFor(data.image) : null;
  if (canvas.paintToken !== token || !canvas.isConnected) return;
  const bbox = extentFor(canvas, options.bbox || data?.bbox || [75, 16, 136, 55]),
    f = frame(canvas, bbox);
  if (!f) return;
  const { ctx, w, h, x, y } = f;
  ctx.fillStyle = '#203c54';
  ctx.fillRect(0, 0, w, h);
  if (options.zonal && data?.values) {
    zonal(f, data);
    return;
  }
  if (data?.values) {
    const b = data.bbox,
      step = data.step;
    const xx = x(b[0] - step / 2),
      yy = y(b[3] + step / 2);
    const raster = texture(data), width = x(b[2] + step / 2) - xx, height = y(b[1] - step / 2) - yy;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(raster.field, xx, yy, width, height);
    if (raster.coverage) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(raster.coverage, xx, yy, width, height);
    }
  }
  if (img) {
    if (data.externalImage) {
      const scale = Math.min(w / img.width, h / img.height);
      ctx.drawImage(
        img,
        (w - img.width * scale) / 2,
        (h - img.height * scale) / 2,
        img.width * scale,
        img.height * scale
      );
      return;
    }
    const b = data.bbox;
    ctx.drawImage(img, x(b[0]), y(b[3]), x(b[2]) - x(b[0]), y(b[1]) - y(b[3]));
    ctx.fillStyle = 'rgba(15,39,54,.15)';
    ctx.fillRect(0, 0, w, h);
  }
  coastline(f, rings, bbox, data?.values || img ? 'rgba(18,48,70,.10)' : '#304d62');
  graticule(f, bbox);
  if (data?.v) windLines(f, data);
  else if (data?.values) contours(f, data, bbox);
  if (data?.storms) drawTrack(f, data, data.valid || new Date().toISOString());
  markers(f, options.point, options.tag, options.annotation, options.cities !== false);
}
export function geoFromPointer(canvas, event, bbox) {
  const r = canvas.getBoundingClientRect(),
    b = extentFor(canvas, bbox);
  return [
    b[0] + ((event.clientX - r.left) / r.width) * (b[2] - b[0]),
    b[3] - ((event.clientY - r.top) / r.height) * (b[3] - b[1]),
  ];
}
