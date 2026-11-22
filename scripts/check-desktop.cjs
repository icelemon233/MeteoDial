'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright-core');

async function mainPage(app) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const main = app.windows().find((page) => /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()));
    if (main) return main;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('没有找到由观象本地服务加载的应用主窗');
}

async function checkDesktop() {
  const project = path.resolve(__dirname, '..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'guanxiang-desktop-check-'));
  let app;
  try {
    app = await _electron.launch({
      executablePath: process.env.GUANXIANG_TEST_EXE || require('electron'),
      args: process.env.GUANXIANG_TEST_EXE ? [] : [project],
      env: { ...process.env, GUANXIANG_PROFILE: profile },
      timeout: 45000,
    });
    const window = await mainPage(app);
    const errors = [];
    window.on('pageerror', (error) => errors.push(error.message));
    await window.locator('#hour-chart svg, .offline-case').first().waitFor({ timeout: 60000 });
    if (!(await window.locator('#hour-chart svg').count())) await window.locator('.retry').click();
    await window.locator('#hour-chart svg').waitFor({ timeout: 60000 });
    assert.ok((await window.locator('.day-row').count()) >= 9);
    await window.keyboard.press('Control+k');
    await window.locator('#place-query').fill('环翠');
    await window.locator('#results button').first().click();
    await window.locator('#nav [data-nav=cases]').click();
    await window.locator('.case-tile[href="#/cases/bohai"]').click();
    await window.locator('.case-local summary').click();
    assert.equal(await window.locator('.case-local tbody tr').count(), 24);
    assert.equal(await window.locator('.map-panel').count(), 1);
    await window.waitForFunction(() => document.querySelector('#play').getAttribute('aria-pressed') === 'true');
    const first = await window.locator('#frame-slider').inputValue();
    await window.waitForFunction(ix => document.querySelector('#frame-slider').value !== ix, first);
    await window.getByRole('button', { name: '暂停时间轴' }).click();
    for (const count of [1, 2, 4, 1]) {
      await window.getByRole('button', { name: {1: '单图', 2: '双图', 4: '四图'}[count], exact: true }).click();
      await window.waitForFunction(expected => {
        const panels = [...document.querySelectorAll('.map-panel')];
        return panels.length === expected && panels.every(panel => {
          const rect = panel.querySelector('.map-body').getBoundingClientRect();
          return Math.abs(rect.height - rect.width * 9 / 16) < 1 && panel.querySelector('.map-source').textContent.trim();
        });
      }, count);
    }
    const initialTime = await window.locator('#frame-time').innerText();
    await window.locator('#next-frame').click();
    await window.waitForFunction(previous => document.querySelector('#frame-time').textContent !== previous, initialTime);
    const slider = window.locator('#frame-slider');
    await slider.press('End');
    await window.locator('#play').click();
    await window.waitForFunction(() => document.querySelector('#frame-slider').value === '1');
    await slider.press('Home');
    assert.equal(await window.locator('#play').getAttribute('aria-pressed'), 'false');
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await slider.inputValue(), '0');
    await window.locator('.guide-switch').click();
    assert.equal(await window.locator('.reading').count(), 0);
    await window.locator('#nav [data-nav=cases]').click();
    await window.locator('.case-tile[href="#/cases/beijing-snow"]').click();
    await window.waitForFunction(() => document.querySelector('#frame-slider')?.max === '27');
    const snowSlider = window.locator('#frame-slider');
    await snowSlider.press('Home');
    await window.locator('#next-frame').click();
    await window.waitForFunction(() => document.querySelector('#frame-time').textContent.includes('12/10 09:00'));
    assert.equal(await snowSlider.getAttribute('aria-valuetext'), '12/10 09:00');
    assert.equal(await window.locator('#play').getAttribute('aria-pressed'), 'false');
    assert.equal(await window.locator('.time-mark').count(), 28);
    assert.deepEqual(errors, []);
    console.log('区县预报、地点搜索、地图布局及循环回放检查通过');
  } finally {
    if (app) await app.close();
    const resolved = path.resolve(profile);
    if (
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith('guanxiang-desktop-check-')
    ) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
checkDesktop().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
