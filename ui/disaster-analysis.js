import { escape, fmtNum, HOUR, layerNames, layerUnit, validText, windDir } from './base.js';

const rain = ['rain4h', 'moisture700', 'wind850', 'height500'];
const layerOrder = {
  台风: ['pressure', 'wind850', 'rain4h', 'height500'],
  低温冰雪: ['temp2', 'pressure', 'wind850', 'moisture700'],
  冰冻圈灾害: ['temp2', 'rain4h', 'height500', 'moisture700'],
  高温: ['temp2', 'height500', 'pressure', 'rain4h'],
  高温干旱: ['temp2', 'rain4h', 'height500', 'wind850'],
  干旱: ['rain4h', 'height500', 'temp2', 'moisture700'],
  沙尘大风: ['wind10', 'pressure', 'height500', 'temp2'],
  森林火险: ['wind10', 'temp2', 'rain4h', 'moisture700'],
  大雾: ['wind10', 'pressure', 'moisture700', 'temp2'],
  雾霾: ['wind10', 'pressure', 'height500', 'temp2'],
};
const timeAt = (b, i) => Date.parse(b.start) + i * b.cadence * HOUR;
function statistics(b, kind) {
  const { layer, values } = b.series;
  let max = -1,
    min = -1,
    dry = 0,
    longest = 0,
    total = 0,
    count = 0;
  values.forEach((v, i) => {
    if (v === null) {
      dry = 0;
      return;
    }
    if (max < 0 || v > values[max]) max = i;
    if (min < 0 || v < values[min]) min = i;
    dry = v < 0.1 ? dry + 1 : 0;
    longest = Math.max(longest, dry);
    total += v;
    count++;
  });
  if (!count) return '图示时段内该参考格点缺测。';
  const stamp = (i) => validText(timeAt(b, i)),
    value = (i) => fmtNum(values[i], 1);
  if (layer === 'rain4h') {
    const range = validText(timeAt(b, -1)) + ' 至 ' + stamp(values.length - 1);
    return (
      range +
      ' 的 ' +
      count +
      ' 个有资料时段累计降水 ' +
      fmtNum(total, 1) +
      ' 毫米。' +
      (count < values.length ? '另有 ' + (values.length - count) + ' 个时段缺测。' : '') +
      (kind === '干旱'
        ? '最长有 ' + longest * b.cadence + ' 小时连续低于每 ' + b.cadence + ' 小时 0.1 毫米。'
        : '其中 ' + stamp(max) + ' 结束的 ' + b.cadence + ' 小时雨量最大，为 ' + value(max) + ' 毫米。')
    );
  }
  if (layer === 'temp2')
    return (
      '每 ' +
      b.cadence +
      ' 小时取样的近地面气温中，最低为 ' +
      value(min) +
      '℃（' +
      stamp(min) +
      '），最高为 ' +
      value(max) +
      '℃（' +
      stamp(max) +
      '）。'
    );
  if (layer === 'pressure')
    return (
      '海平面气压在 ' +
      stamp(min) +
      ' 降至图示时次中的最低值 ' +
      value(min) +
      ' hPa。对照前后的风场，可以追踪低压经过的时段。'
    );
  return (
    '离地 10 米风速在 ' +
    stamp(min) +
    ' 为 ' +
    value(min) +
    ' m/s，在 ' +
    stamp(max) +
    ' 达到 ' +
    value(max) +
    ' m/s。站点瞬时阵风由观测记录核实。'
  );
}
function atmosphere(a, time, name) {
  const upper = a.u850 != null && a.v850 != null;
  const u = upper ? a.u850 : a.u10,
    v = upper ? a.v850 : a.v10;
  const parts = [];
  if (u != null && v != null) {
    const wind = Math.hypot(u, v);
    parts.push(
      (upper ? '850 hPa' : '离地 10 米') +
        (wind > 0
          ? ' 吹' + windDir(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360) + '，风速为 '
          : ' 风速为 ') +
        fmtNum(wind, 1) +
        ' m/s',
    );
  }
  if (a.moisture700 != null) parts.push('700 hPa 相对湿度为 ' + fmtNum(a.moisture700) + '%');
  if (parts.length < 2 && a.height500 != null)
    parts.push('500 hPa 位势高度为 ' + fmtNum(a.height500) + ' 米');
  if (parts.length < 2 && a.temp2 != null) parts.push('离地 2 米气温为 ' + fmtNum(a.temp2, 1) + '℃');
  return (
    validText(time) +
    '，' +
    name +
    '附近的参考格点' +
    (parts.length ? '上，' + parts.join('，') + '。' : '缺测。')
  );
}
function compare(b, kind, name) {
  const p = b.regional;
  if (p)
    return (
      '在' +
      name +
      '周围 5×5 个降水格点中，截至 ' +
      validText(p.time) +
      ' 的 ' +
      b.cadence +
      ' 小时降水在 ' +
      p.lon.toFixed(2) +
      '°E、' +
      p.lat.toFixed(2) +
      '°N 达到 ' +
      fmtNum(p.value, 1) +
      ' 毫米，是这些时段和格点中的最大值。可以点到该处，和机构记录对照。'
    );
  const k = ['高温', '干旱', '高温干旱'].includes(kind)
    ? 'height500'
    : ['沙尘大风', '大雾', '雾霾', '森林火险'].includes(kind)
      ? 'wind10'
      : 'temp2';
  if (b.before[k] == null || b.after[k] == null) return '';
  return (
    '对照 ' +
    validText(b.before.time) +
    ' 和 ' +
    validText(b.after.time) +
    '，' +
    name +
    '附近的' +
    layerNames[k] +
    '分别为 ' +
    fmtNum(b.before[k], 1) +
    ' 和 ' +
    fmtNum(b.after[k], 1) +
    ' ' +
    layerUnit[k] +
    '。'
  );
}
function curve(b, name) {
  const { values, layer } = b.series,
    valid = values.filter(Number.isFinite);
  if (valid.length < 2) return '';
  const lo = Math.min(...valid),
    hi = Math.max(...valid);
  let pen = false;
  const path = values
    .map((v, i) => {
      if (v === null) {
        pen = false;
        return '';
      }
      const x = 2 + (296 * i) / (values.length - 1),
        y = lo === hi ? 24 : 44 - (40 * (v - lo)) / (hi - lo);
      const cmd = pen ? 'L' : 'M';
      pen = true;
      return cmd + x.toFixed(1) + ' ' + y.toFixed(1);
    })
    .join(' ');
  const label = escape(name + '附近 · ' + layerNames[layer] + '（' + layerUnit[layer] + '）');
  return (
    '<figure class="event-curve"><figcaption>' +
    label +
    '</figcaption><output class="event-current"></output>' +
    '<svg viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true"><path d="' +
    path +
    '"/><line class="event-cursor" y1="0" y2="48"/></svg>' +
    '<div><span>' +
    validText(b.start) +
    '</span><span>' +
    validText(b.end) +
    '</span></div></figure>'
  );
}
export function markEventTime(c, root, time) {
  const b = c.atlas;
  const output = root.querySelector('.event-current');
  if (!output) return;
  const i = (time - Date.parse(b.start)) / (b.cadence * HOUR);
  if (!Number.isInteger(i) || i < 0 || i >= b.count) return;
  const guide = root.querySelector('.atmosphere-reading');
  if (guide && b.pointWeather) {
    const reading = Object.fromEntries(
      Object.entries(b.pointWeather).map(([key, values]) => [key, values[i]]),
    );
    guide.textContent = atmosphere(reading, time, c.pointName);
  }
  const x = 2 + (296 * i) / (b.count - 1),
    line = root.querySelector('.event-cursor');
  line.setAttribute('x1', x);
  line.setAttribute('x2', x);
  const v = b.series.values[i];
  output.textContent =
    validText(time) + ' · ' + (v == null ? '缺测' : fmtNum(v, 1) + ' ' + layerUnit[b.series.layer]);
}
export function overview(event, b, place, report) {
  if (b.id !== event.id || b.version !== 2 || b.cadence !== 4 || b.series.values.length !== b.count)
    throw Error('灾害回放与时次目录不符');
  const name = place[1];
  const source = b.end < '2011-04-01' ? 'CFSR' : b.start >= '2011-04-01' ? 'CFSv2' : 'CFSR / CFSv2';
  const dataLinks = [];
  if (b.start < '2011-01-01')
    dataLinks.push(['https://gdex.ucar.edu/datasets/d093001/', 'NCEP CFSR 逐小时归档']);
  if (b.end >= '2011-01-01')
    dataLinks.push(['https://gdex.ucar.edu/datasets/d094001/', 'NCEP 逐小时归档（2011 年起）']);
  const guides = [event.analysis, atmosphere(b.atFocus, b.focus, name), compare(b, event.kind, name)].filter(
    Boolean,
  );
  const defaults = (layerOrder[event.kind] || rain).map((k) =>
    k === 'wind850' && b.atFocus.wind850 == null ? 'wind10' : k,
  );
  return {
    id: event.id,
    title: event.title,
    atlas: b,
    run: event.map.from,
    point: [place[5], place[4]],
    pointName: name,
    tag: name + '参考点',
    area: name + '参考点',
    layers: b.layers,
    defaults,
    guides,
    forecast:
      '读数取自 ' +
      b.series.lon.toFixed(2) +
      '°E、' +
      b.series.lat.toFixed(2) +
      '°N。' +
      statistics(b, event.kind),
    outcome: event.fact,
    link: report,
    evidenceCurve: curve(b, name),
    dataLinks,
    method:
      '天气场取自 NCEP ' +
      source +
      ' 分析和短时预报，按北京时间每四小时取一个原始有效时次。降水由连续四份一小时模式累计量相加，任一份缺测或出现负值时，该格点标为缺测。700 hPa 相对湿度由同时次的温度、比湿计算，相对于液态水。等压面按同时次地面气压遮挡。',
  };
}
