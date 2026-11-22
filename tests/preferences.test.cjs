'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preferences } = require('../desktop/preferences.cjs');

test('市级、港澳台与补充县的地点偏好在重开后仍有效', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guanxiang-preferences-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  let recent = [];
  for (const id of ['1101', '371002', 'TW10014', 'HK1818224', 'MO11875154', 'CNH-hekang', 'CNH-hean']) {
    recent = [id, ...recent].slice(0, 5);
    const change = {place:id, recent, pinned:false, theme:'dark', closeBehavior:'quit'};
    preferences(directory).set(change);
    const saved = preferences(directory).get();
    for (const [key,value] of Object.entries(change)) assert.deepEqual(saved[key],value);
  }
  const service = preferences(directory);
  const previous = service.get();
  assert.throws(() => service.set({place:'999999'}), /无效/);
  assert.throws(() => service.set({recent:['invalid']}), /无效/);
  assert.deepEqual(preferences(directory).get(), previous);
});

test('旧资料以正常速度回放，保存的倍速在重开后生效', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteodial-playback-rate-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({theme:'dark'}));
  const settings = preferences(dir);
  assert.equal(settings.get().playbackRate, 1);
  settings.set({playbackRate:0.5});
  const reopened = preferences(dir);
  assert.equal(reopened.get().playbackRate, 0.5);
  assert.equal(reopened.get().theme, 'dark');
  for (const invalid of [0, -1, '2', Infinity, 16])
    assert.throws(() => reopened.set({playbackRate:invalid}), /无效/);
  assert.equal(preferences(dir).get().playbackRate, 0.5);
  fs.writeFileSync(path.join(dir,'preferences.json'), JSON.stringify({playbackRate:'fast',theme:'light'}));
  assert.equal(preferences(dir).get().playbackRate, 1);
  assert.equal(preferences(dir).get().theme, 'light');
});
