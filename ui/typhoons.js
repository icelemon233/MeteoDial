import { $, get, escape, fmtNum, validText, safeLink } from './base.js';
import { drawMap, clampView } from './cartography.js';
const jma = 'https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/besttrack.html';
export function bestTrack(s) {
  return {
    id: s.id,
    name: s.name || s.id,
    source: '日本气象厅 RSMC 东京',
    url: jma,
    forecasts: [],
    analyses: s.points.map(([h, lon, lat, grade, pressure, kt]) => ({
      time: new Date(h * 36e5).toISOString(),
      lon,
      lat,
      grade,
      pressure,
      wind: kt == null ? null : kt * 0.514444,
    })),
  };
}
export async function showTyphoons({ main, ctx }) {
  main.innerHTML =
    '<div class="page-head"><div class="seg storm-tabs" role="group" aria-label="路径资料"><button class="on" aria-pressed="true">当前与近期</button><button aria-pressed="false">历史最佳路径</button></div></div><div class="storm-filters"><select aria-label="台风年份" hidden></select><select aria-label="选择台风"></select><button class="btn">更新</button></div><p class="storm-status subtitle" role="status"></p><section class="panel storm-map"><canvas role="img" aria-label="台风分析与预报路径地图"></canvas><div class="storm-fix"></div></section><div class="storm-time"><label>定位时刻（北京时）<select aria-label="台风定位时刻"></select></label></div><div class="storm-details"></div>';
  const tabs = [...main.querySelectorAll('.storm-tabs button')],
    [year, choice] = main.querySelectorAll('.storm-filters select'),
    retry = $('.storm-filters button', main),
    status = $('.storm-status', main),
    fix = $('.storm-fix', main),
    canvas = $('canvas', main),
    time = $('.storm-time select', main),
    details = $('.storm-details', main);
  let archive = false,
    version = 0,
    selection = 0,
    storm = null,
    rows = [],
    list = null;
  function plot() {
    const p = storm?.analyses[Number(time.value)];
    if (!p) {
      fix.textContent = '';
      void drawMap(canvas, null, { bbox: [95, 2, 165, 52] });
      return;
    }
    const pts = [...storm.analyses, ...(storm.forecasts || [])];
    const xs = pts.map((p) => p.lon),
      ys = pts.map((p) => p.lat);
    let left = Math.min(...xs) - 5,
      right = Math.max(...xs) + 5;
    if (right - left > 180) {
      left = p.lon - 24;
      right = p.lon + 24;
    }
    const box = clampView([left, Math.min(...ys) - 4, right, Math.max(...ys) + 4]);
    void drawMap(canvas, { storms: [storm], valid: p.time }, { bbox: box, cities: true });
    fix.textContent = [
      storm.name,
      validText(p.time) + ' 北京时',
      fmtNum(Math.abs(p.lon), 1) +
        '°' +
        (p.lon < 0 ? 'W' : 'E') +
        ' ' +
        fmtNum(Math.abs(p.lat), 1) +
        '°' +
        (p.lat < 0 ? 'S' : 'N'),
      p.pressure != null ? p.pressure + ' hPa' : '',
      p.wind != null ? fmtNum(p.wind, 1) + ' m/s' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const preds = p === storm.analyses.at(-1) ? storm.forecasts || [] : [];
    details.innerHTML =
      '<p>' +
      escape(storm.source) +
      (archive ? ' · 事后最佳路径' : ' · 实线为机构定位') +
      (preds.length ? '，虚线为本次预报' : '') +
      '　' +
      safeLink(storm.url, '路径来源') +
      '</p>' +
      (preds.length
        ? '<table><thead><tr><th>预报有效时刻（北京时）</th><th>经度</th><th>纬度</th></tr></thead><tbody>' +
          preds
            .map(
              (v) =>
                '<tr><td>' +
                validText(v.time) +
                '</td><td>' +
                fmtNum(v.lon, 1) +
                '°</td><td>' +
                fmtNum(v.lat, 1) +
                '°</td></tr>',
            )
            .join('') +
          '</tbody></table>'
        : '');
  }
  function clear() {
    storm = null;
    time.replaceChildren();
    time.disabled = true;
    details.replaceChildren();
    plot();
  }
  async function select() {
    const seq = ++selection,
      ver = version;
    clear();
    if (!choice.value) return;
    try {
      const s = archive
        ? bestTrack(rows.find((s) => s.id === choice.value))
        : await get('/api/typhoon?id=' + encodeURIComponent(choice.value), ctx.signal);
      if (!ctx.active || seq !== selection || ver !== version) return;
      storm = s;
      time.replaceChildren(...s.analyses.map((p, i) => new Option(validText(p.time), String(i))));
      time.value = String(s.analyses.length - 1);
      time.disabled = false;
      plot();
    } catch (e) {
      if (ctx.active && seq === selection && ver === version)
        status.textContent = '这条路径读取失败。' + e.message;
    }
  }
  async function populate() {
    const ver = ++version;
    choice.replaceChildren();
    clear();
    status.textContent = '读取路径资料…';
    try {
      if (archive) {
        if (!year.length) {
          const meta = await get('/assets/data/typhoons/index.json', ctx.signal);
          if (!ctx.active || ver !== version) return;
          year.replaceChildren(...meta.years.map((y) => new Option(y + ' 年', String(y))));
        }
        const entries = await get('/assets/data/typhoons/' + year.value + '.json.gz', ctx.signal);
        if (!ctx.active || ver !== version) return;
        rows = entries;
        status.textContent = year.value + ' 年 · ' + rows.length + ' 条已归档路径';
      } else {
        list = await get('/api/typhoons', ctx.signal);
        if (!ctx.active || ver !== version) return;
        rows = list.items;
        const active = rows.filter((p) => p.active).length;
        status.textContent =
          list.source +
          ' · ' +
          validText(list.checked) +
          ' 北京时 · ' +
          (active ? active + ' 个气旋正在跟踪' : '当前无活动气旋') +
          (list.delayed ? ' · 最近一次成功更新' : '');
      }
      choice.replaceChildren(
        ...rows.map(
          (s) =>
            new Option(
              [archive ? s.id : s.number, s.name, archive ? '' : s.active ? '跟踪中' : '已停编']
                .filter(Boolean)
                .join(' · '),
              s.id,
            ),
        ),
      );
      if (!archive && rows.some((s) => s.active)) choice.value = rows.find((s) => s.active).id;
      await select();
    } catch (e) {
      if (ctx.active && ver === version)
        status.textContent = '资料暂时不可用。' + (archive ? e.message : '可切换历史最佳路径离线查看。');
    }
  }
  tabs.forEach(
    (btn, i) =>
      (btn.onclick = () => {
        archive = !!i;
        tabs.forEach((el, j) => {
          el.classList.toggle('on', i === j);
          el.setAttribute('aria-pressed', String(i === j));
        });
        year.hidden = !archive;
        retry.hidden = archive;
        void populate();
      }),
  );
  year.onchange = populate;
  choice.onchange = select;
  time.onchange = plot;
  retry.onclick = populate;
  const resize = new ResizeObserver(plot);
  resize.observe(canvas);
  ctx.onClose(() => resize.disconnect());
  await populate();
}
