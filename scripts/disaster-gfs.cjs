'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { readGrid } = require('../server/grids.cjs');
const { configureCache } = require('../server/network.cjs');
const archive = require('../assets/data/disasters.json');
const day = 86400000;
const fields = ['height500','wind850','moisture700','temp2','pressure','wind10'];
const iso = t => new Date(t).toISOString().slice(0,10);
function sampleDates(map) {
  const start = Date.parse(map.from), end = Date.parse(map.to), days = Math.round((end-start)/day);
  const count = Math.min(12,days);
  const times = new Set(Array.from({length:count+1}, (_,i) => iso(start+Math.round(i*days/count)*day)));
  if (map.focus) times.add(map.focus);
  return [...times].sort();
}
async function prepare(cache) {
  configureCache(path.join(cache,'grib'));
  const dir = path.join(cache,'gfs-daily');
  await fs.mkdir(dir,{recursive:true});
  const dates = [...new Set(archive.events.filter(e => e.year === 2026).flatMap(e => sampleDates(e.map)))];
  let index=0;
  await Promise.all(Array.from({length:3}, async () => {
    while (index < dates.length) {
      const date=dates[index++], filename=path.join(dir,date+'.json');
      let result = {};
      try { result=JSON.parse(await fs.readFile(filename,'utf8')); }
      catch (error) { if (error.code!=='ENOENT') throw error; }
      if (fields.every(layer=>result[layer])) continue;
      for (const layer of fields) {
        if (result[layer]) continue;
        const grids = await Promise.all(['00','06','12','18'].map(async hour => {
          const run=date+'T'+hour+':00:00.000Z';
          const grid=await readGrid(run,0,layer,'national','1p00',1);
          if (grid.layer!==layer || grid.valid!==run || grid.lead!==0 || grid.run!==run) throw Error('Wrong GFS analysis '+run+' '+layer);
          return grid;
        }));
        const first = grids[0];
        const g = {layer,bbox:first.bbox,step:first.step,nx:first.nx,ny:first.ny,
          resolution:'1°',source:'NOAA GFS',type:'分析场日平均',valid:date+'T00:00:00.000Z'};
        for (const key of ['values','v']) if (first[key]) {
          g[key]=first[key].map((_,i) => {
            if (!grids.every(f => Number.isFinite(f[key][i]))) return null;
            return Math.round(10*grids.reduce((n,f)=>n+f[key][i],0)/grids.length)/10;
          });
        }
        if (first.terrainMask) g.terrainMask=first.terrainMask.map((_,i)=>Number(grids.some(f=>f.terrainMask[i])));
        result[layer]=g;
      }
      await fs.writeFile(filename+'.partial',JSON.stringify(result));
      await fs.rename(filename+'.partial',filename);
      console.log(date);
    }
  }));
}
if (require.main === module) {
  if (!process.argv[2]) throw Error('Supply a build cache directory');
  prepare(path.resolve(process.argv[2])).catch(error=>{ console.error(error); process.exitCode=1; });
}
module.exports = {sampleDates};
