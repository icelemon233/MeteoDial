export const satelliteChannels = {
  satellite: { code: 'B13', product: 'B13/TBB', label: 'B13 长波红外', day: false },
  satVisible: { code: 'B03', product: 'B03/ALBD', label: 'B03 可见光', day: true },
  satColor: { code: 'TCR', product: 'REP/ETC', label: 'TCR 真彩色合成', day: true },
  satVapor: { code: 'B08', product: 'B08/TBB', label: 'B08 高层水汽', day: false },
};
export const satelliteRegions = {
  local: { name: '所在地' },
  china: { name: '全国', bbox: [72, 2, 137, 55] },
  north: { name: '华北', bbox: [104, 33, 123, 44] },
  northeast: { name: '东北', bbox: [117, 38, 136, 54] },
  east: { name: '华东', bbox: [111, 23, 127, 39] },
  central: { name: '华中', bbox: [105, 23, 119, 36] },
  south: { name: '华南', bbox: [103, 16, 122, 29] },
  southwest: { name: '西南', bbox: [92, 19, 112, 36] },
  northwest: { name: '西北', bbox: [73, 30, 111, 50] },
  plateau: { name: '青藏高原', bbox: [74, 26, 105, 40] },
};
export function satelliteBounds(region, lon, lat) {
  if (!Object.hasOwn(satelliteRegions, region)) throw Error('未知卫星区域');
  if (region !== 'local') return [...satelliteRegions[region].bbox];
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < 55 || lon > 165 || lat < 0 || lat > 75)
    throw Error('选点超出东亚覆盖范围');
  const dy = Math.min(8, 83 - Math.abs(lat)),
    dx = Math.min(30, (dy * 16) / 9 / Math.cos((lat * Math.PI) / 180));
  return [lon - dx, lat - dy, lon + dx, lat + dy].map((n) => Number(n.toFixed(4)));
}
export function solarTerms(time) {
  const d = new Date(time),
    h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const days =
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) /
    86400000;
  const a = ((2 * Math.PI) / 365) * (days + (h - 12) / 24);
  return {
    decl:
      0.006918 -
      0.399912 * Math.cos(a) +
      0.070257 * Math.sin(a) -
      0.006758 * Math.cos(2 * a) +
      0.000907 * Math.sin(2 * a) -
      0.002697 * Math.cos(3 * a) +
      0.00148 * Math.sin(3 * a),
    noonAngle:
      ((h * 15 -
        180 +
        (229.18 *
          (0.000075 +
            0.001868 * Math.cos(a) -
            0.032077 * Math.sin(a) -
            0.014615 * Math.cos(2 * a) -
            0.040849 * Math.sin(2 * a))) /
          4) *
        Math.PI) /
      180,
  };
}
export function isDaylight(time, lon, lat) {
  const { decl, noonAngle } = solarTerms(time),
    r = Math.PI / 180;
  return (
    Math.sin(lat * r) * Math.sin(decl) + Math.cos(lat * r) * Math.cos(decl) * Math.cos(noonAngle + lon * r) >
    0
  );
}
