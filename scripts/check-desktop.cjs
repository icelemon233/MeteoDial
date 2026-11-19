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
    await window.waitForFunction(() =>
      Array.from(document.querySelectorAll('.map-source')).every((el) => el.textContent.trim())
    );
    const initialTime = await window.locator('#frame-time').innerText();
    await window.locator('#next-frame').click();
    assert.notEqual(await window.locator('#frame-time').innerText(), initialTime);
    await window.locator('.guide-switch').click();
    assert.equal(await window.locator('.reading').count(), 0);
    assert.deepEqual(errors, []);
    console.log('区县预报、地点搜索和双图案例回放检查通过');
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
