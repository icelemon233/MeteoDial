'use strict';
const http = require('node:http'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { forecast, stationFor, byId } = require('./weather.cjs');
const { fields, readGrid, latestRun } = require('./grids.cjs');
const { configureCache, pruneCache, request } = require('./network.cjs');
const { satellite, cyclones, radar, radarIndex } = require('./sky.cjs');
const ROOT = path.join(__dirname, '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const H = 36e5;
async function api(url) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/forecast':
      return forecast(q.get('id'));
    case '/api/station': {
      const p = byId.get(q.get('id'));
      if (!p) throw Error('地点不存在');
      return { station: await stationFor(p) };
    }
    case '/api/run':
      return latestRun();
    case '/api/grid': {
      const run = Date.parse(q.get('run')),
        lead = Number(q.get('lead')),
        layer = q.get('layer');
      if (
        !Number.isFinite(run) ||
        run % (6 * H) !== 0 ||
        run > Date.now() ||
        Date.now() - run > 6 * 864e5 ||
        !Number.isInteger(lead) ||
        lead < 0 ||
        lead > 240 ||
        lead % 3 !== 0 ||
        !Object.hasOwn(fields, layer)
      )
        throw Error('请选择有效的预报图层和时次');
      return readGrid(run, lead, layer, 'asia');
    }
    case '/api/satellite': {
      const t = Date.parse(q.get('time'));
      if (!Number.isFinite(t)) throw Error('无效时刻');
      return satellite(t, q.get('region') || 'jpn');
    }
    case '/api/cyclones':
      return cyclones();
    case '/api/radar-times':
      return radarIndex();
    case '/api/radar':
      return radar(Date.parse(q.get('time')));
    default:
      throw Object.assign(Error('此接口不存在'), { statusCode: 404 });
  }
}
const routes = new Set([
  '/api/forecast',
  '/api/station',
  '/api/run',
  '/api/grid',
  '/api/satellite',
  '/api/cyclones',
  '/api/radar-times',
  '/api/radar',
]);
function serviceBase(value) {
  if (!value) return null;
  const endpoint = new URL(value);
  const local =
    endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (!local && endpoint.protocol !== 'https:') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error('数据服务地址须使用 HTTPS，或本机 HTTP');
  return endpoint.origin + endpoint.pathname.replace(/\/$/, '');
}
async function startServer(cacheDir, port = 0, { upstream = null } = {}) {
  const remote = serviceBase(upstream);
  configureCache(cacheDir);
  void pruneCache().catch(() => {});
  const server = http.createServer(async (req, res) => {
    try {
      const host = '127.0.0.1:' + server.address().port;
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== 'http://' + host) ||
        req.method !== 'GET'
      ) {
        res.writeHead(403);
        return res.end();
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
      );
      const url = new URL(req.url, 'http://' + host);
      if (url.pathname.startsWith('/api/')) {
        if (!routes.has(url.pathname)) {
          res.writeHead(404);
          return res.end();
        }
        const payload = remote
          ? await (await request(remote + url.pathname + url.search, { timeout: 45000 })).json()
          : await api(url);
        if (res.destroyed) return;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', mime['.json']);
        return res.end(JSON.stringify(payload));
      }
      const rel = decodeURIComponent(url.pathname === '/' ? '/ui/index.html' : url.pathname).slice(1);
      if (
          !/^(ui\/|assets\/(?:data\/|cases\/|brand\/app-icon-(?:32|256)\.png$|icon\.ico$))/.test(rel) ||
        rel.includes('..') ||
        rel.includes('\\') ||
        rel.includes('\0')
      ) {
        res.writeHead(404);
        return res.end();
      }
      const ext = path.extname(rel);
      if (!mime[ext]) {
        res.writeHead(404);
        return res.end();
      }
      const content = await fs.readFile(path.join(ROOT, rel));
      res.setHeader('Content-Type', mime[ext]);
      res.setHeader('Cache-Control', rel.startsWith('assets/') ? 'private, max-age=3600' : 'no-cache');
      res.end(content);
    } catch (err) {
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(err.code === 'ENOENT' || err.statusCode === 404 ? 404 : 502, {
          'Content-Type': mime['.json'],
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: err.code === 'ENOENT' ? '没有找到此资料' : err.message || '数据暂不可用',
          })
        );
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
module.exports = { startServer, serviceBase };
