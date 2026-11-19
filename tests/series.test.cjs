'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const product = require('../installer/inno/product.json');
const brand = require('../assets/brand/manifest.json');

test('发布身份、历史 AppID 和版本化图标在桌面与安装器之间一致', () => {
  assert.equal(pkg.author, 'Cinna');
  assert.equal(pkg.build.productName, product.Name);
  assert.equal(product.Name, 'MeteoDial');
  assert.equal(brand.product, product.Name);
  assert.equal(product.Executable, pkg.build.executableName + '.exe');
  assert.equal(product.Executable, 'Guanxiang.exe');
  assert.equal(product.AppUserModelId, pkg.build.appId);
  assert.equal(pkg.build.appId, 'org.guanxiang.weather');
  assert.equal(pkg.version, brand.version);
  assert.equal(product.ShortcutIcon, 'resources/app-icon-${version}.ico');
  assert.equal(pkg.build.win.target, 'dir');
  assert.ok(pkg.build.extraResources.some((r) => r.to === 'app-icon-${version}.ico'));
  assert.equal(product.DataDirectory, '{userappdata}\\观象');
});

test('图标导出来自同一气压计母图，ICO 小尺寸及日夜场景可核实', () => {
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
  assert.equal(brand.variant, 'weather-barometer');
  for (const [rel, sha] of Object.entries(brand.files)) {
    assert.equal(digest(fs.readFileSync(path.join(root, 'assets', rel))), sha);
  }
  const ico = fs.readFileSync(path.join(root, 'assets/icon.ico'));
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) sizes.push(ico[6 + 16 * i] || 256);
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  const scenes = require('../installer/inno/assets/manifest.json');
  assert.equal(scenes.product, product.Name);
  for (const f of scenes.files) {
    assert.ok(f.width >= 1280 && f.height >= 768);
    assert.equal(digest(fs.readFileSync(path.join(root, 'installer/inno/assets', f.path))), f.sha256);
  }
  assert.notEqual(
    scenes.files.find((f) => f.path === 'scene-day.jpg').sha256,
    scenes.files.find((f) => f.path === 'scene-night.jpg').sha256
  );
});
