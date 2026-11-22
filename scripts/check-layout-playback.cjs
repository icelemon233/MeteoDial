'use strict';
const assert = require('node:assert/strict');

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return {promise, release};
}

async function checkLayoutPlayback(page) {
  const origin = new URL(page.url()).origin;
  await page.goto(origin + '/?layout-playback#/cases/beijing-snow?time=2023-12-10T00%3A00%3A00Z');
  const speed = page.getByRole('combobox', {name:'播放速度'});
  const layout = count => page.locator('.map-layout button[data-count="' + count + '"]').click();
  const wait = (fn, arg, timeout = 7000) => page.waitForFunction(fn, arg, {timeout, polling:25});
  const frame = () => page.locator('#frame-slider').inputValue().then(Number);
  await wait(() => document.querySelector('.map-source')?.textContent.includes('12/10 08:00'));
  await page.evaluate(() => {
    const title = document.querySelector('#frame-time');
    window.layoutFrames = [];
    document.querySelector('.map-layout').addEventListener('click', () => {
      window.layoutSwitchFrom = Number(document.querySelector('#frame-slider').value);
    }, true);
    new MutationObserver(() => {
      const panels = [...document.querySelectorAll('.map-panel')];
      const time = title.textContent.split(' · ')[0];
      window.layoutFrames.push({index:Number(document.querySelector('#frame-slider').value), at:performance.now(), count:panels.length,
        aligned:panels.every(p => p.dataset.layer && p.querySelector('.map-source').textContent.includes(time)),
        rate:document.querySelector('#playback-rate').value});
    }).observe(title, {childList:true, subtree:true});
  });
  await speed.selectOption('4');
  await page.locator('#play').click();
  await wait(() => window.layoutFrames.length >= 2);
  const current = gate(), primary = gate(), fourth = gate();
  let blockCurrent = true, sawCurrent = false, primaryReads = 0, fourthReads = 0, slowLead = -1;
  const pattern = '**/beijing-snow/*-*.json';
  const intercept = async route => {
    const [, layer, lead] = /\/([a-z0-9]+)-(\d+)\.json$/.exec(route.request().url());
    if (blockCurrent && layer === 'temp2' && Number(lead) === await page.evaluate(() => window.layoutSwitchFrom)) {
      sawCurrent = true;
      await current.promise;
    } else if (Number(lead) === slowLead) {
      if (layer === 'wind925') { primaryReads++; await primary.promise; }
      if (layer === 'temp2') { fourthReads++; await fourth.promise; }
    }
    await route.continue().catch(() => {});
  };
  await page.route(pattern, intercept);
  try {
    await layout(4);
    // A slow read of the already displayed time must not hold up newer complete frames.
    await wait(() => window.layoutFrames.filter(f => f.count === 4 && f.aligned).length >= 4);
    assert.ok(sawCurrent, '未覆盖新增面板的慢请求');
    blockCurrent = false;
    current.release();
    slowLead = (await frame() + 6) % 28;
    await wait(previous => Number(document.querySelector('#frame-slider').value) === previous,
      (slowLead + 27) % 28);
    await wait(() => document.querySelector('#frame-time').hasAttribute('data-buffering'));
    assert.ok(primaryReads && fourthReads);
    await layout(1);
    await speed.selectOption('2');
    primary.release();
    // Keep the removed fourth request held until two verified single frames have actually painted.
    await wait(next => window.layoutFrames.some(f => f.count === 1 && f.rate === '2' && f.aligned && f.index === next),
      (slowLead + 1) % 28);
    assert.equal(primaryReads, 1, '切回单图重复读取了保留图层');
    const slowPair = await page.evaluate(() => window.layoutFrames.filter(f => f.count === 1 && f.rate === '2').slice(-2));
    const singleFrameMs = slowPair[1].at - slowPair[0].at;
    fourth.release();
    await speed.selectOption('4');
    // A compositor animation may be suspended when a pane is off screen.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const fades = document.querySelector('canvas.current').getAnimations();
        if (!fades.length) return;
        fades.forEach(f => f.pause());
        window.pausedLayoutFade = window.layoutFrames.length;
        observer.disconnect();
      });
      observer.observe(document.querySelector('#frame-time'), {childList:true});
    });
    await wait(() => window.pausedLayoutFade && window.layoutFrames.length >= window.pausedLayoutFade + 3);
    await layout(4);
    await layout(2);
    await layout(1);
    assert.equal(await speed.inputValue(), '4');
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true');
    await page.locator('#frame-slider').press('Home');
    await layout(4);
    await layout(1);
    await wait(() => document.querySelector('.map-source').textContent.includes('12/10 08:00'));
    await page.waitForTimeout(550);
    assert.equal(await frame(), 0);
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    const records = await page.evaluate(() => window.layoutFrames);
    const fourFrames = records.filter(f => f.count === 4 && f.aligned && f.rate === '4').slice(0,4);
    const average = (fourFrames.at(-1).at - fourFrames[0].at) / 3;
    assert.ok(average < 350 && singleFrameMs / average > 1.45, '四图 4× 和单图 2× 的实测速度不符');
    return {fourFrameMs:Math.round(average), singleFrameMs:Math.round(singleFrameMs), retainedPrimaryRequests:primaryReads};
  } finally {
    current.release(); primary.release(); fourth.release();
    await page.unroute(pattern, intercept);
  }
}
module.exports = {checkLayoutPlayback};
