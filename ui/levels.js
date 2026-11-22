import { gridIndex, liveDomain } from '../shared/levels.mjs';
import { get } from './base.js';
export { automaticLayers, pressureLevels, gridIndex, levelFor } from '../shared/levels.mjs';

let cycleRequest;
export function forecastRun() {
  if (cycleRequest && cycleRequest.until > Date.now()) return cycleRequest.promise;
  const entry = { until: Date.now() + 30000 };
  entry.promise = get('/api/run').catch(error => {
    if (cycleRequest === entry) cycleRequest = null;
    throw error;
  });
  cycleRequest = entry;
  return entry.promise;
}

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
