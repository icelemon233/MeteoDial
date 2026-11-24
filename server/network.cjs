'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const inflight = new Map();
const userAgent =
  'MeteoDial/' + require('../package.json').version + ' (https://github.com/icelemon233/MeteoDial)';
let directory;
let systemFetch;
function configureTransport(fn) {
  systemFetch = fn;
}

function configureCache(folder) {
  directory = folder;
}
async function request(url, options = {}) {
  const {
    timeout = 15000,
    headers = {},
    preferSystem = false,
    acceptErrorResponse = false,
    ...rest
  } = options;
  const init = () => ({
    ...rest,
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': userAgent, ...headers },
  });
  const preferred =
    systemFetch && (preferSystem || new URL(url).hostname.endsWith('.cwa.gov.tw'))
      ? systemFetch
      : fetch;
  let res;
  try {
    res = await preferred(url, init());
  } catch (error) {
    if (!systemFetch || !['GET','HEAD'].includes((rest.method||'GET').toUpperCase())) throw error;
    const alternate=preferred===systemFetch?fetch:systemFetch;
    res = await alternate(url, init());
  }
  if (!res.ok && !acceptErrorResponse) {
    await res.body?.cancel();
    throw Object.assign(new Error('上游数据服务返回 ' + res.status), {
      statusCode: res.status,
      retryAfter: res.headers.get('retry-after'),
    });
  }
  return res;
}
function cacheFile(key) {
  return path.join(
    directory,
    crypto.createHash('sha256').update(key).digest('hex') + '.json',
  );
}
// A hint for choosing a replica; cached() still validates expiry and reads the record.
async function cachePresent(key) {
  if (!directory) return false;
  try { await fs.access(cacheFile(key)); return true; } catch { return false; }
}
async function cached(key, ttl, loader, { stale = 0 } = {}) {
  if (inflight.has(key)) return inflight.get(key);
  const target = cacheFile(key);
  const task = (async () => {
    let old;
    try {
      old = JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {}
    if (old && old.expires > Date.now()) return old.value;
    try {
      const loaded = await loader();
      const entry = {
        expires: loaded.expires || Date.now() + ttl,
        at: Date.now(),
        value: loaded.value,
      };
      await fs.mkdir(directory, { recursive: true });
      const temp = target + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temp, JSON.stringify(entry));
      await fs.rename(temp, target);
      return entry.value;
    } catch (error) {
      if (
        old &&
        stale &&
        Date.now() - old.at < stale &&
        (!error.statusCode || error.statusCode >= 500 || error.statusCode === 429)
      ) {
        return { ...old.value, cachedAt: old.at, offline: true };
      }
      throw error;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
async function pruneCache(keepBytes = 180 * 1024 * 1024) {
  let files;
  try {
    files = await fs.readdir(directory);
  } catch {
    return;
  }
  const entries = await Promise.all(
    files
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map(async (name) => {
        const file = path.join(directory, name);
        try {
          const s = await fs.stat(file);
          return { file, size: s.size, time: s.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  let sum = 0;
  for (const e of entries.filter(Boolean).sort((a, b) => b.time - a.time)) {
    sum += e.size;
    if (sum > keepBytes || Date.now() - e.time > 30 * 864e5)
      await fs.unlink(e.file).catch(() => {});
  }
}
module.exports = { configureCache, configureTransport, cached, cachePresent, request, pruneCache };
