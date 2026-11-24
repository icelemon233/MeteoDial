import {
  get,
  $,
  $$,
  icon,
  escape,
  validText,
  clockTime,
  isoDay,
  HOUR,
  fmtNum,
  windDir,
  layerNames,
  layerUnit,
  safeLink,
  openDialog,
  closeButton,
} from './base.js';
import { drawMap, geoFromPointer, sample, legend, extentFor, nationalView, clampView, panView, prepareMapData, loadLand } from './cartography.js';
import { automaticLayers, pressureLevels,heightLevels, liveGridUrl, sourceName, actualLevel, forecastRun } from './levels.js';
import archiveBounds from '../assets/data/archive-domain.json' with { type: 'json' };
import { forecastTimes, forecastFrame, frameStops, nearestFrame, playbackRates } from '../shared/timeline.mjs';
import { drawTimeRuler } from './time-ruler.js';
import { bindPreferenceSelect } from './shell.js';
import { playbackClock } from './playback-clock.js';
import { playbackBuffer } from './playback-buffer.js';
import { cmaProducts, cmaDefaults, reflectLayer, cmaGuide, chartPeers,sharedObservationTimes } from './cma-maps.js';
import { markEventTime,atmosphere } from './disaster-analysis.js';
import { showGaugeReference } from './gauge-reference.js';
import {pressureGuide,selectionNote} from './pressure-guides.js';
import {showProfile} from './pressure-profile.js';
import { satelliteChannels, satelliteRegions, satelliteBounds } from '../shared/satellite.mjs';
import { caseLesson } from './case-lessons.js';
import { showHenanClouds } from './event-clouds.js';
import { bestTrack } from './typhoons.js';
import { phaseNames, phasesFromFlags } from '../shared/products.mjs';
import {gridIndex,liveDomain} from '../shared/levels.mjs';
const memo = new Map();
function cachedResource(url) {
  const hit = memo.get(url);
  return hit && hit.expires > Date.now() ? hit : null;
}
function remember(url, entry) {
  memo.delete(url);
  memo.set(url, entry);
  if (memo.size > 90) memo.delete(memo.keys().next().value);
}
function resource(url, group) {
  const cached = cachedResource(url) || group?.requests.get(url);
  if (cached) return cached.promise;
  const ttl = url.startsWith('/api/grid?') ? 5 * 60000 : url === '/api/cyclones' ? 15 * 60000 : 24 * HOUR;
  const entry = { ready: false, expires: Date.now() + ttl };
  entry.promise = get(url, group?.controller.signal).then(value => {
    entry.ready = true;
    // Share completed fields. Cancelling a superseded group releases its own
    // HTTP reads without poisoning a later request for the same forecast.
    if (group && !group.controller.signal.aborted && !cachedResource(url)) remember(url, entry);
    return value;
  }, error => {
    if (memo.get(url) === entry) memo.delete(url);
    throw error;
  });
  if (group) group.requests.set(url, entry);
  else remember(url, entry);
  return entry.promise;
}
const liveGroups = {
  随选点与时次选层: Object.keys(automaticLayers),
  地面与降水: ['wind10', 'temp2', 'pressure', 'rainRate', 'precipTotal', 'precipPhase'],
  '动力场 · 位势高度': heightLevels.map((p) => 'height' + p),
  '动力场 · 水平风': pressureLevels.map((p) => 'wind' + p),
  '动力场 · 垂直速度、涡度与散度': [
    ...pressureLevels.map((p) => 'omega' + p),
    ...pressureLevels.map((p) => 'vort' + p),
    'div850',
    'div200',
  ],
  '热力与水汽 · 气温': pressureLevels.map((p) => 'temp' + p),
  '热力与水汽 · 湿度': [
    'precipitableWater',
    ...pressureLevels.map((p) => 'moisture' + p),
    ...pressureLevels.map((p) => 'specific' + p),
  ],
  '热力与水汽 · 水汽通量': pressureLevels.map((p) => 'flux' + p),
  中央气象台: ['cmaRadar', 'cmaChart', 'cmaSatellite'],
  卫星与区域雷达: [...Object.keys(satelliteChannels), 'radar'],
};
function caseDate(c, frames) {
  if (!frames.length) return c.period || c.run.replaceAll('-', '.');
  const first = frames[0], last = frames.at(-1);
  const start = isoDay(first), end = isoDay(last);
  const from = start.replaceAll('-', '.') + ' ' + clockTime(first);
  if (frames.length === 1) return from;
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const endDate = (sameYear ? end.slice(5) : end).replaceAll('-', '.');
  const to = start === end ? clockTime(last) : endDate + ' ' + clockTime(last);
  const steps = new Set(frames.slice(1).map((t, i) => (t - frames[i]) / HOUR));
  const step = steps.size === 1 ? '每 ' + [...steps][0] : Math.min(...steps) + '–' + Math.max(...steps);
  return from + ' — ' + to + ' · ' + step + ' 小时';
}
function timesFor(c) {
  if (c.atlas) return Array.from({length:c.atlas.count},(_,i)=>Date.parse(c.atlas.start)+i*c.atlas.cadence*HOUR);
  return c.leads.map(n=>Date.parse(c.run + 'T00:00:00Z') + n * HOUR);
}
function caseFrameUrl(c, layer, time, xy=c.point) {
  if (layer === 'heightWide500')
    return (
      '/local/disaster-field?' +
      new URLSearchParams({
        id: c.event.id,
        layer,
        time: new Date(time).toISOString(),
        ...(!c.atlas ? { section: c.id } : {}),
      })
    );
  if (c.atlas) {
    const q=new URLSearchParams({id:c.id,layer,time:new Date(time).toISOString()});
    if(Object.hasOwn(automaticLayers,layer)&&xy){q.set('lon',xy[0]);q.set('lat',xy[1]);}
    return '/local/disaster-field?'+q;
  }
  const folder = '/assets/cases/' + c.id + '/';
  if (layer === 'satellite') return null;
  if (layer === 'track') return folder + 'track.json';
  const lead = (time - Date.parse(c.run + 'T00:00:00Z')) / HOUR;
  return folder + layer + '-' + lead + '.json';
}
async function caseFrame(c, layer, time, group,xy=c.point) {
  if (c.atlas || layer === 'heightWide500') {
    const field = await resource(caseFrameUrl(c, layer, time, xy), group);
    if (
      (Object.hasOwn(automaticLayers, layer) ? field.autoRole !== layer : field.layer !== layer) ||
      Date.parse(field.valid) !== time
    )
      throw Error('历史格点与所选时次或图层不符');
    return field;
  }
  if (layer === 'satellite') {
    const date = new Date(time).toISOString().slice(0, 10), folder = '/assets/cases/' + c.id + '/';
    return { image: folder + 'national-' + date + '.jpg', bbox: archiveBounds,
      detailImage: folder + date + '.jpg', detailBounds: c.bbox, valid: date,
      source: 'NASA GIBS · Terra / MODIS', type: '卫星日合成' };
  }
  const data = await resource(caseFrameUrl(c, layer, time), group);
  return layer === 'track' ? { ...data, valid: new Date(time).toISOString() } : data;
}
export async function prepareLiveMap(place, requested) {
  void loadLand().catch(() => {});
  const {run} = await forecastRun();
  const times = forecastTimes(run), time = times[nearestFrame(times, requested ?? Date.now())];
  const frame = forecastFrame(run, time);
  if (frame) await prepareMapData(await resource(liveGridUrl(frame.run, frame.lead, 'autoUpper', [place[5], place[4]])));
}
function principle(kind) {
  const mountain = kind === 'terrain';
  const shape = mountain
    ? '<path d="M0 123 72 119 124 109 211 55 292 117 380 124V145H0" fill="#829c8b"/><path d="M47 104Q104 106 175 55" fill="none" stroke="#268e9a" stroke-width="5" marker-end="url(#section-arrow)"/><text x="42" y="93">暖湿气流</text><text x="177" y="135">迎风坡</text>'
    : '<path d="M0 42Q130 56 294 122H0Z" fill="#7ba5d0"/><path d="M294 115Q204 77 109 55" fill="none" stroke="#ba7855" stroke-width="5" marker-end="url(#section-arrow)"/><text x="42" y="104">冷空气</text><text x="244" y="74">暖湿空气</text>';
  return `<details class="cross-section"><summary>${icon('cross', 16)} 从侧面看${mountain ? '地形抬升' : '冷暖交锋'} · 原理示意</summary><svg viewBox="0 0 380 145" role="img" aria-label="${mountain ? '湿空气沿迎风坡抬升' : '暖湿空气沿倾斜锋面抬升'}"><defs><marker id="section-arrow" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><path d="M0 0L4 2 0 4Z" fill="${mountain ? '#268e9a' : '#ba7855'}"/></marker></defs><rect width="380" height="145" fill="#e9f2f5"/><path d="M0 123h380v22H0" fill="#a5ac91"/>${shape}</svg></details>`;
}
function panelHtml(index, available) {
  const options = (keys) => keys.map((k) => `<option value="${k}">${layerNames[k]}</option>`).join('');
  const choices = available ? options(available) : Object.entries(liveGroups)
    .map(([name, keys]) => `<optgroup label="${name}">${options(keys)}</optgroup>`).join('');
  const name = '第' + (index + 1) + '图';
  return `<section class="map-panel no-frame" aria-label="${name}"><div class="map-panel-head"><label><span class="sr">${name}图层</span><select class="layer-select">${choices}</select></label><span class="kind"></span></div><div class="map-body" tabindex="0" role="group" aria-label="${name}天气图，点选或方向键读取位置，Shift 加方向键平移"><canvas class="current" aria-hidden="true"></canvas><canvas aria-hidden="true"></canvas><div class="map-message"></div></div><div class="map-footer"><span class="map-source"></span><span class="color-scale"></span></div><div class="point-read"></div></section>`;
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
  if (satelliteChannels[layer])
    return {
      satellite: '红外亮度描出云顶和地表的辐射特征，可连续追踪夜间云系。',
      satVisible: '可见光反映太阳光的反射，白天可辨认云纹和云带边缘。',
      satColor: '红绿蓝通道合成接近人眼所见的白天景象，便于辨认云、海陆与尘烟。',
      satVapor: 'B08 主要反映对流层上部的水汽和云顶，干湿带可显示高空环流。',
    }[layer];
  if (layer === 'precipTotal') return '从本次模式起报累加至图头的有效时刻，跨起报周期会重新计数。';
  if (layer === 'precipPhase')
    return '颜色表示模式判断的近地雨、雪、冻雨或冰粒。点读混合格点可查看同时出现的相态信号。';
  if (layer === 'precipitableWater')
    return '把单位面积空气柱中的水汽全部凝结，所得水深就是可降水量。实际雨量还受水汽补给和抬升影响。';
  if (layer.startsWith('specific'))
    return '比湿表示每千克湿空气含多少克水汽。比较同层上游和下游，可追踪湿空气的来源。';
  if (layer.startsWith('flux'))
    return '箭头表示水汽随风输送的方向，颜色同时计入风速和比湿。强输送带的末端若伴随抬升，水汽更易凝结。';
  if (layer === 'div850')
    return '负散度表示周围气流从水平方向汇入。把辐合区与负 ω 的上升区对照，留意两者是否重合。';
  if (layer.startsWith('vort'))
    return '北半球正相对涡度表示气旋性旋转。沿时间轴追踪正值中心，并用同层风场核对旋转方向。';
  if (layer.startsWith('omega'))
    return '气压坐标的垂直速度以 Pa/s 表示，负值表示上升。结合湿度可判断上升区是否容易形成云雨。';
  const explanation=pressureGuide(layer);
  if(explanation)return explanation;
  if (guides[layer]) return guides[layer];
  if (layer.startsWith('wind')) return '沿箭头向上游回看，比较进入选点的气流来自哪个方向。';
  if (layer.startsWith('height')) return guides.height500;
  if (layer.startsWith('temp')) return '颜色与等温线表示这一气压层的冷暖分布。';
  if (layer.startsWith('moisture')) return guides.moisture700;
  return '';
}
export async function showMaps({ main, ctx, place, params }, c) {
  const lesson = c?.event ? caseLesson(c) : null;
  const available = c?.layers;
  const defaults = c?.defaults || ['autoUpper', 'autoTransport','autoMoisture','temp2'];
  const choices = [...new Set([...defaults, ...(available || ['temp2', 'pressure'])])];
  const layers = Array.from({ length: 4 }, (_, i) => choices[i % choices.length]);
  const forecastLayers = layers.slice(),
    observationLayers = ['radar-chinaall', 'radar-huabei', 'radar-huadong', 'radar-huanan'];
  let satRegion = 'local',
    terrainOn = false,
    caseStorms = null;

  const chosenPanels=new Set();
  let frames = c ? timesFor(c) : [],
    index = c ? Math.floor(c.leads?.length / 2 || 0) : 0;
  if (c?.atlas) index=nearestFrame(frames,Date.parse(c.atlas.focus));
  const timeParam=params.get('time');
  const requestedTime = Date.parse(c?.atlas && /^\d{4}-\d\d-\d\d$/.test(timeParam)?timeParam+'T00:00:00+08:00':timeParam);
  if (c && Number.isFinite(requestedTime)) index = nearestFrame(frames, requestedTime);
  const cycle = c ? null : forecastRun().then(value => ({value}), error => ({error}));
  if (c) {
    // Begin the real first archived field before laying out controls or text.
    const firstLayer = layers[0];
    void caseFrame(c, firstLayer, frames[index]).then(data => {
      if (ctx.active && layers[0] === firstLayer) return prepareMapData(data, {zonal:firstLayer === 'zonal'});
    }).catch(() => {});
  }
  let run, cycleError,
    revision = 0,
    playing = false,
    autoStart = !params.has('time') && !matchMedia('(prefers-reduced-motion: reduce)').matches,
    timePinned = params.has('time'),
    playSession = 0,
    showGuide = c?.id !== 'bohai22',
    point = c?.point || [place[5], place[4]],
    cursor = null;
  let forecastFrames = [],
    modeRevision = 0,
    observing = false, observationError = null, delayedProducts = new Map(),
    localArchive = null;
  const clock = playbackClock();
  const playbackFields = playbackBuffer(dataFor);
  let activeStep = null, joining = null;
  let scrubFrame = 0, settleTimer = 0, scrubJob = null, scrubQueued = false, scrubPointer = null;
  let quickVisible = false, nextPreviewAt = 0, frameLoad = null;
  let shownTime = null, loadingTimer = 0, selectedReading=0,chartReference=null,chartRequest=0;
  const originalBox = nationalView;
  let bbox = [...originalBox], items = {}, forecast = null, requestedComparison = false;
  let viewRevision = 0, redrawFrame = 0;
  void loadLand().catch(() => {});
  const panels = [];
  const baseJobs = new WeakMap();
  const visibleLayers = () => layers.slice(0, panels.length);
  const isSatellite = (k) => Object.hasOwn(satelliteChannels, k);
  const isObservation = (k) => cmaProducts.has(k) || isSatellite(k) || k === 'radar';
  const hasObservation = () => visibleLayers().some(isObservation);
  const observationSource = () => [...new Set(visibleLayers().filter(isObservation))].sort().join('|');
  const satelliteParams = (k) =>
    new URLSearchParams({ channel: k, region: satRegion, lon: point[0], lat: point[1] });
  function activateGroup(observe) {
    const selected = observe ? observationLayers : forecastLayers;
    for (let i = 0; i < layers.length; i++) {
      layers[i] = selected[i];
      if (panels[i]) reflectLayer(panels[i], layers[i]);
    }
  }
  function chooseArea() {
    if (c) return;
    const satellite = visibleLayers().some(isSatellite),
      taiwan = visibleLayers().includes('radar');
    regionPick.hidden = !satellite;
    bbox = satellite
      ? satelliteBounds(satRegion, ...point)
      : taiwan
        ? [114.5, 17.7, 127, 29.3]
        : [...originalBox];
    $('.atlas-region', main).lastChild.textContent = satellite
      ? satRegion === 'local'
        ? place[1]
        : satelliteRegions[satRegion].name
      : taiwan
        ? '台湾及近海'
        : '全国';
    viewRevision++;
  }
  const sections=c?.sections ? '<nav class="event-sections" aria-label="事件分析视角">'+c.sections.map(s=>'<a href="'+escape(s.href)+'"'+(s.active?' aria-current="page"':'')+'>'+escape(s.label)+'</a>').join('')+'</nav>' : '';
  const layouts = [[1, '单图'], [2, '双图'], [4, '四图']];
  main.innerHTML = `${sections}<div class="page-head map-heading"><div class="seg map-layout" role="group" aria-label="地图布局">${layouts.map(([n, text]) => `<button data-count="${n}" aria-pressed="${n === 1}" class="${n === 1 ? 'on' : ''}">${text}</button>`).join('')}</div>${c ? '<span class="subtitle">' + escape(caseDate(c, frames)) + '</span>' : ''}<button class="btn guide-switch" aria-pressed="${showGuide}">${icon('eye', 16)}读图标注<span class="switch ${showGuide ? 'on' : ''}"></span></button></div>
    <div class="map-toolbar"><span class="atlas-region">${icon('globe', 16)}${escape(c?.area || '全国')}</span><span id="frame-time"></span>${c ? '' : '<div class="seg mode-tabs" role="group" aria-label="时次类型"><button data-mode="forecast" class="on" aria-pressed="true">预报时次</button><button data-mode="observation" aria-pressed="false">观测回放</button></div>'}<div class="zoom"><button aria-label="缩小地图">${icon('minus', 15)}</button><button aria-label="放大地图">${icon('plus', 15)}</button><button aria-label="还原全国地图范围">${icon('focus', 15)}</button></div></div>
    <div class="map-grid" data-count="1"></div>
    <div class="timeline panel"><button id="play" aria-label="播放时间轴" aria-pressed="false">${icon('play', 17)}</button><button class="iconbtn" id="prev-frame" aria-label="上一时次">${icon('left', 16)}</button><div class="timeline-track"><input id="frame-slider" type="range" aria-label="地图有效时刻" min="0" max="0" value="0"><span class="time-preview" aria-hidden="true"></span><div class="time-ruler" id="time-ticks" aria-hidden="true"></div></div><button class="iconbtn" id="next-frame" aria-label="下一时次">${icon('right', 16)}</button><select id="playback-rate" aria-label="播放速度" title="播放速度">${playbackRates.map(rate => '<option value="' + rate + '">' + rate + '×</option>').join('')}</select></div>
    <div id="reading"></div>`;
  const intro = document.createElement('section');
  intro.className = 'case-lesson panel';
  if (lesson) {
    intro.innerHTML =
      '<h2>发生了什么</h2><p>' +
      escape(c.event.fact) +
      '</p><h2>' +
      (lesson.background ? '这类天气怎样形成' : '为什么会发生') +
      '</h2><p>' +
      escape(lesson.why) +
      '</p><div class="evidence-actions" aria-label="在天气图上验证"></div><p class="evidence-caption" hidden></p>';
    const row = $('.evidence-actions', intro);
    lesson.steps.forEach((step, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = step.label;
      b.dataset.evidence = String(i);
      b.onclick = () => void applyEvidence(i);
      row.append(b);
    });
    $('.map-heading', main).before(intro);
  }
  async function applyEvidence(i) {
    const step = lesson?.steps[i];
    if (!step || !ctx.active) return;
    if (step.section && (step.section === 'overview' ? !c.atlas : c.id !== step.section)) {
      const q = new URLSearchParams(params);
      q.set('time', new Date(step.time).toISOString());
      q.set('evidence', i);
      if (step.section === 'overview') q.delete('section');
      else q.set('section', step.section);
      location.hash = '/cases/' + c.event.id + '?' + q;
      return;
    }
    stop();
    timePinned = true;
    const selected = ++modeRevision;
    for (const b of intro.querySelectorAll('button'))
      b.setAttribute('aria-pressed', String(Number(b.dataset.evidence) === i));
    const caption = $('.evidence-caption', intro);
    caption.hidden = false;
    caption.textContent = step.text;
    if (step.cloud) {
      showHenanClouds(ctx, step.time);
      return;
    }
    cursor = step.point || c.point;
    terrain(!!step.terrain);
    bbox = clampView(step.bbox || bbox);
    caseStorms = null;
    if (step.storm) {
      try {
        const year = await resource('/assets/data/typhoons/2021.json.gz'),
          record = year.find((x) => x.id === '2106');
        if (!ctx.active || modeRevision !== selected) return;
        const s = bestTrack(record);
        s.name = '烟花';
        s.labelFixTime = true;
        caseStorms = [s];
      } catch {
        if (ctx.active && modeRevision === selected) caption.textContent += ' 台风定位暂缺。';
      }
    }
    if (!ctx.active || modeRevision !== selected) return;
    if (step.layers) {
      const selectedLayers = step.layers.filter((key) => available.includes(key));
      const n = selectedLayers.length >= 3 ? 4 : selectedLayers.length >= 2 ? 2 : 1;
      if (selectedLayers.length === 3)
        selectedLayers.push(available.find((k) => !selectedLayers.includes(k)));
      selectedLayers.forEach((key, idx) => {
        layers[idx] = key;
        chosenPanels.add(idx);
      });
      setPanels(n);
      panels.forEach((p, j) => reflectLayer(p, layers[j]));
    }
    index = nearestFrame(frames, step.time);
    controls(index);
    repaint();
    await refresh(index);
    if (!ctx.active || modeRevision !== selected) return;
    if (step.profile) profileButton.click();
  }
  const grid = $('.map-grid', main);
  const frameTime = $('#frame-time', main);
  const regionPick = document.createElement('select');
  regionPick.hidden = true;
  regionPick.className = 'sat-region';
  regionPick.setAttribute('aria-label', '卫星云图区域');
  for (const [key, r] of Object.entries(satelliteRegions))
    regionPick.add(new Option(key === 'local' ? '所在地 · ' + place[1] : r.name, key));
  frameTime.after(regionPick);
  regionPick.onchange = () => {
    satRegion = regionPick.value;
    chooseArea();
    void setMode(true);
  };
  const terrainButton = document.createElement('button');
  terrainButton.className = 'btn terrain-toggle';
  terrainButton.textContent = '地形等高线';
  terrainButton.setAttribute('aria-pressed', 'false');
  if (c) $('.zoom', main).before(terrainButton);
  function terrain(value) {
    terrainOn = value;
    terrainButton.setAttribute('aria-pressed', String(value));
    terrainButton.classList.toggle('on', value);
    terrainButton.title = '海拔 200、500、1,000、2,000、4,000 米';
  }
  terrainButton.onclick = () => {
    terrain(!terrainOn);
    repaint();
  };
  const modelMeta = document.createElement('span');
  modelMeta.className = 'model-time';
  frameTime.after(modelMeta);
  const profileButton=document.createElement('button');
  profileButton.type='button';profileButton.className='btn profile-open';profileButton.textContent='温湿廓线';
  profileButton.disabled=true;profileButton.title='查看选点的气温、湿球温度与雨雪层结';
  $('.zoom',main).before(profileButton);
  const joint=document.createElement('button');
  if(!c||c.atlas?.columnVersion){
    joint.type='button';joint.className='btn joint-view';joint.textContent='分层联读';
    joint.title='并排查看高空形势、输送层风、湿度和近地气温';
    $('.map-layout',main).after(joint);
  }
  profileButton.onclick=()=>{
    const t=shownTime;
    if(!Number.isFinite(t)||t%HOUR!==0)return;
    pauseAtCurrent();
    const xy=cursor||point;
    if(c){
      const q=new URLSearchParams({id:c.atlas?c.id:c.event.id,time:new Date(t).toISOString(),lon:xy[0],lat:xy[1]});
      if(!c.atlas)q.set('section',c.id);
      const url='/local/disaster-profile?'+q;
      showProfile({url,detailedUrl:url+'&detail=full',valid:t},ctx);
    }else{
      // For a published observation, choose an actual matching model valid
      // hour and retain its initialization in the column source label.
      const model=observing?Math.floor(t/(6*HOUR))*6*HOUR:Date.parse(run);
      const f=observing?{run:new Date(model).toISOString(),lead:(t-model)/HOUR}:forecastFrame(run,t);
      if(f)showProfile({url:'/api/profile?'+new URLSearchParams({run:f.run,lead:f.lead,cell:gridIndex(liveDomain,...xy)}),valid:t},ctx);
    }
  };
  if (c) {
    const pick=document.createElement('button');
    pick.className='btn pick-frame';pick.innerHTML=icon('calendar',15)+'选时次';
    frameTime.after(pick);
    pick.onclick=()=>{
      pauseAtCurrent();
      const day=t=>new Date(t+8*HOUR).toISOString().slice(0,10);
      const initial=frames[index];
      openDialog('<div class="modal-head"><h2>选择回放时次</h2>'+closeButton()+'</div>'+
        '<form class="choose-frame"><label>日期<input type="date" required value="'+day(initial)+'" min="'+day(frames[0])+
        '" max="'+day(frames.at(-1))+'"></label><label>时刻（北京时）<select></select></label><button type="submit" class="btn">转到该时次</button></form>',dialog=>{
        const form=$('.choose-frame',dialog),date=$('input',form),clock=$('select',form),submit=$('[type=submit]',form);
        function hours(){
          const previous=clock.selectedOptions[0]?.textContent||clockTime(initial);
          const options=frames.map((t,i)=>({t,i})).filter(({t})=>day(t)===date.value);
          clock.replaceChildren(...options.map(({t,i})=>new Option(clockTime(t),String(i))));
          const preferred=options.find(({t})=>clockTime(t)===previous);
          if(preferred)clock.value=String(preferred.i);
          clock.disabled=submit.disabled=!options.length;
        }
        hours();date.oninput=hours;
        form.onsubmit=e=>{
          e.preventDefault();
          if(!ctx.active||submit.disabled||!form.reportValidity())return;
          seek(Number(clock.value),false);dialog.close();
        };
      });
    };
  }
  let refreshTimes;
  if (!c) {
    refreshTimes=document.createElement('button');
    refreshTimes.className='btn refresh-times';
    refreshTimes.hidden=true;
    refreshTimes.innerHTML=icon('refresh',15)+'更新时次';
    refreshTimes.onclick=()=>void setMode(true,!timePinned);
    $('.zoom',main).before(refreshTimes);
  }
  const timeline = $('.timeline', main);
  timeline.classList.toggle('case-timeline', Boolean(c));
  const speed = $('#playback-rate', timeline);
  bindPreferenceSelect(speed, 'playbackRate', { parse: Number, onValue(rate) {
    clock.setRate(rate);
    for (const panel of panels)
      for (const animation of $('canvas.current', panel).getAnimations()) animation.updatePlaybackRate(rate);
  } });
  const cancelAutoStart = (event) => { if (!speed.contains(event.target)) autoStart = false; };
  timeline.addEventListener('pointerdown', cancelAutoStart, { signal: ctx.signal });
  timeline.addEventListener('keydown', cancelAutoStart, { signal: ctx.signal });
  function setPanels(count) {
    while (panels.length > count) {
      const panel = panels.pop();
      for (const fade of $('canvas.current', panel).getAnimations()) fade.cancel();
      panel.remove();
      delete items[panels.length];
    }
    while (panels.length < count) {
      const i = panels.length;
      grid.insertAdjacentHTML('beforeend', panelHtml(i, available));
      const panel = grid.lastElementChild;
      panels.push(panel);
      reflectLayer(panel,layers[i]);
    }
    grid.dataset.count = count;
    for (const btn of $$('.map-layout button', main)) {
      const selected = Number(btn.dataset.count) === count;
      btn.classList.toggle('on', selected);
      btn.setAttribute('aria-pressed', String(selected));
    }
  }
  setPanels(c?.atlas ? 4 : 1);
  function referenceKey(t) {return t+'/'+gridIndex(liveDomain,...(cursor||point));}
  async function chartPressure(t){
    if(!Number.isFinite(t)||t%HOUR||Date.now()-t>6*24*HOUR)return null;
    const key=referenceKey(t);
    if(chartReference?.key===key)return chartReference;
    const xy=cursor||point,cell=gridIndex(liveDomain,...xy);
    if(cell<0)return null;
    const init=Math.floor(t/(6*HOUR))*6*HOUR;
    try{
      const g=await resource(liveGridUrl(new Date(init).toISOString(),(t-init)/HOUR,'surfacePressure',xy));
      const ps=g.values?.[cell];if(Date.parse(g.valid)!==t||!Number.isFinite(ps))return null;
      return {key,ps,name:cursor?'选点':place[1],source:g.source};
    }catch{return null;}
  }
  function readChartPressure(t){
    const rev=++chartRequest;
    if(c||!visibleLayers().some(k=>cmaProducts.get(k)?.kind==='chart'))return;
    if(chartReference?.key===referenceKey(t))return;
    void chartPressure(t).then(r=>{
      if(ctx.active&&rev===chartRequest&&r?.key===referenceKey(shownTime)){chartReference=r;renderReading();}
    });
  }
  joint.onclick=async()=>{
    const chart=!c&&observing,wasTime=shownTime,at=referenceKey(wasTime);
    let keys=['autoUpper','autoTransport','autoMoisture','temp2'];
    if(chart){
      const ref=playing?(chartReference?.key===at?chartReference:null):await chartPressure(wasTime);
      if(!ctx.active||!observing||wasTime!==shownTime||at!==referenceKey(shownTime))return;
      chartReference=ref;keys=chartPeers(ref?.ps).slice(0,4);
    }
    const count=keys.length>=4?4:2;
    setPanels(count);
    keys.slice(0, count).forEach((key, i) => {
      layers[i] = key;
      if (!c) (chart ? observationLayers : forecastLayers)[i] = key;
      chosenPanels.add(i);
      reflectLayer(panels[i], key);
    });
    if (chart) {
      chooseArea();
      void setMode(true);
    } else void refreshView();
  };
  const slider = $('#frame-slider');
  const ruler = $('#time-ticks'), preview = $('.time-preview', main);
  let stops = [], hoverFrame = null, rulerWidth = 0;
  $('.map-layout', main).onclick = (e) => {
    const btn = e.target.closest('[data-count]');
    if (!btn || panels.length === Number(btn.dataset.count)) return;
    const before = observationSource();
    const product=cmaProducts.get(layers[0]), count=Number(btn.dataset.count);
    if (!c && product && count>panels.length) {
      const peers=product.kind==='chart'?[...chartPeers(chartReference?.key===referenceKey(shownTime)?chartReference.ps:null),'chart-500','chart-700','chart-850']:
        ['radar-chinaall','fy4b','radar-huabei','radar-huadong','radar-huanan'];
      for (let i=panels.length;i<count;i++) {
        if (!chosenPanels.has(i)) layers[i]=peers.find(key=>!layers.slice(0,i).includes(key));
      }
    }
    if (!c && observing) for (let i = 0; i < count; i++) observationLayers[i] = layers[i];
    setPanels(Number(btn.dataset.count));
    if (observing && before !== observationSource()) void setMode(hasObservation());
    else if (playing && activeStep) {
      const hold = activeStep.hold;
      repaint();
      void startPlayback(hold);
      fillJoiningPanels();
    } else void refreshView();
  };
  grid.onchange = (e) => {
    if (!e.target.matches('.layer-select,.cma-product-select')) return;
    const i = panels.indexOf(e.target.closest('.map-panel'));
    const before = observationSource();
    chosenPanels.add(i);
    const key = cmaDefaults[e.target.value] || e.target.value;
    if (c) {
      layers[i] = key;
      reflectLayer(panels[i], key);
      if (key === 'heightWide500') {
        bbox = [25, 14, 166, 74];
        repaint();
      }
      void refreshView();
      return;
    }
    const observe = isObservation(key);
    (observe ? observationLayers : forecastLayers)[i] = key;
    if (observe !== observing) activateGroup(observe);
    else {
      layers[i] = key;
      reflectLayer(panels[i], key);
    }
    if (observe !== observing || (observe && before !== observationSource())) {
      chooseArea();
      void setMode(observe);
    } else void refreshView();
  };
  function modelFrameType(init, valid) {
    if (Date.parse(init) === valid) return valid < Date.parse(run) ? '历史模式分析' : '起报分析';
    return valid < Date.now() ? '过去预报回放' : '模式预报';
  }
  function frameLabel(t) {
    return validText(t);
  }
  const jumps = document.createElement('div');
  jumps.className = 'time-jumps';
  jumps.hidden = true;
  timeline.after(jumps);
  function paintTicks() {
    drawTimeRuler(ruler, frames, stops, rulerWidth);
    jumps.replaceChildren();
    jumps.hidden = Boolean(c || observing || !run || !frames.length);
    if (jumps.hidden) return;
    for (const [kind, label, t] of [
      ['run', '本批起报', Date.parse(run)],
      ['now', '距现在最近', Date.now()],
    ]) {
      const i = nearestFrame(frames, t),
        bar = document.createElement('i');
      bar.className = 'cycle-mark ' + kind;
      bar.style.left = (100 * stops[i]) / stops.at(-1) + '%';
      ruler.append(bar);
      const btn = document.createElement('button');
      btn.className = 'textlink ' + kind;
      btn.type = 'button';
      btn.textContent = label + ' ' + validText(frames[i]);
      btn.onclick = () => seek(i, false);
      jumps.append(btn);
    }
  }
  function updateTicks() {
    stops = frameStops(frames);
    hoverFrame = null;
    slider.max = String(stops.at(-1) || 0);
    slider.disabled = !frames.length;
    if (!frames.length) {
      for (const id of ['#play','#prev-frame','#next-frame']) $(id, timeline).disabled = true;
      preview.textContent = '';
      ruler.replaceChildren();
      return;
    }
    controls(index);
    if (rulerWidth) paintTicks();
  }
  async function setMode(observe,latest=false) {
    clearSeekStatus();
    const modeVersion = ++modeRevision;
    const requested = frames[index] ?? shownTime ?? (Number.isFinite(requestedTime) ? requestedTime : Date.now());
    const source = observe ? observationSource() : null;
    if (refreshTimes) refreshTimes.hidden = !observe;
    const wasObserving=observing;
    observationError = null;
    delayedProducts.clear();
    revision++;
    playSession++;
    resetPlayback();
    discardScrub();
    frameLoad?.abort();
    frames = observe ? [] : forecastFrames;
    index = frames.length ? nearestFrame(frames, requested) : 0;
    shownTime = null;
    frameTime.textContent = '';
    modelMeta.textContent = '';
    jumps.hidden = true;
    panels.forEach((p, i) => {
      clearPanel(p, i);
      p.classList.remove('has-basemap');
    });
    observing = observe;
    joint.title=observe?'对照同一分析时次的地面和等压面原图':'并排查看环流形势、输送层风、湿度和近地气温';
    for (const el of $$('.mode-tabs button')) {
      const selected = (el.dataset.mode === 'observation') === observe;
      el.classList.toggle('on', selected);
      el.setAttribute('aria-pressed', String(selected));
    }
    updateTicks();
    if (source) {
      showPending(visibleLayers(), '读取已发布的观测时次…');
      try {
        const published = await sharedObservationTimes(
          source.split('|'),
          (url) => get(url, ctx.signal),
          (key) =>
            isSatellite(key) ? '/api/satellite-times?' + satelliteParams(key) : '/api/' + key + '-times',
        );
        if (!ctx.active || modeVersion !== modeRevision || source !== observationSource()) return;
        frames = published.times;
        delayedProducts = published.delayed;
        index =
          !latest && (timePinned || (wasObserving && frames.includes(requested)))
            ? nearestFrame(frames, requested)
            : frames.length - 1;
        updateTicks();
      } catch (e) {
        if (!ctx.active || modeVersion !== modeRevision) return;
        observationError = e;
        stop();
        await refreshView();
        return;
      }
    }
    void refreshView();
  }
  updateTicks();
  if (!c)
    $('.mode-tabs').onclick = (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      const observe = btn.dataset.mode === 'observation';
      if (observe === observing) return;
      activateGroup(observe);
      chooseArea();
      void setMode(observe);
    };
  function renderReading() {
    if (!ctx.active) return;
    const el = $('#reading'),
      crossOpen = $('.cross-section', el)?.open,
      localOpen = $('.case-local', el)?.open;
    if (!showGuide && !c?.event) {
      el.innerHTML = '';
      return;
    }
    let compare = '';
    const g = Object.values(items).find((o) => o?.layer === 'temp2');
    if (!c && g && !requestedComparison) {
      requestedComparison = true;
      void get('/api/forecast?id=' + place[0], ctx.signal).then(d => {
        if (ctx.active) { forecast = d; renderReading(); }
      }).catch(() => {});
    }
    if (!c && g && forecast) {
      const rows = forecast.daily.flatMap((d) => d.rows),
        row = rows.find((r) => Date.parse(r.time) === Date.parse(g.valid)),
        s = sample(g, ...point);
      if (s?.value != null && row) {
        const delta = Math.abs(row.temp - s.value);
        compare = `<p class="compare"><b>${escape(place[1])} · ${clockTime(row.time)}</b>　主预报 ${fmtNum(row.temp, 1)}℃，${escape(g.source)} 最近格点 ${fmtNum(s.value, 1)}℃。两份预报相差 ${fmtNum(delta, 1)}℃。</p>`;
      }
    }
    const reading = visibleLayers().map((choice, i) => {
      const g = items[i],
        l = g?.layer || choice,
        v = sample(g, ...(cursor || point));
      if (cmaProducts.has(choice)) return cmaGuide(cmaProducts.get(choice),chartReference?.key===referenceKey(shownTime)?chartReference:null);
      if (l === 'radar')
        return '看图上的有效范围和 dBZ 色标，再逐帧观察回波的移动。图像覆盖台湾及邻近海域。';
      if (l === 'rainRate')
        return '颜色表示模式预计的瞬时降水率，单位为毫米每小时。比较前后时次，看降水区的位置如何移动。';
      if ((l.startsWith('omega') || l.startsWith('div')) && Number.isFinite(v?.value)) {
        return (
          (cursor ? '选点' : place[1]) +
          '附近的' +
          layerNames[l] +
          '为 ' +
          fmtNum(v.value, l.startsWith('omega') ? 3 : 2) +
          ' ' +
          layerUnit[l] +
          '。' +
          guideFor(l)
        );
      }
      if (l.startsWith('flux')) return guideFor(l);
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
          (g.autoRole?selectionNote(g.autoRole,g.selectionPressure,l):'')+guideFor(l)
        );
      }
      return (g?.autoRole?selectionNote(g.autoRole,g.selectionPressure,l):'')+guideFor(l);
    }).filter(Boolean);
    const links = c ? [[c.report||c.link,c.reportName||'查看机构原始资料'],[c.outcomeSource,'实况记录'],
      [c.link!==c.report&&c.report?c.link:null,'专题资料'],[c.event?.extraSource,'过程核查资料'],[c.event?.map.source,'时段核查资料'],...(c.dataLinks||[])] : [];
    const seen=new Set();
    const sources=links.filter(([url])=>url&&!seen.has(url)&&seen.add(url)).map(([url,label])=>safeLink(url,label)).join(' ');
    const evidence = c
      ? '<div class="case-evidence"><h3>' +
        (c.atlas ? '图上读数' : c.dataMode === 'reanalysis' ? '再分析回看' : '当时的预报') +
        '</h3><p>' +
        escape(c.forecast) +
        '</p>' +
        (c.evidenceCurve || '') +
        (c.atlas ? '<button type="button" class="textlink gauge-reference">雨量站日累计对照</button>' : '') +
        (!c.atlas && c.event && c.outcome !== c.event.fact ? '<p>' + escape(c.outcome) + '</p>' : '') +
        '<details class="event-sources"><summary>资料来源</summary>' +
        (c.method ? '<p>' + escape(c.method) + '</p>' : '') +
        sources +
        '</details></div>'
      : '';
    if (lesson) {
      const check = c.event.analysis && lesson.background ? '<p>' + escape(c.event.analysis) + '</p>' : '';
      const study = lesson.sources.map(([url, name]) => safeLink(url, name)).join(' ');
      el.innerHTML =
        '<section class="reading panel"><div class="reading-main"><h2>' +
        icon('book', 18) +
        '这次过程有什么特别</h2><p>' +
        escape(lesson.special) +
        '</p>' +
        (c.atlas ? '<p class="atmosphere-reading">' + escape(c.guides[1] || '') + '</p>' : '') +
        '<h3>资料能说明到哪一步</h3><p>' +
        escape(lesson.limit) +
        '</p>' +
        check +
        study +
        '</div>' +
        evidence +
        '</section>' +
        (c.cross ? principle(c.cross) : '');
    } else {
      el.innerHTML =
        '<section class="reading panel"><div class="reading-main"><h2>' +
        icon('book', 18) +
        '怎样读天气图</h2>' +
        [...new Set(reading)].map((s) => '<p>' + escape(s) + '</p>').join('') +
        compare +
        '</div></section>';
    }
    if (c?.atlas) {
      if (shownTime!==null) markReading(el,shownTime);
      $('.gauge-reference',el).onclick=()=>{const t=shownTime??frames[index];pauseAtCurrent();showGaugeReference(c,t,ctx);};
    }
    const auto = Object.values(items).find((g) => g?.autoRole);
    if (!c && visibleLayers().includes('radar'))
      $('.reading-main', el).insertAdjacentHTML('beforeend', safeLink('https://www.nmc.cn/publish/radar/chinaall.html', '中央气象台全国雷达拼图'));
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
      if (layer === 'precipPhase')
        return (
          phaseNames[v.value] + (v.value === 5 ? '（' + phasesFromFlags(v.phaseMask).join('、') + '）' : '')
        );
      let out =
        fmtNum(
          v.value,
          layer.startsWith('omega') || layer.startsWith('flux') ? 3 : layer.startsWith('div') ? 2 : 1,
        ) +
        ' ' +
        (layerUnit[layer] || '');
      if (layer.startsWith('omega')) out += ' · ' + (v.value < 0 ? '上升' : v.value > 0 ? '下沉' : '接近零');
      if (layer.startsWith('div')) out += ' · ' + (v.value > 0 ? '辐散' : v.value < 0 ? '辐合' : '接近零');
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
      if (g?.externalImage) {
        const product=cmaProducts.get(layers[i]);
        if (product) {
          const url='https://www.nmc.cn'+product.page;
          const delay=delayedProducts.get(product.id)||'';
          if (el.querySelector('a')?.href!==url || el.dataset.delay!==delay) {
            el.innerHTML=(delay?'资料延迟，最近一期 '+validText(delay)+' · ':'')+safeLink(url,'中央气象台产品原页');
            el.dataset.delay=delay;
          }
        }
        else el.textContent='原始观测图像';
        return;
      }
      if (!cursor) {
        el.textContent =
          g?.pointStatus === 'missing'
            ? '此时次各源未补到选点，周边格点可点读'
            : g?.pointStatus === 'terrain'
              ? '选点的气压面位于模式地面或地下'
              : g?.layer?.startsWith('omega')
                ? '负值表示上升，正值表示下沉。点击地图可读数。'
                : g?.layer?.startsWith('div')
                  ? '正值表示辐散，负值表示辐合。点击地图可读数。'
                  : g?.values
                    ? '点击地图读取格点值'
                    : '';
        return;
      }
      const v = valueFor(g, layers[i] === 'zonal' ? 'zonal' : g?.layer || layers[i], ...cursor);
      el.textContent = v
        ? `${fmtNum(Math.abs(cursor[0]), 1)}°${cursor[0] < 0 ? 'W' : 'E'}　${fmtNum(Math.abs(cursor[1]), 1)}°${cursor[1] < 0 ? 'S' : 'N'}　·　${v}`
        : g?.values
          ? '此处超出数据覆盖'
          : '';
    });
  }
  function mapOptions(i) {
    return {
      bbox,
      terrain: terrainOn,
      storms: layers[i] === 'heightWide500' ? caseStorms : null,
      point: cursor || point,
      tag: cursor ? '选点' : showGuide ? c?.tag || place[3] : '',
      annotation: showGuide ? c?.annotation : null,
      cities: showGuide,
      zonal: layers[i] === 'zonal',
    };
  }
  function repaint() {
    viewRevision++;
    if (redrawFrame || !ctx.active) return;
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = 0;
      if (!ctx.active) return;
      quickVisible = false;
      panels.forEach((panel, i) => {
        const canvas = $('canvas.current', panel);
        if (items[i]) void drawMap(canvas, items[i], mapOptions(i)).catch(() => {});
        else showBasemap(panel, i);
      });
      updateRead();
    });
  }
  const plotSize = () => [window.devicePixelRatio, ...panels.map(p => $('.map-body', p).getBoundingClientRect().width)].join(',');
  let previousSize;
  const resizePlots = () => {
    const size = plotSize();
    const changed = previousSize !== undefined && size !== previousSize;
    previousSize = size;
    if (changed) repaint();
  };
  const observer = new ResizeObserver(resizePlots);
  observer.observe(grid, { box: 'device-pixel-content-box' });
  const rulerObserver = new ResizeObserver(([entry]) => {
    rulerWidth = entry.contentRect.width;
    paintTicks();
  });
  rulerObserver.observe(ruler);
  const nowTimer = c
    ? null
    : setInterval(() => {
        if (!observing && frames.length && rulerWidth) {
          paintTicks();
          if (shownTime !== null) displayTime(shownTime);
        }
      }, 60000);
  window.addEventListener('resize', resizePlots, { signal: ctx.signal });
  ctx.onClose(() => {
    discardScrub();
    frameLoad?.abort();
    clearSeekStatus();
    cancelAnimationFrame(redrawFrame);
    observer.disconnect();
    rulerObserver.disconnect();
    clearInterval(nowTimer);
    revision++;
    stop();
  });
  function frameUrl(layer, t, modelRun = run) {
    if (c) return caseFrameUrl(c, layer, t,cursor||point);
    const iso = new Date(t).toISOString();
    if (cmaProducts.has(layer)) return '/api/cma-image?'+new URLSearchParams({product:layer,time:iso});
    if (isSatellite(layer)) {
      const q = satelliteParams(layer);
      q.set('time', iso);
      return '/api/satellite?' + q;
    }
    if (layer === 'radar') return '/api/radar?time=' + encodeURIComponent(iso);
    if (layer === 'track') return '/api/cyclones';
    const forecast = forecastFrame(modelRun, t);
    return forecast ? liveGridUrl(forecast.run, forecast.lead, layer, cursor || point) : null;
  }
  async function dataFor(layer, time, group) {
    if (c) return caseFrame(c, layer, time, group,cursor||point);
    let modelRun = run;
    if (!modelRun && !isObservation(layer)) {
      const result = await cycle;
      if (result.error) throw result.error;
      group?.controller.signal.throwIfAborted();
      modelRun = result.value.run;
    }
    const url = frameUrl(layer, time, modelRun);
    if (!url) throw Error('该观测时刻没有对应的模式预报');
    const data = await resource(url, group);
    if (
      cmaProducts.has(layer) &&
      (data.product !== layer || Date.parse(data.valid) !== time || !data.externalImage)
    )
      throw Error('原图的产品或时次与选项不符');
    if (isObservation(layer) && Date.parse(data.valid) !== time) throw Error('观测有效时刻与所选帧不一致');
    if (isSatellite(layer) && data.channel !== satelliteChannels[layer].code)
      throw Error('卫星通道与所选产品不一致');
    return data;
  }
  function previewAt(target) {
    if (!frames.length) return;
    preview.textContent = frameLabel(frames[target]);
    const percent = stops.at(-1) ? 100 * stops[target] / stops.at(-1) : 0;
    preview.style.setProperty('--time-position', percent + '%');
    preview.toggleAttribute('data-loading', target === index && grid.getAttribute('aria-busy') === 'true');
  }
  function clearSeekStatus() {
    clearTimeout(loadingTimer);
    grid.removeAttribute('aria-busy');
    preview.removeAttribute('data-loading');
    frameTime.removeAttribute('data-buffering');
  }
  function noteSeek() {
    clearSeekStatus();
    if (shownTime === frames[index]) return;
    loadingTimer = setTimeout(() => {
      if (!ctx.active || !timePinned || shownTime === frames[index]) return;
      grid.setAttribute('aria-busy', 'true');
      previewAt(hoverFrame ?? index);
    }, 150);
  }
  function controls(target) {
    slider.value = String(stops[target]);
    slider.setAttribute('aria-valuetext', frameLabel(frames[target]));
    previewAt(hoverFrame ?? target);
    $('#play').disabled = frames.length < 2;
    $('#prev-frame').disabled = target === 0;
    $('#next-frame').disabled = target === frames.length - 1;
  }
  function describe(panel, layer, data) {
    const area = $('.map-body', panel);
    panel.classList.toggle('original-image', Boolean(data.externalImage));
    area.setAttribute('aria-label', panel.getAttribute('aria-label') + (data.externalImage
      ? '原始观测图像'
      : layer === 'zonal' ? '纬向平均气压，点选纬度' : '天气图，点选或方向键读取位置，Shift 加方向键平移'));
    $('.kind', panel).textContent =
      !c && !observing && data.run ? modelFrameType(data.run, Date.parse(data.valid)) : data.type || '预报';
    $('.kind',panel).title=pressureGuide(data.layer)||'';
    const valid = data.intervalStart&&data.intervalEnd ? validText(data.intervalStart)+' — '+validText(data.intervalEnd)
      : data.period || (data.type === '卫星日合成' ? data.valid + ' UTC' : validText(data.valid));
    const src = $('.map-source', panel);
    const level = data.autoRole ? actualLevel(data, layerNames) + ' · ' : '';
    src.textContent = level + sourceName(data) + ' · ' + valid + (data.type === '卫星日合成' ? ' · 黑区为缺测' : '');
    src.title = data.run ? [
      data.channel, '起报 ' + validText(data.run), '有效 ' + valid,
      data.resolution && '原始网格 ' + data.resolution,
      data.step && Number.parseFloat(data.resolution) !== data.step && '显示格距 ' + data.step + '°',
      data.preferredLayer && data.layer !== data.preferredLayer && '首选层在此点缺少可用值',
      data.terrainReference && '同时参考 ' + data.terrainReference + ' 地形',
    ].filter(Boolean).join(' · ') : [data.source,data.type,data.channel,data.resolution&&'资料网格 '+data.resolution,data.step&&'显示格距 '+data.step+'°'].filter(Boolean).join(' · ');
    if(data.selectionPressure!=null)src.title+=' · 选点模式地面气压 '+fmtNum(data.selectionPressure,1)+' hPa '+selectionNote(data.autoRole,data.selectionPressure,data.layer);
    if(data.partial)src.title+=' · 部分边缘区域缺测';
    if(data.derived)src.title+=' · '+data.derived;
    if (data.sourceRuns) {
      const runs=[...new Set(data.sourceRuns)].map(t=>validText(t)).join('、');
      src.title='累计时段 '+valid+'（北京时） · 四份一小时资料的起报时次 '+runs+' · 原始格距 '+data.resolution;
    }
    const scale = $('.color-scale', panel);
    const terrain = data.terrainMask?.includes(1);
    const scaleKey = data.values && layer !== 'zonal' ? data.layer + (terrain ? '-terrain' : '') : '';
    if (scale.dataset.key === scaleKey) return;
    scale.dataset.key = scaleKey;
    scale.replaceChildren();
    if (scaleKey) {
      const l = legend(data.layer);
      if (data.layer === 'precipPhase') {
        const colors = ['#2e3f4d', '#5ba97c', '#cd6695', '#b892d4', '#9aceeb', '#dbab61'];
        scale.innerHTML = phaseNames
          .map(
            (name, i) =>
              '<span class="phase-key" style="--phase:' + colors[i] + '">' + (i ? name : '无') + '</span>',
          )
          .join('');
        return;
      }
      scale.innerHTML = `<span>${l.low}</span><i style="background:${l.gradient}"></i><span>${l.high} ${l.unit}</span>`;
      if (terrain) scale.insertAdjacentHTML('beforeend', '<span class="terrain-key">地形遮挡</span>');
    }
  }
  function clearPanel(panel, i) {
    delete items[i];
    delete panel.dataset.layer;
    panel.classList.add('no-frame');
    $('.map-source', panel).removeAttribute('title');
    delete $('.color-scale', panel).dataset.key;
    for (const field of $$('.kind, .map-source, .color-scale, .point-read', panel)) field.replaceChildren();
  }
  function showBasemap(panel, i) {
    if (cmaProducts.has(layers[i]) || layers[i] === 'zonal' || items[i] || !ctx.active) return;
    const canvas = $('canvas.current', panel), prior = baseJobs.get(panel);
    if (prior?.canvas === canvas && prior.view === viewRevision) return;
    const job = {canvas, view:viewRevision};
    baseJobs.set(panel, job);
    const pending = () => ctx.active && panel.isConnected && !items[i] &&
      baseJobs.get(panel) === job && canvas.classList.contains('current');
    const paint = async () => {
      if (!pending()) return;
      const options = {...mapOptions(i), annotation:null};
      if (!await drawMap(canvas, null, {...options, firstLook:true}) || !pending()) return;
      panel.classList.add('has-basemap');
      if (!c) {
        await yieldToPaint();
        if (pending()) await drawMap(canvas, null, options);
      }
    };
    const start = () => { void paint().catch(() => { if (baseJobs.get(panel) === job) baseJobs.delete(panel); }); };
    // Fast local case data usually arrives first. Avoid rendering an extra full-size canvas for it.
    if (c) setTimeout(start, 65);
    else start();
  }
  function showPending(choices, text) {
    for (const [i, panel] of panels.entries()) {
      if (panel.dataset.layer !== choices[i]) {
        clearPanel(panel, i);
        if (choices[i] === 'zonal') { baseJobs.delete(panel); panel.classList.remove('has-basemap'); }
        else showBasemap(panel, i);
        const message = $('.map-message', panel);
        message.className = 'map-message pending show';
        message.textContent = text;
      }
    }
  }
  function publishPanel(i, layer, result, buffer, animate) {
    const panel = panels[i], msg = $('.map-message', panel);
    if (result.status === 'rejected') {
      clearPanel(panel, i);
      showBasemap(panel, i);
      msg.innerHTML = `<span>${escape(result.reason?.message || '此时次暂无资料')}</span><button class="btn map-retry">重试</button>`;
      msg.className = 'map-message show';
      $('.map-retry', msg).onclick = () => { stop(); void refresh(); };
      return;
    }
    const data = result.value, previous = $('canvas.current', panel);
    for (const fade of previous.getAnimations()) fade.cancel();
    previous.classList.remove('current');
    buffer.classList.add('current');
    if (animate && items[i] && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const fade = buffer.animate([{opacity:0}, {opacity:1}], {duration:180, easing:'ease-out'});
      fade.playbackRate = clock.rate;
    }
    items[i] = data;
    panel.dataset.layer = layer;
    panel.classList.remove('no-frame', 'has-basemap');
    baseJobs.delete(panel);
    const empty = layer === 'track' && !data.storms?.length;
    msg.className = empty ? 'map-message show' : 'map-message';
    msg.textContent = empty ? '此时次没有已发布的台风路径' : '';
    describe(panel, layer, data);
  }
  function fillJoiningPanels() {
    joining?.abort();
    const group = {controller:new AbortController(), requests:new Map()};
    joining = group.controller;
    const time = shownTime;
    panels.forEach(async (panel, i) => {
      const layer = layers[i];
      if (items[i] || time === null || (!c && !cachedResource(frameUrl(layer, time))?.ready)) return;
      const current = () => !group.controller.signal.aborted && ctx.active && panels[i] === panel &&
        shownTime === time && layers[i] === layer && !items[i];
      try {
        const data = await dataFor(layer, time, group);
        await prepareMapData(data, {zonal:layer === 'zonal'});
        if (!current()) return;
        // The other canvas belongs to the upcoming synchronized frame.
        const canvas = $('canvas.current', panel);
        baseJobs.delete(panel);
        if (await drawMap(canvas, data, mapOptions(i)) && current()) {
          publishPanel(i, layer, {status:'fulfilled', value:data}, canvas, false);
          updateRead();
        }
      } catch { /* The next playback frame handles unavailable layers. */ }
    });
  }
  function yieldToPaint() {
    // Let the real field reach the screen before the full-resolution overlays
    // or the next animation frame occupy the renderer. Hidden windows can settle too.
    return new Promise(resolve => {
      const raf = requestAnimationFrame(() => { clearTimeout(fallback); setTimeout(resolve, 0); });
      const fallback = setTimeout(() => { cancelAnimationFrame(raf); resolve(); }, 100);
    });
  }
  function markReading(root,time){
    markEventTime(c,root,time);
    const rev=++selectedReading,xy=cursor;
    if(!xy||!c.atlas.columnVersion)return;
    const el=root.querySelector('.atmosphere-reading');if(!el)return;
    const q=new URLSearchParams({id:c.id,time:new Date(time).toISOString(),lon:xy[0],lat:xy[1]});
    el.textContent=validText(time)+' · 正在读取选点气象场…';
    resource('/local/disaster-point?'+q).then(p=>{
      if(ctx.active&&el.isConnected&&rev===selectedReading&&Date.parse(p.valid)===time)
        el.textContent=atmosphere(p.reading,time,fmtNum(p.lon,2)+'°E、'+fmtNum(p.lat,2)+'°N',true);
    }).catch(()=>{if(ctx.active&&el.isConnected&&rev===selectedReading)el.textContent=validText(time)+' · 此处缺少可用的选点气象场。';});
  }
  function displayTime(time) {
    profileButton.disabled=!Number.isFinite(time)||time%HOUR!==0;
    profileButton.title=profileButton.disabled?'该观测图为非整点时次，可切至整点图查看对应廓线':'查看选点的气温、湿球温度与雨雪层结';
    if (shownTime !== time) {
      frameTime.textContent = frameLabel(time) + ' · 北京时间';
      if(c?.atlas)markReading(main,time);
    }
    if (!c && !observing && run) {
      const f = forecastFrame(run, time);
      const category = modelFrameType(f.run, time);
      modelMeta.textContent =
        category +
        ' · 起报 ' +
        validText(f.run) +
        ' 北京时（' +
        f.run.slice(5, 10).replace('-', '/') + ' ' + f.run.slice(11, 13) +
        ' UTC） · 时效 +' +
        f.lead +
        ' h';
    }
    if (observing) profileButton.disabled = true;
    shownTime = time;
    readChartPressure(time);
    if (time === frames[index]) clearSeekStatus();
  }
  async function refresh(target = index, { animate = false, hold, preview } = {}) {
    if (!ctx.active || !frames.length) return;
    if (!preview) discardScrub();
    const rev = ++revision, time = frames[target], choices = visibleLayers();
    frameLoad?.abort();
    const group = {controller: new AbortController(), requests: new Map()};
    frameLoad = group.controller;
    const current = () => ctx.active && rev === revision;
    showPending(choices, '读取图层…');
    const buffers = panels.map(panel => $('canvas:not(.current)', panel));
    const reads = animate ? playbackFields.plan(choices, time, frames[(target + 1) % frames.length]) : null;
    // Opening or changing layers at one valid time can publish independently.
    // A time change still swaps all the staging canvases together.
    const independent = !animate && !preview && (shownTime === null || shownTime === time) &&
      panels.some((panel,i) => panel.dataset.layer !== choices[i]);
    async function stage(result, i, quick, buffer = buffers[i], firstLook = false) {
      if (result.status === 'fulfilled') {
        baseJobs.delete(panels[i]);
        try { await drawMap(buffer, result.value, { ...mapOptions(i), quick, firstLook }); }
        catch (reason) { return {status:'rejected', reason}; }
      }
      return result;
    }
    const results = await Promise.all(choices.map(async (layer, i) => {
      let result;
      try {
        result = reads ? await reads[i] : {status:'fulfilled', value:await dataFor(layer, time, group)};
        if (animate && current() && result.status === 'fulfilled')
          await prepareMapData(result.value, {zonal:layer === 'zonal'});
      } catch (reason) { result = {status:'rejected', reason}; }
      if (independent && current()) {
        for (const fade of $('canvas.current', panels[i]).getAnimations()) fade.cancel();
        const firstField = !items[i] && result.status === 'fulfilled' && result.value.values && layer !== 'zonal';
        let version;
        do {
          version = viewRevision;
          result = await stage(result, i, firstField, buffers[i], firstField);
        } while (current() && version !== viewRevision);
        if (current()) {
          publishPanel(i, layer, result, buffers[i], false);
          if (result.status === 'fulfilled') { displayTime(time); updateRead(); }
          if (firstField && result.status === 'fulfilled') {
            await yieldToPaint();
            if (!current()) return result;
            const detailed = $('canvas:not(.current)', panels[i]);
            do {
              version = viewRevision;
              result = await stage(result, i, false, detailed);
            } while (current() && version !== viewRevision);
            if (current()) publishPanel(i, layer, result, detailed, false);
          }
        }
      }
      return result;
    }));
    if (frameLoad === group.controller) frameLoad = null;
    if (!current()) return;
    // A fast intermediate preview may paint with its own timestamp while the
    // thumb keeps moving. Late network replies and obsolete failures stay off screen.
    if (preview && target !== index &&
        (performance.now() - preview.started > 120 || results.some(r => r.status === 'rejected'))) return;
    let quick = false;
    if (!independent) {
      // The previous canvas is visible beneath a crossfade until it finishes.
      const fades = panels.flatMap(panel => $('canvas.current', panel).getAnimations());
      if (animate && hold && fades.length) {
        await Promise.race([hold, Promise.all(fades.map(fade => fade.finished.catch(() => {})))]);
        if (!current()) return;
      }
      for (const fade of fades) fade.cancel();
      let version;
      do {
        version = viewRevision;
        quick = Boolean(preview && !preview.detail);
        await Promise.all(results.map(async (result, i) => { results[i] = await stage(result, i, quick); }));
        if (!current()) return;
        if (hold) {
          await hold;
          hold = null;
          if (!current()) return;
        }
      } while (version !== viewRevision || (quick && preview.detail));
      joining?.abort();
      results.forEach((result,i) => publishPanel(i, choices[i], result, buffers[i], animate));
    }
    quickVisible = quick;
    if (!preview) {
      index = target;
      controls(index);
    }
    const canZoom = panels.some((panel, i) => !items[i]?.externalImage && layers[i] !== 'zonal');
    for (const btn of $$('.zoom button', main)) btn.disabled = !canZoom;
    displayTime(time);
    updateRead();
    if (!c) renderReading();
    return results.some(result => result.status === 'fulfilled');
  }
  async function refreshView() {
    if (!frames.length) {
      if (observing) {
        showPending(visibleLayers(), '读取观测时次…');
        if (observationError) {
          for (const p of panels) {
            const msg = $('.map-message', p);
            msg.className = 'map-message show';
            msg.innerHTML =
              '<span>' + escape(observationError.message) + '</span><button class="btn">重试</button>';
            $('button', msg).onclick = () => void setMode(true);
          }
        }
        return;
      }
      showPending(visibleLayers(), '读取预报时次…');
      if (cycleError) {
        const message = $('.map-message', panels[0]);
        message.className = 'map-message show';
        message.innerHTML = '<span>' + escape(cycleError.message) + '</span><button class="btn retry">重试</button><a href="#/cases" class="btn">打开离线案例</a>';
        $('.retry', message).onclick = () => location.reload();
      }
      return;
    }
    const resume = playing || autoStart, seq = ++playSession;
    resetPlayback();
    const hasData = await refresh();
    if (!ctx.active || seq !== playSession || hasData === undefined) return;
    if (resume && (playing || (autoStart && hasData))) void startPlayback(clock.wait());
    else if (!hasData) stop();
  }
  function resetPlayback() {
    activeStep = null;
    playbackFields.clear();
    joining?.abort();
    clock.cancel();
    clearSeekStatus();
  }
  function stop() {
    if (playing) {
      revision++;
      frameLoad?.abort();
      for (const panel of panels)
        for (const fade of $('canvas.current', panel).getAnimations()) fade.cancel();
    }
    resetPlayback();
    autoStart = false;
    playing = false;
    playSession++;
    if (!ctx.active) return;
    const btn = $('#play');
    btn.innerHTML = icon('play', 17);
    btn.setAttribute('aria-label', '播放时间轴');
    btn.setAttribute('aria-pressed', 'false');
  }
  async function startPlayback(hold = null) {
    discardScrub();
    clearSeekStatus();
    if (frames.length < 2) { stop(); return; }
    playing = true;
    autoStart = false;
    const seq = ++playSession, btn = $('#play');
    btn.innerHTML = icon('pause', 17);
    btn.setAttribute('aria-label', '暂停时间轴');
    btn.setAttribute('aria-pressed', 'true');
    let missing = 0;
    while (ctx.active && playing && seq === playSession) {
      const next = (index + 1) % frames.length;
      const step = {hold};
      activeStep = step;
      // Show buffering only after the frame was due. The displayed time and
      // all published plots continue to describe the last verified frame.
      void Promise.resolve(hold).then(() => {
        if (activeStep !== step) return;
        loadingTimer = setTimeout(() => {
          if (activeStep !== step || !ctx.active) return;
          grid.setAttribute('aria-busy', 'true');
          frameTime.setAttribute('data-buffering', '');
        }, 250);
      });
      const hasData = await refresh(next, { animate: true, hold });
      if (!ctx.active || !playing || seq !== playSession) break;
      missing = hasData === false ? missing + 1 : 0;
      if (missing >= Math.min(3, frames.length)) { stop(); break; }
      hold = clock.wait();
    }
  }
  function cancelScrubJob() {
    if (scrubJob) {
      frameLoad?.abort();
      scrubJob = null;
      revision++;
    }
  }
  function discardScrub() {
    cancelAnimationFrame(scrubFrame);
    clearTimeout(settleTimer);
    scrubFrame = settleTimer = 0;
    scrubQueued = false;
    cancelScrubJob();
  }
  function scheduleScrub() {
    if (!scrubFrame && ctx.active) scrubFrame = requestAnimationFrame(paintScrub);
  }
  function paintScrub(now) {
    scrubFrame = 0;
    if (!ctx.active || !scrubQueued) return;
    if (now < nextPreviewAt) { scheduleScrub(); return; }
    if (scrubJob && scrubJob.target !== index &&
        !visibleLayers().every(layer => cachedResource(frameUrl(layer, frames[index]))?.ready)) {
      // The outstanding read will schedule the latest selection on completion.
      return;
    }
    startScrubJob(false);
  }
  function startScrubJob(detail) {
    scrubQueued = false;
    if (scrubJob?.target === index) {
      if (detail) scrubJob.detail = true;
      return;
    }
    cancelScrubJob();
    const started = performance.now();
    if (!detail) nextPreviewAt = started + 32;
    const job = { target: index, started, detail };
    scrubJob = job;
    void refresh(index, { preview: job }).finally(() => {
      if (scrubJob !== job) return;
      scrubJob = null;
      if (scrubQueued) scheduleScrub();
    });
  }
  function finishScrub() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    if (!ctx.active) return;
    if (scrubQueued) startScrubJob(true);
    else if (scrubJob) scrubJob.detail = true;
    else if (quickVisible) repaint();
  }
  function seek(target, coalesce) {
    if (timePinned && !playing && target === index) {
      controls(index);
      return;
    }
    if (playing || autoStart || !timePinned) stop();
    timePinned = true;
    modeRevision++;
    index = target;
    controls(target);
    noteSeek();
    if (!coalesce) { void refresh(); return; }
    if (!scrubJob) revision++;
    scrubQueued = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(finishScrub, 100);
    scheduleScrub();
  }
  function pauseAtCurrent() {
    timePinned = true;
    modeRevision++;
    stop();
    if (panels.some(panel => !panel.dataset.layer && !$('.map-retry', panel))) void refresh();
  }
  $('#play').onclick = () => {
    if (playing) { pauseAtCurrent(); return; }
    timePinned = false;
    modeRevision++;
    void startPlayback();
  };
  const track = slider.parentElement;
  track.onpointermove = (e) => {
    if (e.buttons || e.pointerType === 'touch') return;
    const bounds = ruler.getBoundingClientRect();
    if (!bounds.width) return;
    const position = (e.clientX - bounds.left) / bounds.width * stops.at(-1);
    hoverFrame = nearestFrame(stops, position);
    previewAt(hoverFrame);
  };
  track.onpointerleave = () => { hoverFrame = null; previewAt(index); };
  slider.onpointerdown = (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    scrubPointer = event.pointerId;
    hoverFrame = null;
    previewAt(index);
    pauseAtCurrent();
  };
  const finishPointer = (event) => {
    if (event.pointerId !== scrubPointer) return;
    scrubPointer = null;
    finishScrub();
  };
  window.addEventListener('pointerup', finishPointer, { capture: true, signal: ctx.signal });
  window.addEventListener('pointercancel', finishPointer, { capture: true, signal: ctx.signal });
  slider.onkeydown = (e) => {
    const page = Math.max(1, Math.round((frames.length - 1) / 10));
    const targets = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1,
      Home: 0, End: frames.length - 1, PageDown: index - page, PageUp: index + page };
    if (!Object.hasOwn(targets, e.key)) return;
    e.preventDefault();
    hoverFrame = null;
    seek(Math.max(0, Math.min(frames.length - 1, targets[e.key])), true);
  };
  slider.oninput = () => seek(nearestFrame(stops, Number(slider.value)), true);
  slider.onchange = slider.onkeyup = finishScrub;
  $('#prev-frame').onclick = () => seek(Math.max(0, index - 1));
  $('#next-frame').onclick = () => seek(Math.min(frames.length - 1, index + 1));

  const zoom = (factor) => {
    const cx = (bbox[0] + bbox[2]) / 2,
      cy = (bbox[1] + bbox[3]) / 2,
      hw = ((bbox[2] - bbox[0]) * factor) / 2,
      hh = ((bbox[3] - bbox[1]) * factor) / 2;
    if (hw < 1 || hw > 180) return;
    bbox = clampView([cx - hw, cy - hh, cx + hw, cy + hh]);
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
    if(c?.atlas&&shownTime!==null)markReading(main,shownTime);
    readChartPressure(shownTime);
    const reload = (!c||c.atlas) && visibleLayers().some((id, i) => {
      if (Object.hasOwn(automaticLayers, id)) return true;
      if (c) return false;
      const grid = items[i];
      if (!grid?.values) return false;
      const value = sample(grid, ...(cursor || point));
      return grid.backupSource || grid.pointStatus === 'missing' || (value && value.value === null && !value.belowGround);
    });
    if (reload) {playbackFields.clear();void refreshView();}
    else { repaint(); renderReading(); }
  }
  $('.guide-switch').onclick = (e) => {
    showGuide = !showGuide;
    e.currentTarget.setAttribute('aria-pressed', String(showGuide));
    $('.switch').classList.toggle('on', showGuide);
    repaint();
    renderReading();
  };
  let drag = null;
  function targetMap(target) {
    const body = target.closest('.map-body');
    if (!body || target.closest('button, .map-message')) return null;
    const i = panels.indexOf(body.closest('.map-panel'));
    if (i < 0 || items[i]?.externalImage) return null;
    return { body, i };
  }
  grid.onpointerdown = (e) => {
    const target = targetMap(e.target);
    if (!target || e.button !== 0 || !e.isPrimary) return;
    drag = { ...target, x: e.clientX, y: e.clientY, box: bbox.slice(), id: e.pointerId, moved: false };
    target.body.setPointerCapture(e.pointerId);
  };
  grid.onpointermove = (e) => {
    if (!drag || drag.id !== e.pointerId || layers[drag.i] === 'zonal') return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) < 4 && !drag.moved) return;
    drag.moved = true;
    const r = drag.body.getBoundingClientRect(), view = extentFor(drag.body, drag.box);
    bbox = panView(drag.box, -dx * (view[2] - view[0]) / r.width, dy * (view[3] - view[1]) / r.height);
    repaint();
  };
  grid.onpointerup = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved) {
      cursor = geoFromPointer(drag.body, e, bbox);
      if (layers[drag.i] === 'zonal') {
        const rect = drag.body.getBoundingClientRect();
        const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left - 30) / Math.max(1, rect.width - 58)));
        cursor = [(bbox[0] + bbox[2]) / 2, 90 - 180 * fraction];
      }
      readPoint();
    }
    drag = null;
  };
  grid.onlostpointercapture = grid.onpointercancel = () => { drag = null; };
  grid.onkeydown = (e) => {
    const target = targetMap(e.target);
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!target || !move) return;
    e.preventDefault();
    const view = extentFor(target.body, bbox);
    if (e.shiftKey) {
      if (layers[target.i] === 'zonal') return;
      bbox = panView(bbox, move[0] * (view[2] - view[0]) / 8, move[1] * (view[3] - view[1]) / 8);
      repaint();
      return;
    }
    cursor ||= [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
    const step = items[target.i]?.step || 1;
    if (layers[target.i] === 'zonal') {
      cursor[1] = Math.max(-90, Math.min(90, cursor[1] + (move[1] - move[0]) * step));
    } else {
      cursor = [
        Math.max(view[0], Math.min(view[2], cursor[0] + move[0] * step)),
        Math.max(view[1], Math.min(view[3], cursor[1] + move[1] * step)),
      ];
    }
    readPoint();
  };

  if (!c) {
    showPending(visibleLayers(), '读取预报时次…');
    const outcome = await cycle;
    if (!ctx.active) return;
    if (outcome.error) {
      cycleError = outcome.error;
      if (!observing) { await refreshView(); renderReading(); }
      return;
    }
    run = outcome.value.run;
    forecastFrames = forecastTimes(run);
    if (!observing) {
      frames = forecastFrames;
      index = nearestFrame(frames, Number.isFinite(requestedTime) ? requestedTime : Date.now());
      updateTicks();
    }
    if (observing) return;
  }
  const evidenceParam = params.get('evidence');
  const initialFrame =
    lesson && evidenceParam !== null && /^\d+$/.test(evidenceParam) && lesson.steps[Number(evidenceParam)]
      ? applyEvidence(Number(evidenceParam))
      : refreshView();
  if (c?.id === 'bohai') {
    localArchive = await resource('/assets/cases/' + c.id + '/local.json');
    if (!ctx.active) return;
  }
  await initialFrame;
  if (c && ctx.active) renderReading();
}
