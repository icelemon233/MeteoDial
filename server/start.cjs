'use strict';
const os = require('node:os'),
  path = require('node:path');
const { startServer } = require('./http.cjs');
startServer(
  process.env.GUANXIANG_CACHE || path.join(os.tmpdir(), 'guanxiang-service-cache'),
  Number(process.env.PORT) || 4173
)
  .then((s) => {
    console.log('观象 ' + s.url);
    process.once('SIGINT', () => s.close());
    process.once('SIGTERM', () => s.close());
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
