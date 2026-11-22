'use strict';
const {cached,request} = require('./network.cjs');
const origin='https://www.nmc.cn';
const sourcePage=origin+'/publish/alarm.html';
const autonomous={内蒙古:'内蒙古自治区',广西:'广西壮族自治区',西藏:'西藏自治区',宁夏:'宁夏回族自治区',新疆:'新疆维吾尔自治区'};
function provinceName(place) {
  const name=place[2];
  if (['香港','澳门','台湾'].includes(name)) return null;
  if (Object.hasOwn(autonomous,name)) return autonomous[name];
  return name+(['北京','天津','上海','重庆'].includes(name)?'市':'省');
}
function warningRecords(data,prefix,now=Date.now()) {
  const page=data?.data?.page;
  if (Number(data?.code)!==0 || !Array.isArray(page?.list) || !Number.isInteger(page.count) ||
      (page.count>0&&!page.list.length)) throw Error('中央气象台预警列表格式异常');
  const found=new Map();
  for (const row of page.list) {
    const id=row.alertid;
    if (typeof id!=='string' || !/^\d{8,20}_\d{14}$/.test(id) || !id.startsWith(prefix) ||
        row.url!=='/publish/alarm/'+id+'.html' || typeof row.title!=='string' || !row.title.trim() ||
        !/^\d{4}\/\d\d\/\d\d \d\d:\d\d$/.test(row.issuetime)) throw Error('预警记录与所选省份或原文不符');
    const time=Date.parse(row.issuetime.replaceAll('/','-').replace(' ','T')+':00+08:00');
    if (!Number.isFinite(time)) throw Error('预警记录时间异常');
    if (time<=now && now-time<=86400000)
      found.set(id,{id,title:row.title,time:new Date(time).toISOString(),url:origin+row.url});
  }
  return [...found.values()].sort((a,b)=>b.time.localeCompare(a.time));
}
async function warnings(place) {
  const province=provinceName(place), prefix=place[0].slice(0,2);
  if (!province) throw Object.assign(Error('中央气象台此目录未按所选地区提供记录'),{statusCode:404});
  const result=await cached('nmc-warnings-v1:'+prefix,3*60000,async()=>{
    const params=new URLSearchParams({pageNo:'1',pageSize:'12',signaltype:'',signallevel:'',province});
    const response=await request(origin+'/rest/findAlarm?'+params,{timeout:6000});
    const records=warningRecords(await response.json(),prefix);
    return {value:{province,sourcePage,checked:new Date().toISOString(),records}};
  });
  return {...result,records:result.records.filter(r=>Date.now()-Date.parse(r.time)<=86400000)};
}
module.exports={warnings,warningRecords};
