import { $, get, openDialog, closeButton, validText, escape, safeLink, fmtNum } from './base.js';
import { drawMap, sample } from './cartography.js';
import { nearestFrame, frameStops } from '../shared/timeline.mjs';
export function showHenanClouds(ctx, initial) {
  openDialog(
    '<div class="modal-head"><h2>郑州暴雨 · 红外云图</h2>' +
      closeButton() +
      '</div><div class="cloud-observation"><canvas aria-label="河南及周边真实红外亮温"></canvas><p class="cloud-clock" aria-live="polite">正在读取观测…</p><div class="cloud-controls"><button class="btn" aria-label="播放红外云图">播放</button><input type="range" aria-label="红外观测时刻" disabled><select aria-label="红外云图播放速度">' +
      [0.5, 1, 2, 4]
        .map((v) => '<option' + (v === 1 ? ' selected' : '') + ' value="' + v + '">' + v + '×</option>')
        .join('') +
      '</select></div><p class="cloud-notes"></p></div>',
    (dialog) => {
      const body = $('.cloud-observation', dialog),
        canvas = $('canvas', body),
        clock = $('.cloud-clock', body),
        slider = $('input', body),
        play = $('button', body),
        speed = $('select', body);
      const controller = new AbortController();
      let rev = 0,
        playing = false,
        timeout = 0,
        index = 0,
        times = [],
        stops = [],
        meta = null,
        last = null;
      const cache = new Map(),
        xy = [113.66, 34.72];
      const active = () => ctx.active && dialog.open && body.isConnected && !controller.signal.aborted;
      function stop() {
        playing = false;
        clearTimeout(timeout);
        play.textContent = '播放';
        play.setAttribute('aria-label', '播放红外云图');
        play.setAttribute('aria-pressed', 'false');
      }
      const cleanup = () => {
        stop();
        controller.abort();
        resize.disconnect();
      };
      const resize = new ResizeObserver(() => {
        if (active() && last) void drawMap(canvas, last, { bbox: meta.bbox, point: xy, tag: '郑州' });
      });
      resize.observe(canvas);
      dialog.addEventListener('close', cleanup, { once: true });
      ctx.signal.addEventListener('abort', cleanup, { once: true });
      async function field(i) {
        if (cache.has(i)) return cache.get(i);
        const frame = meta.frames[i],
          r = await fetch('/assets/cases/henan-clouds/' + frame.file, { signal: controller.signal });
        if (!r.ok) throw Error('红外观测文件读取失败');
        const v = new Int16Array(await r.arrayBuffer());
        if (v.length !== meta.nx * meta.ny) throw Error('红外观测格点不完整');
        const grid = {
          layer: 'cloudTopTemperature',
          valid: frame.time,
          nx: meta.nx,
          ny: meta.ny,
          bbox: meta.bbox,
          step: meta.step,
          values: Array.from(v, (n) => (n === -32768 ? null : n / 10)),
        };
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(i, grid);
        return grid;
      }
      async function show(i) {
        const id = ++rev;
        index = i;
        slider.value = stops[i];
        slider.setAttribute('aria-valuetext', validText(times[i]) + ' 北京时');
        try {
          const g = await field(i);
          if (!active() || id !== rev) return;
          last = g;
          await drawMap(canvas, g, { bbox: meta.bbox, point: xy, tag: '郑州' });
          if (!active() || id !== rev) return;
          clock.textContent =
            validText(times[i]) + ' 北京时 · 郑州附近亮温 ' + fmtNum(sample(g, ...xy)?.value, 1) + ' ℃';
          if (playing)
            timeout = setTimeout(() => void show((index + 1) % times.length), 550 / Number(speed.value));
        } catch (e) {
          if (active() && id === rev) {
            stop();
            clock.textContent = e.message;
          }
        }
      }
      play.onclick = () => {
        if (!meta) return;
        if (playing) {
          stop();
          return;
        }
        playing = true;
        play.textContent = '暂停';
        play.setAttribute('aria-pressed', 'true');
        play.setAttribute('aria-label', '暂停红外云图');
        void show((index + 1) % times.length);
      };
      slider.onkeydown = (event) => {
        const lastIndex = times.length - 1;
        const page = Math.max(1, Math.round(lastIndex / 10));
        const targets = {
          ArrowLeft: index - 1,
          ArrowDown: index - 1,
          ArrowRight: index + 1,
          ArrowUp: index + 1,
          Home: 0,
          End: lastIndex,
          PageDown: index - page,
          PageUp: index + page,
        };
        if (!Object.hasOwn(targets, event.key) || lastIndex < 0) return;
        event.preventDefault();
        stop();
        void show(Math.max(0, Math.min(lastIndex, targets[event.key])));
      };
      slider.oninput = () => {
        stop();
        void show(nearestFrame(stops, Number(slider.value)));
      };
      get('/assets/cases/henan-clouds/index.json', controller.signal)
        .then((m) => {
          if (!active()) return;
          meta = m;
          times = m.frames.map((f) => Date.parse(f.time));
          stops = frameStops(times);
          slider.min = 0;
          slider.max = stops.at(-1);
          slider.step = 1;
          slider.disabled = false;
          $('.cloud-notes', body).innerHTML =
            escape(m.source) +
            ' · 浅色为较冷云顶。' +
            (m.gaps.length ? '归档缺少 ' + m.gaps.map(validText).join('、') + ' 北京时的观测。' : '') +
            ' ' +
            safeLink(m.sourceUrl, '原始观测归档');
          void show(nearestFrame(times, initial));
        })
        .catch((e) => {
          if (active()) clock.textContent = e.message;
        });
    },
  );
}
