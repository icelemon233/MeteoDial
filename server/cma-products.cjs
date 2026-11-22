'use strict';
const {cached,request} = require('./network.cjs');
const catalog = new Map(require('../assets/data/cma-products.json').map(p=>[p.id,p]));
const origin = 'https://www.nmc.cn';
const hour = 3600000;
function attributes(tag) {
  const values = Object.create(null);
  for (const [,key,a,b,c] of tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g))
    values[key.toLowerCase()] = (a??b??c).replaceAll('&amp;','&');
  return values;
}
function productFor(id) {
  const product=catalog.get(id);
  if (!product) throw Object.assign(Error('未收录这项中央气象台产品'),{statusCode:400});
  return product;
}
function transmission(link,product) {
  let url;
  try { url=new URL(link); } catch { return null; }
  if (url.origin!=='https://image.nmc.cn' || url.username || url.password) return null;
  const file=url.pathname.match(/^\/product\/\d{4}\/\d\d\/\d\d\/(WESA|RDCP|WXBL)\/(?:medium\/)?(SEVP_[A-Z0-9_]+)_(\d{12})00000\.(PNG|JPG)$/i);
  if (!file) return null;
  const [,folder,series,digits,ext]=file;
  if (product.kind==='chart') {
    if (folder!=='WESA' || !series.endsWith('_L'+product.id.slice(6,8)+'_P9')) return null;
  } else if (product.kind==='satellite') {
    if (folder!=='WXBL'||!series.includes('_NSMC_WXBL_FY4B_')) return null;
  } else if (folder!=='RDCP' || (product.kind==='station' && !/_AZ\d+_/.test(series)) ||
      (product.id==='radar-chinaall' && !series.includes('_ACHN_'))) return null;
  const utc=digits.replace(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)/,'$1-$2-$3T$4:$5:00.000Z');
  const t=Date.parse(utc);
  if (!Number.isFinite(t)||new Date(t).toISOString()!==utc) return null;
  const bj=new Date(t+8*hour).toISOString();
  return {series,t,time:utc,local:bj.slice(5,10).replace('-','/')+' '+bj.slice(11,16),
    image:url.href,format:ext.toLowerCase()==='png'?'png':'jpeg'};
}
function parseIndex(html,product,now=Date.now()) {
  const title=html.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  if (['radar','station'].includes(product.kind) && !title?.endsWith(product.label)) throw Error('雷达页面与所选地区不符');
  const primary=attributes([...html.matchAll(/<img\b[^<>]*>/gi)].map(m=>m[0]).find(t=>attributes(t).id==='imgpath')||'');
  const first=transmission(primary.src,product);
  if (!first) throw Error('中央气象台尚未公布该产品原图');
  const found=new Map(), maxAge=(product.kind==='chart'?6*24:24)*hour;
  for (const [tag] of html.matchAll(/<div\b[^<>]*\bdata-img\s*=[^<>]*>/gi)) {
    const attr=attributes(tag), frame=transmission(attr['data-img'],product);
    if (!frame || frame.series!==first.series || attr['data-time']!==frame.local ||
        frame.t>now || now-frame.t>maxAge) continue;
    found.set(frame.time,{time:frame.time,image:frame.image,format:frame.format});
  }
  return [...found.values()].sort((a,b)=>a.time.localeCompare(b.time));
}
function recent(frames,product,now) {
  const maxAge=(product.kind==='chart'?6*24:24)*hour;
  const available=frames.filter(f=>{const age=now-Date.parse(f.time);return age>=0&&age<=maxAge;});
  if (!available.length)
    throw Object.assign(Error(product.kind==='chart'?'近六天没有该分析图的可用时次':'近 24 小时没有该产品的可用时次'),{statusCode:404});
  return available;
}
async function indexFor(product) {
  const result=await cached('nmc-index-v1:'+product.id,(product.kind==='chart'?10:2)*60000,async()=>{
    const response=await request(origin+product.page,{timeout:8500});
    const frames=parseIndex(await response.text(),product);
    recent(frames,product,Date.now());
    return {value:{frames}};
  },{stale:product.kind==='chart'?12*hour:hour});
  return recent(result.frames,product,Date.now());
}
async function productTimes(id) {
  const product=productFor(id),frames=await indexFor(product);
  const latest=frames.at(-1).time;
  const lag=product.kind==='chart'?(id==='chart-000'?8:20)*hour:2*hour;
  return {product:id,latest,delayed:Date.now()-Date.parse(latest)>lag,frames:frames.map(({time})=>({time}))};
}
function validImage(bytes,format) {
  if (bytes.length<32 || bytes.length>10*1024*1024) return false;
  return format==='png'
    ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) &&
      bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0 &&
      bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND'
    : bytes.readUInt16BE(0)===0xffd8 && bytes.readUInt16BE(bytes.length-2)===0xffd9;
}
async function productImage(id,time) {
  const product=productFor(id), t=Date.parse(time);
  if (!Number.isFinite(t)||t>Date.now()) throw Object.assign(Error('请选择已发布的原图时次'),{statusCode:400});
  const valid=new Date(t).toISOString();
  return cached('nmc-original-v1:'+id+':'+valid,24*hour,async()=>{
    const frame=(await indexFor(product)).find(f=>f.time===valid);
    if (!frame) throw Object.assign(Error('所选时次没有这项中央气象台原图'),{statusCode:404});
    const response=await request(frame.image,{timeout:12000});
    const final=transmission(response.url,product);
    if (!final || final.series!==transmission(frame.image,product).series || final.time!==valid ||
        Number(response.headers.get('content-length'))>10*1024*1024) throw Error('原图身份或大小异常');
    const bytes=Buffer.from(await response.arrayBuffer());
    if (!validImage(bytes,frame.format)) throw Error('中央气象台返回的原图不完整');
    const name=product.kind==='station'?product.group+' · '+product.label:product.label;
    return {value:{product:id,externalImage:true,source:'中央气象台 · '+name,sourcePage:origin+product.page,
      type:{chart:'天气分析图',station:'单站雷达',radar:'雷达拼图',satellite:'卫星云图'}[product.kind],valid,
      image:'data:image/'+frame.format+';base64,'+bytes.toString('base64')}};
  });
}
module.exports={productFor,parseIndex,recent,validImage,productTimes,productImage};
