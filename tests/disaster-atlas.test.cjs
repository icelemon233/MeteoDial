'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), {gunzipSync}=require('node:zlib');
const archive=require('../assets/data/disasters.json'), catalog=require('../assets/data/catalog.json');
const places=new Map(require('../assets/data/places.json').map(p=>[p[0],p]));
const directory=path.resolve(__dirname,'../assets/cases/disasters');
test('每起重大灾害有独立的真实日期、全国多层天气图、格点变化和来源', () => {
  assert.equal(fs.readdirSync(directory).length,archive.events.length);
  for (const e of archive.events) {
    assert.ok(places.has(e.map.place));
    const b=JSON.parse(gunzipSync(fs.readFileSync(path.join(directory,e.id+'.json.gz'))));
    assert.equal(b.id,e.id); assert.deepEqual(b.dates,[...new Set(b.dates)].sort());
    assert.ok(b.dates.length>=3 && b.dates.includes(b.focus));
    assert.equal(b.dates[0],e.map.from);assert.equal(b.dates.at(-1),e.map.to);
    assert.ok(b.series.days.length>=3);
    assert.ok(b.series.days.every(p=>p.value===null||Number.isFinite(p.value)));
    assert.ok(b.series.days.filter(p=>p.value!==null).length>=2,e.id+' 缺少参考格点曲线');
    assert.ok(new Set(b.layers).size>=4);
    for (const date of b.dates) for (const layer of b.layers) {
      const g=b.frames[date][layer];
      assert.equal(g.layer,layer);assert.equal(g.valid,date+'T00:00:00.000Z');
      assert.equal(g.values.length,g.nx*g.ny);assert.ok(g.source&&g.period&&g.resolution);
      assert.ok(g.values.some(Number.isFinite));
      assert.ok(g.bbox[0]<=73 && g.bbox[1]<=4 && g.bbox[2]>=135 && g.bbox[3]>=54);
      if (layer==='wind850'||layer==='wind10') assert.equal(g.v.length,g.values.length);
      if (['height500','wind850','moisture700'].includes(layer)) {
        assert.equal(g.terrainMask.length,g.values.length);
        assert.ok(g.terrainMask.every((m,i)=>!m || g.values[i]===null));
      }
      if (layer==='rainDay') assert.equal(g.type,'雨量站格点分析');
      else assert.equal(g.type,e.year===2026?'分析场日平均':'再分析日平均');
    }
  }
});
test('旧专题只归入对应重大事件，移除普通教学过程',()=>{
  const chapters=archive.events.flatMap(e=>e.chapters||[]);
  assert.deepEqual([...chapters].sort(),catalog.map(c=>c.id).sort());
  assert.deepEqual(archive.events.find(e=>e.id==='2022-s3').chapters,['coldpool','front']);
  assert.deepEqual(archive.events.find(e=>e.id==='2023-c3').chapters,['bohai']);
  for(const id of ['beijing-snow','bohai22','terrain','belts']) {
    assert.ok(!chapters.includes(id));
    assert.ok(!fs.existsSync(path.resolve(directory,'..',id)));
  }
});
