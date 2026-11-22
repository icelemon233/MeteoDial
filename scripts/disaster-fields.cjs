'use strict';
// Subset the original NOAA PSL grids using DAP2. Cache the selected years
// outside the application. Dates, coordinates and pressure levels travel with the values.
const fs = require('node:fs/promises');
const path = require('node:path');
const root = 'https://psl.noaa.gov/thredds/dodsC/Datasets/';
const regular = '[6:1:36][21:1:66]';
const gaussian = '[7:1:47][28:1:88]';
const sources = {
  height500: ['pressure/hgt', 'hgt', 5, 500],
  u850: ['pressure/uwnd', 'uwnd', 2, 850],
  v850: ['pressure/vwnd', 'vwnd', 2, 850],
  moisture700: ['pressure/rhum', 'rhum', 3, 700],
  surface: ['surface/pres.sfc', 'pres'],
  pressure: ['surface/slp', 'slp'],
  temp2: ['surface_gauss/air.2m.gauss', 'air'],
  u10: ['surface_gauss/uwnd.10m.gauss','uwnd'],
  v10: ['surface_gauss/vwnd.10m.gauss','vwnd'],
  rainDay: ['cpc_global_precip/precip', 'precip'],
};
const day = 864e5;
function decode(buffer) {
  const cut = buffer.indexOf('Data:\n');
  if (cut < 0) throw Error('Missing DAP2 data');
  const header = buffer.toString('ascii', 0, cut);
  const [array, maps] = header.split('MAPS:');
  const size = [...array.matchAll(/\[(\w+) = (\d+)\]/g)].map(m => Number(m[2]));
  if (!maps || !size.length || !/ARRAY:\s*Float32 /.test(array)) throw Error('Unsupported DAP2 grid');
  let offset = cut + 6;
  function column(count, double) {
    const width = double ? 8 : 4;
    if (buffer.readUInt32BE(offset) !== count || buffer.readUInt32BE(offset + 4) !== count)
      throw Error('Invalid DAP2 array length');
    offset += 8;
    const data = buffer.subarray(offset, offset + count * width);
    if (data.length !== count * width) throw Error('Truncated DAP2 array');
    offset += data.length;
    return data;
  }
  const values = column(size.reduce((a,b) => a*b, 1), false);
  const axes = {};
  for (const [,type,name,n] of maps.matchAll(/(Float32|Float64) (\w+)\[\w+ = (\d+)\];/g)) {
    const double = type === 'Float64', data = column(Number(n), double);
    axes[name] = Array.from({length:Number(n)}, (_,i) => double ? data.readDoubleBE(i*8) : data.readFloatBE(i*4));
  }
  if (offset !== buffer.length || !axes.time || !axes.lat || !axes.lon) throw Error('Incomplete DAP2 coordinate axes');
  return {axes, values};
}
function readYear(bytes, year, key) {
  const result = decode(bytes), {time,level,lat,lon} = result.axes;
  const expected = sources[key][3], epoch = key === 'rainDay' ? 1900 : 1800;
  if (expected && level?.[0] !== expected) throw Error('Incorrect pressure level for '+key);
  const first = (Date.UTC(year,0,1) - Date.UTC(epoch,0,1)) / 3600000;
  if (!time.every((value,i) => value === first + i*24) || lat[0] <= lat.at(-1) || lon[0] >= lon.at(-1))
    throw Error('Invalid dates or orientation for '+year+' '+key);
  return result;
}
async function acquire(cache, year, key, lastDay) {
  const filename = path.join(cache, year+'-'+key+'.dap');
  try { await fs.access(filename); return; } catch {}
  const [folder, name, level] = sources[key];
  const count = Math.round((Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/day);
  const end = lastDay === undefined ? count - 1 : lastDay;
  const cpc = key === 'rainDay';
  const spatial = cpc ? '[29:2:179][104:2:330]' : folder.startsWith('surface_gauss/') ? gaussian : regular;
  const constraint = name+'[0:1:'+end+']'+(level === undefined ? '' : '['+level+']')+spatial;
  const url = root+(cpc ? '' : 'ncep.reanalysis.dailyavgs/')+folder+'.'+year+'.nc.dods?'+constraint;
  for (let attempt=1; ; attempt++) {
    try {
      const response = await fetch(url, {signal:AbortSignal.timeout(210000)});
      if (!response.ok) {
        const delay=Number(response.headers.get('retry-after'));
        throw Object.assign(Error('HTTP '+response.status),{delay:Number.isFinite(delay)?delay*1000:0});
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (readYear(bytes, year, key).axes.time.length !== end+1) throw Error('Incomplete year');
      await fs.writeFile(filename+'.partial', bytes);
      await fs.rename(filename+'.partial', filename);
      console.log(year, key, bytes.length);
      return;
    } catch (e) {
      if (attempt === 4) throw Error(year+' '+key+': '+e.message, {cause:e});
      console.warn('Retry', year, key, e.message);
      await new Promise(resolve => setTimeout(resolve, Math.max(e.delay||0,1500*attempt)));
    }
  }
}
async function download(cache) {
  await fs.mkdir(cache,{recursive:true});
  const jobs = [];
  for (let year=2001; year<=2025; year++)
    for (const key of Object.keys(sources)) jobs.push([year,key]);
  jobs.unshift([2026,'rainDay',303]);
  let next = 0;
  await Promise.all(Array.from({length:6}, async () => {
    while (next < jobs.length) await acquire(cache, ...jobs[next++]);
  }));
}
if (require.main === module) {
  if (!process.argv[2]) throw Error('Supply a build cache directory');
  download(path.resolve(process.argv[2])).catch(e => { console.error(e); process.exitCode=1; });
}
module.exports = {readYear};
