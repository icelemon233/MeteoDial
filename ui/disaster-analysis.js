import { escape, layerNames, layerUnit, windDir } from './base.js';
import { sample } from './cartography.js';

const shortDate = iso => Number(iso.slice(5,7))+'月'+Number(iso.slice(8,10))+'日';
const rain = ['rainDay','moisture700','wind850','height500'];
const cold = ['temp2','pressure','wind850','moisture700'];
const layerOrder = {
  '台风':['pressure','wind850','rainDay','height500'],
  '低温冰雪':cold, '冰冻圈灾害':['temp2','rainDay','height500','moisture700'],
  '高温':['temp2','height500','pressure','rainDay'], '高温干旱':['temp2','rainDay','height500','wind850'],
  '干旱':['rainDay','height500','temp2','moisture700'],
  '沙尘大风':['wind10','pressure','height500','temp2'], '森林火险':['wind10','temp2','rainDay','moisture700'],
  '大雾':['wind10','pressure','moisture700','temp2'], '雾霾':['wind10','pressure','height500','temp2'],
};
const sources = {
  cpc:['https://www.psl.noaa.gov/data/gridded/data.cpc.globalprecip.html','CPC 雨量站分析'],
  r1:['https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html','NCEP/NCAR 再分析'],
  gfs:['https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast','GFS 分析场'],
};
function seriesReading(kind,series) {
  const rows=series.days.filter(p=>p.value!==null);
  if (!rows.length) return '这个参考格点在所选时段缺少可用读数，可以点击周边有资料的格点查看。';
  const high=rows.reduce((a,b)=>a.value>=b.value?a:b),low=rows.reduce((a,b)=>a.value<=b.value?a:b);
  const date=p=>shortDate(p.date), number=p=>p.value.toFixed(1);
  if (series.layer==='rainDay') {
    const total=rows.reduce((n,p)=>n+p.value,0);
    let dry=0,longest=0;
    for (const d of series.days) { dry=d.value!==null && d.value<1 ? dry+1 : 0; longest=Math.max(longest,dry); }
    const period=rows.length+' 个有资料日的累计降水为 '+total.toFixed(1)+' 毫米。';
    return period+(kind==='干旱'?'其中日雨量不足 1 毫米的最长连续时段为 '+longest+' 天。':
      '日雨量最高出现在 '+date(high)+'，为 '+number(high)+' 毫米。');
  }
  if (series.layer==='temp2') return '所取日期中，日平均气温最低为 '+number(low)+'℃（'+date(low)+'），最高为 '+number(high)+'℃（'+date(high)+'），相差 '+(high.value-low.value).toFixed(1)+'℃。';
  if (series.layer==='pressure') return date(low)+' 的日平均海平面气压最低，为 '+number(low)+' hPa。对照前后的风场，可以跟踪低压环流经过参考点附近的时间。';
  return '离地 10 米的日平均风矢量在 '+date(low)+' 的风速为 '+number(low)+' m/s，在 '+date(high)+' 达到 '+number(high)+' m/s。当地瞬时阵风还要看站点记录。';
}
function atmosphere(bundle,point,name) {
  const date=bundle.focus,fields=bundle.frames[date],at=layer=>sample(fields[layer],...point);
  const windLayer=at('wind850')?.value==null?'wind10':'wind850';
  const wind=at(windLayer),wet=at('moisture700'),height=at('height500'),temp=at('temp2');
  const readings=[];
  if (wind?.value!=null) {
    const direction=(Math.atan2(-wind.u,-wind.v)*180/Math.PI+360)%360;
    readings.push((windLayer==='wind850'?'850 hPa':'离地 10 米')+' 为'+windDir(direction)+'，风速 '+wind.value.toFixed(1)+' m/s');
  }
  if (wet?.value!=null) readings.push('700 hPa 相对湿度为 '+wet.value.toFixed(0)+'%');
  if (readings.length<2 && height?.value!=null) readings.push('500 hPa 位势高度为 '+height.value.toFixed(0)+' 米');
  if (readings.length<2 && temp?.value!=null) readings.push('近地面日平均气温为 '+temp.value.toFixed(1)+'℃');
  return readings.length ? '选到 '+shortDate(date)+'，'+name+'附近的格点上，'+readings.join('，')+'。' : '';
}
function compareMaps(bundle,kind,point,name) {
  if (['暴雨洪涝','山洪地灾','强对流','台风','连阴雨'].includes(kind)) {
    let highest;
    for (const date of bundle.dates) {
      const rain=bundle.frames[date].rainDay;
      const col=Math.round((point[0]-rain.bbox[0])/rain.step),row=Math.round((rain.bbox[3]-point[1])/rain.step);
      for (let y=Math.max(0,row-2); y<=Math.min(rain.ny-1,row+2); y++) {
        for (let x=Math.max(0,col-2); x<=Math.min(rain.nx-1,col+2); x++) {
          const value=rain.values[y*rain.nx+x];
          if (value!==null && (!highest||value>highest.value))
            highest={date,value,lon:rain.bbox[0]+x*rain.step,lat:rain.bbox[3]-y*rain.step};
        }
      }
    }
    if (highest) return '在收录的地图中，以'+name+'为中心查看周围 5×5 个降水格点，日雨量最高的一格在 '+
      shortDate(highest.date)+' 的 '+highest.lon.toFixed(2)+'°E、'+highest.lat.toFixed(2)+'°N，为 '+
      highest.value.toFixed(1)+' 毫米。可以点到这个位置，和公报中的站点或流域记录对照。';
  }
  const key=kind==='高温'||kind==='干旱'||kind==='高温干旱'?'height500':
    ['沙尘大风','大雾','雾霾','森林火险'].includes(kind)?'wind10':'temp2';
  const dates=bundle.dates,index=dates.indexOf(bundle.focus);
  const first=dates[Math.max(0,index-1)],last=dates[Math.min(dates.length-1,index+1)];
  const a=sample(bundle.frames[first][key],...point)?.value,b=sample(bundle.frames[last][key],...point)?.value;
  if (a==null||b==null) return '';
  return '对照 '+shortDate(first)+' 与 '+shortDate(last)+'，'+name+'附近的'+layerNames[key]+'读数分别是 '+
    a.toFixed(1)+' 和 '+b.toFixed(1)+' '+layerUnit[key]+'。'+(key==='height500'?'沿等高线看脊线相对当地的位置怎样变化。':
    key==='wind10'?'结合风向线，看气流来自哪个方向。':'配合湿度图，辨认降温时水汽较多的位置。');
}
function curve(series,name) {
  const rows=series.days, valid=rows.filter(p=>p.value!==null);
  if (valid.length<2) return '';
  const lo=Math.min(...valid.map(p=>p.value)),hi=Math.max(...valid.map(p=>p.value));
  const start=Date.parse(rows[0].date),span=Date.parse(rows.at(-1).date)-start;
  let connected=false;
  const path=rows.map(p=>{
    if (p.value===null) { connected=false; return ''; }
    const x=2+296*(Date.parse(p.date)-start)/span,y=hi===lo?24:44-40*(p.value-lo)/(hi-lo);
    const cmd=connected?'L':'M'; connected=true; return cmd+x.toFixed(1)+' '+y.toFixed(1);
  }).join(' ');
  const label=name+'附近 · '+layerNames[series.layer]+'（'+layerUnit[series.layer]+'）';
  return '<figure class="event-curve"><figcaption>'+escape(label)+'</figcaption><svg viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true"><path d="'+path+'"/></svg><div><span>'+shortDate(rows[0].date)+'</span><span>'+shortDate(rows.at(-1).date)+'</span></div></figure>';
}
export function overview(event,bundle,place,report) {
  if (bundle.id!==event.id || !bundle.frames[bundle.focus]) throw Error('归档资料与此灾害事件不符');
  const point=[place[5],place[4]],name=place[1];
  const guides=[event.analysis,atmosphere(bundle,point,name),compareMaps(bundle,event.kind,point,name)].filter(Boolean);
  const {lon,lat}=bundle.series;
  const grid='读数取自'+name+'附近 '+lon.toFixed(2)+'°E、'+lat.toFixed(2)+'°N 的格点。';
  const days=(Date.parse(event.map.to)-Date.parse(event.map.from))/86400000+1;
  const dates=event.map.from.replaceAll('-','.')+' — '+event.map.to.replaceAll('-','.');
  const order=(layerOrder[event.kind]||rain).map(layer =>
    layer==='wind850' && sample(bundle.frames[bundle.focus].wind850,...point)?.value==null ? 'wind10' : layer);
  return {id:event.id,title:event.title,daily:bundle,run:event.map.from,point,tag:name+'参考点',
    area:name+'参考点',period:'图示时段 '+dates+(bundle.dates.length<days?' · '+bundle.dates.length+' 个代表日':''),
    leads:bundle.dates.map(d=>(Date.parse(d)-Date.parse(event.map.from))/3600000),
    layers:bundle.layers,defaults:order,guides,
    forecast:grid+seriesReading(event.kind,bundle.series),outcome:event.fact,link:report,
    evidenceCurve:curve(bundle.series,name), dataLinks:[event.year===2026?sources.gfs:sources.r1,sources.cpc],
    method:event.year===2026?'全国气象场取 UTC 00、06、12、18 时四次 GFS 分析的平均。':'全国气象场采用 NCEP/NCAR 逐日再分析，显示格距为 2.5°。',
  };
}
