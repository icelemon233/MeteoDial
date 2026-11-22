import { closeButton, escape, fmtNum, get, isoDay, openDialog, safeLink } from './base.js';
import { drawMap, geoFromPointer, legend, nationalView, sample } from './cartography.js';

export function showGaugeReference(caseInfo, time, ctx) {
  const date = isoDay(time),
    month = date.slice(0, 7);
  openDialog(
    '<div class="modal-head"><h2>雨量站日累计对照</h2>' +
      closeButton() +
      '</div>' +
      '<p>' +
      date +
      ' · NOAA CPC 陆地雨量站分析</p><div class="gauge-body"><canvas tabindex="0" role="group" aria-label="全国日累计降水，点击或用方向键读取格点"></canvas></div>' +
      '<div class="gauge-scale color-scale"></div><p class="gauge-reading" role="status">读取当日资料…</p>' +
      '<p class="muted">累计时段按源站观测日统计。原始格距 0.5°，图上按 1° 取样。</p>' +
      safeLink('https://www.psl.noaa.gov/data/gridded/data.cpc.globalprecip.html', 'CPC 资料说明'),
    (dialog) => {
      const canvas = dialog.querySelector('.gauge-body canvas'),
        reading = dialog.querySelector('.gauge-reading');
      const alive = () => ctx.active && canvas.isConnected && dialog.open;
      const abort = new AbortController();
      let observer;
      const clean = () => {
        abort.abort();
        observer?.disconnect();
      };
      dialog.addEventListener('close', clean, { once: true });
      ctx.signal.addEventListener('abort', clean, { once: true, signal: abort.signal });
      async function load() {
        const pack = await get('/assets/cases/gauge-days/' + month + '.json.gz', abort.signal);
        if (!alive()) return;
        const row = pack.days?.[Number(date.slice(8, 10))];
        if (pack.month !== month || typeof row !== 'string') throw Error('此资料日没有归档雨量');
        const bytes = Uint8Array.from(atob(row), (c) => c.charCodeAt(0));
        if (bytes.length !== 2 * pack.nx * pack.ny) throw Error('日雨量资料不完整');
        const view = new DataView(bytes.buffer),
          values = Array.from({ length: pack.nx * pack.ny }, (_, i) => {
            const v = view.getInt16(i * 2, true);
            return v === -32768 ? null : v / 10;
          });
        const grid = { layer: 'rainDay', nx: pack.nx, ny: pack.ny, bbox: pack.bbox, step: 1, values };
        const scale = legend('rainDay');
        dialog.querySelector('.gauge-scale').innerHTML =
          '<span>' +
          scale.low +
          '</span><i style="background:' +
          escape(scale.gradient) +
          '"></i><span>' +
          scale.high +
          ' mm</span>';
        let point = caseInfo.point,
          tag = caseInfo.tag;
        function paint() {
          if (!alive()) return;
          const cell = sample(grid, ...point);
          reading.textContent = cell
            ? cell.lon.toFixed(2) +
              '°E、' +
              cell.lat.toFixed(2) +
              '°N · ' +
              (cell.value == null ? '缺测' : fmtNum(cell.value, 1) + ' mm')
            : '选点超出资料范围';
          void drawMap(canvas, grid, { bbox: nationalView, point, tag, cities: true }).catch(() => {
            if (alive()) reading.textContent = '日雨量图暂时无法绘制';
          });
        }
        canvas.onclick = (e) => {
          point = geoFromPointer(canvas, e, nationalView);
          tag = '选点';
          paint();
        };
        canvas.onkeydown = (e) => {
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
          if (!d) return;
          e.preventDefault();
          point = [
            Math.max(grid.bbox[0], Math.min(grid.bbox[2], point[0] + d[0])),
            Math.max(grid.bbox[1], Math.min(grid.bbox[3], point[1] + d[1])),
          ];
          tag = '选点';
          paint();
        };
        observer = new ResizeObserver(paint);
        observer.observe(canvas.parentElement);
        paint();
      }
      void load().catch((e) => {
        if (alive()) reading.textContent = e.message;
      });
    },
  );
}
