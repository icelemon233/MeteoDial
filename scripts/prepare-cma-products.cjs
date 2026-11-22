'use strict';
// Build the small product directory from the National Meteorological Center's
// public navigation. Weather images and station reports are fetched on demand.
const fs = require('node:fs/promises');
const path = require('node:path');
const origin = 'https://www.nmc.cn';
const national = '/publish/radar/chinaall.html';
const beijing = '/publish/radar/bei-jing/da-xing.htm';
const surface = '/publish/observations/china/dm/weatherchart-h000.htm';
async function page(url) {
  const response = await fetch(new URL(url,origin), {signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw Error(url+' '+response.status);
  return response.text();
}
function navigation(html, heading) {
  const section = [...html.matchAll(/<div class="p-nav nav\d+">[\s\S]*?<\/ul>/g)]
    .find(([text])=>text.includes(heading))?.[0];
  if (!section) throw Error('Missing directory '+heading);
  return [...section.matchAll(/<a\b[^<>]*href="(\/publish\/[a-zA-Z0-9_./-]+)"[^<>]*>([^<]+)<\/a>/g)]
    .map(([,page,label])=>({page,label:label.trim()}));
}
async function main() {
  const [radar,single,chart] = await Promise.all([page(national),page(beijing),page(surface)]);
  const products=navigation(radar,'区域：').map(x=>({...x,id:'radar-'+path.posix.basename(x.page,'.html'),kind:'radar',group:'雷达拼图'}));
  products.unshift({id:'fy4b',kind:'satellite',group:'卫星云图',label:'风云四号B星',page:'/publish/satellite/fy4b-visible.htm'});
  const levels=navigation(chart,'层次：').filter(x=>/weatherchart-h\d{3}\.htm$/.test(x.page));
  for (const x of levels) {
    const code=x.page.match(/h(\d{3})\.htm$/)[1];
    products.push({...x,id:'chart-'+code,kind:'chart',group:'天气分析图',label:code==='000'?'地面':Number(code)+' hPa'});
  }
  const provinces=navigation(single,'省份/市');
  for (const province of provinces) {
    const html=province.page===beijing?single:await page(province.page);
    const sites=navigation(html,'城市/地区');
    for (const x of sites) {
      const slug=x.page.replace(/\/index\.html?$/,'').replace(/\.html?$/,'').split('/').slice(-2).join('-');
      products.push({...x,id:'site-'+slug,kind:'station',group:province.label});
    }
  }
  if (new Set(products.map(p=>p.id)).size!==products.length || products.length<40 ||
      !products.some(p=>p.id==='chart-500') || !products.some(p=>p.id==='radar-chinaall'))
    throw Error('Incomplete or ambiguous NMC directory');
  const records=products.map(({id,kind,group,label,page})=>JSON.stringify({id,kind,group,label,page}));
  await fs.writeFile(path.join(__dirname,'../assets/data/cma-products.json'),'[\n  '+records.join(',\n  ')+'\n]\n');
  console.log(provinces.length+' regions, '+products.length+' products');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
