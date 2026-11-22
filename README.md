<p align="center"><img src="./assets/brand/app-icon-256.png" width="88" alt="MeteoDial"></p>

<h1 align="center">MeteoDial</h1>
<p align="center">English | <a href="./README.zh-CN.md">简体中文</a></p>

MeteoDial (观象) is a Windows weather app by Cinna. Look up a city or county in China to see when the temperature, wind or precipitation is forecast to change. Open a second map alongside the first to see how the weather system develops.

[Download for Windows x64](https://github.com/icelemon233/MeteoDial/releases/latest) · [Run from source](#run-from-source)

<img src="./docs/previews/weather-home.png" width="960" alt="MeteoDial showing a local forecast and the regional wind field">

## Using MeteoDial

Press **Ctrl K** to search 3,641 cities, counties and districts by name or pinyin. **使用我的位置** (Use my location) finds the nearest national station in the bundled directory. Select the station to see each measurement and its observation time. The local forecast covers the next 48 hours by hour and the next 10 days by day.

**天气图** (Weather maps) opens with a 16:9 map of China. Switch to two or four panels to compare upper-air patterns, lower-level transport and near-surface wind at the same valid time. Forecasts advance hourly through day five and every three hours through day ten. The speed selector at the right of the timeline remembers your choice from 0.25× to 4×. Drag to pause and preview the map, release for full detail, or use the arrow keys to step through individual frames. At three-hourly slots, ECMWF IFS and the NOAA GEFS control forecast can fill a missing GFS field at the same initialization and valid time. Each panel identifies its field and source. Gray cells mark a pressure surface at or below model terrain.

**重大灾害分析** (Major disaster analysis) covers 352 events in China since 2001. Each event opens an offline map timeline with gridded weather fields, a local time series and the original report. Selected events have additional replays, including the 2008 ice storms and the 2021 Henan floods.

## Run from source

The interface is in Simplified Chinese. The desktop installer includes Electron and targets Windows x64, starting with Windows 10 build 19041. For development, install Node.js 24 or later and run the following commands in the project directory.

```sh
npm ci
npm start
```

`npm test` runs the tests. `npm run service` starts the local web app at `http://127.0.0.1:4173`. `npm run package` builds the Cinna Windows installer with Inno Setup 7.1.0 and Zig 0.15.2. Optional service and build settings are documented in the [development notes](./docs/development.md).

MET Norway supplies the hourly forecast. The local weather page also shows CMA city observations and day/night forecasts, provincial warning bulletins, and recent national-station reports from CMA WIS2 and Q-Weather.info. Weather maps include original NMC radar mosaics and individual radar images, Fengyun-4B cloud imagery, and surface and upper-air analyses. [Data sources and attribution](./assets/NOTICE.txt)
