export const automaticLayers = {
  autoUpper: '高空形势 · 自动选层',
  autoTransport: '输送层风场 · 自动选层',
  autoMoisture: '湿度场 · 自动选层',
  autoNear: '近地层风场 · 自动选层',
};
export const pressureLevels = [925, 850, 700, 600, 500, 400, 300, 200];
// The map picker exposes the standard reading levels. Other native levels
// remain available for terrain-aware selection and for data requests.
export const heightLevels = [925,850,700,500,300];
export const nativeHeightLevels = [...new Set([...pressureLevels,1000,975,950,900,800,750,650,550,450,350,250,150,100])];
export const profileLevels = [
  1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300,
];
// Extending south appends rows and preserves every existing reference cell index.
export const liveDomain = { bbox: [55, 0, 165, 75], step: 1, nx: 111, ny: 76 };

export function gridIndex(g, lon, lat) {
  if (
    !g?.bbox ||
    !(g.step > 0) ||
    !Number.isInteger(g.nx) ||
    !Number.isInteger(g.ny) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat)
  )
    return -1;
  const x = Math.round((lon - g.bbox[0]) / g.step),
    y = Math.round((g.bbox[3] - lat) / g.step);
  return x < 0 || y < 0 || x >= g.nx || y >= g.ny ? -1 : y * g.nx + x;
}
export const validPressure = (ps) => Number.isFinite(ps) && ps >= 250 && ps <= 1100;
export const roleLevels = {
  autoUpper: [500, 400, 300],
  autoTransport: [850, 700, 600, 500, 400, 300],
  autoMoisture: [700, 600, 500, 400, 300],
};
export function suitable(role, layer, ps) {
  if (layer === 'wind10') return role === 'autoNear';
  if (!validPressure(ps)) return false;
  if (role === 'autoNear') return layer === 'wind925' && ps >= 950;
  const level = Number(/\d+$/.exec(layer)?.[0]);
  return level > 0 && level <= ps * (role === 'autoUpper' ? 0.72 : 0.9);
}
export function levelChoices(role, ps) {
  if (!Object.hasOwn(automaticLayers, role)) return [role];
  if (role === 'autoNear') return suitable(role, 'wind925', ps) ? ['wind925', 'wind10'] : ['wind10'];
  const upper = role === 'autoUpper',
    wet = role === 'autoMoisture';
  const levels = roleLevels[role];
  const choices = levels.map((p) => (upper ? 'height' : wet ? 'moisture' : 'wind') + p);
  // One neighbouring pressure level can still answer the original reading question.
  return choices.filter((layer) => suitable(role, layer, ps)).slice(0, 2);
}
export function levelFor(role, ps) {
  return levelChoices(role, ps)[0] ?? null;
}
