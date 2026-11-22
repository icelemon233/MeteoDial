export const HOUR = 3600000;
export const fmtNum = (n, dec = 0) => (Number.isFinite(n) ? Number(n).toFixed(dec) : '—');
export const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
export const isoDay = (t) => new Date(new Date(t).getTime() + 8 * HOUR).toISOString().slice(0, 10);
export function dateText(t, opts = {}) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...opts }).format(new Date(t));
}
const clockFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' });
export const clockTime = (t) => clockFormatter.format(new Date(t));
export const md = (t) => dayFormatter.format(new Date(t));
export const validText = (t) => md(t) + ' ' + clockTime(t);
export const windDir = (d) =>
  Number.isFinite(d)
    ? ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(d / 45) % 8] + '风'
    : '风向不定';
export const $ = (q, el = document) => el.querySelector(q);
export const $$ = (q, el = document) => [...el.querySelectorAll(q)];
const paths = {
  settings: '<path d="m10 3 .5-1h3l.5 2 2 1 2-.5 1.5 2.6-1.2 1.6v2.5l1.2 1.6-1.5 2.6-2-.5-2 1-.5 2h-3l-.5-2-2-1-2 .5-1.5-2.6 1.2-1.6v-2.5L4.5 7.6 6 5l2 .5 2-1z" transform="translate(0 2)"/><circle cx="12" cy="12" r="3"/>',
  fix: '<path d="m15 3 6 6-3 1-4 4v3l-2 2-7-7 2-2h3l4-4zM9 15l-6 6"/>',
  unpin: '<path d="m3 3 18 18M9 15l-6 6M14 5l1-2 6 6-3 1-1 1M6 10l-1 2 7 7 2-2v-2"/>',
  tray: '<path d="M12 2v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  forecast:
    '<path d="M3 16h3a4 4 0 0 1 7.5-1.9A3.4 3.4 0 1 1 17 20H7a3 3 0 0 1-3-3"/><path d="M6 11a4 4 0 1 1 7-4M4 6 2 5m4-2L5 1m7 2 1-2m3 6 2-1"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5"/>',
  book: '<path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v14h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3zM12 6v14"/>',
  pin: '<path d="M19 9c0 5-7 11-7 11S5 14 5 9a7 7 0 0 1 14 0Z"/><circle cx="12" cy="9" r="2.4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.8"/><path d="m16 16 5 5"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  out: '<path d="M7 17 18 6M8 6h10v10"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  refresh: '<path d="M20 9a8 8 0 1 0 0 6M20 3v6h-6"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-2.7-4.2M2 12h17a2.5 2.5 0 1 0-2.3-3.5M4 16h9a3 3 0 1 1-2.8 4"/>',
  drop: '<path d="M12 2C10 6 5 11 5 15a7 7 0 0 0 14 0c0-4-5-9-7-13Z"/>',
  gauge: '<path d="M3.5 17a9 9 0 1 1 17 0H3.5ZM12 14l4-5M6 13h1m3-6 .5 1m7 5h1"/>',
  sun: '<circle cx="12" cy="12" r="4.3"/><path d="M12 2v2M12 20v2M2 12h2m16 0h2M4.8 4.8l1.5 1.5m11.4 11.4 1.5 1.5M4.8 19.2l1.5-1.5M17.7 6.3l1.5-1.5"/>',
  moon: '<path d="M19 16A8 8 0 0 1 8 5a8.5 8.5 0 1 0 11 11Z"/>',
  cloud: '<path d="M6 17h12a4 4 0 0 0 .3-8A6 6 0 0 0 7 7.8 4.6 4.6 0 0 0 6 17Z"/>',
  rain: '<path d="M5 14a4 4 0 0 1 1-7.7A5.5 5.5 0 0 1 17 7a3.5 3.5 0 1 1 1 7M7 16l-1 3m6-3-1 4m6-4-1 3"/>',
  snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4M20 14l-4 1 1 4M7 19l1-4-4-1M17 5l-1 4 4 1"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 11h18"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  minus: '<path d="M4 12h16"/>',
  focus: '<circle cx="12" cy="12" r="6"/><path d="M12 1v5m0 12v5M1 12h5m12 0h5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="2.5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4.5" ry="9"/><path d="M3 12h18"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  temp: '<path d="M9 14.5V5a3 3 0 1 1 6 0v9.5a5 5 0 1 1-6 0ZM12 7v9"/>',
  cross: '<path d="m2 18 7-9 4 5 4-8 5 12H2Z"/>',
  trend: '<path d="m3 17 6-7 5 4 7-9m-6 0h6v6"/>',
};
export function icon(n, size = 18) {
  return (
    '<svg class="icon" aria-hidden="true" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' +
    (paths[n] || '') +
    '</svg>'
  );
}
export function wxIcon(c, night = false) {
  return icon(
    c?.includes('雪')
      ? 'snow'
      : c?.includes('雨')
        ? 'rain'
        : c === '晴'
          ? night
            ? 'moon'
            : 'sun'
          : c === '晴间多云'
            ? 'forecast'
            : 'cloud',
    22
  );
}
export function get(url, signal) {
  return requestJson(url, { signal });
}
export async function requestJson(url, options) {
  const res = await fetch(url, options);
  let data;
  try {
    data = await res.json();
  } catch {
    throw Error('数据格式异常');
  }
  if (!res.ok) throw Error(data.error || '资料暂不可用');
  return data;
}
export function failBox(msg, action = '重试') {
  return (
    '<div class="empty" role="status"><strong>暂时无法读取</strong><p>' +
    escape(msg) +
    '</p><button class="btn retry">' +
    icon('refresh', 15) +
    escape(action) +
    '</button></div>'
  );
}
export function context() {
  let active = true;
  const cleanups = [],
    controller = new AbortController();
  return {
    get active() {
      return active;
    },
    signal: controller.signal,
    onClose: (f) => cleanups.push(f),
    close() {
      active = false;
      controller.abort();
      for (const f of cleanups) f();
    },
  };
}
export function announce(t) {
  $('#announce').textContent = t;
}
export function openDialog(html, after) {
  const d = $('#dialog');
  if (d.open) d.close();
  $('#dialog-body').innerHTML = html;
  d.showModal();
  after?.(d);
}
export const closeButton = () =>
  '<button class="iconbtn dialog-close" aria-label="关闭">' + icon('close') + '</button>';
