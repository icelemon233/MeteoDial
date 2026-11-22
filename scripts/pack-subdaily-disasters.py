"""Build the shared monthly map blocks and the small per-event evidence files.

python scripts/pack-subdaily-disasters.py CACHE [--months YYYY-MM ...]
python scripts/pack-subdaily-disasters.py CACHE --summaries-only
"""

import argparse
from collections import defaultdict
import datetime as dt
import gzip
import json
import os
from pathlib import Path
import struct
import zlib

import numpy as np

from cfs_archive import ROOT, UTC, PRODUCTS, MISSING, event_hours, geometry, month_for, utc_hour

MAGIC = b"MDCFS4H1"
CADENCE = 4
ORDER = ("height", "u850", "v850", "rh", "t2", "msl", "u10", "v10", "terrain", "rain")
LAYERS = ["height500", "wind850", "moisture700", "temp2", "pressure", "rain4h", "wind10"]
WET = {"暴雨洪涝", "山洪地灾", "强对流", "台风", "连阴雨"}


def iso(hour):
    return dt.datetime.fromtimestamp(hour * 3600, UTC).strftime("%Y-%m-%dT%H:00:00.000Z")


def encode(fields, leads):
    chunks = [np.asarray(leads, dtype="u1").tobytes()]
    for key in ORDER:
        a = np.stack(fields[key]).astype("<u2", copy=False)
        delta = a.copy()
        delta[:, :, 1:] -= a[:, :, :-1]
        delta[1:] -= delta[:-1].copy()
        chunks.append(delta.view("u1").reshape(-1, 2).T.copy().tobytes())
    return zlib.compress(b"".join(chunks), 5)


def decode(compressed, count, month):
    buf = zlib.decompress(compressed)
    offset = count * 11
    leads = np.frombuffer(buf, dtype="u1", count=offset).reshape(count, 11)
    result = {}
    for key in ORDER:
        x, y = geometry(month, key == "rain")
        n = count * len(y) * len(x)
        vals = np.frombuffer(buf, dtype="u1", count=n * 2, offset=offset).reshape(2, n)
        a = (vals[0].astype("u2") | (vals[1].astype("u2") << 8)).reshape(count, len(y), len(x))
        np.cumsum(a, axis=0, dtype="u2", out=a)
        np.cumsum(a, axis=2, dtype="u2", out=a)
        result[key] = a.view("<i2")
        offset += n * 2
    if offset != len(buf):
        raise ValueError("Invalid packed length")
    return result, leads


def input_data(cache, month):
    fields = defaultdict(dict)
    start = utc_hour(month + "-01")
    for source_month in [month_for(start - 1), month]:
        for product, specs in PRODUCTS.items():
            f = cache / source_month / (product + ".npz")
            if not f.exists():
                continue
            with np.load(f) as part:
                stamps = part["hours"]
                leads = part["leads"]
                if not len(stamps):
                    continue
                for key, *_ in specs:
                    data = part[key]
                    for h, lead, a in zip(stamps, leads, data):
                        if source_month != month and h < start - 3:
                            continue
                        if h not in fields[key] or lead < fields[key][h][1]:
                            fields[key][int(h)] = (a, int(lead))
    return fields


def rounded(a):
    return np.where(np.isfinite(a), np.rint(a), MISSING).astype("<i2")


def convert(fields, h):
    current = {}
    refs = {}
    for key in ("height", "u850", "v850", "q", "t", "t2", "msl", "u10", "v10", "ps"):
        if h not in fields[key]:
            raise ValueError(f"Missing {key} at {iso(h)}")
        current[key], refs[key] = fields[key][h]
    if refs["q"] != refs["t"] or refs["u850"] != refs["v850"] or refs["u10"] != refs["v10"]:
        raise ValueError("Related CFS fields have different initialization times")
    q = current.pop("q").astype("f8")
    tc = current.pop("t").astype("f8")
    valid = (q != MISSING) & (tc != MISSING) & (q >= 0)
    q = np.where(valid, q / 1e6, 0)
    tc = np.where(valid, tc / 100, 0)
    # Vapour pressure in hPa from specific humidity at 700 hPa, followed by
    # Bolton's saturation vapour pressure over liquid water (temperature in C).
    e = 700 * q / (0.622 + 0.378 * q)
    rh = 100 * e / (6.112 * np.exp(17.67 * tc / (tc + 243.5)))
    current["rh"] = rounded(np.where(valid, rh * 10, np.nan))
    ps = current.pop("ps")
    terrain = np.zeros(ps.shape, dtype="<i2")
    for level in (500, 700, 850):
        terrain += ps > level * 10
    terrain[ps == MISSING] = MISSING
    current["terrain"] = terrain
    for key, required in (("height", 1), ("rh", 2), ("u850", 3), ("v850", 3)):
        current[key] = np.where(terrain >= required, current[key], MISSING).astype("<i2")
    rain = []
    rain_leads = []
    for t in range(h - CADENCE + 1, h + 1):
        if t not in fields["rain"]:
            raise ValueError("Missing hourly precipitation at " + iso(t))
        a, lead = fields["rain"][t]
        rain.append(a)
        rain_leads.append(lead)
    amounts = np.stack(rain)
    current["rain"] = rounded(
        np.where(np.all(amounts >= 0, axis=0), amounts.sum(axis=0, dtype="i4") / 10, np.nan)
    )
    for key in ORDER:
        if not np.any(current[key] != MISSING):
            raise ValueError(f"Entire {key} field missing at {iso(h)}")
    lead_codes = [refs[k] for k in ("height", "u850", "q", "t2", "msl", "u10", "ps")] + rain_leads
    return current, lead_codes


