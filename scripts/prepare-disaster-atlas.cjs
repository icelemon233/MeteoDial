'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {gzipSync} = require('node:zlib');
const {readYear} = require('./disaster-fields.cjs');
const {sampleDates} = require('./disaster-gfs.cjs');
const archive = require('../assets/data/disasters.json');
const places = new Map(require('../assets/data/places.json').map(p => [p[0],p]));
const root = path.resolve(__dirname,'..');
const day = 86400000;
const iso = time => new Date(time).toISOString().slice(0,10);
const dateText = date => Number(date.slice(5,7))+'月'+Number(date.slice(8))+'日';
const round = v => Math.round(v*10)/10;
const layers = ['height500','wind850','moisture700','temp2','pressure','rainDay','wind10'];
const archiveSource = 'NOAA PSL · NCEP/NCAR R1';
function value(field,t,i) {
  const n=field.values.readFloatBE(4*(t*field.axes.lon.length*field.axes.lat.length+i));
  return Number.isFinite(n) && Math.abs(n)<1e10 ? n : null;
}
function indexOfDay(date) {
  return Math.round((Date.parse(date)-Date.parse(date.slice(0,4)+'-01-01'))/day);
}
function cell(grid,point) {
  const x=Math.round((point[0]-grid.bbox[0])/grid.step), y=Math.round((grid.bbox[3]-point[1])/grid.step);
  if (x<0||x>=grid.nx||y<0||y>=grid.ny) throw Error('Reference point outside archive');
  return {i:y*grid.nx+x, lon:grid.bbox[0]+x*grid.step,lat:grid.bbox[3]-y*grid.step};
}
function geometry(axes) {
  return {nx:axes.lon.length,ny:axes.lat.length,step:axes.lon[1]-axes.lon[0],
    bbox:[axes.lon[0],axes.lat.at(-1),axes.lon.at(-1),axes.lat[0]]};
}
// Interpolate the native Gaussian 2 m temperature to the regular pressure grid.
function gaussianWeights(axes,regular) {
  return regular.lat.flatMap(lat => regular.lon.map(lon => {
    const x=Math.max(0,Math.min(axes.lon.length-2,axes.lon.findIndex(v=>v>=lon)-1));
    const y=Math.max(0,Math.min(axes.lat.length-2,axes.lat.findIndex(v=>v<=lat)-1));
    const wx=(lon-axes.lon[x])/(axes.lon[x+1]-axes.lon[x]), wy=(lat-axes.lat[y])/(axes.lat[y+1]-axes.lat[y]);
    if (wx<0||wx>1||wy<0||wy>1) throw Error('Gaussian interpolation outside coordinates');
    const i=y*axes.lon.length+x, row=axes.lon.length;
    return [[i,(1-wx)*(1-wy)],[i+1,wx*(1-wy)],[i+row,(1-wx)*wy],[i+row+1,wx*wy]];
  }));
}
function gaussianValue(year,key,t,i) {
  let result=0;
  for (const [j,w] of year.weights[i]) {
    if (!w) continue;
    const n=value(year[key],t,j);
    if (n===null) return null;
    result+=n*w;
  }
  return round(key==='temp2'?result-273.15:result);
}
async function openYear(cache,y) {
  const keys = y===2026 ? ['rainDay'] : ['height500','u850','v850','moisture700','temp2','u10','v10','pressure','surface','rainDay'];
  const state={};
  for (const k of keys) state[k]=readYear(await fs.readFile(path.join(cache,'dap',y+'-'+k+'.dap')),y,k);
  if (y!==2026) state.weights=gaussianWeights(state.temp2.axes,state.height500.axes);
  return state;
}
function dailyRain(year,t,date) {
  const g=geometry(year.rainDay.axes);
  const values=Array.from({length:g.nx*g.ny},(_,i)=>value(year.rainDay,t,i)).map(n=>n===null?null:round(n));
  return {...g,layer:'rainDay',values,valid:date+'T00:00:00.000Z',period:dateText(date)+' · 日累计',
    source:'NOAA CPC',type:'雨量站格点分析',resolution:'0.5°'};
}
function regularGrids(year,t,date) {
  const g=geometry(year.height500.axes), length=g.nx*g.ny, fields={};
  const ps=Array.from({length},(_,i)=>value(year.surface,t,i));
  for (const [layer,key,level] of [['height500','height500',500],['wind850','u850',850],['moisture700','moisture700',700],['temp2','temp2'],['pressure','pressure'],['wind10','u10']]) {
    const gaussian=layer==='temp2'||layer==='wind10';
    const grid={...g,layer,valid:date+'T00:00:00.000Z',type:'再分析日平均',source:archiveSource,
      resolution:gaussian?'T62 高斯格网':'2.5°'};
    if (level) grid.terrainMask=ps.map(n=>Number(n!==null&&n<=level*100));
    function extract(key,i) {
      if (level&&(ps[i]===null||grid.terrainMask[i])) return null;
      if (gaussian) return gaussianValue(year,key,t,i);
      const v=value(year[key],t,i);
      return v===null ? null : round(layer==='pressure'?v/100:v);
    }
    grid.values=Array.from({length},(_,i)=>extract(key,i));
    if (layer==='wind850') grid.v=Array.from({length},(_,i)=>extract('v850',i));
    if (layer==='wind10') grid.v=Array.from({length},(_,i)=>extract('v10',i));
    fields[layer]=grid;
  }
  return fields;
}
function indicator(kind) {
  if (['高温','高温干旱','低温冰雪','冰冻圈灾害'].includes(kind)) return 'temp2';
  if (kind==='台风') return 'pressure';
  if (['沙尘大风','雾霾','大雾','森林火险'].includes(kind)) return 'wind10';
  return 'rainDay';
}
function gridValue(grid,point) {
  const {i} = cell(grid,point), n=grid.values[i];
  return n===null ? null : grid.v ? (grid.v[i]===null?null:round(Math.hypot(n,grid.v[i]))) : n;
}
async function buildEvent(e,year,cache) {
  const p=places.get(e.map.place),point=[p[5],p[4]],selected=new Set(sampleDates(e.map));
  const series=[], key=indicator(e.kind), rainGeo=geometry(year.rainDay.axes);
  const rainCell=cell(rainGeo,point);
  const geometryR1=year.height500 && geometry(year.height500.axes);
  const regularCell=geometryR1 && cell(geometryR1,point);
  const dates=[],frames={}, dailyGfs=new Map();
  async function gfs(date) {
    if (!dailyGfs.has(date)) dailyGfs.set(date, JSON.parse(await fs.readFile(path.join(cache,'gfs-daily',date+'.json'),'utf8')));
    return dailyGfs.get(date);
  }
  for (let now=Date.parse(e.map.from);now<=Date.parse(e.map.to);now+=day) {
    const date=iso(now),t=indexOfDay(date);
    let n;
    if (key==='rainDay') n=value(year.rainDay,t,rainCell.i);
    else if (!geometryR1) {
      if (!selected.has(date)) continue;
      n=gridValue((await gfs(date))[key],point);
    } else if (key==='temp2') n=gaussianValue(year,key,t,regularCell.i);
    else if (key==='pressure') { const q=value(year.pressure,t,regularCell.i); n=q===null?null:q/100; }
    else {
      const u=gaussianValue(year,'u10',t,regularCell.i),v=gaussianValue(year,'v10',t,regularCell.i);
      n=u===null||v===null ? null : Math.hypot(u,v);
    }
    series.push({date,value:n===null?null:round(n)});
  }
  const valid=series.filter(p=>p.value!==null);
  const low=['台风','低温冰雪'].includes(e.kind);
  const extreme=valid.reduce((a,b)=>!a||(low?b.value<a.value:b.value>a.value)?b:a,null);
  // Include the actual local extreme as a selectable map whenever the complete daily fields are available.
  if (extreme && geometryR1) selected.add(extreme.date);
  const focus=e.map.focus || (extreme&&selected.has(extreme.date)?extreme.date:null);
  for (const date of [...selected].sort()) {
    const t=indexOfDay(date);
    const fields=geometryR1 ? regularGrids(year,t,date) : await gfs(date);
    for (const grid of Object.values(fields)) grid.period=dateText(date)+' · 日平均（UTC）';
    fields.rainDay=dailyRain(year,t,date);
    frames[date]=fields;
    dates.push(date);
  }
  const central=focus||dates[Math.floor(dates.length/2)];
  const ref=cell(frames[central][key],point);
  return {id:e.id,dates,focus:central,layers,frames,series:{layer:key,lon:ref.lon,lat:ref.lat,days:series}};
}
async function main(cache,specific) {
  const dir=path.join(root,'assets/cases/disasters');
  await fs.mkdir(dir,{recursive:true});
  const years=Object.keys(archive.years).map(Number).filter(y=>!specific||specific.includes(y));
  for (const y of years) {
    const year=await openYear(cache,y);
    for (const e of archive.events.filter(e=>e.year===y)) {
      const bundle=await buildEvent(e,year,cache);
      const name=path.join(dir,e.id+'.json.gz');
      await fs.writeFile(name+'.partial',gzipSync(JSON.stringify(bundle),{level:7}));
      await fs.rename(name+'.partial',name);
    }
    console.log(y);
  }
}
if (require.main===module) {
  if (!process.argv[2]) throw Error('Supply a build cache directory');
  main(path.resolve(process.argv[2]),process.argv.length>3?process.argv.slice(3).map(Number):null)
    .catch(e=>{console.error(e);process.exitCode=1;});
}
