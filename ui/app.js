import { prefs, save, showSettings, migrateLocation } from './shell.js';
import {
  get,
  $,
  $$,
  icon,
  escape,
  dateText,
  clockTime,
  context,
  openDialog,
  closeButton,
  safeLink,
} from './base.js';
import { showForecast } from './forecast.js';
import { showMaps, showCases } from './viewer.js';
const main = $('#content');
const nav = [
  ['weather', 'forecast', '本地天气'],
  ['maps', 'layers', '天气图'],
  ['cases', 'book', '天气案例'],
];
$('#nav').innerHTML = nav
  .map(
    ([key, img, label]) =>
      `<a href="#/${key}" class="nav-row" title="${label}" aria-label="${label}" data-nav="${key}">${icon(img, 18)}<span>${label}</span></a>`,
  )
  .join('');
$('#search').insertAdjacentHTML('afterbegin', icon('search', 16));
$('#sources').insertAdjacentHTML('afterbegin', icon('db', 17));
const [places, catalog] = await Promise.all([
  get('/assets/data/places.json'),
  get('/assets/data/catalog.json'),
]);
const byId = new Map(places.map((p) => [p[0], p]));
await migrateLocation(byId);
let place = byId.get(prefs.place) || byId.get('371002'),
  ctx;
let recent = prefs.recent.filter((id) => byId.has(id)).slice(0, 5);
function selectPlace(id) {
  if (!byId.has(id)) return;
  place = byId.get(id);
  recent = [...new Set([id, ...recent])].slice(0, 5);
  void save({ place: id, recent }).catch(() => {});
  if (location.hash === '#/weather') route();
  else location.hash = '/weather';
}
function searchDialog() {
  openDialog(
    `<div class="modal-head"><h2>选择地点</h2>${closeButton()}</div><div class="search-input">${icon('search', 19)}<input id="place-query" autocomplete="off" aria-label="搜索城市、区县或拼音" placeholder="输入城市、区县或拼音"></div><div class="results" id="results" role="listbox" aria-label="地点结果"></div>`,
    (d) => {
      const q = $('#place-query'),
        res = $('#results');
      let list = [],
        selected = 0;
      function update() {
        const term = q.value.trim().replace(/\s/g, '').toLowerCase();
        list = term
          ? places
              .map((p) => {
                const name = p[1],
                  short = name.replace(/(自治县|自治旗|特别行政区|新区|区|市|县|旗)$/, '');
                const score =
                  name === term || short === term
                    ? 100
                    : p[6] === term
                      ? 95
                      : name.startsWith(term)
                        ? 90
                        : p[6].startsWith(term)
                          ? 74
                          : p[3] === term
                            ? 70
                            : (p[2] + p[3] + name + (p[8] || '')).toLowerCase().includes(term)
                              ? 50
                              : 0;
                return [score, p];
              })
              .filter((a) => a[0])
              .sort((a, b) => b[0] - a[0] || a[1][7] - b[1][7])
              .slice(0, 65)
              .map((a) => a[1])
          : [
              ...new Set([
                place[0],
                ...recent,
                '110101',
                '310115',
                '440106',
                '510104',
                '320102',
                '420106',
                '650102',
              ]),
            ]
              .map((id) => byId.get(id))
              .filter(Boolean);
        selected = 0;
        paint();
      }
      function paint() {
        res.innerHTML = list.length
          ? list
              .map(
                (p, i) =>
                  `<button role="option" id="place-option-${i}" aria-selected="${i === selected}" data-i="${i}">${icon('pin', 16)}<b>${escape(p[1])}</b><span>${escape(p[2] + ' · ' + p[3])}</span></button>`,
              )
              .join('')
          : '<p class="muted search-empty">没有找到该地点，请试试上级城市或名称中的几个字。</p>';
        if (list.length) q.setAttribute('aria-activedescendant', 'place-option-' + selected);
      }
      function choose(i) {
        if (!list[i]) return;
        d.close();
        selectPlace(list[i][0]);
      }
      q.oninput = update;
      q.onkeydown = (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          selected = Math.max(
            0,
            Math.min(list.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)),
          );
          paint();
          res.children[selected]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          choose(selected);
        }
      };
      res.onclick = (e) => {
        const el = e.target.closest('[data-i]');
        if (el) choose(Number(el.dataset.i));
      };
      update();
      q.focus();
    },
  );
}
$('#search').onclick = searchDialog;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchDialog();
  }
});
$('#dialog').addEventListener('click', (e) => {
  if (e.target.closest('.dialog-close') || e.target === $('#dialog')) $('#dialog').close();
});
$('#sources').onclick = () =>
  openDialog(`<div class="modal-head"><h2>数据来源</h2>${closeButton()}</div><dl class="source-list">
<dt>区县预报</dt><dd>MET Norway Locationforecast，卫星与地面观测同化后的格点预报。区县名称对应代表点，逐日范围由源时间序列汇总。${safeLink('https://docs.api.met.no/doc/locationforecast/datamodel.html', '数据说明')} ${safeLink('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}</dd>
<dt>地面观测</dt><dd>显示距地点 100 公里内有近期站报的航空气象站，注明站号、距离与观测时间。${safeLink('https://aviationweather.gov/data/api/', 'NOAA Aviation Weather Center')}</dd>
<dt>高空与地面图</dt><dd>NOAA GFS 原始 GRIB2。等值线、箭头和颜色由观象绘制。${safeLink('https://www.noaa.gov/information-technology/open-data-dissemination', 'NOAA 开放资料')}</dd>
<dt>卫星观测</dt><dd>近期红外云图来自日本气象厅葵花卫星。案例云图取自 NASA GIBS 的 MODIS Terra 真彩色日合成，并叠加地理标注。${safeLink('https://www.data.jma.go.jp/mscweb/en/general/note.html', '日本气象厅使用说明')} ${safeLink('https://www.earthdata.nasa.gov/data/tools/gibs', 'NASA GIBS')}</dd>
<dt>台风与气候</dt><dd>近期路径由香港天文台发布，历史最佳路径取自日本气象厅 RSMC Tokyo。气候平均采用 NOAA PSL 的 NCEP/NCAR 1991—2020 常年值。${safeLink('https://data.gov.hk/sc-data/dataset/hk-hko-rss-tc-track-info', '香港天文台')} ${safeLink('https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.derived.html', 'NOAA PSL')}</dd>
<dt>区域雷达</dt><dd>CWA 雷达整合回波图覆盖台湾及邻近海域。保留原图地理范围、时次与回波图例，每十分钟的回放取自原机构图像目录。${safeLink('https://www.cwa.gov.tw/V8/C/W/OBS_Radar.html', '雷达实况')} ${safeLink('https://data.gov.tw/dataset/75125', '开放资料说明')}</dd>
<dt>地理资料</dt><dd>地点来自 AreaCity 区划索引及公开行政区地理资料，地理底图采用 Natural Earth，航空站位置来自 OurAirports。${safeLink('https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov', 'AreaCity')} ${safeLink('https://www.naturalearthdata.com/about/terms-of-use/', 'Natural Earth')}</dd></dl>`);
function tick() {
  $('#clock').innerHTML = icon('time', 14) + clockTime(Date.now()) + ' <span>北京时间</span>';
}
tick();
setInterval(tick, 30000);
function route() {
  ctx?.close();
  ctx = context();
  const own = ctx;
  const [fragment, raw = ''] = location.hash.slice(1).split('?'),
    parts = fragment.split('/').filter(Boolean);
  const key = parts[0] === 'settings' || nav.some((n) => n[0] === parts[0]) ? parts[0] : 'weather',
    params = new URLSearchParams(raw),
    label = nav.find((n) => n[0] === key)?.[2] || '设置';
  const c = catalog.find((entry) => entry.id === parts[1]);
  $$('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === key);
    a.setAttribute('aria-current', a.dataset.nav === key ? 'page' : 'false');
  });
  const settingsNav = $('#settings-nav');
  settingsNav.classList.toggle('active', key === 'settings');
  settingsNav.setAttribute('aria-current', key === 'settings' ? 'page' : 'false');
  $('#breadcrumb').innerHTML =
    key === 'cases' && c
      ? '<a href="#/cases" title="返回天气案例" aria-label="返回天气案例">' +
        icon('left', 18) +
        '</a><h1>' +
        escape(c.title) +
        '</h1>'
      : '<h1>' + escape(label) + '</h1>';
  document.title = label + ' · MeteoDial';
  main.scrollTop = 0;
  const env = { main, ctx, place, catalog, params, search: searchDialog };
  const task =
    key === 'settings'
      ? showSettings(env)
      : key === 'weather'
        ? showForecast(env)
        : key === 'maps'
          ? showMaps(env, null)
          : c
            ? showMaps(env, c)
            : showCases(env);
  Promise.resolve(task).catch((error) => {
    if (own.active) {
      main.innerHTML =
        '<div class="empty"><h2>资料暂不可用</h2><p>' +
        escape(error.message) +
        '</p><button class="btn" id="route-retry">重新载入</button></div>';
      $('#route-retry').onclick = route;
    }
  });
}
window.addEventListener('hashchange', route);
route();