def pack_month(cache, out, month, hours):
    fields = input_data(cache, month)
    start = utc_hour(month + "-01")
    blocks = []
    offset = 0
    entries = {}
    grouped = defaultdict(list)
    for h in sorted(hours):
        grouped[(h - start) // 24].append(h)
    for day, times in sorted(grouped.items()):
        data = defaultdict(list)
        leads = []
        mask = 0
        for h in times:
            frame, reference = convert(fields, h)
            for key in ORDER:
                data[key].append(frame[key])
            leads.append(reference)
            mask |= 1 << ((h % 24) // CADENCE)
        block = encode(data, leads)
        entries[str(day + 1)] = [offset, len(block), mask]
        blocks.append(block)
        offset += len(block)
    header = json.dumps(
        {"version": 1, "month": month, "cadence": CADENCE, "days": entries}, separators=(",", ":")
    ).encode("ascii")
    out.mkdir(parents=True, exist_ok=True)
    file = out / (month + ".bin")
    with open(str(file) + ".part", "wb") as f:
        f.write(MAGIC + struct.pack("<I", len(header)) + header)
        for block in blocks:
            f.write(block)
    os.replace(str(file) + ".part", file)


def samples_from_month(file):
    with file.open("rb") as f:
        if f.read(8) != MAGIC:
            raise ValueError("Wrong archive format")
        size = struct.unpack("<I", f.read(4))[0]
        meta = json.loads(f.read(size))
        if file.stem != meta["month"]:
            raise ValueError("Wrong archive month")
        start = utc_hour(meta["month"] + "-01")
        pos = f.tell()
        for d, (offset, length, mask) in meta["days"].items():
            slots = [i for i in range(6) if mask & (1 << i)]
            f.seek(pos + offset)
            arrays, _ = decode(f.read(length), len(slots), file.stem)
            for i, slot in enumerate(slots):
                yield start + 24 * (int(d) - 1) + CADENCE * slot, {k: a[i] for k, a in arrays.items()}


def cell(month, where, rain=False):
    xs, ys = geometry(month, rain)
    lon, lat = where
    step = xs[1] - xs[0]
    x = int(np.floor((lon - xs[0]) / step + 0.5))
    y = int(np.floor((ys[0] - lat) / step + 0.5))
    return x, y, [float(xs[x]), float(ys[y])]


def indicator(kind):
    if kind in ("高温", "高温干旱", "低温冰雪", "冰冻圈灾害"):
        return "temp2"
    if kind == "台风":
        return "pressure"
    if kind in ("沙尘大风", "雾霾", "大雾", "森林火险"):
        return "wind10"
    return "rain4h"


def point_reading(frame, state, rain):
    x, y, _ = state
    rx, ry, _ = rain

    def val(key, scale=10):
        v = int(frame[key][ry, rx] if key == "rain" else frame[key][y, x])
        return None if v == MISSING else v / scale

    terrain = val("terrain", 1)

    def above(level):
        return terrain is not None and terrain >= {500: 1, 700: 2, 850: 3}[level]

    u, v = val("u850"), val("v850")
    u10, v10 = val("u10"), val("v10")
    return {
        "height500": val("height", 1) if above(500) else None,
        "wind850": (
            round(float(np.hypot(u, v)), 1) if above(850) and u is not None and v is not None else None
        ),
        "u850": u if above(850) else None,
        "v850": v if above(850) else None,
        "moisture700": val("rh") if above(700) else None,
        "temp2": val("t2"),
        "pressure": val("msl"),
        "wind10": round(float(np.hypot(u10, v10)), 1) if u10 is not None and v10 is not None else None,
        "u10": u10,
        "v10": v10,
        "rain4h": val("rain"),
    }


def summaries(events, folder, metadata):
    places = {p[0]: p for p in json.loads((ROOT / "assets/data/places.json").read_text(encoding="utf8"))}
    by_time = defaultdict(list)
    series = {}
    regional = {}
    cells = {}
    for e in events:
        loc = places[e["map"]["place"]]
        point = [loc[5], loc[4]]
        key = e["id"]
        series[key] = []
        regional[key] = None
        for h in event_hours(e):
            by_time[h].append(e)
            m = month_for(h)
            if (key, m) not in cells:
                cells[key, m] = (cell(m, point), cell(m, point, True))
    for month in sorted({month_for(h) for h in by_time}):
        xs, ys = geometry(month, True)
        for h, frame in samples_from_month(folder / (month + ".bin")):
            for e in by_time.get(h, ()):
                key = e["id"]
                state, rain = cells[key, month]
                series[key].append((h, point_reading(frame, state, rain)))
                if e["kind"] not in WET:
                    continue
                x, y, _ = rain
                xl = max(0, x - 2)
                yl = max(0, y - 2)
                patch = frame["rain"][yl : y + 3, xl : x + 3]
                j, i = np.unravel_index(np.argmax(patch), patch.shape)
                amount = int(patch[j, i])
                if amount != MISSING and (regional[key] is None or amount > regional[key][0]):
                    regional[key] = (amount, iso(h), float(xs[xl + i]), float(ys[yl + j]))
    metadata.mkdir(parents=True, exist_ok=True)
    for e in events:
        key = e["id"]
        rows = series[key]
        times = [h for h, _ in rows]
        if times != list(event_hours(e)):
            raise ValueError("Incomplete timeline " + key)
        field = indicator(e["kind"])
        vals = [r[field] for _, r in rows]
        if sum(v is not None for v in vals) < 2:
            raise ValueError("Missing reference series " + key)
        eligible = [
            i
            for i, (h, r) in enumerate(rows)
            if r[field] is not None
            and (not e["map"].get("focus") or iso(h + 8)[:10] == e["map"]["focus"])
        ]
        if not eligible:
            eligible = [i for i, v in enumerate(vals) if v is not None]
        low = e["kind"] in ("低温冰雪", "台风")
        ix = (min if low else max)(eligible, key=lambda i: vals[i])
        loc = cells[key, month_for(times[ix])][int(field == "rain4h")][2]
        best = regional[key]
        result = {
            "version": 2,
            "id": key,
            "start": iso(times[0]),
            "end": iso(times[-1]),
            "cadence": CADENCE,
            "count": len(rows),
            "focus": iso(times[ix]),
            "layers": LAYERS,
            "series": {"layer": field, "lon": loc[0], "lat": loc[1], "values": vals},
            "pointWeather": {
                component: [reading[component] for _, reading in rows]
                for component in ("u850", "v850", "u10", "v10", "moisture700", "height500", "temp2")
            },
            "atFocus": rows[ix][1],
            "before": {"time": iso(times[max(0, ix - 1)]), **rows[max(0, ix - 1)][1]},
            "after": {
                "time": iso(times[min(len(times) - 1, ix + 1)]),
                **rows[min(len(times) - 1, ix + 1)][1],
            },
            "regional": (
                None
                if best is None
                else {"value": best[0] / 10, "time": best[1], "lon": best[2], "lat": best[3]}
            ),
        }
        dest = metadata / (key + ".json.gz")
        with open(str(dest) + ".part", "wb") as f:
            f.write(
                gzip.compress(
                    json.dumps(
                        result, ensure_ascii=False, separators=(",", ":"), allow_nan=False
                    ).encode(),
                    mtime=0,
                )
            )
        os.replace(str(dest) + ".part", dest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--months", nargs="+")
    parser.add_argument("--summaries-only", action="store_true")
    args = parser.parse_args()
    events = json.loads((ROOT / "assets/data/disasters.json").read_text(encoding="utf8"))["events"]
    out = ROOT / "assets/cases/disaster-fields"
    if not args.summaries_only:
        groups = defaultdict(set)
        for e in events:
            for h in event_hours(e):
                groups[month_for(h)].add(h)
        for m in sorted(groups):
            if args.months and m not in args.months:
                continue
            pack_month(args.cache, out, m, groups[m])
            print("packed", m, len(groups[m]), flush=True)
    if not args.months:
        summaries(events, out, ROOT / "assets/cases/disasters")


if __name__ == "__main__":
    main()
