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
