import {
  get,
  $,
  $$,
  icon,
  wxIcon,
  escape,
  fmtNum,
  windDir,
  isoDay,
  md,
  dateText,
  clockTime,
  validText,
  HOUR,
  failBox,
  openDialog,
  closeButton,
} from './base.js';
import { drawMap, sample } from './cartography.js';

function change(rows) {
  const near = rows.slice(0, 25),
    first = near[0];
  const candidates = [],
    local = (t) => (isoDay(t) === isoDay(first.time) ? '' : '明天 ') + clockTime(t);
  for (let i = 0; i < near.length; i++) {
    const r = near[i],
      prev = near[i - 1];
    if (r.rain === null || r.rain < 0.2 || !r.interval) continue;
    const phaseChange =
      prev?.rain >= 0.2 && r.condition.includes('雪') && !prev.condition.includes('雪');
    if (i && prev?.rain >= 0.2 && !phaseChange) continue;
    const score =
      1.3 +
      Math.min(8, (r.rain / r.interval) * 1.6) +
      (r.condition.includes('雪') ? 1.2 : 0) +
      (phaseChange ? 1.2 : 0);
    const wetType = /雨|雪/.test(r.condition) ? r.condition : '降水';
    candidates.push({
      score,
      title:
        (i ? local(r.time) + ' 前后' : '当前时段') +
        (phaseChange ? '预计转为' + wetType : '可能出现' + wetType),
      detail: '该时段预计降水 ' + fmtNum(r.rain, 1) + ' mm · ' + r.interval + ' 小时',
      at: r.time,
    });
  }
  let sharp = null;
  for (let i = 0; i < near.length; i++)
    for (let j = i + 1; j < near.length; j++) {
      if (Date.parse(near[j].time) - Date.parse(near[i].time) > 6 * HOUR) break;
      const diff = near[j].temp - near[i].temp;
      if (!sharp || Math.abs(diff) > Math.abs(sharp.diff)) sharp = { diff, a: near[i], b: near[j] };
    }
  if (sharp && Math.abs(sharp.diff) >= 3)
    candidates.push({
      score: Math.abs(sharp.diff) * 0.72,
      title:
        local(sharp.a.time) +
        ' 起气温' +
        (sharp.diff < 0 ? '下降' : '回升') +
        '约 ' +
        fmtNum(Math.abs(sharp.diff)) +
        '°',
      detail:
        local(sharp.a.time) +
        ' 至 ' +
        local(sharp.b.time) +
        '，预计由 ' +
        fmtNum(sharp.a.temp) +
        '° 变为 ' +
        fmtNum(sharp.b.temp) +
        '°',
      at: sharp.b.time,
    });
  const strongest = near.reduce((a, r) => ((r.wind ?? 0) > (a.wind ?? 0) ? r : a), first);
  if (Number.isFinite(first.wind) && strongest.wind - first.wind >= 3)
    candidates.push({
      score: (strongest.wind - first.wind) * 0.8,
      title: local(strongest.time) + ' 前后风力增强',
      detail: '预计' + windDir(strongest.direction) + ' ' + fmtNum(strongest.wind, 1) + ' m/s',
      at: strongest.time,
    });
  if (candidates.length)
    return candidates.sort((a, b) => b.score - a.score || Date.parse(a.at) - Date.parse(b.at))[0];
  const temps = near.map((r) => r.temp);
  return {
    title: '未来一天气温约 ' + fmtNum(Math.min(...temps)) + '° 至 ' + fmtNum(Math.max(...temps)) + '°',
    detail: '预计' + first.condition + ' · ' + windDir(first.direction),
    at: first.time,
  };
}
const metrics = { temp: ['气温', '℃'], rain: ['降水', 'mm'], wind: ['风速', 'm/s'] };
function chart(el, rows, metric) {
  const drawn = rows.filter((r) => Number.isFinite(r[metric]));
  if (!drawn.length) {
    el.innerHTML = '<div class="muted">这个时间段暂无所选要素</div>';
    return;
  }
  const width = Math.max(330, el.clientWidth || 650),
    height = 155,
    L = 26,
    R = 12,
    T = 21,
    B = 36;
  const vals = drawn.map((r) => r[metric]);
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  if (metric !== 'temp') lo = 0;
  const span = Math.max(hi - lo, metric === 'temp' ? 3 : metric === 'rain' ? 0.5 : 1);
  lo = metric === 'temp' ? Math.floor(lo - span * 0.12) : 0;
  hi = Math.max(hi + span * 0.12, lo + span);
  const a = Date.parse(rows[0].time),
    z = Date.parse(rows.at(-1).time);
  const xx = (t) => L + ((Date.parse(t) - a) / Math.max(HOUR, z - a)) * (width - L - R),
    yy = (v) => T + ((hi - v) / (hi - lo)) * (height - B - T);
  const pts = drawn.map((r) => [xx(r.time), yy(r[metric])]),
    line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const grid = [0, 0.5, 1]
    .map((k) => {
      const v = lo + k * (hi - lo),
        y = yy(v);
      return `<path d="M${L},${y}H${width - R}" stroke="var(--chart-grid)" stroke-dasharray="3 4"/><text x="0" y="${y + 4}">${fmtNum(v, metric === 'rain' ? 1 : 0)}</text>`;
    })
    .join('');
  const tickCount = Math.min(7, rows.length, Math.max(2, Math.floor((width - L - R) / 72) + 1));
  const ticks = [
    ...new Set(
      Array.from({ length: tickCount }, (_, i) =>
        Math.round((i * (rows.length - 1)) / (tickCount - 1 || 1))
      )
    ),
  ]
    .map(
      (k, i, all) =>
        `<text x="${xx(rows[k].time)}" y="${height - 18}" text-anchor="${i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}">${clockTime(rows[k].time)}${!i || isoDay(rows[k].time) !== isoDay(rows[all[i - 1]].time) ? `<tspan x="${xx(rows[k].time)}" dy="14">${md(rows[k].time)}</tspan>` : ''}</text>`
    )
    .join('');
  const fill =
    metric === 'rain'
      ? drawn
          .map(
            (r) =>
              `<rect x="${xx(r.time) - 2.5}" y="${yy(r.rain)}" width="5" height="${height - B - yy(r.rain)}" rx="1.5" fill="var(--accent)"/>`
          )
          .join('')
      : `<path d="${line} L${pts.at(-1)[0]},${height - B} L${pts[0][0]},${height - B} Z" fill="url(#chart-fill)"/><path d="${line}" fill="none" stroke="${metric === 'temp' ? 'var(--accent)' : 'var(--good)'}" stroke-width="2.6" stroke-linejoin="round"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${metrics[metric][0]}变化曲线"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="${metric === 'temp' ? 'var(--primary)' : 'var(--good)'}" stop-opacity=".28"/><stop offset="1" stop-color="var(--surface)" stop-opacity=".1"/></linearGradient></defs>${grid}${fill}${ticks}<g class="chart-marker"></g></svg><div class="chart-readout"></div>`;
  const display = (i) => {
    const r = rows[i],
      v = r[metric];
    if (v == null) return;
    const x = xx(r.time),
      y = yy(v);
    $('.chart-marker', el).innerHTML =
      `<path d="M${x} ${T}V${height - B}" stroke="var(--muted)" stroke-dasharray="3 3"/><circle cx="${x}" cy="${y}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
    $('.chart-readout', el).textContent =
      validText(r.time) +
      '　' +
      fmtNum(v, metric === 'temp' ? 0 : 1) +
      ' ' +
      metrics[metric][1] +
      (metric === 'rain' ? ' / ' + r.interval + '小时' : '');
  };
  let selected = 0;
  el.tabIndex = 0;
  el.setAttribute('aria-label', metrics[metric][0] + '曲线，左右键读数');
  el.onpointermove = (e) => {
    const px = e.clientX - el.getBoundingClientRect().left;
    selected = rows.reduce(
      (best, r, i) => (Math.abs(xx(r.time) - px) < Math.abs(xx(rows[best].time) - px) ? i : best),
      0
    );
    display(selected);
  };
  el.onpointerleave = () => {
    $('.chart-marker', el).innerHTML = '';
    $('.chart-readout', el).textContent = '';
  };
  el.onkeydown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      selected = Math.max(0, Math.min(rows.length - 1, selected + (e.key === 'ArrowRight' ? 1 : -1)));
      display(selected);
    }
  };
}
function stats(p) {
  return [
    ['wind', '风速', fmtNum(p.wind, 1), 'm/s', windDir(p.direction)],
    ['drop', '相对湿度', fmtNum(p.rh), '%', null],
    ['gauge', '海平面气压', fmtNum(p.pressure), 'hPa', null],
  ]
    .map(
      ([ico, n, v, u, more]) =>
        `<div class="stat"><span>${icon(ico, 17)}${n}</span><b>${v}<small>${u}</small></b>${more ? `<em>${more}</em>` : ''}</div>`
    )
    .join('');
}
export async function showForecast({ main, ctx, place, locationMatch, search }) {
  const placeName = place[7] === 2 && place[3] !== place[1] ? place[3] + ' · ' + place[1] : place[1];
  main.innerHTML = `<div class="page-head"><div><div class="subtitle">${dateText(Date.now(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</div></div><button class="btn reload">${icon('refresh', 15)}更新</button></div>
  <section class="weather-hero"><div class="hero-map"><canvas aria-label="区域高空风场预报"></canvas></div>
    <div class="hero-copy"><button class="hero-location">${icon('pin', 18)}${escape(placeName)}${icon('down', 13)}</button>
      <div id="now-temp" class="big-temp">—<sup>°</sup></div><div id="obs-line" class="observation-line">正在查询附近站报…</div><div id="hero-change" class="hero-change">正在读取预报…</div><div id="hero-sub" class="hero-sub"></div></div>
    <div class="hero-atlas"><span id="map-stamp">区域天气图</span><a id="hero-open" href="#/maps" class="glass-button">展开天气图 ${icon('out', 15)}</a></div></section>
  <div id="weather-details" class="loading">正在读取逐小时与逐日预报…</div>`;
  $('.hero-location', main).onclick = search;
  let data,
    station,
    stationReport,
    observationState = 'loading',
    lastStationCheck = 0,
    checkingStation = false,
    metric = 'temp',
    grid,
    busy = false,
    modelRun,
    heroTime,
    showTime,
    chartObserver;
  let refreshTimer,
    nextForecastCheck = 0;
  const loadMap = async () => {
    const region = [
      place[5] - 25,
      Math.max(5, place[4] - 14),
      place[5] + 15,
      Math.min(75, place[4] + 12),
    ];
    const canvas = $('.hero-map canvas', main);
    const paint = () => {
      if (ctx.active)
        void drawMap(canvas, grid, {
          bbox: region,
          point: [place[5], place[4]],
          tag: place[3],
          cities: true,
        });
    };
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    ctx.onClose(() => ro.disconnect());
    paint();
    try {
      modelRun = (await get('/api/run', ctx.signal)).run;
      if (!ctx.active) return;
      const lead = Math.max(
        0,
        Math.min(240, Math.round((Date.now() - Date.parse(modelRun)) / (3 * HOUR)) * 3)
      );
      grid = await get(
        '/api/grid?run=' + encodeURIComponent(modelRun) + '&lead=' + lead + '&layer=wind850',
        ctx.signal
      );
      if (!ctx.active) return;
      heroTime = grid.valid;
      $('#map-stamp').textContent = '850 hPa 风场 · GFS ' + validText(grid.valid);
      paint();
      $('#hero-open').href = '#/maps?time=' + encodeURIComponent(showTime || heroTime);
    } catch {
      if (ctx.active) $('#map-stamp').textContent = '地理底图 · 风场暂缺';
    }
  };
  void loadMap();
  const reference = locationMatch ? '定位' : '区县代表点';
  const selections = locationMatch ? [locationMatch.national, ...locationMatch.airports].filter(Boolean) : [];
  const stationQuery = new URLSearchParams({ id: place[0] });
  if (locationMatch) {
    stationQuery.set('national', locationMatch.national?.id || 'none');
    stationQuery.set('airports', locationMatch.airports.map((s) => s.id).join(','));
  }
  function missingNational() {
    const closest = stationReport?.closest;
    if (!closest) return '';
    const why = stationReport.nationalState === 'unavailable' ? '查询暂不可用' : '暂无三小时内气温';
    const km = locationMatch?.national?.id === closest.id ? locationMatch.national.km : closest.km;
    const distanceText = Number.isFinite(km) ? ` · 距${reference}约 ${fmtNum(km, 1)} km` : '';
    return `${closest.name}国家站 ${closest.id}${distanceText} · ${why}`;
  }
  function stationDetails() {
    const s = station;
    if (!s) return;
    const isNational = s.kind === 'national';
    const rows = [['气温', s.temp, '°C', s.time]];
    if (isNational) {
      for (const [key, label, unit] of [
        ['rh', '相对湿度', '%'], ['wind2m', '两分钟平均风速', 'm/s'], ['windDirection2m', '两分钟平均风向', '°'],
        ['stationPressure', '本站气压', 'hPa'], ['rain1h', '过去一小时降水', 'mm'],
      ]) {
        const f = s.fields?.[key];
        rows.push([label, f?.value, unit, f?.time]);
      }
    }
    const body = rows.map(([name, value, unit, time]) => {
      let reading = '—';
      if (Number.isFinite(value)) {
        if (unit === '°') {
          const speed = s.fields.wind2m;
          reading = speed?.value === 0 && speed.time === time ? '静风' : windDir(value) + '（' + fmtNum(value) + '°）';
        } else {
          reading = fmtNum(value, unit === '%' ? 0 : 1) + ' ' + unit;
        }
      }
      return `<tr><th scope="row">${name}</th><td>${reading}</td><td>${time ? validText(time) : '—'}</td></tr>`;
    }).join('');
    const reason = !isNational && missingNational();
    openDialog(`<div class="modal-head"><h2>${escape(isNational ? s.station : s.id)}${isNational ? '国家站' : '航空站'}</h2>${closeButton()}</div><p class="muted">${escape(isNational ? s.id + ' · ' + s.grade : s.station)} · 距${reference}约 ${fmtNum(s.km, 1)} km · ${escape(s.source || 'NOAA AWC')}${s.offline ? '（缓存站报）' : ''}</p><table class="station-readings"><thead><tr><th>要素</th><th>实测值</th><th>观测时间（北京时）</th></tr></thead><tbody>${body}</tbody></table>${reason ? '<p class="muted">' + escape(reason) + '</p>' : ''}`);
  }
  const drawNow = () => {
    if (!ctx.active) return;
    const p = data?.current, s = station;
    const condition = p ? wxIcon(p.condition, Number(clockTime(p.time).slice(0, 2)) < 6) + (s ? '预报' : '') + escape(p.condition) : '';
    const temperatureLabel = s ? (s.km > 100 ? '远站实测气温' : '实测气温') : p ? '当前格点预报' : '';
    $('#now-temp').innerHTML = `${fmtNum(s?.temp ?? p?.temp)}<sup>°</sup><span>${condition}<small>${temperatureLabel}</small></span>`;
    const obs = $('#obs-line', main);
    if (s) {
      const label = s.kind === 'national' ? s.station + '国家站 ' + s.id : '航空站 ' + s.id;
      obs.innerHTML = `<button class="textlink" aria-haspopup="dialog">${escape(label)} · 距${reference}约 ${fmtNum(s.km, 1)} km · ${validText(s.time)} ${icon('out', 12)}</button>`;
      obs.firstElementChild.onclick = stationDetails;
    } else {
      obs.textContent = observationState === 'loading' ? '正在查询附近站报…' :
        missingNational() || (observationState === 'error' ? '附近站报暂时无法获取' : '100 公里内暂无三小时内站报');
    }
    if (!data) return;
    const changeInfo = change(data.hourly);
    showTime = changeInfo.at;
    $('#hero-change').textContent = changeInfo.title;
    $('#hero-sub').textContent = changeInfo.detail;
    $('#hero-open').href = '#/maps?time=' + encodeURIComponent(changeInfo.at);
  };
  async function refreshStation() {
    if (checkingStation || !ctx.active) return;
    checkingStation = true;
    lastStationCheck = Date.now();
    try {
      stationReport = await get('/api/station?' + stationQuery, ctx.signal);
      if (!ctx.active) return;
      station = stationReport.station;
      if (station && locationMatch) {
        const selected = selections.find((s) => s.id === station.id);
        station = selected ? { ...station, km: selected.km } : null;
      }
      observationState = station ? 'ready' :
        stationReport.aviationUnavailable || stationReport.nationalState === 'unavailable' ? 'error' : 'empty';
    } catch {
      station = null;
      stationReport = null;
      observationState = 'error';
    } finally {
      checkingStation = false;
      drawNow();
    }
  }
  const renderDetail = () => {
    const hourly = data.hourly,
      current = data.current;
    const min = Math.min(...data.daily.map((d) => d.low)),
      max = Math.max(...data.daily.map((d) => d.high));
    const dailyRows = data.daily
      .map((d, i) => {
        const left = ((d.low - min) / Math.max(1, max - min)) * 100,
          right = ((max - d.high) / Math.max(1, max - min)) * 100;
        return `<button class="day-row" data-day="${i}"><span><b>${i === 0 ? '今天' : dateText(d.date + 'T04:00Z', { weekday: 'short' })}</b><small>${d.date.slice(5).replace('-', '/')}</small></span><i>${wxIcon(d.condition)}</i><span class="daily-low">${fmtNum(d.low)}°</span><span class="range-bar"><i style="left:${left}%;right:${right}%"></i></span><b>${fmtNum(d.high)}°</b></button>`;
      })
      .join('');
    $('#weather-details').className = '';
    $('#weather-details').innerHTML =
      `${data.offline ? '<div class="notice">连接暂不可用，显示仍在有效期内的缓存预报。</div>' : ''}
      <div class="stats-band">${stats(current)}<div class="source-meta"><span>格点预报 · MET Norway</span><b>${validText(data.issued)} 更新</b></div></div>
      <div class="home-grid"><div class="home-left"><section class="panel hour-panel"><div class="section-top"><h2>${icon('time')}逐小时预报</h2><div id="metrics" class="seg">${Object.entries(
        metrics
      )
        .map(
          ([k, [v]]) => `<button data-metric="${k}" class="${metric === k ? 'on' : ''}">${v}</button>`
        )
        .join(
          ''
        )}</div></div><div class="chart-meta"><span>未来 48 小时</span><span id="chart-unit">${metrics[metric][1]}</span></div><div class="chart" id="hour-chart"></div></section>
      <section class="feature-case"><img class="feature-photo" src="/assets/cases/bohai/cover.jpg" width="800" height="400" alt="山东半岛的 MODIS 卫星日合成局部" loading="lazy"><div class="feature-copy"><h2>越过渤海的冷流雪</h2><p>为什么烟台、威海沿海的雪，常常比内陆更集中？</p><a class="textlink" href="#/cases/bohai">回放这次过程 ${icon('arrow', 16)}</a></div></section></div>
      <section class="panel day-panel"><div class="section-top"><h2>${icon('calendar')}十日天气</h2><span class="muted">低温 / 高温</span></div><div class="day-list">${dailyRows}</div></section></div>`;
    const redraw = () => {
      if (ctx.active) chart($('#hour-chart'), hourly, metric);
    };
    chartObserver?.disconnect();
    chartObserver = new ResizeObserver(redraw);
    chartObserver.observe($('#hour-chart'));
    redraw();
    $('#metrics').onclick = (e) => {
      const b = e.target.closest('[data-metric]');
      if (!b) return;
      metric = b.dataset.metric;
      $$('#metrics button').forEach((el) => el.classList.toggle('on', el === b));
      $('#chart-unit').textContent = metrics[metric][1];
      redraw();
    };
    $('.day-list').onclick = (e) => {
      const el = e.target.closest('[data-day]');
      if (!el) return;
      const d = data.daily[Number(el.dataset.day)];
      openDialog(
        `<div class="modal-head"><h2>${md(d.date + 'T04:00Z')} · ${escape(placeName)}</h2>${closeButton()}</div><div class="day-summary">${wxIcon(d.condition)}<b>${fmtNum(d.low)}° — ${fmtNum(d.high)}°</b><span>${escape(d.condition)}</span></div><p class="muted">${d.partial ? '可用时段汇总' : '当日时段汇总'} · 降水 ${fmtNum(d.rain, 1)} mm · 最大预报风速 ${fmtNum(d.wind, 1)} m/s</p><div class="detail-times">${d.rows.map((r) => `<div><span>${clockTime(r.time)}</span><b>${fmtNum(r.temp)}°</b><span>${escape(r.condition)}</span><a href="#/maps?time=${encodeURIComponent(r.time)}" aria-label="查看${clockTime(r.time)}天气图">${icon('layers', 16)}</a></div>`).join('')}</div>`,
        (dlg) => {
          $$('.detail-times a', dlg).forEach((a) => (a.onclick = () => dlg.close()));
        }
      );
    };
    drawNow();
  };
  async function refresh() {
    if (busy) return;
    busy = true;
    clearTimeout(refreshTimer);
    $('.reload').disabled = true;
    void refreshStation();
    try {
      data = await get('/api/forecast?id=' + place[0], ctx.signal);
      if (!ctx.active) return;
      renderDetail();
    } catch (e) {
      if (ctx.active) {
        data = null;
        drawNow();
        $('#weather-details').className = 'panel';
        $('#weather-details').innerHTML =
          failBox(e.message) +
          '<a class="offline-case" href="#/cases/bohai">打开已收录的降雪案例 ' +
          icon('arrow', 15) +
          '</a>';
        $('.retry').onclick = refresh;
        $('#hero-change').textContent = '预报暂时无法更新';
        $('#hero-sub').textContent = '';
      }
    } finally {
      busy = false;
      if (ctx.active) {
        $('.reload').disabled = false;
        const wait =
          Math.max(
            5 * 60000,
            Math.min(90 * 60000, (data?.expiresAt || Date.now() + 15 * 60000) - Date.now())
          ) +
          15000 +
          Math.random() * 30000;
        nextForecastCheck = Date.now() + wait;
        refreshTimer = setTimeout(() => {
          if (!document.hidden) void refresh();
        }, wait);
      }
    }
  }
  const resume = () => {
    if (!ctx.active || document.hidden) return;
    if (nextForecastCheck && Date.now() >= nextForecastCheck) void refresh();
    else if (Date.now() - lastStationCheck >= 5 * 60000) void refreshStation();
  };
  const stationTimer = setInterval(resume, 5 * 60000);
  document.addEventListener('visibilitychange', resume);
  ctx.onClose(() => {
    clearTimeout(refreshTimer);
    clearInterval(stationTimer);
    chartObserver?.disconnect();
    document.removeEventListener('visibilitychange', resume);
  });
  $('.reload').onclick = refresh;
  await refresh();
}
