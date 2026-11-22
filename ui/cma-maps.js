import catalog from '../assets/data/cma-products.json' with {type:'json'};
import {escape} from './base.js';
export const cmaProducts=new Map(catalog.map(p=>[p.id,p]));
export const cmaDefaults={cmaRadar:'radar-chinaall',cmaChart:'chart-500',cmaSatellite:'fy4b'};
const menus = new Map();
function options(family) {
  if (menus.has(family)) return menus.get(family);
  const groups=new Map();
  for (const p of catalog) {
    if (p.kind==='satellite') continue;
    if ((p.kind==='chart')!==(family==='cmaChart')) continue;
    const group=p.kind==='station'?p.group+' · 单站雷达':p.group;
    if (!groups.has(group)) groups.set(group,[]);
    groups.get(group).push('<option value="'+escape(p.id)+'">'+escape(p.label)+'</option>');
  }
  const html=[...groups].map(([name,rows])=>'<optgroup label="'+escape(name)+'">'+rows.join('')+'</optgroup>').join('');
  menus.set(family,html);
  return html;
}
export function reflectLayer(panel,layer) {
  const select=panel.querySelector('.layer-select'), p=cmaProducts.get(layer);
  let label=panel.querySelector('.cma-product');
  if (!p) {
    label?.remove();
    select.value=layer;
    return;
  }
  if (p.kind==='satellite') {
    label?.remove();
    select.value='cmaSatellite';
    return;
  }
  const family=p.kind==='chart'?'cmaChart':'cmaRadar';
  select.value=family;
  if (!label) {
    label=document.createElement('label');
    label.className='cma-product';
    select.parentElement.after(label);
  }
  if (label.dataset.family!==family) {
    label.innerHTML='<select class="cma-product-select" aria-label="'+panel.getAttribute('aria-label')+
      (family==='cmaChart'?'分析层次':'雷达区域或站点')+'">'+options(family)+'</select>';
    label.dataset.family=family;
  }
  label.firstElementChild.value=layer;
}
export function cmaGuide(p) {
  if (p.kind==='satellite') return '沿时间轴观察云团的位置和范围。对照同一时次的雷达图，可以看出云系中哪些区域出现了降水回波。';
  if (p.kind!=='chart') return '按原图的 dBZ 色标追踪回波的强弱和移动方向。雷达波束会受地形遮挡，远离雷达时也可能探测不到低层降水。';
  if (p.id==='chart-000') return '从海平面等压线找高低压中心，再对照锋线两侧站点的风向和温度。';
  if (['chart-925','chart-850','chart-700'].includes(p.id)) return '顺着站点风羽向上游读风，再对照等高线和温度场，判断这一层有无冷暖空气输送。高地附近要留意气压面与地形的关系。';
  return '沿等高线找槽和脊，再看风羽的方向与强弱，比较相邻时次中系统的位置。';
}
export async function sharedObservationTimes(keys,request) {
  const delayed=new Map();
  const lists=await Promise.all(keys.map(async key=>{
    const data=await request(cmaProducts.has(key)?'/api/cma-times?product='+encodeURIComponent(key):'/api/'+key+'-times');
    if (cmaProducts.has(key)&&data.product!==key) throw Error('原图时次与所选产品不符');
    if (data.delayed && Number.isFinite(Date.parse(data.latest))) delayed.set(key,data.latest);
    return new Set((data.frames||[]).map(f=>Date.parse(f.time)).filter(Number.isFinite));
  }));
  const times=[...lists[0]].filter(t=>lists.every(s=>s.has(t))).sort((a,b)=>a-b);
  if (!times.length) throw Error(keys.length>1?'这些图层暂无共同观测时次，可切回单图或更换图层。':'该产品暂无可回放的观测时次。');
  return {times,delayed};
}
