import { $, escape, get, icon, safeLink } from './base.js';
import { showMaps } from './viewer.js';
import { overview } from './disaster-analysis.js';

let archive;
function loadArchive() {
  return (archive ||= get('/assets/data/disasters.json').catch((error) => {
    archive = null;
    throw error;
  }));
}
function termsFor(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/(20\d{2}|暴雨|洪涝|冻雨|冰冻|寒灾|寒潮|台风|沙尘|高温|干旱|降雪|暴雪)/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word === '寒灾' ? '低温' : word));
}
export async function showDisasters(env, id) {
  const { main, ctx, params, catalog, byId } = env;
  const data = await loadArchive();
  if (!ctx.active) return;
  const listing = '#/cases';
  const filters = new URLSearchParams(params);
  filters.delete('time');
  filters.delete('section');
  filters.delete('evidence');
  const filterSuffix = filters.size ? '?' + filters : '';
  if (id) {
    const event = data.events.find(e => e.id === id || e.chapters?.includes(id));
    if (!event) {
      if (!['beijing-snow','bohai22','terrain','belts'].includes(id)) throw Error('没有找到这起灾害事件');
      history.replaceState(null,'',listing+filterSuffix);
      $('#breadcrumb').innerHTML='<h1>重大灾害分析</h1>';
      return showDisasters(env);
    }
    const year = data.years[event.year];
    const source = event.source || year.source;
    const detailLink = event.page ? source.split('#')[0] + '#page=' + event.page : source;
    $('#breadcrumb h1').textContent = event.title;
    $('#breadcrumb a').href = listing + filterSuffix;
    const base=listing+'/'+event.id;
    const selected = event.chapters?.includes(id) ? id : params.get('section');
    const chapter = event.chapters?.includes(selected) && catalog.find(c=>c.id===selected);
    const link = (section, time) => {
      const q=new URLSearchParams(filters);
      if (section) q.set('section',section);
      if (time) q.set('time',time);
      return base+(q.size?'?'+q:'');
    };
    const target = new URL(link(chapter?.id, params.get('time')).slice(1), location.origin);
    if (params.has('evidence')) target.searchParams.set('evidence', params.get('evidence'));
    history.replaceState(null, '', '#' + target.pathname + target.search);
    main.innerHTML='<p class="loading" role="status">读取过程天气图…</p>';
    let analysis;
    if (chapter) analysis={...chapter};
    else {
      const bundle=await get('/assets/cases/disasters/'+event.id+'.json.gz',ctx.signal);
      if (!ctx.active) return;
      analysis=overview(event,bundle,byId.get(event.map.place),detailLink);
    }
    analysis.layers = [
      ...new Set([
        ...analysis.layers,
        'heightWide500',
        ...(analysis.atlas
          ? [
              'div850',
              'specific850',
              'specific700',
              'specific500',
              'flux850',
              'flux700',
              'flux500',
              'vort850',
              'vort700',
              'vort500',
            ]
          : []),
      ]),
    ];
    analysis.event=event;
    analysis.report=detailLink;
    analysis.reportName=event.sourceTitle||year.label;
    if (event.chapters?.length) {
      analysis.sections=[{label:'过程全景',href:link(null),active:!chapter},...event.chapters.map(key=>({
        label:catalog.find(c=>c.id===key).title,href:link(key),active:key===chapter?.id
      }))];
    }
    return showMaps(env,analysis);
  }
  const yearIds = Object.keys(data.years)
    .map(Number)
    .sort((a, b) => b - a);
  const kinds = [...new Set(data.events.map((e) => e.kind))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  main.innerHTML = `<div class="archive-filter"><input id="event-search" type="search" placeholder="搜索地区、事件或年份" aria-label="搜索重大灾害"><select aria-label="年份" id="event-year"><option value="">全部年份</option>${yearIds.map((y) => `<option>${y}</option>`).join('')}</select><select aria-label="灾种" id="event-kind"><option value="">全部灾种</option>${kinds.map((v) => `<option>${escape(v)}</option>`).join('')}</select></div><div class="archive-summary"><span id="event-count" aria-live="polite"></span><details><summary>收录范围</summary><p>${escape(data.scope)}</p></details></div><div id="event-list"></div>`;
  const search = $('#event-search'),
    year = $('#event-year'),
    kind = $('#event-kind'),
    list = $('#event-list');
  search.value = params.get('q') || '';
  year.value = yearIds.includes(Number(params.get('year'))) ? params.get('year') : '';
  kind.value = kinds.includes(params.get('kind')) ? params.get('kind') : '';
  function filter() {
    const terms = termsFor(search.value);
    const query = new URLSearchParams();
    if (terms.length) query.set('q', search.value.trim());
    if (year.value) query.set('year', year.value);
    if (kind.value) query.set('kind', kind.value);
    const ending = query.size ? '?' + query.toString() : '';
    history.replaceState(null, '', listing + ending);
    const events = data.events.filter((e) => {
      const haystack = [e.year, e.title, e.fact, e.kind, byId.get(e.map.place)?.[1],
        ...(e.chapters || []).map(key => catalog.find(c=>c.id===key)?.title)].join(' ').toLowerCase();
      return (
        (!year.value || e.year === Number(year.value)) &&
        (!kind.value || e.kind === kind.value) &&
        terms.every((term) => haystack.includes(term))
      );
    });
    $('#event-count').textContent = events.length + ' 起灾害事件';
    const sections = [];
    for (const y of yearIds) {
      const group = events.filter((e) => e.year === y);
      if (!group.length) continue;
      const record = data.years[y];
      const source = record.chapterPage
        ? record.source + '#page=' + record.chapterPage
        : record.source;
      sections.push(
        `<section class="event-year panel"><div class="section-top"><h2>${y} 年</h2>${safeLink(source, record.label)}</div>${group.map((e) => `<a class="event-row" href="${listing}/${escape(e.id)}${escape(ending)}"><span>${escape(e.kind)}</span><b>${escape(e.title)}</b>${icon('right', 14)}</a>`).join('')}</section>`,
      );
    }
    list.innerHTML =
      sections.join('') || '<p class="loading">没有匹配的事件，可更换关键词或筛选条件。</p>';
  }
  search.oninput = filter;
  year.onchange = kind.onchange = filter;
  filter();
}
