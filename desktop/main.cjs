'use strict';
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  net,
  Tray,
  nativeTheme,
  ipcMain,
} = require('electron');
const { configureTransport } = require('../server/network.cjs');
const path = require('node:path');
const { startServer } = require('../server/http.cjs');
app.setName('观象');
app.setAppUserModelId('org.guanxiang.weather');
const { preferences } = require('./preferences.cjs');
const { migrateLocationOnce } = require('./legacy-location.cjs');
const { locateWindows } = require('./windows-location.cjs');
const { TrayMenu } = require('./tray-menu.cjs');
const contract = require('./window-shell.json');
const qaIndex = process.argv.indexOf('--qa-data');
const qaPath = qaIndex < 0 ? process.env.GUANXIANG_PROFILE : process.argv[qaIndex + 1];
if (qaIndex >= 0 && (!qaPath || !path.isAbsolute(qaPath)))
  throw new Error('QA 资料必须使用绝对路径');
app.setPath('userData', qaPath ? path.resolve(qaPath) : path.join(app.getPath('appData'), '观象'));
const requestExit = process.argv.includes('--request-exit');
let window,
  service,
  settings,
  tray,
  trayMenu,
  quitting = false,
  confirming = false;
const iconFile = app.isPackaged
  ? path.join(process.resourcesPath, `app-icon-${app.getVersion()}.ico`)
  : path.join(__dirname, '../assets/icon.ico');
function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#16181b' : '#f4f4f0',
    symbolColor: dark ? '#f2efea' : '#46332a',
    height: contract.titlebar.height,
  };
}
function restore() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
async function enterTray() {
  if (!tray) {
    window.minimize();
    return;
  }
  if (confirming) return;
  confirming = true;
  try {
    if (!settings.get().trayNotice) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'info',
        title: '进入托盘',
        message: '观象将在系统托盘继续运行。',
        detail: '点击托盘图标可以打开窗口，在托盘菜单中可以退出。',
        buttons: ['进入托盘', '取消'],
        cancelId: 1,
        defaultId: 0,
      });
      if (response !== 0 || quitting) return;
      settings.set({ trayNotice: true });
    }
    window.hide();
  } finally {
    confirming = false;
  }
}
function createTray() {
  try {
    tray = new Tray(iconFile);
    tray.setToolTip('MeteoDial · 观象');
    trayMenu = new TrayMenu({
      restoreFocus: () => tray?.focus(),
      reportError: (e) => dialog.showErrorBox('托盘菜单', e.message),
      items: [
        { id: 'open', icon: 'app-window', label: '打开观象', click: restore },
        {},
        { id: 'exit', icon: 'power', label: '退出应用', click: () => app.quit() },
      ],
    });
    tray.on('click', restore);
    tray.on('double-click', restore);
    tray.on(
      'right-click',
      (_e, bounds) =>
        void trayMenu.popup(bounds).catch((e) => dialog.showErrorBox('托盘菜单', e.message)),
    );
  } catch {
    trayMenu?.dispose();
    trayMenu = null;
    tray?.destroy();
    tray = null;
  }
}
function handle(channel, action) {
  ipcMain.handle('guanxiang:' + channel, (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== service.url
    )
      throw new Error('窗口身份无效');
    return action(...args);
  });
}
const allowed = [
  'met.no',
  'noaa.gov',
  'data.jma.go.jp',
  'jma.go.jp',
  'hko.gov.hk',
  'weather.gov.hk',
  'data.gov.hk',
  'weather.com.cn',
  'cma.gov.cn',
  'nmc.cn',
  'earthdata.nasa.gov',
  'github.com',
  'naturalearthdata.com',
  'ourairports.com',
  'tcdata.typhoon.org.cn',
  'aviationweather.gov',
  'q-weather.info',
  'data.cma.cn',
  'wis2node.wis.cma.cn',
  'weather.cma.cn',
  'ncc-cma.net',
  'mee.gov.cn',
  'mem.gov.cn',
  'beijing.gov.cn',
  'mzj.panjin.gov.cn',
  'cgs.gov.cn',
  'xinhuanet.com',
  'www.cnfin.com',
  'ndrcc.org.cn',
  'weatherbench2.readthedocs.io',
  'ecmwf.int',
  'creativecommons.org',
  'noaa-gfs-bdp-pds.s3.amazonaws.com',
  'data.gov.tw',
  'data.gov.mo',
  'www.geonames.org',
];
allowed.push('cwa.gov.tw', 'weihai.gov.cn', 'geonames.org');
function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 830,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d20' : '#fffcf6',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    title: 'MeteoDial',
    icon: iconFile,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (
        u.protocol === 'https:' &&
        allowed.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))
      )
        void shell.openExternal(u.href);
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(service.url + '/')) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) =>
    respond(false),
  );
  window.on('page-title-updated', (e) => e.preventDefault());
  window.on('close', (e) => {
    if (quitting) return;
    if (settings.get().closeBehavior === 'quit') {
      e.preventDefault();
      setImmediate(() => app.quit());
      return;
    }
    e.preventDefault();
    void enterTray().catch((error) => dialog.showErrorBox('无法隐藏窗口', error.message));
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    window = null;
  });
  void window.loadURL(service.url + '/');
}
if (!app.requestSingleInstanceLock({ requestExit, executable: process.execPath }) || requestExit)
  app.quit();
else {
  app.on('second-instance', (_event, _argv, _cwd, extra) => {
    if (extra?.requestExit) {
      if (extra.executable === process.execPath) app.quit();
      return;
    }
    restore();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      configureTransport((url, init) => net.fetch(url, init));
      service = await startServer(path.join(app.getPath('userData'), 'weather-cache'), 0, {
        upstream: process.env.GUANXIANG_DATA_SERVICE,
      });
      settings = preferences(app.getPath('userData'));
      await migrateLocationOnce(app.getPath('userData'), settings);
      nativeTheme.themeSource = settings.get().theme;
      handle('read', () => ({ ...settings.get(), version: app.getVersion() }));
      handle('save', (patch) => {
        const updated = settings.set(patch);
        nativeTheme.themeSource = updated.theme;
        return updated;
      });
      handle('quit', () => app.quit());
      handle('locate', locateWindows);
      handle('hide', enterTray);
      nativeTheme.on('updated', () => {
        if (window && !window.isDestroyed()) window.setTitleBarOverlay(overlay());
      });
      createWindow();
      createTray();
    })
    .catch((err) => {
      dialog.showErrorBox('观象无法启动', err.message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    trayMenu?.dispose();
    tray?.destroy();
    service?.close();
  });
}
