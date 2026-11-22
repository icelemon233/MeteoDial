"""Acquire the missing ERA5 analysis fields at the original archive instants.

python scripts/prepare-pressure-analysis.py CACHE [--workers 12] [--months YYYY-MM ...]
The display grid matches the CFS archive. Resampling is horizontal only.
"""

import argparse
from collections import defaultdict, deque
import concurrent.futures
import json
import gzip
import queue
from pathlib import Path
import runpy
import threading
import time
import numpy as np
from cfs_archive import ROOT, MISSING, geometry, needed_hours, month_for
from era5_subset import WB, ARCO, Store
from era5_netcdf import Daily
from cfs_archive import event_hours

base = runpy.run_path(str(ROOT / "scripts/pack-subdaily-disasters.py"))
layout = json.loads((ROOT / "assets/data/disaster-analysis-fields.json").read_text())
folder = ROOT / "assets/cases/disaster-analysis-fields"
ORDER = layout["fields"]
MAGIC = layout["magic"].encode()
FIELDS = {
    "u_component_of_wind": ("m s**-1", [600, 400, 925]),
    "v_component_of_wind": ("m s**-1", [600, 400, 925]),
    "geopotential": ("m**2 s**-2", [400, 300]),
    "vertical_velocity": ("Pa s**-1", [700]),
    "surface_pressure": ("Pa", []),
    "temperature": ("K", [600, 400]),
    "specific_humidity": ("kg kg**-1", [600, 400]),
}


def pack_values(arr, scale):
    a = np.rint(arr * scale)
    if np.any(np.isfinite(a) & ((a > 32767) | (a <= MISSING))):
        raise ValueError("ERA5 quantization overflow")
    return np.where(np.isfinite(a), a, MISSING).astype("<i2")


def acquire(store, hours, cache, alternate=None):
    month = month_for(hours[0])
    x, y = geometry(month)
    dest = cache / f"{hours[0]}-{hours[-1]}.npz"
    existing = None
    if dest.is_file():
        with np.load(dest) as f:
            if set(ORDER) <= set(f.files) and list(f["hours"]) == hours:
                return dest
            if list(f["hours"]) == hours and "ps" in f:
                existing = {k: f[k] for k in f.files if k != "hours"}

    def read(field, levels):
        unit = FIELDS[field][0]
        try:
            return store.read(field, hours, levels, x, y, unit)
        except Exception:
            if alternate is None:
                raise
            return np.concatenate([alternate.read(field, [h], levels, x, y, unit) for h in hours])

    if existing is not None and set(ORDER) - set(existing) <= {"u925", "v925", "z400", "z300"}:
        ps = existing["ps"].astype("f4") / 10
        for c in "uv":
            existing[c + "925"] = pack_values(
                np.where(ps > 925, read(c + "_component_of_wind", [925])[:, 0], np.nan), 4
            )
        z = read("geopotential", [400, 300])
        for i, p in enumerate([400, 300]):
            existing["z" + str(p)] = pack_values(np.where(ps > p, z[:, i] / 9.80665, np.nan), 1)
        tmp = dest.with_suffix(".npz.part")
        with tmp.open("wb") as f:
            np.savez_compressed(f, hours=hours, **existing)
        tmp.replace(dest)
        return dest
    raw = {}
    for field, (unit, levels) in FIELDS.items():
        # Access to each variable resumes independently after a transport interruption.
        part = cache / f"{hours[0]}-{hours[-1]}-{field}-{'_'.join(map(str,levels))}.npy"
        previous = cache / f"{hours[0]}-{hours[-1]}-{field}.npy"
        if part.exists():
            a = np.load(part)
        elif previous.exists() and np.load(previous, mmap_mode="r").shape == (
            len(hours),
            len(levels) or 1,
            len(y),
            len(x),
        ):
            a = np.load(previous)
        else:
            a = read(field, levels)
            tmp = part.with_suffix(".npy.part")
            with tmp.open("wb") as fp:
                np.save(fp, a)
            tmp.replace(part)
        if a.shape != (len(hours), len(levels) or 1, len(y), len(x)):
            raise ValueError("ERA5 subset shape mismatch")
        raw[field] = a
    ps = raw["surface_pressure"][:, 0] / 100
    data = {
        "ps": pack_values(ps, 10),
        "omega700": pack_values(np.where(ps > 700, raw["vertical_velocity"][:, 0], np.nan), 1000),
    }
    for i, level in enumerate([400, 300]):
        data["z" + str(level)] = pack_values(
            np.where(ps > level, raw["geopotential"][:, i] / 9.80665, np.nan), 1
        )
    for c in "uv":
        data[c + "925"] = pack_values(np.where(ps > 925, raw[c + "_component_of_wind"][:, 2], np.nan), 4)
    for i, level in enumerate([600, 400]):
        valid = ps > level
        for c in "uv":
            data[c + str(level)] = pack_values(
                np.where(valid, raw[c + "_component_of_wind"][:, i], np.nan), 4
            )
        t = raw["temperature"][:, i] - 273.15
        q = raw["specific_humidity"][:, i]
        rh = 100 * level * q / (0.622 + 0.378 * q) / (6.112 * np.exp(17.67 * t / (t + 243.5)))
        data["temp" + str(level)] = pack_values(np.where(valid, t, np.nan), 5)
        data["rh" + str(level)] = pack_values(np.where(valid & (q >= 0), rh, np.nan), 1)
    if any(np.any(np.all(a == MISSING, axis=(1, 2))) for a in data.values()):
        raise ValueError("Entire ERA5 field missing")
    tmp = dest.with_suffix(".npz.part")
    with tmp.open("wb") as f:
        np.savez_compressed(f, hours=hours, **data)
    tmp.replace(dest)
    for field, (_, levels) in FIELDS.items():
        (cache / f"{hours[0]}-{hours[-1]}-{field}-{'_'.join(map(str,levels))}.npy").unlink(missing_ok=True)
    return dest


