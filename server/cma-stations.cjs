'use strict';
const {cached,request} = require('./network.cjs');
const collection='https://wis2node.wis.cma.cn/oapi/collections/urn:wmo:md:cn-cma:data.core.weather.surface-based-observations';
const hour=3600000;
const definitions = {
  air_temperature:['temp','Celsius',-95,65],
  dewpoint_temperature:['dewpoint','Celsius',-105,55],
  relative_humidity:['rh','%',0,100],
  non_coordinate_pressure:['stationPressure','hPa',250,1100],
  pressure_reduced_to_mean_sea_level:['seaPressure','hPa',820,1100],
  horizontal_visibility:['visibility','m',0,200000],
  wind_speed:['wind10min','m/s',0,120,10*60000],
  wind_direction:['windDirection10min','deg',0,360,10*60000],
  total_precipitation_past24hours:['rain24h','kg m-2',0,2000],
};
function parseObservations(payload,id,now=Date.now()) {
  if (payload?.type!=='FeatureCollection'||!Array.isArray(payload.features)) throw Error('中国气象局站报格式异常');
  const wigos='0-20000-0-'+id, reports=new Map();
  for (const f of payload.features) {
    const p=f?.properties;
    if (p?.wigos_station_identifier!==wigos || !Number.isFinite(p.value)) continue;
    const time=Date.parse(p.reportTime);
    if (!Number.isFinite(time) || time>now || now-time>3*hour ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(p.reportTime)) continue;
    const stamp=new Date(time).toISOString();
    if (p.reportId!==wigos+'-'+stamp.slice(0,16).replace(/[-:T]/g,'')) continue;
    const interval=String(p.phenomenonTime).split('/');
    if (interval.length>2 || !interval.every(s=>s.endsWith('Z')) || Date.parse(interval.at(-1))!==time) continue;
    const duration=interval.length===2?time-Date.parse(interval[0]):0;
    let spec=Object.hasOwn(definitions,p.name)?definitions[p.name]:null;
    if (p.name==='total_precipitation_or_total_water_equivalent' && [1,6,12,24].includes(duration/hour))
      spec=['rain'+(duration/hour)+'h','kg m-2',0,2000,duration];
    if (!spec) continue;
    const [key,unit,min,max,period]=spec;
    if (p.units!==unit || p.value<min || p.value>max ||
        (key==='rain24h'&&!period?duration!==0&&duration!==24*hour:duration!==(period||0))) continue;
    const fields=reports.get(time)||{};
    fields[key]={value:Math.round(p.value*100)/100,time:stamp};
    reports.set(time,fields);
  }
  const latest=[...reports.entries()].filter(([,f])=>f.temp).sort((a,b)=>b[0]-a[0])[0];
  if (!latest) return null;
  const {temp,...fields}=latest[1];
  return {id,kind:'national',source:'中国气象局 WIS2',time:temp.time,temp:temp.value,fields};
}
async function readCmaStation(id) {
  if (!/^\d{5}$/.test(id)) return null;
  const payload=await cached('cma-wis2-synop-v1:'+id,5*60000,async()=>{
    const now=Date.now(),params=new URLSearchParams({f:'json',wigos_station_identifier:'0-20000-0-'+id,
      datetime:new Date(now-3*hour).toISOString()+'/'+new Date(now).toISOString(),sortby:'-reportTime',limit:'100'});
    const response=await request(collection+'/items?'+params,{timeout:3600});
    const data=await response.json();
    parseObservations(data,id,now);
    return {value:{type:data.type,features:data.features}};
  },{stale:3*hour});
  const result=parseObservations(payload,id);
  return result && {...result,offline:Boolean(payload.offline)};
}
module.exports={parseObservations,readCmaStation};
