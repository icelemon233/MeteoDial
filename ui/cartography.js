import { get, fmtNum, layerUnit, clockTime } from './base.js';
import { gridIndex } from './levels.js';
let geography;
const textures = new WeakMap(),
  images = new Map(),
  basemaps = new Map();
let basemapPixels = 0;
export const nationalView = Object.freeze([70, 2.5, 146, 54.5]);
function indexLines(lines) {
  return lines.map((points) => {
    const bounds = [180, 90, -180, -90];
    for (const [lon, lat] of points) {
      bounds[0] = Math.min(bounds[0], lon);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lon);
      bounds[3] = Math.max(bounds[3], lat);
    }
    return { points, bounds };
  });
}
export function loadLand() {
  return (geography ||= Promise.all([
    get('/assets/data/land.json?v=4.1.0'), get('/assets/data/coastlines.json'), get('/assets/data/china-boundaries.json'),
  ])
    .then(([land, coast, boundary]) => ({ land: indexLines(land), coast: indexLines(coast), boundary: indexLines(boundary) }))
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
function writeColor(pixels, offset, stops, value) {
  let upper = 0;
  while (upper < stops.length && stops[upper][0] < value) upper++;
  if (upper === 0 || upper === stops.length) {
    pixels.set(stops[Math.min(upper, stops.length - 1)][1], offset);
  } else {
    const [lo, a] = stops[upper - 1], [hi, b] = stops[upper];
    const t = (value - lo) / (hi - lo);
    for (let channel = 0; channel < 3; channel++)
      pixels[offset + channel] = Math.round(a[channel] + (b[channel] - a[channel]) * t);
  }
  pixels[offset + 3] = 255;
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
  const terrain = [111, 113, 116, 255], missing = [32, 60, 84, 255];
  let coverage;
  for (let i = 0; i < g.values.length; i++) {
    let val = scalar(g, i);
    if (val === null) {
      coverage ||= t.createImageData(g.nx, g.ny);
      coverage.data.set(g.terrainMask?.[i] ? terrain : missing, 4 * i);
      continue;
    }
    writeColor(pixels.data, 4 * i, p, val);
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
  if (!g?.values) return null;
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
function boundedAxis(center, span, limit) {
  const width = Math.min(2 * limit, Math.max(0.001, span));
  const start = Math.max(-limit, Math.min(limit - width, center - width / 2));
  return [start, start + width];
}
export function clampView(box) {
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1])
    return [...nationalView];
  const [west, east] = boundedAxis((box[0] + box[2]) / 2, box[2] - box[0], 180);
  const [south, north] = boundedAxis((box[1] + box[3]) / 2, box[3] - box[1], 90);
  return [west, south, east, north];
}
export function panView(box, east, north) {
  return clampView([box[0] + east, box[1] + north, box[2] + east, box[3] + north]);
}
function projection(w, h, requested) {
  const b = clampView(requested);
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  // Equidistant cylindrical projection with the viewpoint's centre as standard parallel.
  const cos = Math.max(0.01, Math.cos(cy * Math.PI / 180));
  const dw = b[2] - b[0], dh = b[3] - b[1];
  const ratio = w / h / cos;
  const [west, east] = boundedAxis(cx, Math.max(dw, dh * ratio), 180);
  const [south, north] = boundedAxis(cy, Math.max(dh, dw / ratio), 90);
  const scale = Math.min(w / ((east - west) * cos), h / (north - south));
  const width = (east - west) * cos * scale, height = (north - south) * scale;
  return { bbox: [west, south, east, north], width, height, left: (w - width) / 2, top: (h - height) / 2 };
}
export function extentFor(canvas, box) {
  const { width, height } = canvas.getBoundingClientRect();
  return width && height ? projection(width, height, box).bbox : clampView(box);
}
function frame(c, requested, geographic, quick) {
  const r = c.getBoundingClientRect(),
    width = r.width,
    height = r.height;
  if (!width || !height) return null;
  const view = projection(width, height, requested);
  const { bbox } = view;
  const w = geographic ? view.width : width, h = geographic ? view.height : height;
  const d = Math.min(window.devicePixelRatio || 1, quick ? 1 : 2);
  const cw = Math.round(width * d),
    ch = Math.round(height * d);
  if (c.width !== cw || c.height !== ch) {
    c.width = cw;
    c.height = ch;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = '#182c3d';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  if (geographic) {
    ctx.translate(view.left, view.top);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
  }
  const x = (a) => ((a - bbox[0]) / (bbox[2] - bbox[0])) * w,
    y = (b) => ((bbox[3] - b) / (bbox[3] - bbox[1])) * h;
  return {
    bbox,
    ctx,
    pixelRatio: d,
    w,
    h,
    x,
    y,
    lon: (x) => bbox[0] + (x / w) * (bbox[2] - bbox[0]),
    lat: (y) => bbox[3] - (y / h) * (bbox[3] - bbox[1]),
  };
}
function outlinePath(f, rings, closed) {
  const { x, y, bbox } = f;
  const path = new Path2D();
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
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i];
      const xx = x(p[0]),
        yy = y(p[1]);
      if (!first && i < r.points.length - 1 && Math.abs(xx - px) + Math.abs(yy - py) < 0.7) continue;
      if (first) {
        path.moveTo(xx, yy);
        first = false;
      } else path.lineTo(xx, yy);
      px = xx;
      py = yy;
    }
    if (closed) path.closePath();
  }
  return path;
}
function basemapFor(f, geography, shaded) {
  const key = [f.w, f.h, ...f.bbox, f.pixelRatio, shaded].join(',');
  const old = basemaps.get(key);
  if (old) {
    basemaps.delete(key);
    basemaps.set(key, old);
    return old;
  }
  function surface() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(f.w * f.pixelRatio));
    canvas.height = Math.max(1, Math.round(f.h * f.pixelRatio));
    const ctx = canvas.getContext('2d');
    ctx.scale(canvas.width / f.w, canvas.height / f.h);
    return ctx;
  }
  const base = surface(), border = surface();
  base.fillStyle = shaded ? 'rgba(18,48,70,.07)' : '#496473';
  base.fill(outlinePath(f, geography.land, true), 'evenodd');
  base.strokeStyle = 'rgba(217,234,238,.65)';
  base.lineWidth = 0.8;
  base.stroke(outlinePath(f, geography.coast, false));
  graticule({ ...f, ctx: base }, f.bbox);
  const china = outlinePath(f, geography.boundary, false);
  border.lineJoin = border.lineCap = 'round';
  border.lineWidth = 2.6;
  border.strokeStyle = 'rgba(20,39,46,.86)';
  border.stroke(china);
  border.lineWidth = 1.15;
  border.strokeStyle = '#fff5d8';
  border.stroke(china);
  const result = { base: base.canvas, border: border.canvas, pixels: base.canvas.width * base.canvas.height * 2 };
  basemaps.set(key, result);
  basemapPixels += result.pixels;
  // Share the same geography across frames, staging canvases and synchronized
  // panels. Limit retained sizes when the window or geographic extent changes.
  while (basemaps.size > 1 && (basemaps.size > 4 || basemapPixels > 8_000_000)) {
    const oldest = basemaps.keys().next().value;
    const retired = basemaps.get(oldest);
    basemapPixels -= retired.pixels;
    basemaps.delete(oldest);
    retired.base.width = retired.border.width = 0;
  }
  return result;
}
function axisLabel(value, negative, positive) {
  return Math.abs(value) + '°' + (value === 0 || Math.abs(value) === 180 ? '' : value < 0 ? negative : positive);
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
      ctx.fillText(axisLabel(l, 'W', 'E'), x(l) + 3, h - 7);
  for (let l = Math.ceil(b[1] / inc) * inc; l < b[3]; l += inc)
    if (y(l) > 22 && y(l) < h - 22) ctx.fillText(axisLabel(l, 'S', 'N'), 5, y(l) - 3);
}
function windLines(f, g, quick) {
  const { ctx, w, h, lon, lat } = f;
  const spacing = quick ? 30 : Math.max(15, Math.min(22, w / 31));
  ctx.lineWidth = 0.85;
  if (quick) ctx.beginPath();
  for (let sy = -spacing, j = 0; sy < h + spacing; sy += spacing, j++)
    for (let sx = -spacing, k = 0; sx < w + spacing; sx += spacing, k++) {
      const seed = Math.sin((j + 1) * 78.233 + (k + 1) * 12.9898) * 43758.5453,
        rand = seed - Math.floor(seed);
      let xx = sx + (rand - 0.5) * spacing,
        yy = sy + Math.sin(k * 4 + j) * 0.36 * spacing;
      if (!quick) ctx.beginPath();
      ctx.moveTo(xx, yy);
      let vx = 0,
        vy = 0,
        valid = false;
      const steps = quick ? 5 : 8 + Math.floor(rand * 7);
      for (let p = 0; p < steps; p++) {
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
      if (valid && (quick || (k + j) % 3 === 0)) {
        ctx.lineTo(xx - vx * 3 - vy * 1.55, yy - vy * 3 + vx * 1.55);
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx - vx * 3 + vy * 1.55, yy - vy * 3 - vx * 1.55);
      }
      if (!quick) {
        ctx.strokeStyle = 'rgba(222,244,241,' + (0.32 + 0.35 * rand) + ')';
        ctx.stroke();
      }
    }
  if (quick) {
    ctx.strokeStyle = 'rgba(222,244,241,.65)';
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
  const rowStart = Math.max(0, Math.floor((g.bbox[3] - bbox[3]) / g.step) - 1);
  const rowEnd = Math.min(g.ny - 1, Math.ceil((g.bbox[3] - bbox[1]) / g.step) + 1);
  const colStart = Math.max(0, Math.floor((bbox[0] - g.bbox[0]) / g.step) - 1);
  const colEnd = Math.min(g.nx - 1, Math.ceil((bbox[2] - g.bbox[0]) / g.step) + 1);
  const dx = x(g.step) - x(0), dy = y(-g.step) - y(0);
  for (let row = rowStart; row < rowEnd; row++) {
    const yy = y(g.bbox[3] - row * g.step);
    for (let col = colStart; col < colEnd; col++) {
      const i = row * g.nx + col;
      const a = g.values[i], b = g.values[i + 1], c = g.values[i + 1 + g.nx], d = g.values[i + g.nx];
      if (a == null || b == null || c == null || d == null) continue;
      const min = Math.min(a, b, c, d), max = Math.max(a, b, c, d);
      const first = Math.ceil(min / inc) * inc;
      if (min === max || first > max) continue;
      const v = [a, b, c, d], xx = x(g.bbox[0] + col * g.step);
      const pts = [
        [xx, yy],
        [xx + dx, yy],
        [xx + dx, yy + dy],
        [xx, yy + dy],
      ];
      for (let level = first; level <= max; level += inc) {
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
  return labels;
}
function labelContours(ctx, labels, markers) {
  ctx.font = '10px Consolas,monospace';
  ctx.textAlign = 'center';
  for (const [px, py, level] of labels) {
    const s = String(level),
      tw = ctx.measureText(s).width;
    const left = px - tw / 2 - 4, right = px + tw / 2 + 4;
    const top = py - 11, bottom = py + 5;
    const collides = markers.some(([x0, y0, x1, y1, dotX, dotY]) =>
      (left < x1 + 2 && right > x0 - 2 && top < y1 + 3 && bottom > y0 - 2) ||
      (left < dotX + 8 && right > dotX - 8 && top < dotY + 8 && bottom > dotY - 8));
    if (collides) continue;
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
  [75.99, 39.47, '喀什'],
  [110.35, 20.02, '海口'],
  [121.56, 25.04, '台北'],
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
  return used;
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
export async function prepareMapData(data) {
  if (data?.values) texture(data);
  const [geography, image, detail] = await Promise.all([
    loadLand(),
    data?.image ? imageFor(data.image) : null,
    data?.detailImage ? imageFor(data.detailImage).catch(() => null) : null,
  ]);
  return { geography, image, detail };
}
export async function drawMap(canvas, data, options = {}) {
  const token = Symbol();
  canvas.paintToken = token;
  const { geography, image, detail } = await prepareMapData(data);
  if (canvas.paintToken !== token || !canvas.isConnected) return;
  const f = frame(canvas, options.bbox || data?.bbox || nationalView,
    !options.zonal && !data?.externalImage, options.quick);
  if (!f) return;
  try {
    paint(f, data, options, geography, image, detail);
  } finally {
    f.ctx.restore();
  }
}
function paint(f, data, options, geography, img, detail) {
  const { ctx, w, h, x, y, bbox } = f;
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
    if (detail && data.detailBounds && bbox[2] - bbox[0] < 45) {
      const a = data.detailBounds;
      ctx.drawImage(detail, x(a[0]), y(a[3]), x(a[2]) - x(a[0]), y(a[1]) - y(a[3]));
    }
    ctx.fillStyle = 'rgba(15,39,54,.15)';
    ctx.fillRect(0, 0, w, h);
  }
  const basemap = basemapFor(f, geography, Boolean(data?.values || img));
  ctx.drawImage(basemap.base, 0, 0, w, h);
  let contourLabels = [];
  if (data?.v) windLines(f, data, options.quick);
  else if (data?.values && !options.quick) contourLabels = contours(f, data, bbox);
  ctx.drawImage(basemap.border, 0, 0, w, h);
  ctx.lineJoin = ctx.lineCap = 'round';
  if (data?.storms) drawTrack(f, data, data.valid || new Date().toISOString());
  const occupied = markers(f, options.point, options.tag, options.annotation, options.cities !== false);
  labelContours(ctx, contourLabels, occupied);
}
export function geoFromPointer(canvas, event, bbox) {
  const r = canvas.getBoundingClientRect();
  const view = projection(Math.max(1, r.width), Math.max(1, r.height), bbox);
  const b = view.bbox;
  const u = Math.max(0, Math.min(1, (event.clientX - r.left - view.left) / view.width));
  const v = Math.max(0, Math.min(1, (event.clientY - r.top - view.top) / view.height));
  return [
    b[0] + u * (b[2] - b[0]),
    b[3] - v * (b[3] - b[1]),
  ];
}
