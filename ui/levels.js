export const automaticLayers = {
  autoUpper: '高空形势 · 自动选层',
  autoTransport: '输送层风场 · 自动选层',
  autoNear: '近地层风场 · 自动选层',
};
export const pressureLevels = [925, 850, 700, 600, 500, 400, 300];

export function gridIndex(g, lon, lat) {
  if (!g?.values || !Number.isFinite(lon) || !Number.isFinite(lat)) return -1;
  const x = Math.round((lon - g.bbox[0]) / g.step);
  const y = Math.round((g.bbox[3] - lat) / g.step);
  return x < 0 || y < 0 || x >= g.nx || y >= g.ny ? -1 : y * g.nx + x;
}

// These margins select a reading level for the reference point. Every plotted cell
// still uses the model's own surface pressure at the valid time for terrain masking.
export function levelFor(role, ps) {
  if (!Object.hasOwn(automaticLayers, role)) return role;
  if (!Number.isFinite(ps) || ps < 250 || ps > 1100) return role === 'autoNear' ? 'wind10' : null;
  if (role === 'autoNear') return ps >= 950 ? 'wind925' : 'wind10';
  const upper = role === 'autoUpper';
  const candidates = upper ? [500, 400, 300] : pressureLevels.slice(1);
  const level = candidates.find((hPa) => hPa <= ps * (upper ? 0.72 : 0.9));
  return level ? (upper ? 'height' : 'wind') + level : null;
}

export async function loadLevel(role, point, load) {
  if (!Object.hasOwn(automaticLayers, role)) return load(role);
  let ps = null;
  try {
    const surface = await load('surfacePressure');
    const value = surface.values[gridIndex(surface, ...point)];
    if (Number.isFinite(value) && value >= 250 && value <= 1100) ps = value;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
  }
  const layer = levelFor(role, ps);
  if (!layer) throw Error('选点缺少可用地面气压，可手选气压层或近地面要素。');
  return { ...(await load(layer)), selectionPressure: ps, autoRole: role };
}
