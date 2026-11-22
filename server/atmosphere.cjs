'use strict';

const kelvin = 273.15,
  epsilon = 0.622,
  rd = 287.05,
  cp = 1004.0,
  lv = 2.5e6;
const finite = Number.isFinite;
const round = (n, digits = 1) => (finite(n) ? Number(n.toFixed(digits)) : null);
const es = (t) => 6.112 * Math.exp((17.67 * t) / (t + 243.5)); // hPa over liquid water

function relativeHumidity(p, t, q) {
  if (!finite(p) || !finite(t) || !finite(q) || q < 0 || q >= 0.07 || p <= 0) return null;
  return (100 * p * q) / ((epsilon + (1 - epsilon) * q) * es(t));
}
function specificHumidity(p, t, rh) {
  if (!finite(p) || !finite(t) || !finite(rh) || p <= 0 || rh < 0) return null;
  const e = (rh * es(t)) / 100;
  return e < p ? (epsilon * e) / (p - (1 - epsilon) * e) : null;
}

function wetBulb(p, t, q) {
  const rh = relativeHumidity(p, t, q);
  if (rh === null || t < -100 || t > 65) return null;
  // Normand's rule: lift to the LCL, then follow the liquid-water saturated
  // pseudoadiabat back to the original pressure. Preserve supersaturation in
  // the reported humidity; apply saturation to the parcel calculation.
  if (rh >= 100) return t;
  const e = Math.max(1e-8, (p * q) / (epsilon + (1 - epsilon) * q));
  const log = Math.log(e / 6.112),
    td = kelvin + (243.5 * log) / (17.67 - log),
    tk = t + kelvin;
  const lcl = 1 / (1 / (td - 56) + Math.log(tk / td) / 800) + 56;
  const span = (cp / rd) * Math.log(tk / lcl),
    steps = Math.max(1, Math.ceil(span / 0.025));
  const dx = span / steps;
  function slope(x, temp) {
    const pressure = p * Math.exp(x),
      sat = es(temp - kelvin);
    const mixing = (epsilon * sat) / (pressure - sat);
    return (rd * temp + lv * mixing) / (cp + (lv * lv * mixing * epsilon) / (rd * temp * temp));
  }
  let temp = lcl;
  for (let i = 0; i < steps; i++) {
    const x = -span + i * dx;
    const a = slope(x, temp),
      b = slope(x + dx / 2, temp + (dx * a) / 2);
    const c = slope(x + dx / 2, temp + (dx * b) / 2),
      d = slope(x + dx, temp + dx * c);
    temp += (dx * (a + 2 * b + 2 * c + d)) / 6;
  }
  return Math.min(t, temp - kelvin);
}

function thermalDepths(rows) {
  const crossings = [];
  for (let i = 1; i < rows.length; i++) {
    const lo = rows[i - 1],
      hi = rows[i];
    if (
      lo.wetBulb === null ||
      hi.wetBulb === null ||
      lo.height === null ||
      hi.height === null ||
      lo.pressure - hi.pressure > 80
    )
      break;
    if (lo.wetBulb > 0 === hi.wetBulb > 0) continue;
    const fraction = lo.wetBulb / (lo.wetBulb - hi.wetBulb);
    const height = Math.round((lo.height + (hi.height - lo.height) * fraction) / 10) * 10;
    crossings.push({ height, warmAbove: hi.wetBulb > 0 });
  }
  const parts = [];
  if (crossings.length) {
    const a = crossings[0],
      b = crossings[1];
    parts.push(
      '按相邻取样的湿球零度交点估算，近地' + (a.warmAbove ? '冷' : '暖') + '层厚约 ' + a.height + ' 米',
    );
    if (a.warmAbove && b && !b.warmAbove)
      parts.push(
        '其上暖层约从离地 ' +
          a.height +
          ' 米延伸至 ' +
          b.height +
          ' 米，厚约 ' +
          (b.height - a.height) +
          ' 米',
      );
  }
  return parts.length ? parts.join('，') + '。' : '';
}
function phaseReading(rows) {
  const ground = rows[0];
  if (!ground?.surface || ground.wetBulb === null) return '近地面温湿资料缺测，地面降水相态待核实。';
  const column = [ground],
    top = Math.max(300, Math.min(500, ground.pressure - 150));
  for (const r of rows.slice(1)) {
    column.push(r);
    if (r.pressure <= top && r.wetBulb !== null && r.wetBulb <= -8) break;
  }
  const largestGap = Math.max(0, ...column.slice(1).map((r, i) => column[i].pressure - r.pressure));
  const incomplete =
    column.length < 3 ||
    column.at(-1).pressure > top ||
    largestGap > 80 ||
    column.some((r) => r.wetBulb === null);
  const warm = rows.slice(1).find((r) => r.wetBulb !== null && r.wetBulb > 0.5);
  const coldAloft = rows
    .slice(1)
    .some((r) => r.wetBulb !== null && r.wetBulb < -2 && (!warm || r.pressure < warm.pressure));
  let description;
  if (ground.wetBulb <= 0 && warm && coldAloft) {
    description =
      '临近地面的湿球温度低于或等于零度，上方 ' +
      warm.pressure +
      ' hPa 有暖层。雪晶下落时可能先融化，再进入冷空气。冰粒与冻雨还取决于两层厚度和地面实况。';
  } else if (ground.wetBulb > 0 && coldAloft) {
    description =
      '高处有冷层，近地面湿球温度为 ' +
      ground.wetBulb.toFixed(1) +
      '℃。雪晶下落经过正湿球温度层时可能融化，融化程度取决于暖层厚度。';
  } else if (!incomplete && !warm && coldAloft && column.every((r) => r.wetBulb <= 0)) {
    description =
      '从近地面到上方冷层，连续取样层的湿球温度均在零度及以下。有降水且云中形成冰晶时，这种层结有利于雪花落地。';
  } else if (incomplete) {
    description = '现有取样能比较各层冷暖，层间仍可能夹有浅薄的融化层或冷层。';
  } else {
    description = '结合湿球温度随高度的变化读零度层，再用降水回波和地面观测核实雨、雪或混合相态。';
  }
  if (incomplete) {
    description +=
      largestGap > 80
        ? '相邻取样最大间隔 ' + Math.round(largestGap) + ' hPa，细薄层结有待更密资料核实。'
        : '近地面或上方的连续取样不足。';
  }
  return description;
}