def pack_month(month, needed, files, source_meta):
    target = folder / (month + ".bin")
    if target.exists() and all(f.stat().st_mtime_ns <= target.stat().st_mtime_ns for f in files):
        try:
            with target.open("rb") as f:
                header = f.read(12)
                table = json.loads(f.read(int.from_bytes(header[8:12], "little")))
            if (
                table.get("codec") == "zstd"
                and all(table.get(k) == v for k, v in source_meta.items())
                and {h for h, _ in base["samples_from_month"](target, MAGIC, ORDER, 0)} == needed
            ):
                return
        except (ValueError, KeyError, EOFError):
            pass
    data = {}
    for file in files:
        with np.load(file) as f:
            stamps = f["hours"]
            fields = {k: f[k] for k in ORDER}
            for i, h in enumerate(stamps):
                if int(h) in needed:
                    if h in data:
                        raise ValueError("Duplicate ERA5 time")
                    data[int(h)] = {k: a[i] for k, a in fields.items()}
    if set(data) != needed:
        raise ValueError("Incomplete ERA5 month " + month)
    base["write_month"](folder, month, needed, lambda h: (data[h], []), ORDER, MAGIC, source_meta)
    checked = {h for h, _ in base["samples_from_month"](folder / (month + ".bin"), MAGIC, ORDER, 0)}
    if checked != needed:
        raise ValueError("ERA5 map verification failed")


