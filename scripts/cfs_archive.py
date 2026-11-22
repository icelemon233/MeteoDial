"""Subset the public NCEP CFS hourly archive. Requires Python 3 and NumPy.

python scripts/cfs_archive.py CACHE [--workers 4] [--months YYYY-MM ...]
Native timestamps, reference times, levels and precipitation bounds are checked
before the compact regional subsets can be used by the offline packer.
"""

import argparse
import calendar
from collections import deque
import concurrent.futures
import datetime as dt
import gzip
import http.client
import json
import math
import multiprocessing
import os
import re
import struct
import threading
import time
import urllib.error
import zlib
from pathlib import Path
from urllib.parse import quote

import numpy as np
from cfs_transport import response

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://tds.gdex.ucar.edu/thredds/dodsC/files"
UTC = dt.timezone.utc
MISSING = -32768
# Field name, variable, vertical coordinate in source units, unit check,
# multiplier and offset for the stored signed integers.
CORE_PRODUCTS = {
    "z500": [("height", "Geopotential_height_isobaric", 50000, "gpm", 1, 0)],
    "wnd850": [(c + "850", c + "-component_of_wind_isobaric", 85000, "m/s", 10, 0) for c in "uv"],
    "q700": [("q", "Specific_humidity_isobaric", 70000, "kg/kg", 1_000_000, 0)],
    "t700": [("t", "Temperature_isobaric", 70000, "K", 100, -273.15)],
    "prmsl": [("msl", "Pressure_reduced_to_MSL_msl", None, "Pa", 0.1, 0)],
    "pressfc": [("ps", "Pressure_surface", None, "Pa", 0.1, 0)],
    "tmp2m": [("t2", "Temperature_height_above_ground", 2, "K", 10, -273.15)],
    "wnd10m": [(c + "10", c + "-component_of_wind_height_above_ground", 10, "m/s", 10, 0) for c in "uv"],
    "apcp": [("rain", "Total_precipitation_surface_1_Hour_Accumulation", None, "kg.m-2", 100, 0)],
}
COLUMN_PRODUCTS = {
    "z700": [("z700", "Geopotential_height_isobaric", 70000, "gpm", 1, 0)],
    "q2m": [("q2", "Specific_humidity_height_above_ground", 2, "kg/kg", 100000, 0)],
}
for level in (700, 500, 200):
    COLUMN_PRODUCTS[f"wnd{level}"] = [
        (f"{c}{level}", f"{c}-component_of_wind_isobaric", level * 100, "m/s", 10, 0) for c in "uv"
    ]
for level in (850, 500):
    COLUMN_PRODUCTS[f"t{level}"] = [(f"t{level}", "Temperature_isobaric", level * 100, "K", 100, -273.15)]
    COLUMN_PRODUCTS[f"q{level}"] = [
        (f"q{level}", "Specific_humidity_isobaric", level * 100, "kg/kg", 100000, 0)
    ]
PRODUCTS = {**CORE_PRODUCTS, **COLUMN_PRODUCTS}
DECL = re.compile(r"(Float32|Float64|Int32)\s+([^\s\[;]+)((?:\[[^\]]+\])+);")
SHAPE = re.compile(r"\[(?:(\w+)\s*=\s*)?(\d+)\]")
FORMATS = {"Float32": ">f4", "Float64": ">f8", "Int32": ">i4"}


