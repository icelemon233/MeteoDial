import { gridIndex, liveDomain } from '../shared/levels.mjs';
export { automaticLayers, pressureLevels, gridIndex, levelFor } from '../shared/levels.mjs';

export function liveGridUrl(run, lead, layer, point) {
  const params = new URLSearchParams({ run, lead: String(lead), layer });
  if (point) params.set('cell', String(gridIndex(liveDomain, ...point)));
  return '/api/grid?' + params;
}
export function sourceName(grid) {
  if (grid.sourceId === 'nomads') return grid.source + ' · NOMADS';
  return grid.backupSource ? grid.source + '（后备）' : grid.source;
}
export function actualLevel(grid, names) {
  const name = names[grid.layer];
  return grid.preferredLayer && grid.preferredLayer !== grid.layer
    ? names[grid.preferredLayer] + ' → ' + name
    : name;
}
