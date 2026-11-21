import {
  get,
  $,
  $$,
  icon,
  escape,
  validText,
  clockTime,
  md,
  dateText,
  HOUR,
  fmtNum,
  windDir,
  layerNames,
  layerUnit,
  safeLink,
  failBox,
} from './base.js';
import { drawMap, geoFromPointer, sample, legend, extentFor } from './cartography.js';
import { automaticLayers, pressureLevels, liveGridUrl, sourceName, actualLevel } from './levels.js';
const memo = new Map();
function resource(url, signal) {
  // Requests shared by panels outlive a panel switch. Only the current revision paints.
  const hit = memo.get(url);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const p = get(url).catch((e) => {
    if (memo.get(url)?.promise === p) memo.delete(url);
    throw e;
  });
  memo.set(url, {
    promise: p,
    expires: Date.now() + (url.startsWith('/api/grid?') ? 5 * 60000 : url === '/api/cyclones' ? 15 * 60000 : 24 * HOUR),
  });
  if (memo.size > 90) memo.delete(memo.keys().next().value);
  return p;
}
const liveGroups = {
  '随选点与时次选层': Object.keys(automaticLayers),
  '地面与降水': ['wind10', 'temp2', 'pressure', 'rainRate'],
  '高空形势': ['height500', 'height400', 'height300'],
  '定压风场': pressureLevels.map((p) => 'wind' + p),
  '定压气温': pressureLevels.map((p) => 'temp' + p),
  '定压湿度': pressureLevels.map((p) => 'moisture' + p),
  '观测': ['satellite', 'radar', 'track'],
};
const seasons = ['冬季（12–2月）', '春季（3–5月）', '夏季（6–8月）', '秋季（9–11月）'];
const categories = {
  bohai: '海洋天气',
  bohai22: '海洋天气',
  'beijing-snow': '锋面与地形',
  'ice-2008': '锋面与地形', 'cold-2016': '大尺度环流', 'henan-2021': '锋面与地形',
  doksuri: '海洋天气',
  ridge: '大尺度环流',
  trough: '大尺度环流',
  coldpool: '大尺度环流',
  belts: '大尺度环流',
  front: '锋面与地形',
  terrain: '锋面与地形',
};
function caseDate(c) {
  return c.climate ? '1991—2020 常年值' : c.run.replaceAll('-', '.');
}
function timesFor(c) {
  return c.climate ? [0, 3, 6, 9] : c.leads.map((n) => Date.parse(c.run + 'T00:00:00Z') + n * HOUR);
}
export function showCases({ main, ctx, catalog }) {
  main.innerHTML = `<div class="case-browse"><div class="case-filter seg">${['全部', '大尺度环流', '海洋天气', '锋面与地形'].map((x, i) => `<button class="${i ? '' : 'on'}">${x}</button>`).join('')}</div><a class="btn" href="#/cases/disasters">${icon('book',16)}重大气象灾害档案 ${icon('right',14)}</a></div><div id="case-list" class="case-grid"></div>`;
  const render = (kind) => {
    const order = (id) => id === 'beijing-snow' ? -1 : Number(id === 'bohai22');
    const ordered = [...catalog].sort((a, b) => order(a.id) - order(b.id));
    $('#case-list').innerHTML = ordered
      .filter((c) => kind === '全部' || categories[c.id] === kind)
      .map(
        (c) =>
          `<a class="case-tile" href="#/cases/${c.id}" aria-labelledby="title-${c.id}"><div class="tile-img">${c.climate ? '<canvas id="belts-cover" role="img" aria-label="全球6月至8月平均海平面气压"></canvas>' : `<img src="/assets/cases/${c.id}/cover.jpg" width="800" height="400" alt="${escape(c.area)}的 MODIS 卫星日合成局部" loading="lazy">`}<span>${escape(c.topic)}</span></div><div class="tile-body"><small>${escape(c.area)}　·　${caseDate(c)}</small><h2 id="title-${c.id}">${escape(c.title)}</h2><p>${escape(c.intro)}</p>${icon('out', 16)}</div></a>`
      )
      .join('');
    const cv = $('#belts-cover');
    if (cv)
      void resource('/assets/cases/belts/climate-6.json').then((g) => {
        if (ctx.active) void drawMap(cv, g, { cities: false, bbox: [-177, -67, 177, 70] });
      });
  };
  $('.case-filter').onclick = (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    $$('.case-filter button').forEach((x) => x.classList.toggle('on', x === e.target));
    render(e.target.textContent);
  };
  render('全部');
}
function principle(kind) {
  const mountain = kind === 'terrain';
  const shape = mountain
    ? '<path d="M0 123 72 119 124 109 211 55 292 117 380 124V145H0" fill="#829c8b"/><path d="M47 104Q104 106 175 55" fill="none" stroke="#268e9a" stroke-width="5" marker-end="url(#section-arrow)"/><text x="42" y="93">暖湿气流</text><text x="177" y="135">迎风坡</text>'
    : '<path d="M0 42Q130 56 294 122H0Z" fill="#7ba5d0"/><path d="M294 115Q204 77 109 55" fill="none" stroke="#ba7855" stroke-width="5" marker-end="url(#section-arrow)"/><text x="42" y="104">冷空气</text><text x="244" y="74">暖湿空气</text>';
  return `<details class="cross-section"><summary>${icon('cross', 16)} 从侧面看${mountain ? '地形抬升' : '冷暖交锋'} · 原理示意</summary><svg viewBox="0 0 380 145" role="img" aria-label="${mountain ? '湿空气沿迎风坡抬升' : '暖湿空气沿倾斜锋面抬升'}"><defs><marker id="section-arrow" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><path d="M0 0L4 2 0 4Z" fill="${mountain ? '#268e9a' : '#ba7855'}"/></marker></defs><rect width="380" height="145" fill="#e9f2f5"/><path d="M0 123h380v22H0" fill="#a5ac91"/>${shape}</svg></details>`;
}
function panelHtml(side, available) {
  const options = (keys) => keys.map((k) => `<option value="${k}">${layerNames[k]}</option>`).join('');
  const choices = available ? options(available) : Object.entries(liveGroups)
    .map(([name, keys]) => `<optgroup label="${name}">${options(keys)}</optgroup>`).join('');
  return `<section class="map-panel" data-side="${side}"><div class="map-panel-head"><label><span class="sr">${side === 'left' ? '左图' : '右图'}图层</span><select class="layer-select">${choices}</select></label><span class="kind"></span></div><div class="map-body"><canvas tabindex="0" aria-label="天气图，点击读取格点，方向键移动取样点"></canvas><div class="map-message"></div></div><div class="map-footer"><span class="map-source"></span><span class="color-scale"></span></div><div class="point-read"></div></section>`;
}
const guides = {
  wind850: '850 hPa 风场显示低层气流。沿箭头向上游回看，可以追踪空气来自哪里。',
  wind10: '箭头表示近地面风吹向的方向，颜色表示风速。结合迎风岸和地形读图。',
  temp850: '观察同一高度层上冷暖空气的分布。等温线靠得越近，水平温度变化越快。',
  temp2: '颜色与等温线给出近地面气温。点当地位置，和区县主预报在同一时刻的值做对照。',
  height500: '顺着等高线观察槽和脊的形状，拖动时间轴看它们的位置怎样移动。',
  pressure: '沿海平面气压的等值线寻找高低压区。相邻等压线越密，气压的水平变化越大。',
  moisture700: '数值表示此气压层的相对湿度。结合风向和抬升条件，判断湿空气的位置。',
  satellite: '卫星云图记录已经发生的云系变化。红外亮温反映云顶或地表的辐射特征。',
  track: '实线为已分析的台风中心位置，虚线为机构发布的预报路径。云系的范围通常超出中心轨迹。',
  climate: '观察各纬度海平面气压的季节平均分布。',
  zonal: '对同一纬度的各经度取平均，比较纬向平均气压的高值和低值。',
};
function guideFor(layer) {
  if (guides[layer]) return guides[layer];
  if (layer.startsWith('wind')) return '沿箭头向上游回看，比较进入选点的气流来自哪个方向。';
  if (layer.startsWith('height')) return guides.height500;
  if (layer.startsWith('temp')) return guides.temp850;
  if (layer.startsWith('moisture')) return guides.moisture700;
  return '';
}
export async function showMaps({ main, ctx, place, params }, c) {
  const available = c?.layers;
  let layers = c ? [...c.defaults] : ['autoUpper', 'autoTransport'],
    frames = c ? timesFor(c) : [],
    index = c ? Math.floor(c.leads?.length / 2 || 0) : 0;
  let run,
    revision = 0,
    playing = false,
    playSession = 0,
    showGuide = c?.id !== 'bohai22',
    point = c?.point || [place[5], place[4]],
    cursor = null;
  let forecastFrames = [],
    modeRevision = 0,
    localArchive = null,
    scrubTimer;
  const originalBox =
    c?.bbox ||
    (params.has('time')
      ? [place[5] - 14, place[4] - 9, place[5] + 14, place[4] + 9]
      : [72, 15, 141, 58]);
  let bbox = originalBox.slice(),
    items = {},
    forecast = null;
  const sub = c ? caseDate(c) : '';
  main.innerHTML = `<div class="page-head"><div><div class="subtitle">${escape(sub)}</div></div><button class="btn guide-switch" aria-pressed="${showGuide}">${icon('eye', 16)}读图标注<span class="switch ${showGuide ? 'on' : ''}"></span></button></div>
    <div class="map-toolbar"><span class="atlas-region">${icon('globe', 16)}${escape(c?.area || '东亚')}</span><span id="frame-time"></span>${c ? '' : '<div class="seg mode-tabs"><button data-mode="forecast" class="on">预报时次</button><button data-mode="observation">观测回放</button></div>'}<div class="zoom"><button aria-label="缩小地图">${icon('minus', 15)}</button><button aria-label="放大地图">${icon('plus', 15)}</button><button aria-label="还原地图范围">${icon('focus', 15)}</button></div></div>
    <div class="map-pair">${panelHtml('left', available)}${panelHtml('right', available)}</div>
    <div class="timeline panel"><button id="play" aria-label="播放时间轴">${icon('play', 17)}</button><button class="iconbtn" id="prev-frame" aria-label="上一时次">${icon('left', 16)}</button><div class="timeline-track"><input id="frame-slider" type="range" aria-label="两图共同的有效时刻" min="0" max="0" value="0"><div id="time-ticks"></div></div><button class="iconbtn" id="next-frame" aria-label="下一时次">${icon('right', 16)}</button></div>
    <div id="reading"></div>`;
  const panels = $$('.map-panel', main);
  panels.forEach((p, i) => {
    $('.layer-select', p).disabled = true;
    $('.layer-select', p).value = layers[i];
    $('.layer-select', p).onchange = (e) => {
      layers[i] = e.target.value;
      stop();
      if (!c && ['radar', 'satellite'].includes(layers[i])) {
        if (layers[i] === 'radar') bbox = [113, 18, 131, 31];
        setMode(true);
      } else void refresh();
    };
  });
  if (!c) {
    try {
      run = (await get('/api/run', ctx.signal)).run;
      if (!ctx.active) return;
      for (let h = -18; h <= 240; h += h < 48 ? 3 : h < 96 ? 6 : 12)
        frames.push(Date.parse(run) + h * HOUR);
      forecastFrames = frames.slice();
      const requestTime = Date.parse(params.get('time')) || Date.now();
      index = frames.reduce(
        (a, t, i) => (Math.abs(t - requestTime) < Math.abs(frames[a] - requestTime) ? i : a),
        0
      );
      void get('/api/forecast?id=' + place[0], ctx.signal)
        .then((d) => {
          if (ctx.active) {
            forecast = d;
            renderReading();
          }
        })
        .catch(() => {});
    } catch (err) {
      if (ctx.active) {
        $('.map-pair').innerHTML =
          failBox(err.message) + '<a href="#/cases" class="btn">打开离线案例</a>';
        $('.retry').onclick = () => location.reload();
        $('.timeline').hidden = true;
      }
      return;
    }
  }
  if (!ctx.active) return;
  const slider = $('#frame-slider');
  panels.forEach((p) => {
    $('.layer-select', p).disabled = false;
  });
  function frameLabel(t) {
    return c?.climate ? seasons[t / 3] : validText(t);
  }
  function updateTicks() {
    slider.max = String(frames.length - 1);
    slider.value = String(index);
    const ticks = [
      ...new Set([
        0,
        Math.floor((frames.length - 1) / 3),
        Math.floor((2 * (frames.length - 1)) / 3),
        frames.length - 1,
      ]),
    ];
    $('#time-ticks').innerHTML = ticks
      .map((i) => '<span>' + frameLabel(frames[i]) + '</span>')
      .join('');
  }
  function setMode(observe) {
    stop();
    const modeVersion = ++modeRevision;
    if (observe) {
      const last = Math.floor((Date.now() - 30 * 60000) / (10 * 60000)) * 10 * 60000;
      frames = Array.from({ length: 19 }, (_, i) => last - (18 - i) * 10 * 60000);
      index = frames.length - 1;
    } else {
      frames = forecastFrames;
      index = frames.reduce(
        (a, t, i) => (Math.abs(t - Date.now()) < Math.abs(frames[a] - Date.now()) ? i : a),
        0
      );
    }
    $$('.mode-tabs button').forEach((el) =>
      el.classList.toggle('on', (el.dataset.mode === 'observation') === observe)
    );
    updateTicks();
    void refresh();
    if (observe && layers.includes('radar')) {
      void get('/api/radar-times', ctx.signal)
        .then((info) => {
          if (
            !ctx.active ||
            modeVersion !== modeRevision ||
            !layers.includes('radar') ||
            index !== frames.length - 1
          )
            return;
          const available = info.frames
            .map((f) => Date.parse(f.time))
            .filter(Number.isFinite)
            .slice(-19);
          if (available.length && available.at(-1) !== frames.at(-1)) {
            frames = available;
            index = frames.length - 1;
            updateTicks();
            void refresh();
          }
        })
        .catch(() => {});
    }
  }
  updateTicks();
  if (!c)
    $('.mode-tabs').onclick = (e) => {
      const btn = e.target.closest('[data-mode]');
      if (btn) setMode(btn.dataset.mode === 'observation');
    };
  function renderReading() {
    if (!ctx.active) return;
    const el = $('#reading'),
      crossOpen = $('.cross-section', el)?.open,
      localOpen = $('.case-local', el)?.open;
    if (!showGuide) {
      el.innerHTML = '';
      return;
    }
    let compare = '';
    const g = Object.values(items).find((o) => o?.layer === 'temp2');
    if (!c && g && forecast) {
      const rows = forecast.daily.flatMap((d) => d.rows),
        row = rows.find((r) => Date.parse(r.time) === Date.parse(g.valid)),
        s = sample(g, ...point);
      if (s?.value != null && row) {
        const delta = Math.abs(row.temp - s.value);
        compare = `<p class="compare"><b>${escape(place[1])} · ${clockTime(row.time)}</b>　主预报 ${fmtNum(row.temp, 1)}℃，${escape(g.source)} 最近格点 ${fmtNum(s.value, 1)}℃。两份预报相差 ${fmtNum(delta, 1)}℃。</p>`;
      }
    }
    const reading = layers.map((choice, i) => {
      const g = items[i],
        l = g?.layer || choice,
        v = sample(g, ...(cursor || point));
      if (l === 'radar')
        return '看图上的有效范围和 dBZ 色标，再逐帧观察回波的移动。图像覆盖台湾及邻近海域。';
      if (l === 'rainRate')
        return '颜色表示模式预计的瞬时降水率，单位为毫米每小时。比较前后时次，看降水区的位置如何移动。';
      if (g?.v && v?.value != null) {
        const direction = ((Math.atan2(-v.u, -v.v) * 180) / Math.PI + 360) % 360;
        return (
          (cursor ? '选点' : place[1]) + '附近的' +
          layerNames[l] +
          '为' +
          windDir(direction) +
          '，风速约 ' +
          fmtNum(v.value, 1) +
          ' m/s。' +
          guideFor(l)
        );
      }
      return guideFor(l);
    }).filter(Boolean);
    el.innerHTML = `<section class="reading panel"><div class="reading-main"><h2>${icon('book', 18)}${c ? '怎样读这次过程' : '怎样读这两张图'}</h2>${(c ? c.guides : [...new Set(reading)]).map((s, i) => `<p class="step"><b>${i + 1}</b>${escape(s)}</p>`).join('')}${compare}</div>${c ? `<div class="case-evidence"><h3>${c.climate ? '资料时段' : c.dataMode === 'reanalysis' ? '再分析回看' : '当时的预报'}</h3><p>${escape(c.forecast)}</p><h3>${c.climate ? '怎么比较' : '实况回看'}</h3><p>${escape(c.outcome)}</p>${safeLink(c.link, '查看机构原始资料')} ${c.outcomeSource ? safeLink(c.outcomeSource, '实况记录') : ''}</div>` : ''}</section>${c?.cross ? principle(c.cross) : ''}${c?.alternate ? `<a class="practice" href="#/cases/${c.alternate}">${icon('layers', 17)}换一次降雪，隐藏标注自己读 ${icon('arrow', 16)}</a>` : ''}`;
    const auto = Object.values(items).find((g) => g?.autoRole);
    if (!c && auto) {
      const explanation = Number.isFinite(auto.selectionPressure)
        ? (cursor ? '选点' : place[1]) + '附近的模式地面气压为 ' + fmtNum(auto.selectionPressure) + ' hPa（' + (auto.selectionPressureSource || auto.source) + '）。选层以此格点、此时次为准，山峰与峡谷的实际地势可能不同。'
        : '该点的模式地面气压暂缺，近地层使用离地 10 米风。';
      $('.reading-main', el).insertAdjacentHTML('beforeend', '<p class="compare">' + escape(explanation) + '</p>');
    }
    if (c?.earlyReport) $('.case-evidence', el).insertAdjacentHTML('beforeend', ' ' + safeLink(c.earlyReport, '初期站报'));
    if (localArchive) {
      const flagged = localArchive.rows.filter((r) => r.snow > 0.5 && r.rate > 0.01);
      const summary = flagged.length
        ? '最早在 ' + validText(flagged[0].time) + ' 的格点预报中同时出现降雪信号与降水。'
        : '这些预报时次没有同时给出降雪信号与可测降水。';
      el.insertAdjacentHTML(
        'beforeend',
        `<details class="case-local panel"><summary>${icon('time', 16)}${escape(localArchive.place)}当地的归档预报 <span>${validText(localArchive.run)} 起报</span></summary><p>${summary} 下表以三小时取样，降水率为相应时刻的瞬时值。</p><div class="archive-table"><table><thead><tr><th>有效时刻（北京时间）</th><th>模式降雪信号</th><th>预报降水率</th></tr></thead><tbody>${localArchive.rows.map((r) => `<tr><td>${validText(r.time)}</td><td>${r.snow > 0.5 ? '有' : '无'}</td><td>${fmtNum(r.rate, 2)} mm/h</td></tr>`).join('')}</tbody></table></div></details>`
      );
    }
    if (crossOpen && $('.cross-section', el)) $('.cross-section', el).open = true;
    if (localOpen && $('.case-local', el)) $('.case-local', el).open = true;
  }
  function valueFor(g, layer, lon, lat) {
    if (layer === 'zonal' && g?.values) {
      const ix = Math.max(0, Math.min(g.ny - 1, Math.round((90 - lat) / g.step)));
      const row = g.values.slice(ix * g.nx, (ix + 1) * g.nx);
      return fmtNum(row.reduce((s, x) => s + x, 0) / row.length, 1) + ' hPa · 纬向平均';
    }
    const v = sample(g, lon, lat);
    if (v?.belowGround) return '该气压面位于模式地面或地下';
    if (v && v.value === null) return '此格点缺测';
    if (v?.value != null) {
      let out = fmtNum(v.value, 1) + ' ' + (layerUnit[layer] || '');
      if (g.v) {
        const degree = ((Math.atan2(-v.u, -v.v) * 180) / Math.PI + 360) % 360;
        out += ' · 风从 ' + fmtNum(degree) + '° 吹来';
      }
      return out;
    }
    return '';
  }
  function updateRead() {
    panels.forEach((p, i) => {
      const g = items[i],
        el = $('.point-read', p);
      if (!cursor) {
        el.textContent = g?.pointStatus==='missing' ? '此时次各源未补到选点，周边格点可点读' :
          g?.pointStatus==='terrain' ? '选点的气压面位于模式地面或地下' : g?.values ? '点击地图读取格点值' : '';
        return;
      }
      const v = valueFor(g, layers[i] === 'zonal' ? 'zonal' : g?.layer || layers[i], ...cursor);
      el.textContent = v
        ? `${fmtNum(cursor[0], 1)}°E　${fmtNum(cursor[1], 1)}°N　·　${v}`
        : g?.values
          ? '此处超出数据覆盖'
          : '';
    });
  }
  function repaint() {
    if (!ctx.active) return;
    panels.forEach((p, i) => {
      const g = items[i];
      if (!g) return;
      void drawMap($('canvas', p), g, {
        bbox,
        point: c?.point || cursor || point,
        tag: showGuide ? c?.tag || (cursor ? '选点' : place[3]) : '',
        annotation: showGuide ? c?.annotation : null,
        cities: showGuide,
        zonal: layers[i] === 'zonal',
      }).catch((e) => {
        if (ctx.active) {
          $('.map-message', p).textContent = e.message;
          $('.map-message', p).classList.add('show');
        }
      });
    });
    updateRead();
  }
  const observers = panels.map((p) => {
    const r = new ResizeObserver(repaint);
    r.observe($('canvas', p));
    return r;
  });
  ctx.onClose(() => {
    clearTimeout(scrubTimer);
    stop();
    observers.forEach((r) => r.disconnect());
  });
  async function dataFor(layer, t) {
    if (c?.climate) return resource('/assets/cases/belts/climate-' + t + '.json');
    const iso = new Date(t).toISOString();
    if (c) {
      if (layer === 'satellite')
        return {
          image: '/assets/cases/' + c.id + '/' + iso.slice(0, 10) + '.jpg',
          bbox: c.bbox,
          valid: iso.slice(0, 10),
          source: 'NASA GIBS · Terra / MODIS',
          type: '卫星日合成',
        };
      if (layer === 'track')
        return { ...(await resource('/assets/cases/doksuri/track.json')), valid: iso };
      const lead = (t - Date.parse(c.run + 'T00:00:00Z')) / HOUR;
      return resource('/assets/cases/' + c.id + '/' + layer + '-' + lead + '.json');
    }
    if (layer === 'satellite') {
      const reg =
        point[0] >= 115 && point[1] >= 22
          ? 'jpn'
          : point[1] >= 25
            ? 'ca1'
            : point[0] >= 105
              ? 'se2'
              : 'se1';
      return resource('/api/satellite?time=' + encodeURIComponent(iso) + '&region=' + reg);
    }
    if (layer === 'radar') return resource('/api/radar?time=' + encodeURIComponent(iso));
    if (layer === 'track') {
      const v = await resource('/api/cyclones');
      return { ...v, valid: iso, type: '机构路径', source: '香港天文台' };
    }
    const batch = t < Date.parse(run) ? Math.floor(t / (6 * HOUR)) * 6 * HOUR : Date.parse(run);
    const lead = Math.floor((t - batch) / (3 * HOUR)) * 3;
    return resource(liveGridUrl(new Date(batch).toISOString(), lead, layer, cursor || point));
  }
  async function refresh() {
    if (!ctx.active) return;
    clearTimeout(scrubTimer);
    const rev = ++revision,
      t = frames[index];
    $('#frame-time').textContent = frameLabel(t) + (c?.climate ? '' : ' · 北京时间');
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', frameLabel(t));
    $('#prev-frame').disabled = index === 0;
    $('#next-frame').disabled = index === frames.length - 1;
    await Promise.all(
      panels.map(async (p, i) => {
        const layer = layers[i],
          msg = $('.map-message', p),
          cv = $('canvas', p);
        delete items[i];
        cv.paintToken = null;
        cv.style.visibility = 'hidden';
        msg.className = 'map-message show';
        msg.textContent = '读取图层…';
        $('.map-source', p).textContent = '';
        $('.kind', p).textContent = '';
        $('.point-read', p).textContent = '';
        $('.color-scale', p).innerHTML = '';
        try {
          const g = await dataFor(layer, t);
          if (rev !== revision || !ctx.active) return;
          items[i] = g;
          if (layer === 'track' && !g.storms?.length) {
            msg.textContent = '香港天文台监测范围内暂无正在发布的台风路径';
          } else msg.classList.remove('show');
          cv.style.visibility = 'visible';
          $('.kind', p).textContent = g.type || '预报';
          const valid = g.period
            ? g.period
            : g.type === '卫星日合成'
              ? g.valid + ' UTC'
              : validText(g.valid);
          const src = $('.map-source', p);
          const level = g.autoRole ? actualLevel(g, layerNames) + ' · ' : '';
          src.textContent = level + sourceName(g) + ' · ' + valid + (g.type === '卫星日合成' ? ' · 黑区为缺测' : '');
          src.title = g.run ? [
            g.channel, '起报 ' + validText(g.run), '有效 ' + valid,
            g.resolution && '原始网格 ' + g.resolution,
            g.preferredLayer && g.layer !== g.preferredLayer && '首选层在此点缺少可用值',
            g.terrainReference && '同时参考 ' + g.terrainReference + ' 地形',
          ].filter(Boolean).join(' · ') : g.source;
          if (g.values && layer !== 'zonal') {
            const l = legend(g.layer);
            $('.color-scale', p).innerHTML =
              `<span>${l.low}</span><i style="background:${l.gradient}"></i><span>${l.high} ${l.unit}</span>`;
            if (g.terrainMask?.includes(1)) $('.color-scale', p).insertAdjacentHTML('beforeend', '<span class="terrain-key">地形遮挡</span>');
          }
          repaint();
        } catch (e) {
          if (rev === revision && ctx.active) {
            msg.innerHTML = `<span>${escape(e.message)}</span><button class="btn map-retry">重试</button>`;
            $('.map-retry', p).onclick = () => refresh();
          }
        }
      })
    );
    if (rev === revision) renderReading();
  }
  function stop() {
    playing = false;
    playSession++;
    const btn = $('#play');
    if (btn) {
      btn.innerHTML = icon('play', 17);
      btn.setAttribute('aria-label', '播放时间轴');
    }
  }
  async function play() {
    if (playing) {
      stop();
      return;
    }
    playing = true;
    const seq = ++playSession;
    $('#play').innerHTML = icon('pause', 17);
    $('#play').setAttribute('aria-label', '暂停时间轴');
    if (index === frames.length - 1) index = -1;
    while (ctx.active && playing && seq === playSession && index < frames.length - 1) {
      index++;
      await refresh();
      await new Promise((r) => setTimeout(r, 900));
    }
    if (ctx.active && seq === playSession) stop();
  }
  $('#play').onclick = play;
  slider.oninput = () => {
    stop();
    index = Number(slider.value);
    if (c) {
      void refresh();
      return;
    }
    ++revision;
    clearTimeout(scrubTimer);
    $('#frame-time').textContent = frameLabel(frames[index]) + ' · 北京时间';
    slider.setAttribute('aria-valuetext', frameLabel(frames[index]));
    for (const p of panels) {
      $('.map-message', p).className = 'map-message show';
      $('.map-message', p).textContent = '定位到所选时次…';
    }
    scrubTimer = setTimeout(() => void refresh(), 160);
  };
  $('#prev-frame').onclick = () => {
    stop();
    index = Math.max(0, index - 1);
    void refresh();
  };
  $('#next-frame').onclick = () => {
    stop();
    index = Math.min(frames.length - 1, index + 1);
    void refresh();
  };
  const zoom = (factor) => {
    const cx = (bbox[0] + bbox[2]) / 2,
      cy = (bbox[1] + bbox[3]) / 2,
      hw = ((bbox[2] - bbox[0]) * factor) / 2,
      hh = ((bbox[3] - bbox[1]) * factor) / 2;
    if (hw < 1 || hw > 180) return;
    bbox = [cx - hw, cy - hh, cx + hw, cy + hh];
    repaint();
  };
  const zb = $$('.zoom button');
  zb[0].onclick = () => zoom(1.25);
  zb[1].onclick = () => zoom(0.8);
  zb[2].onclick = () => {
    bbox = originalBox.slice();
    cursor = null;
    readPoint();
  };
  function readPoint() {
    const reload = !c && layers.some((id, i) => {
      if (Object.hasOwn(automaticLayers, id)) return true;
      const grid = items[i];
      if (!grid?.values) return false;
      const value = sample(grid, ...(cursor || point));
      return grid.backupSource || grid.pointStatus === 'missing' || (value && value.value === null && !value.belowGround);
    });
    if (reload) { stop(); void refresh(); }
    else { repaint(); renderReading(); }
  }
  $('.guide-switch').onclick = (e) => {
    showGuide = !showGuide;
    e.currentTarget.setAttribute('aria-pressed', String(showGuide));
    $('.switch').classList.toggle('on', showGuide);
    repaint();
    renderReading();
  };
  panels.forEach((p, i) => {
    const cv = $('canvas', p);
    let start = null;
    cv.onpointerdown = (e) => {
      if (items[i]?.externalImage) return;
      start = { x: e.clientX, y: e.clientY, b: bbox.slice() };
      cv.setPointerCapture(e.pointerId);
    };
    cv.onpointermove = (e) => {
      if (!start) return;
      const r = cv.getBoundingClientRect(),
        view = extentFor(cv, start.b),
        dx = ((e.clientX - start.x) / r.width) * (view[2] - view[0]),
        dy = ((e.clientY - start.y) / r.height) * (view[3] - view[1]);
      if (Math.abs(dx) + Math.abs(dy) > 0.03) {
        bbox = [start.b[0] - dx, start.b[1] + dy, start.b[2] - dx, start.b[3] + dy];
        repaint();
      }
    };
    cv.onpointerup = (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) {
        cursor = geoFromPointer(cv, e, bbox);
        if (layers[i] === 'zonal' && items[i])
          cursor[1] =
            90 -
            ((e.clientX - cv.getBoundingClientRect().left - 30) / Math.max(1, cv.clientWidth - 58)) *
              180;
        readPoint();
      }
      start = null;
    };
    cv.onpointercancel = () => {
      start = null;
    };
    cv.onkeydown = (e) => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (!moves[e.key]) return;
      e.preventDefault();
      cursor = cursor || [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
      const step = items[i]?.step || 1;
      cursor = [cursor[0] + moves[e.key][0] * step, cursor[1] + moves[e.key][1] * step];
      readPoint();
    };
  });
  if (c && ['bohai', 'bohai22'].includes(c.id)) {
    localArchive = await resource('/assets/cases/' + c.id + '/local.json');
    if (!ctx.active) return;
  }
  renderReading();
  await refresh();
}
