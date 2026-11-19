<p align="center"><img src="./assets/brand/app-icon-256.png" width="88" alt="MeteoDial"></p>

<h1 align="center">MeteoDial</h1>
<p align="center">English | <a href="./README.zh-CN.md">简体中文</a></p>

MeteoDial (观象) is a Windows weather app by Cinna. Look up a city or county in China to see when the temperature, wind or precipitation is forecast to change. Open a second map alongside the first to see how the weather system develops.

[Download for Windows x64](https://github.com/icelemon233/MeteoDial/releases/latest) · [Run from source](#run-from-source)

<img src="./docs/previews/weather-home.png" width="960" alt="MeteoDial showing a local forecast and the regional wind field">

## Using MeteoDial

Press **Ctrl K** to search 3,641 cities, counties and districts by name or pinyin. The local view covers the next 48 hours by hour and the next 10 days by day. Observations include the station, distance and report time when a recent nearby station report is available.

In **天气图** (Weather maps), drag the shared timeline to compare wind, temperature, pressure, upper-air contours or satellite imagery. Each panel shows its source and valid time. Live radar covers Taiwan and its adjacent waters.

In **天气案例** (Case studies), try the Bohai Sea snow event. Follow the wind across the water on one map and look for cloud bands approaching the Shandong coast on the other. Nine archived cases covering eight topics are bundled with the app and work offline. [View the snow case](./docs/previews/bohai-snow.png)

## Run from source

The interface is in Simplified Chinese. The desktop installer includes Electron and targets Windows x64, starting with Windows 10 build 19041. For development, install Node.js 24 or later and run the following commands in the project directory.

```sh
npm ci
npm start
```

`npm test` runs the tests. `npm run service` starts the local web app at `http://127.0.0.1:4173`. `npm run package` builds the Cinna Windows installer with Inno Setup 7.1.0 and Zig 0.15.2. Optional service and build settings are documented in the [development notes](./docs/development.md).

The main forecast comes from MET Norway. The maps use NOAA GFS, Himawari satellite observations, regional radar from CWA and tropical cyclone tracks from the Hong Kong Observatory. The case studies also include NASA satellite composites and historical records. [Data sources and attribution](./assets/NOTICE.txt)