function describeProfile(profile) {
  return { ...profile, summary: phaseReading(profile.rows), depths: thermalDepths(profile.rows) };
}
function makeProfile({ source, valid, run, type, lon, lat, resolution, surface, levels }) {
  const ps = surface?.pressure;
  if (!finite(ps) || ps < 250 || ps > 1100) throw Error('该格点缺少有效地面气压');
  const samples = [
    { ...surface, surface: true },
    ...levels
      .filter((r) => finite(r.pressure) && r.pressure < ps && r.pressure >= 300)
      .sort((a, b) => b.pressure - a.pressure),
  ];
  const rows = [];
  let last = null,
    height = 2;
  for (const s of samples) {
    if (last && (s.pressure >= last.pressure || !finite(last.temp) || !finite(s.temp))) height = null;
    else if (last && height !== null) {
      const virtual = (r) => (r.temp + kelvin) * (1 + (1 / epsilon - 1) * (finite(r.q) ? r.q : 0));
      height += (((rd / 9.80665) * (virtual(last) + virtual(s))) / 2) * Math.log(last.pressure / s.pressure);
    }
    rows.push({
      pressure: round(s.pressure),
      surface: !!s.surface,
      temp: round(s.temp),
      wetBulb: round(wetBulb(s.pressure, s.temp, s.q)),
      rh: round(relativeHumidity(s.pressure, s.temp, s.q)),
      height: round(height, 0),
      ...(s.run ? { run: s.run } : {}),
    });
    last = s;
  }
  if (!rows.some((r) => r.temp !== null && r.wetBulb !== null)) throw Error('该时次缺少配对的温度和湿度');
  return describeProfile({ source, valid, run, type, lon, lat, resolution, rows });
}

// Horizontal divergence on a latitude/longitude sphere, in 10^-5 s^-1.
function divergence(wind) {
  const { nx, ny, step, bbox, values: u, v } = wind;
  const out = Array(nx * ny).fill(null),
    rad = Math.PI / 180,
    d = step * rad,
    radius = 6371000;
  for (let y = 1; y < ny - 1; y++) {
    const lat = (bbox[3] - y * step) * rad,
      cos = Math.cos(lat);
    if (Math.abs(cos) < 0.01) continue;
    for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x;
      if (![u[i], v[i], u[i - 1], u[i + 1], v[i - nx], v[i + nx]].every(finite)) continue;
      out[i] = round(
        (1e5 * (u[i + 1] - u[i - 1] + v[i - nx] * Math.cos(lat + d) - v[i + nx] * Math.cos(lat - d))) /
          (2 * d * radius * cos),
        2,
      );
    }
  }
  const { v: unused, ...grid } = wind;
  return { ...grid, layer: 'div200', values: out, derived: '由同时次 200 hPa 水平风在球面格网上计算' };
}

module.exports = { relativeHumidity, specificHumidity, wetBulb, makeProfile, describeProfile, divergence };
