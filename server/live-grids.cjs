'use strict';
const { sources, hourlySources, fields, fieldError } = require('./grid-sources.cjs');
const { readLiveGrid } = require('./grids.cjs');
const { automaticLayers, levelChoices, suitable, validPressure } = require('../shared/levels.mjs');

function hasValue(grid, index) {
  return (
    !grid.terrainMask?.[index] &&
    Number.isFinite(grid.values[index]) &&
    (!grid.v || Number.isFinite(grid.v[index]))
  );
}
function terrainGuard(grid, surface, p) {
  if (!surface || !p) return grid;
  if (
    grid.step !== surface.step ||
    grid.nx !== surface.nx ||
    grid.ny !== surface.ny ||
    grid.bbox.some((v, i) => v !== surface.bbox[i])
  )
    throw Error('后备资料与地形参考网格不一致');
  let guarded = grid;
  for (let i = 0; i < surface.values.length; i++) {
    const ps = surface.values[i];
    if (!validPressure(ps) || ps > p || grid.terrainMask[i]) continue;
    if (guarded === grid)
      guarded = {
        ...grid,
        values: grid.values.slice(),
        v: grid.v?.slice(),
        terrainMask: grid.terrainMask.slice(),
        terrainReference: surface.source,
      };
    guarded.terrainMask[i] = 1;
    guarded.values[i] = null;
    if (guarded.v) guarded.v[i] = null;
  }
  return guarded;
}
function fieldName(layer) {
  const level = /\d+$/.exec(layer)?.[0];
  if (layer === 'wind10') return '离地 10 米风';
  if (level && Number(level) >= 100) {
    const variable = layer.startsWith('height')
      ? '位势高度'
      : layer.startsWith('wind')
        ? '风场'
        : layer.startsWith('temp')
          ? '气温'
          : '相对湿度';
    return level + ' hPa ' + variable;
  }
  return (
    {
      temp2: '离地 2 米气温',
      pressure: '海平面气压',
      surfacePressure: '模式地面气压',
      rainRate: '瞬时降水率',
      snowFlag: '模式降雪信号',
    }[layer] || layer
  );
}
async function resolveLiveGrid(
  run,
  lead,
  choice,
  cell = null,
  { providers = lead % 3 ? hourlySources : sources, read = readLiveGrid } = {},
) {
  const auto = Object.hasOwn(automaticLayers, choice);
  if (!auto && !Object.hasOwn(fields, choice))
    throw Object.assign(Error('未知图层'), { statusCode: 400 });
  if (auto && (cell === null || cell < 0))
    throw Object.assign(Error('请在东亚模式覆盖范围内选点'), { statusCode: 422 });
  const point = cell === null || cell < 0 ? null : cell;
  const available = lead % 3 === 0 ? providers : providers.filter(source => source.model === 'gfs');
  const memo = new Map();
  const runTime = new Date(run).getTime(),
    validTime = runTime + lead * 36e5;
  const get = (provider, layer) => {
    const key = provider.id + ':' + layer;
    if (!memo.has(key))
      memo.set(
        key,
        Promise.resolve().then(async () => {
          const g = await read(provider, run, lead, layer);
          if (
            g?.sourceId !== provider.id ||
            g.layer !== layer ||
            Date.parse(g.run) !== runTime ||
            Date.parse(g.valid) !== validTime ||
            !Array.isArray(g.values) ||
            !g.values.length ||
            g.values.length !== g.nx * g.ny
          )
            throw Error('模式网格或时次不匹配');
          if (layer.startsWith('wind') && (!Array.isArray(g.v) || g.v.length !== g.values.length))
            throw fieldError('风场缺少分量');
          if (fields[layer][0][1].endsWith(' mb') && g.terrainMask?.length !== g.values.length)
            throw fieldError('缺少有效地形遮挡');
          return g;
        }),
      );
    return memo.get(key);
  };
  let reference = null,
    firstSurface = null,
    surfaceOffline = false;
  if (auto || fields[choice]?.[0][1].endsWith(' mb')) {
    for (const provider of available) {
      try {
        const grid = await get(provider, 'surfacePressure');
        if (!firstSurface && grid.values.some(validPressure)) firstSurface = grid;
        if (point === null ? grid.values.some(validPressure) : validPressure(grid.values[point])) {
          reference = grid;
          break;
        }
      } catch (error) {
        if (error.code !== 'FIELD_MISSING' && ![404, 410].includes(error.statusCode))
          surfaceOffline = true;
      }
    }
  }
  const ps = point === null ? null : (reference?.values[point] ?? null);
  const candidates = levelChoices(choice, ps);
  if (!candidates.length) {
    if (!validPressure(ps) && surfaceOffline)
      throw Object.assign(Error('地面气压暂时无法取得，可读取近地面要素或重试。'), {
        statusCode: 503,
      });
    throw fieldError(
      validPressure(ps)
        ? '此点没有合适的自动气压层，可读取近地面要素。'
        : '各数据源缺少该点可用的地面气压，无法自动选层。',
    );
  }
  let regional = null,
    offline = false;
  function result(grid) {
    const pointStatus =
      point === null
        ? undefined
        : grid.terrainMask?.[point]
          ? 'terrain'
          : hasValue(grid, point)
            ? undefined
            : 'missing';
    return {
      ...grid,
      pointStatus,
      backupSource: grid.sourceId !== available[0]?.id,
      ...(auto
        ? {
            autoRole: choice,
            preferredLayer: candidates[0],
            selectionPressure: ps,
            selectionPressureSource: reference?.source ?? null,
          }
        : {}),
    };
  }
  for (const layer of candidates) {
    const pressure = /^(\d+) mb$/.exec(fields[layer][0][1]);
    const p = pressure ? Number(pressure[1]) : null;
    for (const provider of available) {
      try {
        const original = await get(provider, layer);
        let grid = terrainGuard(original, firstSurface, p);
        if (reference !== firstSurface) grid = terrainGuard(grid, reference, p);
        if (point === null) {
          if (grid.values.some((_, i) => hasValue(grid, i))) return result(grid);
          if (grid.terrainMask?.includes(1)) regional ||= grid;
          continue;
        }
        if (p && grid.terrainMask[point] && reference && validPressure(ps) && ps <= p)
          return result(grid);
        if (auto && p && grid.sourceId !== reference?.sourceId) {
          const own = await get(provider, 'surfacePressure');
          if (!suitable(choice, layer, own.values[point])) continue;
        }
        if (hasValue(grid, point)) return result(grid);
        if (
          !regional &&
          (grid.terrainMask?.includes(1) || grid.values.some((_, i) => hasValue(grid, i)))
        )
          regional = grid;
      } catch (error) {
        if (error.code !== 'FIELD_MISSING' && ![404, 410].includes(error.statusCode))
          offline = true;
      }
    }
  }
  if (regional) return result(regional);
  const target = candidates.map(fieldName).join('、');
  const fixedPressure = !auto && /^(\d+) mb$/.exec(fields[choice][0][1]);
  if (fixedPressure && validPressure(ps) && ps <= Number(fixedPressure[1]))
    throw fieldError('选点的' + target + '位于模式地面或地下，该时次图层暂缺。');
  if (offline)
    throw Object.assign(Error('未取得此时次的' + target + '，部分数据源暂不可用。'), {
      statusCode: 503,
    });
  throw fieldError('各数据源在此时次缺少可用的' + target + '。');
}
module.exports = { resolveLiveGrid };
