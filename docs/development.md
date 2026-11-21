# Developing MeteoDial

The Electron main process starts the data service on a loopback port. The renderer, service and bundled case studies all work from the installed payload. Forecasts and current maps require a network connection. City selections and window preferences are stored in the local user profile.

| Command | Result |
|---|---|
| `npm ci` | Install the dependencies pinned in the lockfile |
| `npm start` | Start Electron and its local service |
| `npm test` | Check the data, archives, preferences and release identities |
| `npm run service` | Start just the web interface and data service |
| `npm run build:app` | Build an unpacked Windows x64 application |
| `npm run package` or `npm run dist` | Build the native installer in `installers/` |
| `node scripts/check-desktop.cjs` | Open an isolated desktop window and exercise search, forecasts and case playback |

`PORT` sets the standalone service port. `GUANXIANG_CACHE` sets its cache directory. `GUANXIANG_DATA_SERVICE` can point the desktop app to a shared HTTPS data service. The interface and bundled cases still load locally. When proxying to the service, use its listening loopback host and port as the upstream `Host`.

The packaging scripts accept `INNOSETUP_ISCC` for Inno Setup 7.1.0 and `CINNA_ZIG` for Zig 0.15.2. Set `GUANXIANG_TEST_EXE` to run the desktop check against a built executable. The existing `GUANXIANG_` environment variables and Windows application ID also work with MeteoDial. [Windows identity and upgrades](./cinna-windows.md)

## Weather maps and case sources

The live map uses GFS surface pressure for the same model run, forecast hour and grid cell as the selected location. A whole panel shows a single physical pressure level. The upper-air preset uses the first suitable level among 500, 400 and 300 hPa, with pressure no greater than 72% of surface pressure. The transport preset starts at 850 hPa and requires pressure no greater than 90% of surface pressure. The near-surface wind preset uses 925 hPa at surface pressures of at least 950 hPa and 10 m wind elsewhere. These are display choices. Each pressure grid also masks cells where the level meets or falls below model terrain.

The Beijing snow and Henan rain replays use archived GFS runs. The 2008 and 2016 cases use six-hourly ERA5 fields from WeatherBench 2. To rebuild the offline case assets, run `node scripts/prepare-cases.cjs`, `python scripts/prepare-reanalysis.py` and `python scripts/prepare-covers.py`. The Python scripts use NumPy, numcodecs and Pillow. The disaster archive stores source references, observed impacts and an original reading guide for each entry in `assets/data/disasters.json`.

## Project layout

| Path | Contents |
|---|---|
| `desktop/` | Electron window, tray, preferences and native lifecycle |
| `server/` | Forecasts, station reports, model grids, satellite, radar and cyclone data |
| `ui/` | Local weather, linked map viewer and case studies |
| `assets/data/` | Place index, coastline and case catalogue |
| `assets/cases/` | Historical model grids and satellite observations shipped with the app |
| `installer/inno/` | Cinna installer, artwork, upgrade handling and isolated installer tests |
| `scripts/` | Build, packaging and preparation of the weather archives |

## 本地服务与安装包

独立服务的端口由 `PORT` 设置，缓存目录由 `GUANXIANG_CACHE` 设置。桌面端可通过 `GUANXIANG_DATA_SERVICE` 连接维护者部署的 HTTPS 服务，本机继续提供界面与离线案例。

打包时可用 `INNOSETUP_ISCC` 和 `CINNA_ZIG` 指定已有工具链。`GUANXIANG_TEST_EXE` 可指定需要验证的桌面程序。安装包保存在 `installers/`，内部构建记录位于 `.packaging/`。旧版本的环境变量、Windows 应用标识和用户资料位置仍可用于 MeteoDial。