def utc_hour(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp() // 3600)


def event_hours(event):
    # Map dates are Chinese civil dates. Beijing midnight is 16 UTC on the previous date.
    return range(utc_hour(event["map"]["from"]) - 8, utc_hour(event["map"]["to"]) + 16, 4)


def month_for(h):
    return dt.datetime.fromtimestamp(h * 3600, UTC).strftime("%Y-%m")


def archive_object(month, product):
    # GDEX files the last three GDAS months alongside the succeeding CDAS1
    # filenames in d094001. NOAA's originals remain in the reanalysis bucket.
    dataset = "d093001" if month < "2011-01" else "d094001"
    model = "gdas" if month < "2011-04" else "cdas1"
    variant = ".l" if month < "2026-01" and product != "apcp" else ""
    name = f"{product}{variant}.{model}.{month.replace('-', '')}.grb2"
    return f"{dataset}/{month[:4]}/{name}"


def needed_hours():
    events = json.loads((ROOT / "assets/data/disasters.json").read_text(encoding="utf8"))["events"]
    return {h for e in events for h in event_hours(e)}


def geometry(month, rain=False):
    step = 1 if rain or month >= "2026-01" else 2.5
    west = 53 if step == 1 else 52.5
    return np.arange(west, 165.01, step), np.arange(75, -0.01, -step)


def dap_arrays(raw):
    header, sep, body = raw.partition(b"Data:\n")
    if not sep:
        raise ValueError("missing DAP2 data marker")
    result = {}
    offset = 0
    for m in DECL.finditer(header.decode("ascii")):
        kind, name, dim = m.groups()
        shape = tuple(int(n) for _, n in SHAPE.findall(dim))
        count = math.prod(shape)
        if struct.unpack_from(">II", body, offset) != (count, count):
            raise ValueError("invalid DAP2 shape for " + name)
        data = np.frombuffer(body, dtype=FORMATS[kind], count=count, offset=offset + 8).reshape(shape)
        result[name] = data
        offset += 8 + data.nbytes
    if offset != len(body) or not result:
        raise ValueError("incomplete DAP2 response")
    return result


def read_url(url, validate=None, attempts=6):
    for attempt in range(attempts):
        try:
            with response(url, {"Accept-Encoding": "gzip, deflate"}, timeout=120) as r:
                data = r.read()
                encoding = r.headers.get("Content-Encoding", "").lower()
            if encoding == "gzip":
                data = gzip.decompress(data)
            elif encoding == "deflate":
                data = zlib.decompress(data)
            if validate:
                validate(data)
            return data
        except (OSError, EOFError, ValueError, zlib.error, struct.error, http.client.HTTPException) as e:
            code = getattr(e, "code", None)
            if attempt + 1 == attempts or (code is not None and code not in (408, 429, 500, 502, 503, 504)):
                raise
            delay = (getattr(e, "headers", None) or {}).get("Retry-After", "0")
            time.sleep(max(int(delay) if delay.isdigit() else 0, 2**attempt))


def cached(url, target, validate=None, attempts=6):
    if target.exists():
        existing = target.read_bytes()
        try:
            if validate:
                validate(existing)
            return existing
        except (ValueError, struct.error):
            pass
    data = read_url(url, validate, attempts)
    part = target.with_suffix(target.suffix + ".part")
    part.write_bytes(data)
    part.replace(target)
    return data


def input_ready(file, hours, month):
    if not file.exists():
        return False
    with np.load(file) as saved:
        if "requested" in saved:
            return hours.issubset(set(saved["requested"].tolist()))
        # Monthly source files may put the midnight boundary in the adjacent month.
        start = utc_hour(month + "-01")
        year, mon = map(int, month.split("-"))
        end = start + 24 * calendar.monthrange(year, mon)[1]
        return (hours - {start, end}).issubset(set(saved["hours"].tolist()))


def dap_url(url, query):
    return url + ".dods?" + quote(query, safe=",/._-")


def attr(das, name, attribute):
    match = re.search(r"^\s*" + re.escape(name) + r"\s*\{([^}]+)\}", das, re.M)
    found = re.search(r"\bString " + re.escape(attribute) + r'\s+"([^"]+)"', match[1]) if match else None
    if not found:
        raise ValueError("Missing attribute " + name + " " + attribute)
    return found[1]


def spatial_axis(source, targets):
    # Request exact native points for aligned grids. Gaussian coordinates are
    # sampled more densely and remapped spatially onto the common display grid.
    asc = source[0] < source[-1]
    a = source if asc else source[::-1]
    if np.any(np.diff(a) <= 0):
        raise ValueError("nonmonotonic coordinates")
    lo, hi = min(targets), max(targets)
    lower = max(0, int(np.searchsorted(a, lo - 0.0001)) - 1)
    upper = min(len(a) - 1, int(np.searchsorted(a, hi + 0.0001)))
    delta = float(np.median(np.diff(a)))
    target_step = abs(targets[1] - targets[0])
    exact = np.rint((targets - a[0]) / delta).astype(int)
    if (
        np.all((exact >= 0) & (exact < len(a)))
        and np.max(np.abs(a[exact] - targets)) < 0.001
        and len(set(np.abs(np.diff(exact)))) == 1
    ):
        lower, upper, stride = int(min(exact)), int(max(exact)), int(abs(exact[1] - exact[0]))
    else:
        stride = max(1, int(target_step / (2 * delta)))
        lower = max(0, upper - math.ceil((upper - lower) / stride) * stride)
        upper = min(len(a) - 1, lower + math.ceil((upper - lower) / stride) * stride)
    if not asc:
        lower, upper = len(a) - 1 - upper, len(a) - 1 - lower
    indices = np.arange(lower, upper + 1, stride)
    chosen = source[indices]
    if min(chosen) > lo + 0.001 or max(chosen) < hi - 0.001:
        raise ValueError("subset misses domain")
    return f"[{lower}:{stride}:{upper}]", chosen.astype(float)


def interpolation(axis, points):
    if axis[0] > axis[-1]:
        return interpolation(-axis, -points)
    left = np.clip(np.searchsorted(axis, points, side="right") - 1, 0, len(axis) - 2)
    weight = np.clip((points - axis[left]) / (axis[left + 1] - axis[left]), 0, 1)
    weight[np.abs(points - axis[left]) < 0.001] = 0
    weight[np.abs(points - axis[left + 1]) < 0.001] = 1
    return left, weight.astype("f4")


def resample(array, lon, lat, x, y):
    ix, wx = interpolation(lon, x)
    iy, wy = interpolation(lat, y)
    result = np.zeros((len(array), len(y), len(x)), dtype="f4")
    for dy, w1 in ((0, 1 - wy), (1, wy)):
        for dx, w2 in ((0, 1 - wx), (1, wx)):
            weight = w1[:, None] * w2[None, :]
            vals = array[:, iy[:, None] + dy, ix + dx]
            result += np.where(weight != 0, vals * weight, 0)
    return result


def runs(indexes):
    """Split a sparse selection into arithmetic runs without shifting any times."""
    pos = 0
    while pos < len(indexes):
        if pos + 1 == len(indexes):
            yield indexes[pos:]
            return
        step = indexes[pos + 1] - indexes[pos]
        end = pos + 2
        while end < len(indexes) and indexes[end] - indexes[end - 1] == step:
            end += 1
        yield indexes[pos:end]
        pos = end


def dap_blocks(url, folder, prefix, names, spatial, blocks, parallel):
    """Read independent time slices, keeping only a small window of replies in memory."""

    def fetch(inds):
        stride = inds[1] - inds[0] if len(inds) > 1 else 1
        suffix = f"[{inds[0]}:{stride}:{inds[-1]}]" + spatial
        part = folder / f"{prefix}-{inds[0]}-{stride}-{inds[-1]}.dap"
        split = part.with_suffix(".split")
        if not (split.exists() and len(inds) > 1):
            query = ",".join(v + suffix for v in names)
            try:
                data = cached(dap_url(url, query), part, dap_arrays, 2 if len(inds) > 1 else 6)
                return [(inds, dap_arrays(data))]
            except (
                OSError,
                EOFError,
                ValueError,
                struct.error,
                zlib.error,
                http.client.HTTPException,
            ) as exc:
                if len(inds) < 2 or getattr(exc, "code", None) not in (None, 408, 413, 500, 502, 503, 504):
                    raise
                # Keep both halves of the same time selection when a server
                # terminates a large response before sending the full grid.
                split.touch(exist_ok=True)
        mid = len(inds) // 2
        return fetch(inds[:mid]) + fetch(inds[mid:])

    if parallel == 1:
        for inds in blocks:
            yield from fetch(inds)
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as readers:
        pending = deque()
        for inds in blocks:
            pending.append(readers.submit(fetch, inds))
            if len(pending) == parallel:
                yield from pending.popleft().result()
        for task in pending:
            yield from task.result()


def download_file(cache, month, product, hours, parallel=1):
    folder = cache / month
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / (product + ".npz")
    if input_ready(output, hours, month):
        return
    url = f"{ORIGIN}/{archive_object(month, product)}"
    dds = cached(url + ".dds", folder / (product + ".dds")).decode("ascii")
    das = cached(url + ".das", folder / (product + ".das")).decode("ascii")
    variables = {m[2]: [key for key, _ in SHAPE.findall(m[3])] for m in DECL.finditer(dds)}
    specs = PRODUCTS[product]
    groups = sorted({key[: -len(specs[0][1])] for key in variables if key.rsplit("/", 1)[-1] == specs[0][1]})
    if not groups:
        raise ValueError("Unavailable field " + product + " " + month)
    x, y = geometry(month, product == "apcp")
    values = {s[0]: {} for s in specs}
    refs = {}
    for n, group in enumerate(groups):
        name = group + specs[0][1]
        dims = variables[name]
        if dims[-2:] != ["lat", "lon"]:
            raise ValueError("Unknown spatial axes " + name)
        coords = attr(das, name, "coordinates").split()
        reference = next(key for key in coords if key.rsplit("/", 1)[-1].startswith("reftime"))
        reference = group + reference.rsplit("/", 1)[-1]
        axes = {group + dim for dim in dims} | {reference}
        if product == "apcp":
            axes.add(group + "time_bounds")
        try:
            raw = cached(
                dap_url(url, ",".join(sorted(axes))), folder / f"{product}-axes{n}.dap", dap_arrays, 2
            )
            axis = dap_arrays(raw)
        except (OSError, ValueError, http.client.HTTPException):
            axis = {}
            for variable in sorted(axes):
                dims_of_axis = next(m[3] for m in DECL.finditer(dds) if m[2] == variable)
                selector = "".join(
                    "[0:1:" + str(int(length) - 1) + "]" for _, length in SHAPE.findall(dims_of_axis)
                )
                raw = cached(
                    dap_url(url, variable + selector),
                    folder / f"{product}-axis{n}-{variable.rsplit('/',1)[-1]}.dap",
                    dap_arrays,
                )
                axis.update(dap_arrays(raw))
        unit = attr(das, group + dims[0], "units")
        if not unit.lower().startswith("hour since "):
            raise ValueError("Unknown time unit " + unit)
        base = utc_hour(unit[11:].removesuffix("Z"))
        offsets = axis[group + dims[0]]
        if np.any(offsets != np.rint(offsets)):
            raise ValueError("Non-hourly timestamp")
        times = np.rint(offsets).astype("i8") + base
        run_unit = attr(das, reference, "units")
        if not run_unit.lower().startswith("hour since "):
            raise ValueError("Unknown initialization unit")
        inits = np.rint(axis[reference]).astype("i8") + utc_hour(run_unit[11:].removesuffix("Z"))
        if len(inits) != len(times) or np.any((times - inits < 0) | (times - inits > 6)):
            raise ValueError("Unexpected CFS forecast lead")
        if product == "apcp":
            bounds = axis[group + "time_bounds"]
            if not np.allclose(bounds[:, 1], offsets) or not np.allclose(bounds[:, 1] - bounds[:, 0], 1):
                raise ValueError("Rain is not a one-hour accumulation")
        for _, var, level, units, _, _ in specs:
            if attr(das, group + var, "units") != units:
                raise ValueError("Unexpected units for " + var)
            if level is not None and (len(dims) != 4 or list(axis[group + dims[1]]) != [level]):
                raise ValueError("Unexpected vertical level for " + var)
        xsel, lon = spatial_axis(axis[group + "lon"], x)
        ysel, lat = spatial_axis(axis[group + "lat"], y)
        # Request only the required portion of the month. The forecast-only
        # surface-pressure group omits cycle hours, so its two off-cycle slots
        # are separate regularly strided projections.
        keep = [i for i, t in enumerate(times) if int(t) in hours]
        selections = [keep]
        if (
            len(keep) > 12
            and product != "apcp"
            and np.gcd.reduce(np.diff(keep)) == 1
            and not np.all(np.diff(times) == 1)
        ):
            selections = [[i for i in keep if int(times[i]) % 12 == slot] for slot in (0, 4, 8)]
        batch = max(1, min(96, (2 * 1024 * 1024) // (4 * len(lon) * len(lat) * len(specs))))
        blocks = (
            seq[off : off + batch]
            for select in selections
            for seq in runs(select)
            for off in range(0, len(seq), batch)
        )
        spatial = ("[0]" if len(dims) == 4 else "") + ysel + xsel
        names = [group + var for _, var, *_ in specs]
        for inds, arr in dap_blocks(url, folder, f"{product}-{n}", names, spatial, blocks, parallel):
            for axis_name, expected in (
                (group + dims[0], offsets[inds]),
                (group + "lat", lat),
                (group + "lon", lon),
            ):
                if axis_name in arr and (
                    arr[axis_name].shape != expected.shape
                    or not np.allclose(arr[axis_name], expected, rtol=0, atol=0.0001)
                ):
                    raise ValueError("Returned DAP coordinates differ from the requested projection")
            for key, var, _, _, scale, add in specs:
                field = np.asarray(arr[group + var], dtype="f4").reshape(len(inds), len(lat), len(lon))
                field = np.where(np.abs(field) < 1e12, field, np.nan)
                sampled = resample(field, lon, lat, x, y)
                number = np.rint((sampled + add) * scale)
                if np.any((number[np.isfinite(number)] > 32767) | (number[np.isfinite(number)] <= MISSING)):
                    raise ValueError(f"Quantization overflow {month} {key}")
                packed = np.where(np.isfinite(number), number, MISSING).astype("<i2")
                for j, i in enumerate(inds):
                    h = int(times[i])
                    if h in values[key]:
                        raise ValueError("Duplicate valid hour")
                    values[key][h] = packed[j]
                    refs[h] = int(times[i] - inits[i])
    stamps = sorted(refs)
    arrays = {k: np.stack([v[h] for h in stamps]) for k, v in values.items()} if stamps else {}
    with open(str(output) + ".part", "wb") as f:
        np.savez_compressed(
            f,
            requested=np.asarray(sorted(hours), dtype="<i4"),
            hours=np.asarray(stamps, dtype="<i4"),
            leads=np.asarray([refs[h] for h in stamps], dtype="i1"),
            **arrays,
        )
    os.replace(str(output) + ".part", output)


def jobs_for(hours):
    rain = {t - k for t in hours for k in range(4)}
    months = {month_for(h) for h in rain | hours}
    # Some month files include 00 UTC of the following month as their last
    # forecast. Read that neighbouring file if its final hour is needed.
    months |= {
        month_for(h - 1)
        for h in rain | hours
        if dt.datetime.fromtimestamp(h * 3600, UTC).day == 1 and h % 24 == 0
    }
    jobs = []
    for m in sorted(months):
        start = utc_hour(m + "-01")
        y, mo = map(int, m.split("-"))
        end = start + calendar.monthrange(y, mo)[1] * 24
        for k in PRODUCTS:
            needed = rain if k == "apcp" else hours
            subset = needed.intersection(range(start, end + 1))
            if subset:
                jobs.append((m, k, subset))
    return jobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--months", nargs="+")
    parser.add_argument("--products", nargs="+", choices=PRODUCTS)
    parser.add_argument("--reader", choices=("auto", "dap", "grib"), default="auto")
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("workers must be positive")
    jobs = [
        j
        for j in jobs_for(needed_hours())
        if (not args.months or j[0] in args.months) and (not args.products or j[1] in args.products)
    ]
    errors = []
    start = time.monotonic()

    def run(j):
        m, k, hours = j
        if input_ready(args.cache / m / (k + ".npz"), hours, m):
            return
        if args.reader == "grib" or (
            args.reader == "auto" and m < "2026-01" and (len(hours) >= 20 or k != "apcp")
        ):
            try:
                from cfs_grib import native_file

                native_file(args.cache, *j, decoders=decoders)
                return
            except Exception as e:
                if args.reader == "grib":
                    raise
                print("Using DAP for", m, k, str(e), flush=True)
        batch_readers = min(3, max(1, args.workers // 4)) if m >= "2026-01" else 1
        download_file(args.cache, *j, parallel=batch_readers)

    # Give the larger high-resolution archive a share of the workers from
    # the start. Once either queue is empty, all workers can finish the other.
    history, recent = deque(), deque()
    for j in sorted(jobs, key=lambda j: not (args.cache / j[0] / (j[1] + ".dds")).exists()):
        (recent if j[0] >= "2026-01" else history).append(j)
    recent_workers = min(3, args.workers // 4) if history else args.workers
    lock = threading.Lock()
    completed = 0

    def drain(first, second):
        nonlocal completed
        for q in (first, second):
            while True:
                with lock:
                    if not q:
                        break
                    j = q.popleft()
                error = None
                try:
                    run(j)
                except Exception as exc:
                    error = exc
                with lock:
                    if error is not None:
                        errors.append(j[:2])
                        print("ERROR", *j[:2], str(error), flush=True)
                    completed += 1
                    if completed % 10 == 0 or completed == len(jobs):
                        print(
                            f"{completed}/{len(jobs)} files, {len(errors)} errors, {time.monotonic()-start:.0f}s",
                            flush=True,
                        )

    with (
        concurrent.futures.ProcessPoolExecutor(
            max_workers=min(6, args.workers), mp_context=multiprocessing.get_context("spawn")
        ) as decoders,
        concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool,
    ):
        workers = [pool.submit(drain, recent, history) for _ in range(recent_workers)]
        workers += [pool.submit(drain, history, recent) for _ in range(args.workers - recent_workers)]
        for worker in workers:
            worker.result()
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
