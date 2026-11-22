'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { inflateSync, zstdDecompressSync, crc32 } = require('node:zlib');
function gridGeometry(month, rain = false) {
  const step = rain || month >= '2026-01' ? 1 : 2.5,
    west = step === 1 ? 53 : 52.5;
  return {
    step,
    bbox: [west, 0, 165, 75],
    nx: Math.round((165 - west) / step) + 1,
    ny: Math.round(75 / step) + 1,
  };
}
function readTable(bytes, month, magic) {
  if (bytes.toString('ascii', 0, 8) !== magic) throw Error('历史格点文件标识不匹配');
  const offset = 12 + bytes.readUInt32LE(8);
  if (offset > bytes.length || offset > 65536) throw Error('历史格点目录长度无效');
  const table = JSON.parse(bytes.toString('ascii', 12, offset));
  if (table.version !== 1 || table.cadence !== 4 || table.month !== month) throw Error('历史格点月份不匹配');
  return { bytes, offset, table };
}
function readDay(file, day, components, leadCount) {
  const entry = file.table.days[day];
  if (!entry) throw Error('归档中没有所选日期');
  const [start, size, mask, checksum] = entry,
    end = file.offset + start + size;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    size < 1 ||
    end > file.bytes.length ||
    !Number.isInteger(mask) ||
    mask <= 0 ||
    mask >= 64
  )
    throw Error('历史格点分块无效');
  const slots = [0, 1, 2, 3, 4, 5].filter((i) => mask & (1 << i));
  const shape = gridGeometry(file.table.month),
    rain = gridGeometry(file.table.month, true);
  const cells = components.reduce(
    (sum, key) => sum + (key === 'rain' ? rain.nx * rain.ny : shape.nx * shape.ny),
    0,
  );
  const expected = slots.length * (leadCount + 2 * cells);
  if (file.table.codec && !['zstd', 'zlib'].includes(file.table.codec)) throw Error('历史格点压缩格式无效');
  const unpack = file.table.codec === 'zstd' ? zstdDecompressSync : inflateSync;
  const block = file.bytes.subarray(file.offset + start, end);
  if (checksum !== undefined && crc32(block) !== checksum) throw Error('历史格点数据块校验失败');
  const raw = unpack(block, { maxOutputLength: expected });
  if (raw.length !== expected) throw Error('历史格点数据长度不完整');
  const leads = raw.subarray(0, slots.length * leadCount),
    fields = {};
  let pos = leads.length;
  for (const key of components) {
    const { nx, ny } = key === 'rain' ? rain : shape,
      cells = nx * ny,
      n = slots.length * cells;
    const a = new Int16Array(n);
    for (let i = 0; i < n; i++)
      a[i] = (raw[pos + i] | (raw[pos + n + i] << 8)) + (i >= cells ? a[i - cells] : 0);
    for (let i = 0; i < n; i += nx) for (let x = i + 1; x < i + nx; x++) a[x] += a[x - 1];
    fields[key] = a;
    pos += 2 * n;
  }
  return { leads, slots, fields, shape, rain, source: file.table.source, resolution: file.table.resolution };
}
function retain(cache, key, load, limit) {
  let entry = cache.get(key);
  if (entry) cache.delete(key);
  else {
    entry = Promise.resolve()
      .then(load)
      .catch((e) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw e;
      });
  }
  cache.set(key, entry);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return entry;
}
function createStore(directory, magic, components, leadCount) {
  const monthCache = new Map(),
    dayCache = new Map();
  function loadDay(stamp) {
    const month = stamp.slice(0, 7),
      day = Number(stamp.slice(8, 10));
    return retain(
      dayCache,
      stamp.slice(0, 10),
      async () => {
        const file = await retain(
          monthCache,
          month,
          async () => readTable(await fs.readFile(path.join(directory, month + '.bin')), month, magic),
          2,
        );
        return readDay(file, day, components, leadCount);
      },
      4,
    );
  }
  return loadDay;
}
module.exports = { gridGeometry, readTable, readDay, createStore };
