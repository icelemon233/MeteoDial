'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchLocation,
  matchFromQuery,
  nationalReading,
  observations,
} = require('../server/stations.cjs');
const { byId } = require('../server/weather.cjs');
const { startServer } = require('../server/http.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

test('按坐标跨区选国家站，搜索地点仍按代表点选站', () => {
  const site = matchLocation(37.505, 122.12);
  assert.equal(site.national.id, '54774');
  assert.equal(site.national.km, 4.4);
  assert.equal(matchLocation(39.8061, 116.4694).national.id, '54511');
  assert.ok(matchFromQuery(byId.get('540630'), new URLSearchParams()).national.km > 100);
  const center = matchFromQuery(byId.get(site.place), new URLSearchParams());
  assert.equal(center.national.id, site.national.id);
  assert.notEqual(center.national.km, site.national.km);
  assert.throws(() => matchLocation(null, 122));
  assert.throws(() => matchLocation(0, 0), /没有收录/);
  assert.throws(() =>
    matchFromQuery(byId.get(site.place), new URLSearchParams('national=anything')),
  );
});
test('各要素按自己的 UTC 时刻校验，保留零雨量，剔除缺测、过期和未来值', () => {
  const now = Date.parse('2026-11-21T08:00:00Z');
  const time = {
    T: '2026-11-21T07:55:00',
    R1h: '2026-11-21T07:50:00',
    P: '2026-11-21T08:05:00',
    WS2m: '2026-11-21T04:59:59',
    WD2m: '2026-11-21T07:50:00',
    RH: '2026-11-21T07:55:00',
  };
  const value = {
    wmo: '54774',
    realtime: { time, T: 2.9, R1h: 0, P: 1012, WS2m: 4, WD2m: 315, RH: 9999 },
  };
  const station = nationalReading(value, '54774', now);
  assert.equal(station.time, '2026-11-21T07:55:00.000Z');
  assert.deepEqual(station.fields.rain1h, { value: 0, time: '2026-11-21T07:50:00.000Z' });
  assert.equal(station.fields.stationPressure, null);
  assert.equal(station.fields.wind2m, null);
  assert.deepEqual(station.fields.windDirection2m, {
    value: 315,
    time: '2026-11-21T07:50:00.000Z',
  });
  assert.equal(station.fields.rh, null);
  assert.equal(nationalReading(value, '54774', now + 3 * 3600000), null);
  assert.throws(() => nationalReading(value, '54511', now));
});
test('国家站缺报或限流时保留原因，并单独标记航空站报', async () => {
  const match = matchLocation(37.505, 122.12);
  const air = { kind: 'aviation', id: 'ZSWH' };
  const missing = await observations(
    match,
    async () => null,
    async () => air,
  );
  assert.equal(missing.closest.id, '54774');
  assert.equal(missing.nationalState, 'empty');
  assert.equal(missing.station, air);
  const failed = await observations(
    match,
    async () => {
      throw Object.assign(Error(), { statusCode: 429 });
    },
    async () => {
      throw Error();
    },
  );
  assert.equal(failed.nationalState, 'unavailable');
  assert.equal(failed.aviationUnavailable, true);
  assert.equal(failed.station, null);
});
test('定位匹配留在本机，配置共享服务时只转交站号和预报点', async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"station":null}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'meteodial-location-test-'));
  const server = await startServer(cache, 0, {
    upstream: 'http://127.0.0.1:' + upstream.address().port,
  });
  try {
    const params = {
      method: 'POST',
      headers: { Origin: server.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 37.505, lon: 122.12 }),
    };
    const response = await fetch(server.url + '/local/nearest', params);
    assert.equal(response.status, 200);
    const match = await response.json();
    assert.equal(match.national.id, '54774');
    assert.deepEqual(requests, []);
    assert.equal(
      (await fetch(server.url + '/local/nearest', { ...params, body: '{"lat":null}' })).status,
      400,
    );
    assert.equal(
      (
        await fetch(server.url + '/local/nearest', {
          ...params,
          headers: { ...params.headers, Origin: 'https://example.org' },
        })
      ).status,
      403,
    );
    const query = new URLSearchParams({
      id: match.place,
      national: match.national.id,
      airports: match.airports.map((s) => s.id).join(','),
    });
    await fetch(server.url + '/api/station?' + query);
    assert.deepEqual(requests, ['/api/station?' + query]);
  } finally {
    server.close();
    upstream.close();
    upstream.closeAllConnections();
    await fs.rm(cache, { recursive: true, force: true });
  }
});
