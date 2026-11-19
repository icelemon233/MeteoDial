'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const defaults = {
  theme: 'system',
  closeBehavior: 'tray',
  trayNotice: false,
  pinned: true,
  place: '',
  recent: [],
};
const placeIds = new Set(require('../assets/data/places.json').map(([id]) => id));
const validPlace = (value) => placeIds.has(value);
const validators = {
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  closeBehavior: (v) => ['tray', 'quit'].includes(v),
  trayNotice: (v) => typeof v === 'boolean',
  pinned: (v) => typeof v === 'boolean',
  place: (v) => v === '' || validPlace(v),
  recent: (v) => Array.isArray(v) && v.length <= 5 && v.every(validPlace),
};
function preferences(directory) {
  const file = path.join(directory, 'preferences.json');
  let state = { ...defaults };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, test] of Object.entries(validators)) {
      if (test(saved[key])) state[key] = saved[key];
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('无法读取观象偏好。原文件已保留。' + error.message);
  }
  return {
    get: () => ({ ...state }),
    set: (patch) => {
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        !Object.entries(patch).every(([k, v]) => Object.hasOwn(validators, k) && validators[k](v))
      )
        throw new Error('无效的偏好设置');
      const next = { ...state, ...patch };
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify(next), { flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      state = next;
      return { ...state };
    },
  };
}
module.exports = { preferences };
