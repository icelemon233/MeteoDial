'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {parseObservations}=require('../server/cma-stations.cjs');
const {readNational}=require('../server/stations.cjs');
const {productFor,parseIndex,recent,validImage}=require('../server/cma-products.cjs');
const {parseCity}=require('../server/cma-city.cjs');
const {warningRecords}=require('../server/cma-warnings.cjs');
const time='2026-11-22T09:00:00Z', t=Date.parse(time), hour=3600000, station='54511';
function feature(name,units,value,phenomenonTime=time,reportTime=time,id=station) {
  const wigos='0-20000-0-'+id;
  return {properties:{name,units,value,phenomenonTime,reportTime,wigos_station_identifier:wigos,
    reportId:wigos+'-'+reportTime.slice(0,16).replace(/[-:T]/g,'')}};
}
test('CMA SYNOP 按站号和时次组报，核对单位、降水时段及十分钟风',()=>{
  const features=[feature('air_temperature','Celsius',5.9),
    feature('air_temperature','Celsius',20,time,time,'54774'),
    feature('air_temperature','K',279),feature('relative_humidity','%',9999),
    feature('non_coordinate_pressure','hPa',1016.3),feature('pressure_reduced_to_mean_sea_level','hPa',1020.6),
    feature('wind_speed','m/s',1,'2026-11-22T08:50:00Z/'+time),
    feature('wind_direction','deg',221,'2026-11-22T08:50:00Z/'+time),
    feature('total_precipitation_or_total_water_equivalent','kg m-2',0,'2026-11-22T03:00:00Z/'+time),
    feature('total_precipitation_or_total_water_equivalent','kg m-2',12,'2026-11-21T21:00:00Z/'+time),
    feature('total_precipitation_or_total_water_equivalent','kg m-2',5,'2026-11-22T07:00:00Z/'+time),
    feature('wind_speed','m/s',57,'2026-11-22T08:58:00Z/'+time)];
  const data={type:'FeatureCollection',features};
  const record=parseObservations(data,station,t+hour);
  assert.equal(record.temp,5.9); assert.equal(record.fields.wind10min.value,1);
  assert.equal(record.fields.windDirection10min.value,221); assert.equal(record.fields.rain6h.value,0);
  assert.equal(record.fields.rain12h.value,12); assert.equal(record.fields.rain1h,undefined);
  assert.equal(record.fields.rh,undefined);assert.equal(record.fields.seaPressure.value,1020.6);
  assert.equal(record.fields.stationPressure.value,1016.3);assert.equal(parseObservations(data,station,t+3*hour+1),null);
  assert.equal(parseObservations(data,station,t-1),null);
});
test('同站气温优先有效时次，同时次用 CMA，保留较早的正式站报供对照',async()=>{
  const cma={id:station,kind:'national',source:'中国气象局 WIS2',time,temp:5.9};
  const match={id:station,km:8},q={...cma,source:'查天气'};
  assert.equal((await readNational(match,async()=>cma,async()=>q)).source,cma.source);
  const latest=await readNational(match,async()=>cma,async()=>({...q,time:'2026-11-22T10:35:00Z'}));
  assert.equal(latest.source,q.source);assert.equal(latest.cma.time,time);
  assert.equal((await readNational(match,async()=>null,async()=>q)).source,q.source);
  assert.equal(await readNational(match,async()=>null,async()=>null),null);
});
function page(prefix='SEVP_AOC_RDCP_SLDAS3_ECREF_ACHN_L88_PI',folder='RDCP',ext='PNG') {
  const url='https://image.nmc.cn/product/2026/11/22/'+folder+'/'+prefix+'_20261122090000000.'+ext;
  return '<title>天气实况_雷达拼图_全国</title><img id=imgpath src="'+url+'"><div data-time="11/22 17:00" data-img="'+url+'"></div>';
}
test('NMC 原图校验产品、UTC 文件时刻与北京时标签，过时目录不会冒充近期产品',()=>{
  const p=productFor('radar-chinaall'),html=page(),frames=parseIndex(html,p,t);
  assert.equal(frames.length,1);assert.equal(Date.parse(frames[0].time),t);
  assert.equal(parseIndex(html.replace('11/22 17:00','11/22 09:00'),p,t).length,0);
  assert.equal(parseIndex(html,p,t-1).length,0);assert.throws(()=>recent(frames,p,t+25*hour));
  assert.throws(()=>parseIndex(html.replaceAll('image.nmc.cn','elsewhere.local'),p,t));
  assert.throws(()=>parseIndex(page('SEVP_AOC_RDCP_SLDAS3_ECREF_AECN_L88_PI'),p,t));
  assert.throws(()=>parseIndex(page('SEVP_NMC_WESA_SFER_EGH_ACWP_L85_P9','WESA','JPG'),productFor('chart-500'),t));
  assert.equal(validImage(Buffer.from('<html>no image</html>'),'jpeg'),false);
});
test('多张官方原图只能使用共同发布的有效时刻',async()=>{
  const {sharedObservationTimes}=await import('../ui/cma-maps.js'),t2='2026-11-22T12:00:00Z';
  const query=async url=>{
    const id=new URL(url,'http://localhost').searchParams.get('product');
    return {product:id,frames:(id==='chart-500'?[time,t2]:[time]).map(time=>({time}))};
  };
  assert.deepEqual((await sharedObservationTimes(['chart-500','radar-chinaall'],query)).times,[t]);
  await assert.rejects(sharedObservationTimes(['chart-500','radar-chinaall'],async url=>{
    const r=await query(url);return {...r,frames:r.product==='chart-500'?[{time:t2}]:r.frames};
  }),/共同观测时次/);
});
test('官方城市产品独立核对站号、产品时间与有效预报日期，日夜缺报保留缺测',()=>{
  const data={location:{id:station,name:'北京'},lastUpdate:'2026/11/22 17:00',now:{temperature:0,humidity:34,windSpeed:9999},
    daily:[{date:'2026/11/22',high:9999,low:0,nightText:'多云',nightWindScale:'微风'}]};
  assert.equal(parseCity({code:0,data},station,'now',t).temp,0);
  assert.equal(parseCity({code:0,data},station,'now',t).wind,null);
  assert.throws(()=>parseCity({code:0,data},'54774','now',t));
  assert.throws(()=>parseCity({code:0,data},station,'now',t+4*hour));
  const next={...data,lastUpdate:'2026/11/22 20:00'};
  assert.equal(parseCity({code:0,data:next},station,'forecast',t).days[0].high,null);
  assert.equal(parseCity({code:0,data:next},station,'forecast',t).days[0].night,'多云');
  assert.throws(()=>parseCity({code:0,data:next},station,'now',t));
});
test('预警记录保留原标题、地区和原文链接，撤销或解除不当成新预警',()=>{
  const id='21011241600000_20261122163000',row={alertid:id,url:'/publish/alarm/'+id+'.html',
    issuetime:'2026/11/22 16:31',title:'示例气象台解除大风蓝色预警信号'};
  const data={code:0,data:{page:{count:1,list:[row]}}};
  assert.equal(warningRecords(data,'21',t)[0].title,row.title);
  assert.deepEqual(warningRecords(data,'21',t+25*hour),[]);
  assert.throws(()=>warningRecords(data,'11',t));
  assert.throws(()=>warningRecords({code:500,data:{page:{count:0,list:[]}}},'21',t));
});
