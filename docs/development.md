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

The live timeline advances hourly through forecast hour 120 and every three hours from 123 to 240. Intermediate hours use the NOAA GFS 0.25° product. Three-hourly slots use GFS 1°, ECMWF IFS 0.25° or the GEFS 0.5° control member. The server checks the inventory, initialization and valid time before accepting a GRIB field. Wind components and the surface pressure used to mask terrain come from the same forecast. All sources share a 1° display grid. When a reference model already places a cell underground, switching models preserves that mask. The client sends the index of the selected display cell.

The upper-air preset starts with the first of 500, 400 and 300 hPa at or below 72% of model surface pressure. The transport preset starts at 850 hPa and requires pressure at or below 90% of surface pressure. The near-surface preset uses 925 hPa from 950 hPa surface pressure upwards and 10 m wind elsewhere. If the preferred field is unavailable at the point across sources, automatic mode tries the next eligible level, or 10 m for near-surface wind. Manual mode keeps the requested level. The source line identifies model substitutions and automatic level changes. Historical case replays keep their original sources.

The Beijing snowfall includes all 28 hourly outputs from the 2023-12-10 00 UTC GFS run through hour 27. The five model fields are sampled from the 0.25° product onto the national 0.5° case grid. Terra/MODIS imagery retains its UTC day. The Henan rain case uses archived GFS forecasts, and the 2008 and 2016 cases use six-hourly ERA5 fields from WeatherBench 2. To rebuild the offline case assets, run `node scripts/prepare-cases.cjs`, `python scripts/prepare-reanalysis.py` and `python scripts/prepare-covers.py`. The Python scripts use NumPy, numcodecs and Pillow. The disaster archive stores source references, observed impacts and an original reading guide for each entry in `assets/data/disasters.json`.

The historical grids and national MODIS images share the extent in `assets/data/archive-domain.json`. Dated local MODIS images retain their original bounds for close-up views and covers. To rebuild the offline basemap, install pyshp and Shapely 2 or later and run `python scripts/prepare-boundaries.py`. It uses the pinned NMC boundary linework and the Natural Earth 1:50m land and coastline files. The separate coastline layer keeps polygon edges at the date line and poles out of the visible shorelines.

The desktop renderer reads the three boundary layers from `basemap-v1.bin`, which the same script generates with the original coordinates at four decimal places and each line's bounds. The case viewer loads regional MODIS detail when the view intersects its footprint at close range. On a new multi-panel layout, fields for one valid time can appear as they arrive. Playback and scrubbing still publish all panels together.

On a cold GFS lookup, a slow inventory request can overlap a second small index from another mirror of the same product. The chosen mirror supplies its own offsets and GRIB ranges. A dedicated Node worker verifies and decodes the GRIB messages while the local HTTP service continues serving the interface and case files.

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
