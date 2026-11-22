import {get,escape,fmtNum,windDir,validText,safeLink,openDialog,closeButton} from './base.js';
export function stationTable(s) {
  const rows=[['气温',s.temp,'°C',s.time]];
  const labels=[
    ['rh','相对湿度','%'],['dewpoint','露点','°C'],
    ['wind2m','两分钟平均风速','m/s'],['windDirection2m','两分钟平均风向','°','wind2m'],
    ['wind10min','十分钟平均风速','m/s'],['windDirection10min','十分钟平均风向','°','wind10min'],
    ['stationPressure','本站气压','hPa'],['seaPressure','海平面气压','hPa'],['visibility','水平能见度','m'],
    ['rain1h','过去一小时降水','mm'],['rain6h','过去六小时降水','mm'],['rain12h','过去十二小时降水','mm'],['rain24h','过去二十四小时降水','mm'],
  ];
  for (const [key,label,unit,wind] of labels) {
    if (!Object.hasOwn(s.fields||{},key)) continue;
    const f=s.fields[key];
    rows.push([label,f?.value,unit,f?.time,wind&&s.fields[wind]]);
  }
  const body=rows.map(([name,value,unit,time,speed])=>{
    let reading='—';
    if (Number.isFinite(value)) {
      if (unit==='°') reading=speed?.value===0&&speed.time===time?'静风':windDir(value)+'（'+fmtNum(value)+'°）';
      else reading=fmtNum(value,unit==='%'||unit==='m'?0:1)+' '+unit;
    }
    return '<tr><th scope="row">'+name+'</th><td>'+reading+'</td><td>'+(time?validText(time):'—')+'</td></tr>';
  }).join('');
  return '<table class="station-readings"><thead><tr><th>要素</th><th>实测值</th><th>观测时间（北京时）</th></tr></thead><tbody>'+body+'</tbody></table>';
}
export function showCity(place,query,ctx) {
  openDialog('<div class="modal-head"><h2>官方城市实况与预报</h2>'+closeButton()+'</div>'+
    '<div class="city-product" role="status">正在读取中国气象局城市产品…</div>',dialog=>{
    const box=dialog.querySelector('.city-product');
    async function load(){
      try {
        const data=await get('/api/cma-city?'+query,ctx.signal);
        if (!ctx.active||!box.isConnected||!dialog.open) return;
        const current=data.now,forecast=data.forecast,location=current||forecast;
        const sub='<p class="muted">'+escape(location.name)+' · '+escape(data.id)+' · 中国气象局</p>';
        const details=current?['气温 '+fmtNum(current.temp,1)+'℃',Number.isFinite(current.rh)&&'相对湿度 '+fmtNum(current.rh)+'%',
          Number.isFinite(current.wind)&&escape(current.direction||'风速')+' '+fmtNum(current.wind,1)+' m/s'].filter(Boolean).join('　'):'';
        const now=current?'<h3>城市实况</h3><p>'+details+'</p><p class="muted">产品更新时间 '+validText(current.time)+
          ' · 北京时'+(current.offline?' · 缓存':'')+'</p>':'<p>此站号暂无近期城市实况。</p>';
        const weatherCell=(label,wind)=>escape(label||'—')+(wind?'<small>'+escape(wind)+'</small>':'');
        const temperature=v=>Number.isFinite(v)?fmtNum(v)+'°':'—';
        const days=forecast?'<h3>逐日预报</h3><p class="muted">产品标注时次 '+validText(forecast.time)+' · 北京时'+
          (forecast.offline?' · 缓存':'')+'</p><table class="station-readings"><thead><tr><th>日期</th><th>白天</th><th>夜间</th><th>最高 / 最低</th></tr></thead><tbody>'+
          forecast.days.map(d=>'<tr><th scope="row">'+escape(d.date.slice(5).replace('-','/'))+'</th><td>'+weatherCell(d.day,d.dayWind)+
            '</td><td>'+weatherCell(d.night,d.nightWind)+'</td><td>'+temperature(d.high)+' / '+temperature(d.low)+'</td></tr>').join('')+
          '</tbody></table>':'<p>此站号暂无有效的逐日城市预报。</p>';
        box.innerHTML=sub+now+days+safeLink(data.sourcePage,'中国气象局城市产品原页');
      } catch {
        if (!ctx.active||!box.isConnected||!dialog.open) return;
        box.innerHTML='<p>'+escape(place[1])+'附近的参考站号暂无可用的官方城市产品。</p><button class="btn">重试</button>';
        box.querySelector('button').onclick=()=>{box.textContent='正在读取…';void load();};
      }
    }
    void load();
  });
}
export function showWarnings(place,ctx) {
  const page='https://www.nmc.cn/publish/alarm.html';
  openDialog('<div class="modal-head"><h2>'+escape(place[2])+'预警发布记录</h2>'+closeButton()+'</div>'+
    '<div class="warning-records" role="status">正在读取中央气象台发布记录…</div>'+safeLink(page,'中央气象台预警原页'),dialog=>{
    const box=dialog.querySelector('.warning-records');
    async function load(){
      try {
        const data=await get('/api/cma-warnings?id='+encodeURIComponent(place[0]),ctx.signal);
        if (!ctx.active||!box.isConnected||!dialog.open) return;
        box.innerHTML=data.records.length
          ? '<p class="muted">近 24 小时的发布记录 · 北京时间</p><ul>'+data.records.map(r=>
            '<li><time>'+validText(r.time)+'</time>'+safeLink(r.url,r.title)+'</li>').join('')+'</ul>'
          : '<p>'+escape(data.province)+'近 24 小时的列表未返回预警发布记录。</p>';
      } catch {
        if (!ctx.active||!box.isConnected||!dialog.open) return;
        box.innerHTML='<p>中央气象台预警列表暂时无法读取。</p><button class="btn">重试</button>';
        box.querySelector('button').onclick=()=>{box.textContent='正在读取…';void load();};
      }
    }
    void load();
  });
}
