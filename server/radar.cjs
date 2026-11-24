'use strict';
const { cached, request } = require('./network.cjs');
const { renderObservation } = require('./satellite.cjs');
const bucket = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/',
  web = 'https://www.cwa.gov.tw/Data/',
  H = 3600000;
const bjt = (t) => new Date(t + 8 * H).toISOString().replace(/[-:T]/g, '').slice(0, 12);
function timeOf(s) {
  if (!/^\d{12}$/.test(s)) return NaN;
  const t = Date.parse(
    s.slice(0, 4) +
      '-' +
      s.slice(4, 6) +
      '-' +
      s.slice(6, 8) +
      'T' +
      s.slice(8, 10) +
      ':' +
      s.slice(10, 12) +
      '+08:00',
  );
  return Number.isFinite(t) && bjt(t) === s ? t : NaN;
}
async function publicFrames() {
  const now = Date.now(),
    q = new URLSearchParams({
      'list-type': '2',
      prefix: 'history/Observation/',
      'start-after': 'history/Observation/' + bjt(now - 24 * H),
      'max-keys': '1000',
    }),
    rows = [];
  for (let page = 0; page < 5; page++) {
    const xml = await (await request(bucket + '?' + q, { timeout: 10000 })).text();
    if (!xml.includes('<ListBucketResult')) throw Error('雷达归档目录无效');
    for (const m of xml.matchAll(/<Key>history\/Observation\/(\d{12})compref_mosaic\.xml<\/Key>/g)) {
      const t = timeOf(m[1]);
      if (t <= now && t >= now - 24 * H)
        rows.push({ time: new Date(t).toISOString(), stamp: m[1], archive: true });
    }
    if (!xml.includes('<IsTruncated>true</IsTruncated>')) break;
    const token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1];
    if (!token) throw Error('归档目录分页中断');
    q.set('continuation-token', token);
  }
  return rows;
}
async function radarIndex() {
  const info = await cached(
    'cwa-radar-index-v4',
    3 * 60000,
    async () => {
      let rows;
      try {
        rows = await publicFrames();
        if (!rows.length) throw Error('归档暂无新帧');
      } catch {
        try {
          const text = await (await request(web + 'js/obs_img/Observe_radar.js', { timeout: 9000 })).text();
          rows = [...new Set([...text.matchAll(/\bCV1_1000_(\d{12})\.png\b/g)].map((m) => m[1]))]
            .filter((s) => Number.isFinite(timeOf(s)))
            .map((stamp) => ({ time: new Date(timeOf(stamp)).toISOString(), stamp }));
        } catch {
          rows = [];
        }
        if (!rows.length) {
          const raw = await (
              await request(bucket + 'Observation/O-A0058-001.json', { timeout: 12000 })
            ).json(),
            d = raw.cwaopendata || raw,
            t = Date.parse(d.dataset?.DateTime);
          if (d.dataid === 'O-A0058-001' && Number.isFinite(t))
            rows = [{ time: new Date(t).toISOString(), stamp: bjt(t) }];
        }
      }
      if (!rows.length) throw Error('CWA 近期没有已发布的区域雷达图');
      return { value: { frames: rows.sort((a, b) => a.time.localeCompare(b.time)) } };
    },
    { stale: 2 * H },
  );
  const frames = info.frames.filter(
    (f) => Date.parse(f.time) <= Date.now() && Date.now() - Date.parse(f.time) < 24 * H,
  );
  if (!frames.length) throw Error('CWA 雷达归档超过一天');
  return { frames, latest: frames.at(-1).time, delayed: Date.now() - Date.parse(frames.at(-1).time) > H };
}
// Published mosaics are about 9 MB of uncompressed XML. Read bounded ranges
// concurrently and require the same S3 object throughout the scan.
async function archivedXml(url) {
  const size = 256 * 1024;
  const first = await request(url, { headers: { Range: 'bytes=0-' + (size - 1) }, timeout: 45000 });
  if (first.status === 200) return first.text();
  const range = /^bytes 0-(\d+)\/(\d+)$/.exec(first.headers.get('content-range') || ''),
    etag = first.headers.get('etag');
  if (first.status !== 206 || !range || !etag) throw Error('雷达格点分段响应无效');
  const total = Number(range[2]),
    head = Buffer.from(await first.arrayBuffer());
  if (total > 20 * 1024 ** 2 || total < head.length || head.length !== Number(range[1]) + 1)
    throw Error('雷达格点文件长度异常');
  const bytes = Buffer.alloc(total);
  head.copy(bytes);
  let offset = head.length;
  async function partAt(start, end) {
    const expected = 'bytes ' + start + '-' + end + '/' + total;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await request(url, {
          headers: { Range: 'bytes=' + start + '-' + end, 'If-Match': etag },
          cache: 'no-store',
          timeout: 45000,
        });
        if (
          res.status !== 206 ||
          res.headers.get('etag') !== etag ||
          res.headers.get('content-range') !== expected
        ) {
          await res.body?.cancel();
          throw Error('雷达格点分段与目录不符');
        }
        const part = Buffer.from(await res.arrayBuffer());
        if (part.length !== end - start + 1) throw Error('雷达格点分段不完整');
        return part;
      } catch (e) {
        if (attempt >= 2 || [403, 404, 412, 416].includes(e.statusCode)) throw e;
      }
    }
  }
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (offset < total) {
        const start = offset,
          end = Math.min(total - 1, start + size - 1);
        offset = end + 1;
        (await partAt(start, end)).copy(bytes, start);
      }
    }),
  );
  return bytes.toString('utf8');
}
async function nativePng(url) {
  const r = await request(url, { timeout: 22000 }),
    b = Buffer.from(await r.arrayBuffer());
  if (
    b.length < 500 ||
    b.readUInt32BE(0) !== 0x89504e47 ||
    b.toString('ascii', b.length - 8, b.length - 4) !== 'IEND'
  )
    throw Error('雷达原图不完整');
  return 'data:image/png;base64,' + b.toString('base64');
}
async function radar(time) {
  const { frames } = await radarIndex(),
    frame = frames.find((r) => Date.parse(r.time) === time);
  if (!frame) throw Error('该时刻没有已发布的 CWA 回波');
  return cached('cwa-observation-v4:' + frame.stamp, 24 * H, async () => {
    let gridError;
    if (frame.archive) {
      try {
        const text = await archivedXml(bucket + 'history/Observation/' + frame.stamp + 'compref_mosaic.xml');
        const grid = await renderObservation({ kind: 'radar', xml: text, valid: frame.time });
        return { value: grid };
      } catch (e) {
        gridError = e;
      }
    }
    try {
      return {
        value: {
          image: await nativePng(web + 'radar/CV1_1000_' + frame.stamp + '.png'),
          valid: frame.time,
          externalImage: true,
          source: 'CWA · 台湾及近海原图',
          type: '雷达观测',
        },
      };
    } catch {
      const meta = async () => {
        const doc = await (await request(bucket + 'Observation/O-A0058-001.json', { timeout: 9000 })).json();
        const a = doc.cwaopendata || doc;
        if (a.dataid !== 'O-A0058-001' || Date.parse(a.dataset?.DateTime) !== time)
          throw Error(gridError ? '该时次的雷达格点读取失败：' + gridError.message : '该时刻的 CWA 原图暂缺');
        return a.identifier;
      };
      const id = await meta(),
        image = await nativePng(bucket + 'Observation/O-A0058-001.png');
      if (!id || id !== (await meta())) throw Error('雷达原图更新中，请重试');
      return {
        value: {
          image,
          valid: frame.time,
          externalImage: true,
          source: 'CWA · 公开资料原图',
          type: '雷达观测',
        },
      };
    }
  });
}
module.exports = { radarIndex, radar, timeOf, archivedXml };
