import catalog from '../assets/data/cma-products.json' with {type:'json'};
import {escape} from './base.js';
import {chartGuide} from './pressure-guides.js';
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
export function chartPeers(ps) {
  const known=Number.isFinite(ps);
  const levels=(known?[500,850,700,200,100,925]:[500,200,100]).filter(n=>!known||n<ps);
  // Keep a surface reference in the four published charts at every altitude.
  return [...new Set(['chart-000',...levels.map(n=>'chart-'+n)])];
}
export function cmaGuide(p,reference=null) {
  if (p.kind==='satellite') return '沿时间轴观察云团的位置和范围。对照同一时次的雷达图，可以看出云系中哪些区域出现了降水回波。';
  if (p.kind!=='chart') return '按原图的 dBZ 色标追踪回波的强弱和移动方向。雷达波束会受地形遮挡，远离雷达时也可能探测不到低层降水。';
  const guide=chartGuide(p.id)||'按原图图头的有效时刻和图例读图。';
  const pressure=Number(p.id.slice(6));
  if(reference&&pressure>0&&pressure>=reference.ps){
    const alternative=pressure===925?'本站近地冷空气可对照地面站与离地 10 米风。':pressure===850?'在地势较低的上游，仍可对照同层风温追踪冷暖空气的来路。':pressure===700?'在地形以上的上游区域，可比较风羽突变与等高线弯曲，再到更高的有效层追踪当地气流。':'请在该等压面高于地面的区域读图。';
    return reference.name+'附近同时次的'+reference.source+'地面气压约 '+Math.round(reference.ps)+' hPa，'+pressure+' hPa 在该模式格点受地形遮挡。'+alternative;
  }
  return guide;
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
