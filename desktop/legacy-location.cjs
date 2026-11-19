'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ClassicLevel } = require('classic-level');

const IDs = new Set(require('../assets/data/places.json').map(([id]) => id));
const PREFIX = 'META:http://127.0.0.1:';
const dbFile = /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/;

// Chromium's LocalStorageOriginMetaData field 1 is the modification time in microseconds.
function modifiedAt(value) {
  if (!value || value[0] !== 8) return 0n;
  let time = 0n;
  for (let i = 1; i <= 10 && i < value.length; i++) {
    time |= BigInt(value[i] & 127) << BigInt(7 * (i - 1));
    if ((value[i] & 128) === 0) return time;
  }
  return 0n;
}

async function oldValue(db, origin, name) {
  const key = Buffer.concat([Buffer.from('_' + origin), Buffer.from([0, 1]), Buffer.from(name)]);
  const bytes = await db.get(key);
  if (!bytes?.length || bytes.length > 4096 || ![0, 1].includes(bytes[0])) return null;
  try {
    return JSON.parse(bytes.subarray(1).toString(bytes[0] === 1 ? 'latin1' : 'utf16le'));
  } catch {
    return null;
  }
}

async function readLegacyLocation(directory) {
  const store = path.join(directory, 'Local Storage', 'leveldb');
  let entries;
  try {
    const st = await fs.lstat(store);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    entries = await fs.readdir(store, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!entries.some((entry) => entry.name === 'CURRENT' && entry.isFile())) return null;
  const root = path.resolve(directory);
  const copy = await fs.mkdtemp(path.join(root, 'weather-location-import-'));
  let db;
  try {
    // Opening a LevelDB can write its lock and journal. Open only a private snapshot.
    for (const entry of entries) {
      if (entry.isFile() && dbFile.test(entry.name)) {
        await fs.copyFile(path.join(store, entry.name), path.join(copy, entry.name));
      }
    }
    db = new ClassicLevel(copy, {
      createIfMissing: false,
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await db.open();
    const origins = [];
    for await (const [key, value] of db.iterator({
      gte: Buffer.from(PREFIX),
      lt: Buffer.from('META:http://127.0.0.1;'),
    })) {
      const origin = key.toString('ascii').slice(5);
      if (
        /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) &&
        Number(origin.split(':').at(-1)) <= 65535
      ) {
        origins.push({ origin, updated: modifiedAt(value) });
      }
    }
    origins.sort((a, b) => (a.updated === b.updated ? 0 : a.updated > b.updated ? -1 : 1));
    for (const { origin } of origins) {
      const place = await oldValue(db, origin, 'guanxiang.place');
      if (!IDs.has(place)) continue;
      const recent = await oldValue(db, origin, 'guanxiang.recent');
      return {
        place,
        recent: Array.isArray(recent)
          ? [...new Set(recent.filter((id) => IDs.has(id)))].slice(0, 5)
          : [place],
      };
    }
    return null;
  } finally {
    try {
      if (db) await db.close();
    } finally {
      if (path.dirname(copy) === root && path.basename(copy).startsWith('weather-location-import-')) {
        await fs.rm(copy, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
}

async function migrateLocationOnce(directory, settings) {
  if (settings.get().place) return;
  try {
    await fs.access(path.join(directory, 'preferences.json'));
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') return;
  }
  try {
    const previous = await readLegacyLocation(directory);
    if (previous) settings.set(previous);
  } catch {
    // A damaged or unknown old store stays intact and cannot prevent startup.
  }
}
module.exports = { readLegacyLocation, migrateLocationOnce };
