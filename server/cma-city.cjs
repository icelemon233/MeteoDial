'use strict';
const {cached,request}=require('./network.cjs');
const base='https://weather.cma.cn';
const hour=3600000;
const reading=(n,min,max)=>Number.isFinite(n)&&n>=min&&n<=max?n:null;
const text=s=>typeof s==='string'&&s.trim()?s.trim():null;
function parseCity(payload,id,kind,now=Date.now()) {
  const data=payload?.data,location=data?.location;
  if (payload?.code!==0 || String(location?.id)!==id || !text(location.name))
    throw Error('官方城市产品与参考站号不符');
  if (!/^\d{4}\/\d\d\/\d\d \d\d:\d\d$/.test(data.lastUpdate)) throw Error('城市产品缺少时次');
  const utc=Date.parse(data.lastUpdate.replaceAll('/','-').replace(' ','T')+':00+08:00');
  const future=kind==='now'?0:12*hour, age=kind==='now'?3*hour:48*hour;
  if (!Number.isFinite(utc)||utc>now+future||now-utc>age) throw Error('官方城市产品没有近期时次');
  const header={name:location.name,id,time:new Date(utc).toISOString()};
  if (kind==='now') {
    const row=data.now,temp=reading(row?.temperature,-95,65);
    if (temp===null) throw Error('城市实况缺少有效气温');
    return {...header,temp,rh:reading(row.humidity,0,100),wind:reading(row.windSpeed,0,120),
      direction:text(row.windDirection)};
  }
  if (!Array.isArray(data.daily)) throw Error('城市预报缺少逐日资料');
  const today=new Date(now+8*hour).toISOString().slice(0,10);
  const until=new Date(now+8*hour+8*24*hour).toISOString().slice(0,10);
  const days=new Map();
  for (const r of data.daily) {
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(r.date)) continue;
    const date=r.date.replaceAll('/','-');
    if (date<today||date>until||(!text(r.dayText)&&!text(r.nightText))) continue;
    days.set(date,{date,high:reading(r.high,-95,65),low:reading(r.low,-95,65),day:text(r.dayText),
      night:text(r.nightText),dayWind:[text(r.dayWindDirection),text(r.dayWindScale)].filter(Boolean).join(' '),
      nightWind:[text(r.nightWindDirection),text(r.nightWindScale)].filter(Boolean).join(' ')});
  }
  if (!days.size) throw Error('没有当前有效的逐日城市预报');
  return {...header,days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(0,7)};
}
async function cityPart(id,kind) {
  const endpoint=kind==='now'?'now':'weather';
  const data=await cached('cma-city-v1:'+kind+':'+id,(kind==='now'?5:30)*60000,async()=>{
    const response=await request(base+'/api/'+endpoint+'/'+id,{timeout:5500});
    const value=await response.json();
    parseCity(value,id,kind);
    return {value};
  },{stale:kind==='now'?3*hour:24*hour});
  return {...parseCity(data,id,kind),offline:Boolean(data.offline)};
}
async function cityWeather(id) {
  if (!/^\d{5}$/.test(id)) throw Object.assign(Error('所选地点附近没有可匹配的官方城市站号'),{statusCode:404});
  const [now,forecast]=await Promise.allSettled([cityPart(id,'now'),cityPart(id,'forecast')]);
  if (now.status==='rejected'&&forecast.status==='rejected') throw Error('此站号的官方城市实况和预报暂不可用');
  return {id,sourcePage:base+'/web/weather/'+id+'.html',
    now:now.status==='fulfilled'?now.value:null,forecast:forecast.status==='fulfilled'?forecast.value:null};
}
module.exports={parseCity,cityWeather};
