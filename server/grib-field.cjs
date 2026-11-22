'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { request } = require('./network.cjs');
const { retryLater } = require('./grid-sources.cjs');

const maxBytes = 8 * 1024 * 1024;
let activeWorker, sequence = 0;
function decodingWorker() {
  if (activeWorker) return activeWorker;
  const folder = path.basename(path.dirname(__dirname)) === 'app.asar' && process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server') : __dirname;
  const thread = new Worker(path.join(folder, 'grib-decoder.cjs'));
  const jobs = new Map();
  const worker = { thread, jobs };
  activeWorker = worker;
  thread.on('message', ({id, values, error}) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (error) job.reject(Error(error));
    else job.resolve(values);
    if (!jobs.size) thread.unref();
  });
  function stopped(error) {
    if (activeWorker === worker) activeWorker = null;
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  }
  thread.on('error', stopped);
  thread.on('exit', () => stopped(Error('格点解码已中断')));
  thread.unref();
  return worker;
}
function readValues(message) {
  const { thread, jobs } = decodingWorker(), id = ++sequence;
  return new Promise((resolve, reject) => {
    jobs.set(id, {resolve, reject});
    thread.ref();
    try { thread.postMessage({id, ...message}, [message.bytes]); }
    catch (error) {
      jobs.delete(id);
      if (!jobs.size) thread.unref();
      reject(error);
    }
  });
}

async function fetchField(source, run, lead, entry, bbox, step) {
  return retryLater(entry.url + '@' + entry.at, async () => {
    if (
      !Number.isSafeInteger(entry.at) ||
      entry.at < 0 ||
      (entry.end !== null && (entry.end - entry.at + 1 > maxBytes || entry.end < entry.at))
    )
      throw Error('气象字段长度异常');
    decodingWorker();
    const response = await request(entry.url, {
      headers: { Range: 'bytes=' + entry.at + '-' + (entry.end ?? '') },
      timeout: 15000,
      preferSystem: true,
    });
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
    const size = range && Number(range[2]) - Number(range[1]) + 1;
    if (
      response.status !== 206 ||
      !range ||
      Number(range[1]) !== entry.at ||
      (entry.end !== null && Number(range[2]) !== entry.end) ||
      Number(range[2]) >= Number(range[3]) ||
      size < 20 ||
      size > maxBytes
    ) {
      await response.body?.cancel();
      throw Error('上游未返回所需 GRIB 分段');
    }
    const body = await response.arrayBuffer(), bytes = Buffer.from(body);
    if (
      bytes.length !== size ||
      bytes.toString('ascii', 0, 4) !== 'GRIB' ||
      bytes[7] !== 2 ||
      bytes.readBigUInt64BE(8) !== BigInt(size) ||
      bytes.toString('ascii', size - 4) !== '7777'
    )
      throw Error('GRIB2 数据不完整');
    return readValues({ source, run, lead, entry, bytes: body, bbox, step });
  });
}
module.exports = { fetchField };
