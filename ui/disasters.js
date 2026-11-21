import { $, escape, get, icon, safeLink } from './base.js';

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
export async function showDisasters({ main, ctx, params }, id) {
  const data = await loadArchive();
  if (!ctx.active) return;
  const listing = '#/cases/disasters';
  const suffix = params.size ? '?' + params.toString() : '';
  if (id) {
    const event = data.events.find((e) => e.id === id);
    if (!event) throw Error('档案中没有这起事件');
    const year = data.years[event.year];
    const source = event.source || year.source;
    const detailLink = event.page ? source.split('#')[0] + '#page=' + event.page : source;
    $('#breadcrumb h1').textContent = event.title;
    $('#breadcrumb a').href = listing + suffix;
    main.innerHTML = `<article class="event-article panel"><div class="event-heading"><div class="muted">${event.year} · ${escape(event.kind)}</div><h2>${escape(event.title)}</h2></div><dl class="event-copy"><dt>过程与影响</dt><dd>${escape(event.fact)}</dd><dt>怎样读这次过程</dt><dd>${escape(event.analysis)}</dd></dl><div class="event-links">${event.replay ? `<a class="btn" href="#/cases/${escape(event.replay)}">${icon('layers', 16)}在双图上回放</a>` : ''}${safeLink(detailLink, event.sourceTitle || year.label)}${event.extraSource ? safeLink(event.extraSource, '过程核查资料') : ''}</div></article>`;
    return;
  }
  const yearIds = Object.keys(data.years)
    .map(Number)
    .sort((a, b) => b - a);
  const kinds = [...new Set(data.events.map((e) => e.kind))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  main.innerHTML = `<div class="archive-filter"><input id="event-search" type="search" placeholder="搜索地区、事件或年份" aria-label="搜索灾害档案"><select aria-label="年份" id="event-year"><option value="">全部年份</option>${yearIds.map((y) => `<option>${y}</option>`).join('')}</select><select aria-label="灾种" id="event-kind"><option value="">全部灾种</option>${kinds.map((v) => `<option>${escape(v)}</option>`).join('')}</select></div><div class="archive-summary"><span id="event-count" aria-live="polite"></span><details><summary>收录范围</summary><p>${escape(data.scope)}</p></details></div><div id="event-list"></div>`;
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
      const haystack = [e.year, e.title, e.fact, e.kind].join(' ').toLowerCase();
      return (
        (!year.value || e.year === Number(year.value)) &&
        (!kind.value || e.kind === kind.value) &&
        terms.every((term) => haystack.includes(term))
      );
    });
    $('#event-count').textContent = events.length + ' 条过程记录';
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
