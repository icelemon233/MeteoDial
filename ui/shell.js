import { $, icon, escape } from './base.js';
import { playbackRates } from '../shared/timeline.mjs';
const host = window.guanxiang;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const defaults = {
  theme: 'system',
  pinned: true,
  closeBehavior: 'tray',
  recent: [],
  place: '',
  playbackRate: 1,
  version: '0.9.0',
};
function saved(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export const prefs = Object.assign(
  {},
  defaults,
  host ? await host.read() : saved('guanxiang.settings', {}),
);
if (!playbackRates.includes(prefs.playbackRate)) prefs.playbackRate = defaults.playbackRate;
function saveErrorMessage(error) {
  // Electron IPC preserves the filesystem error in the message but drops its code property.
  const code = error?.code || error?.message?.match(/(?:^|:\s+)(E[A-Z]+):/)?.[1];
  if (code === 'ENOSPC' || code === 'EDQUOT' || error?.name === 'QuotaExceededError')
    return '无法保存偏好。请释放存储空间后重试。';
  if (['EACCES', 'EPERM', 'EBUSY', 'EROFS'].includes(code) || error?.name === 'SecurityError')
    return '无法保存偏好。请检查写入权限或文件占用后重试。';
  return '无法保存偏好。请稍后重试。';
}
export async function save(patch) {
  try {
    if (host) await host.save(patch);
    else localStorage.setItem('guanxiang.settings', JSON.stringify({ ...prefs, ...patch }));
    Object.assign(prefs, patch);
    const notice = document.querySelector('.pref-error');
    if (notice) {
      notice.textContent = '';
      notice.className = notice.id === 'announce' ? 'sr' : '';
    }
    apply();
  } catch (error) {
    const note = document.querySelector('#settings-error') || $('#announce');
    note.className = 'notice pref-error';
    note.textContent = saveErrorMessage(error);
    throw error;
  }
}
export async function migrateLocation(byId) {
  if (prefs.place) return;
  const place = saved('guanxiang.place', ''),
    recent = saved('guanxiang.recent', []);
  if (byId.has(place))
    await save({
      place,
      recent: Array.isArray(recent) ? recent.filter((id) => byId.has(id)).slice(0, 5) : [],
    }).catch(() => {});
}
function apply() {
  document.documentElement.dataset.theme =
    prefs.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.pinned = String(prefs.pinned);
  const pin = $('#pin');
  pin.innerHTML = icon(prefs.pinned ? 'unpin' : 'fix', 18);
  pin.title = prefs.pinned ? '取消固定侧栏' : '固定侧栏';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(prefs.pinned));
}
apply();
systemTheme.addEventListener('change', apply);
$('#pin').onclick = () => void save({ pinned: !prefs.pinned }).catch(() => {});
$('#settings-nav').insertAdjacentHTML('afterbegin', icon('settings', 18));
if (host) {
  const button = $('#tray');
  button.hidden = false;
  button.innerHTML = icon('tray', 18);
  button.onclick = () =>
    host.hide().catch((error) => {
      $('#announce').textContent = error.message;
    });
}
const pendingSettings = new Map();
let settingsQueue = Promise.resolve();

export function bindPreferenceSelect(select, key, { parse = String, onValue } = {}) {
  const reflect = (value) => {
    if (!select.isConnected) return;
    select.value = String(value);
    onValue?.(value);
  };
  const pending = pendingSettings.get(key);
  if (pending) pending.reflect = reflect;
  reflect(pending?.value ?? prefs[key]);
  select.onchange = () => {
    const change = { value: parse(select.value), reflect };
    pendingSettings.set(key, change);
    onValue?.(change.value);
    settingsQueue = settingsQueue.then(async () => {
      try {
        await save({ [key]: change.value });
      } catch {
        // save reports the error and retains the last persisted preference.
      }
      if (pendingSettings.get(key) === change) {
        pendingSettings.delete(key);
        if (prefs[key] !== change.value) change.reflect(prefs[key]);
      }
    });
  };
}

export function showSettings({ main }) {
  main.innerHTML =
    '<div class="settings-page"><section class="settings-card panel"><h2>外观与窗口</h2><label>主题<select id="theme-choice"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>' +
    (host
      ? '<label>关闭窗口时<select id="close-choice"><option value="tray">进入托盘</option><option value="quit">退出应用</option></select></label>'
      : '') +
    '<div id="settings-error" role="status"></div></section><section class="settings-card panel about"><img src="/assets/brand/app-icon-256.png" width="64" height="64" alt=""><div><h2>MeteoDial · 观象</h2><p>Cinna · ' +
    escape(prefs.version) +
    '</p></div></section>' +
    (host ? '<button class="btn" id="quit-app">退出应用</button>' : '') +
    '</div>';
  for (const [id, key] of [
    ['theme-choice', 'theme'],
    ['close-choice', 'closeBehavior'],
  ]) {
    const select = document.getElementById(id);
    if (select) bindPreferenceSelect(select, key);
  }
  if (host) $('#quit-app').onclick = () => host.quit();
}