export function safeLink(url, text) {
  return /^https:\/\//.test(url)
    ? '<a class="textlink" target="_blank" rel="noopener noreferrer" href="' +
        escape(url) +
        '">' +
        escape(text) +
        icon('out', 13) +
        '</a>'
    : '';
}
import { automaticLayers, pressureLevels } from './levels.js';
export const layerNames = {
  ...automaticLayers,
  wind10: '离地 10 米风场',
  wind850: '850 hPa 风场',
  temp850: '850 hPa 气温',
  temp2: '离地 2 米气温',
  height500: '500 hPa 位势高度',
  pressure: '海平面气压',
  moisture700: '700 hPa 相对湿度',
  rainDay: '日累计降水',
  satellite: '卫星云图',
  radar: '区域雷达 · 台湾近海',
  track: '台风路径',
  climate: '平均海平面气压',
  zonal: '纬向平均气压',
};
export const layerUnit = {
  wind10: 'm/s',
  wind850: 'm/s',
  temp850: '℃',
  temp2: '℃',
  height500: 'm',
  pressure: 'hPa',
  moisture700: '%',
  rainDay: 'mm',
  climate: 'hPa',
  zonal: 'hPa',
};
for (const level of pressureLevels) {
  for (const [variable, name, unit] of [['wind', '风场', 'm/s'], ['temp', '气温', '℃'], ['moisture', '相对湿度', '%']]) {
    layerNames[variable + level] = level + ' hPa ' + name;
    layerUnit[variable + level] = unit;
  }
}
for (const level of [500, 400, 300]) {
  layerNames['height' + level] = level + ' hPa 位势高度';
  layerUnit['height' + level] = 'm';
}
layerNames.rainRate = '预报降水率';
layerUnit.rainRate = 'mm/h';