def summaries(events):
    places = {p[0]: p for p in json.loads((ROOT / "assets/data/places.json").read_text("utf8"))}
    by_time = defaultdict(list)
    cells = {}
    values = {}
    fields = {
        "eraPs": ("ps", 10),
        "u600": ("u600", 4),
        "v600": ("v600", 4),
        "u400": ("u400", 4),
        "v400": ("v400", 4),
        "moisture600": ("rh600", 1),
        "moisture400": ("rh400", 1),
    }
    for e in events:
        eid = e["id"]
        p = places[e["map"]["place"]]
        values[eid] = {k: [] for k in fields}
        for h in event_hours(e):
            m = month_for(h)
            by_time[h].append(eid)
            if (eid, m) not in cells:
                cells[eid, m] = base["cell"](m, (p[5], p[4]))[:2]
    for m in sorted({month_for(h) for h in by_time}):
        for h, frame in base["samples_from_month"](folder / (m + ".bin"), MAGIC, ORDER, 0):
            for eid in by_time[h]:
                x, y = cells[eid, m]
                for k, (f, scale) in fields.items():
                    v = int(frame[f][y, x])
                    values[eid][k].append(None if v == MISSING else v / scale)
    for e in events:
        eid = e["id"]
        f = ROOT / "assets/cases/disasters" / (eid + ".json.gz")
        b = json.loads(gzip.decompress(f.read_bytes()))
        if not b.get("columnVersion") or any(len(a) != b["count"] for a in values[eid].values()):
            raise ValueError("Incomplete CFS/ERA5 evidence " + eid)
        b["pointWeather"].update(values[eid])
        focus = (base["utc_hour"](b["focus"]) - base["utc_hour"](b["start"])) // 4
        b["atFocus"].update({k: a[focus] for k, a in values[eid].items()})
        b["layers"] = list(
            dict.fromkeys(
                b["layers"]
                + [
                    "autoUpper",
                    "autoNear",
                    "wind925",
                    "wind600",
                    "wind400",
                    "omega700",
                    "moisture600",
                    "moisture400",
                    "temp600",
                    "temp400",
                    "height400",
                    "height300",
                ]
            )
        )
        tmp = f.with_suffix(".gz.part")
        tmp.write_bytes(
            gzip.compress(
                json.dumps(b, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(), mtime=0
            )
        )
        tmp.replace(f)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("cache", type=Path)
    p.add_argument("--workers", type=int, default=12)
    p.add_argument("--months", nargs="+")
    p.add_argument("--summaries-only", action="store_true")
    opts = p.parse_args()
    opts.cache.mkdir(parents=True, exist_ok=True)
    events = json.loads((ROOT / "assets/data/disasters.json").read_text("utf8"))["events"]
    if opts.summaries_only:
        summaries(events)
        return
    stores = [Store(WB), Store(ARCO), Daily()]
    jobs = defaultdict(list)
    groups = defaultdict(set)
    final_through = stores[1].meta[".zattrs"]["valid_time_stop"][:10]
    for h in sorted(needed_hours()):
        m = month_for(h)
        if opts.months and m not in opts.months:
            continue
        n = 0 if m < "2023-01" else 2 if m <= final_through[:7] else 1
        if n == 2:
            chunk = h // 24
        else:
            s = stores[n]
            i = s.hour_index(h)
            chunk = i // s.meta["temperature/.zarray"]["chunks"][0]
        jobs[m, n, chunk].append(h)
        groups[m].add(h)
    priority = ("2016-01", "2008-01", "2021-07", "2026-10")
    order = sorted(jobs, key=lambda k: (k[0] not in priority, k[0]))
    remaining = {m: sum(k[0] == m for k in order) for m in groups}
    files = defaultdict(list)
    start = time.monotonic()
    errors = []
    # Interleave different months, but keep enough jobs together to publish verified months early.
    old = deque(k for k in order if k[1] != 2)
    modern = deque(k for k in order if k[1] == 2)
    results = queue.Queue()
    lock = threading.Lock()

    class Hourly:
        def read(self, field, hs, levels, x, y, unit):
            return np.concatenate([stores[1].read(field, [h], levels, x, y, unit) for h in hs])

    def drain(queues, mirror):
        for q in queues:
            while True:
                with lock:
                    if not q:
                        break
                    k = q.popleft()
                try:
                    store = Hourly() if k[1] == 2 and not mirror else stores[k[1]]
                    f = acquire(store, jobs[k], opts.cache, stores[1] if mirror else None)
                    results.put((k, f, None))
                except Exception as e:
                    results.put((k, None, e))

    workers = max(1, opts.workers)
    dedicated = workers // 4 if old and modern else 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers + min(workers, 8)) as pool:
        for _ in range(min(workers, 8)):
            pool.submit(drain, [modern], True)
        for _ in range(dedicated):
            pool.submit(drain, [modern, old], False)
        for _ in range(workers - dedicated):
            pool.submit(drain, [old, modern], False)
        for i in range(1, len(order) + 1):
            k, f, error = results.get()
            m = k[0]
            try:
                if error:
                    raise error
                files[m].append(f)
                remaining[m] -= 1
                if not remaining[m]:
                    source = {
                        "source": "ECMWF ERA5" if m <= final_through[:7] else "ECMWF ERA5T",
                        "resolution": "1.5°" if m < "2023-01" else "0.25°",
                    }
                    pack_month(m, groups[m], files[m], source)
                    print("PACKED", m, len(groups[m]), flush=True)
            except Exception as e:
                errors.append(k)
                print("ERROR", k, repr(e), flush=True)
            if i % 50 == 0 or i == len(order):
                print(
                    f"{i}/{len(order)} chunks; {len(errors)} errors; {time.monotonic()-start:.0f}s",
                    flush=True,
                )
    if errors:
        raise SystemExit(1)
    if not opts.months:
        summaries(events)


if __name__ == "__main__":
    main()
