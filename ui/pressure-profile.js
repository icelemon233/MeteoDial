import { clockTime, closeButton, escape, fmtNum, get, isoDay, openDialog } from './base.js';
const fullTime = (t) => isoDay(t) + ' ' + clockTime(t);

function plot(rows) {
  const w = 600,
    h = 236,
    left = 49,
    right = 18,
    top = 12,
    bottom = 29,
    ps = rows[0].pressure;
  const temps = rows.flatMap((r) => [r.temp, r.wetBulb]).filter(Number.isFinite);
  const min = Math.floor(Math.min(-5, ...temps) / 10) * 10,
    max = Math.ceil(Math.max(5, ...temps) / 10) * 10;
  const floor = rows.at(-1).pressure;
  const x = (v) => left + ((v - min) / (max - min)) * (w - left - right),
    y = (p) => top + (Math.log(p / floor) / Math.max(0.01, Math.log(ps / floor))) * (h - top - bottom);
  const svg = [];
  for (let t = min; t <= max; t += max - min > 90 ? 20 : 10)
    svg.push('<text x="' + x(t) + '" y="' + (h - 5) + '" text-anchor="middle">' + t + '℃</text>');
  for (const p of [1000, 925, 850, 700, 600, 500, 400, 300])
    if (p <= ps && p >= floor) {
      svg.push(
        '<line class="profile-rule" x1="' +
          left +
          '" x2="' +
          (w - right) +
          '" y1="' +
          y(p) +
          '" y2="' +
          y(p) +
          '"/><text x="' +
          (left - 7) +
          '" y="' +
          (y(p) + 4) +
          '" text-anchor="end">' +
          p +
          '</text>',
      );
    }
  svg.push(
    '<line class="profile-zero" x1="' +
      x(0) +
      '" x2="' +
      x(0) +
      '" y1="' +
      top +
      '" y2="' +
      (h - bottom) +
      '"/>',
  );
  for (const [field, label] of [
    ['temp', '气温'],
    ['wetBulb', '湿球温度'],
  ]) {
    let previous;
    for (const row of rows) {
      const v = row[field];
      if (!Number.isFinite(v)) {
        previous = null;
        continue;
      }
      const cx = x(v),
        cy = y(row.pressure);
      if (previous)
        svg.push(
          '<line class="profile-' +
            field +
            '" ' +
            (previous.pressure - row.pressure > 80 ? 'stroke-dasharray="3 4" ' : '') +
            'x1="' +
            previous.x +
            '" x2="' +
            cx +
            '" y1="' +
            previous.y +
            '" y2="' +
            cy +
            '"/>',
        );
      svg.push(
        '<circle class="profile-' +
          field +
          '" cx="' +
          cx +
          '" cy="' +
          cy +
          '" r="2.5"><title>' +
          row.pressure +
          ' hPa · ' +
          label +
          ' ' +
          fmtNum(v, 1) +
          '℃</title></circle>',
      );
      previous = { pressure: row.pressure, x: cx, y: cy };
    }
  }
  return (
    '<svg class="profile-plot" viewBox="0 0 ' +
    w +
    ' ' +
    h +
    '" role="img" aria-label="按气压高度绘制的气温和湿球温度廓线，竖虚线表示零摄氏度">' +
    svg.join('') +
    '</svg>'
  );
}
function body(p) {
  const rows = p.rows,
    hasGap = rows.slice(1).some((r, i) => rows[i].pressure - r.pressure > 80);
  const row = (r) =>
    '<tr><th scope="row">' +
    (r.surface ? '近地面 · ' : '') +
    fmtNum(r.pressure, r.surface ? 1 : 0) +
    '</th><td>' +
    fmtNum(r.height) +
    '</td><td>' +
    fmtNum(r.temp, 1) +
    '</td><td>' +
    fmtNum(r.wetBulb, 1) +
    '</td><td>' +
    fmtNum(r.rh) +
    '</td></tr>';
  return (
    '<p class="profile-source">' +
    escape(p.source + ' · ' + p.type) +
    ' · ' +
    fullTime(p.valid) +
    ' 北京时间<br>' +
    fmtNum(p.lon, 2) +
    '°E、' +
    fmtNum(p.lat, 2) +
    '°N · ' +
    escape(p.resolution) +
    ' 格点' +
    (p.run ? ' · 起报 ' + fullTime(p.run) : '') +
    '</p>' +
    '<figure class="profile-figure"><figcaption><span class="dry">气温</span><span class="wet">湿球温度</span><span>气压（hPa）</span></figcaption>' +
    plot(rows) +
    '</figure>' +
    '<p class="profile-assessment">' +
    escape(p.summary) +
    '</p>' +
    (p.depths ? '<p>' + escape(p.depths) + '</p>' : '') +
    '<details class="profile-table"><summary>逐层读数（' +
    rows.length +
    ' 层）</summary><table><thead><tr><th>气压 hPa</th><th>离地约 m</th><th>气温 ℃</th><th>湿球 ℃</th><th>相对湿度 %</th></tr></thead><tbody>' +
    rows.map(row).join('') +
    '</tbody></table>' +
    '<p>湿球温度按该层气压与水汽含量估算，离地高度按虚温测高公式估算。' +
    (rows.some((r) => r.rh > 100) ? '过饱和格点保留源场湿度，湿球计算按饱和处理。' : '') +
    (hasGap ? '点线段的气压间隔超过 80 hPa，薄层可能落在取样层之间。' : '') +
    '</p></details>'
  );
}
export function showProfile({ url, detailedUrl, valid }, ctx) {
  openDialog(
    '<div class="modal-head"><h2>温湿廓线</h2>' +
      closeButton() +
      '</div><div class="profile-content"><p role="status">正在读取选点上空的温湿资料…</p></div>',
    (dialog) => {
      const box = dialog.querySelector('.profile-content'),
        abort = new AbortController();
      const clean = () => abort.abort();
      ctx.signal.addEventListener('abort', clean, { once: true });
      dialog.addEventListener(
        'close',
        () => {
          clean();
          ctx.signal.removeEventListener('abort', clean);
        },
        { once: true },
      );
      let current = null;
      const button = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = label;
        b.onclick = fn;
        box.append(b);
        return b;
      };
      async function load(path) {
        if (current) {
          box.querySelectorAll('button,.profile-status').forEach((e) => e.remove());
          const s = document.createElement('p');
          s.className = 'profile-status';
          s.setAttribute('role', 'status');
          s.textContent = '正在补充地面至 300 hPa 的 ERA5 廓线…';
          box.append(s);
        }
        try {
          const p = await get(path, abort.signal);
          if (abort.signal.aborted || !ctx.active || !dialog.open) return;
          if (Date.parse(p.valid) !== valid || !Array.isArray(p.rows) || !p.rows.length || !p.rows[0].surface)
            throw Error('廓线与所选时次不符');
          current = p;
          box.innerHTML = body(p);
          if (p.detail === 'basic' && detailedUrl && path !== detailedUrl) {
            if (navigator.onLine) void load(detailedUrl);
            else button('联网补充 ERA5 廓线', () => load(detailedUrl));
          }
        } catch (e) {
          if (abort.signal.aborted || !ctx.active || !dialog.open) return;
          if (current) box.innerHTML = body(current);
          else box.replaceChildren();
          const s = document.createElement('p');
          s.className = 'profile-status';
          s.setAttribute('role', 'status');
          s.textContent = e.message || '廓线资料暂时无法读取';
          box.append(s);
          button('重试', () => load(path));
        }
      }
      void load(url);
    },
  );
}
