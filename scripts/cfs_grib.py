"""Read the same published CFS data from the GDEX bulk GRIB2 objects.

For the low-resolution files, NCEI's original GRIB inventory often describes
the exact GRIB messages retained in GDEX's hourly subset. Use byte ranges only
after its filtered size matches the GDEX object; verify each GRIB message again.
Requires the ECMWF eccodes Python package and NumPy.
"""

from contextlib import contextmanager
import datetime as dt
import hashlib
import http.client
import os
import re
import threading
import time
import urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path

import eccodes as ec
import numpy as np

from cfs_archive import UTC, MISSING, PRODUCTS, archive_object, geometry, input_ready, resample, spatial_axis
from cfs_transport import response as request

CATALOG_LOCK = threading.Lock()
CATALOGS = {}
PARAMS = {
    "height": (3, 5),
    "u850": (2, 2),
    "v850": (2, 3),
    "u10": (2, 2),
    "v10": (2, 3),
    "t2": (0, 0),
    "t": (0, 0),
    "q": (1, 0),
    "msl": (3, 1),
    "ps": (3, 0),
    "rain": (1, 8),
}
for level in (700, 500, 200):
    PARAMS[f"u{level}"] = (2, 2)
    PARAMS[f"v{level}"] = (2, 3)
for level in (850, 500):
    PARAMS[f"q{level}"] = (1, 0)
    PARAMS[f"t{level}"] = (0, 0)
PARAMS["q2"] = (1, 0)
PARAMS["z700"] = (3, 5)


def get_small(url, path):
    if path.exists():
        return path.read_bytes()
    with request(url, timeout=26) as r:
        b = r.read()
    tmp = path.with_name(path.name + "." + str(threading.get_ident()) + ".part")
    tmp.write_bytes(b)
    os.replace(tmp, path)
    return b


def get_bulk(url, path, size):
    if path.exists() and path.stat().st_size == size:
        return path
    part = Path(str(path) + ".partial")
    failures = 0
    while not part.exists() or part.stat().st_size < size:
        start = part.stat().st_size if part.exists() else 0
        try:
            with request(url, {"Range": f"bytes={start}-{size-1}"} if start else {}) as r:
                if start and (
                    r.status != 206 or not r.headers.get("Content-Range", "").startswith(f"bytes {start}-")
                ):
                    raise ValueError("Bulk resume offset mismatch")
                with part.open("ab" if start else "wb") as f:
                    while chunk := r.read(131072):
                        f.write(chunk)
                if part.stat().st_size == start:
                    raise OSError("No more bytes returned before end of object")
        except (OSError, http.client.HTTPException, ValueError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code in (403, 404):
                raise
            failures = failures + 1 if not part.exists() or part.stat().st_size == start else 0
            if failures >= 5:
                raise
            time.sleep(min(15, 2**failures))
        if part.exists() and part.stat().st_size > size:
            raise ValueError("Bulk size mismatch")
    if part.stat().st_size != size:
        raise ValueError("Truncated GRIB")
    os.replace(part, path)
    return path


def index_ranges(folder, month, prod, size, hours):
    y = month[:4]
    ym = month.replace("-", "")
    reanalysis = month < "2011-04"
    prefix = (
        "prod-cfs-reanalysis/time-series/" + ym + "/"
        if reanalysis
        else "prod-cfs-operational-analysis/time-series/" + y + "/" + ym + "/"
    )
    stem = prod + ".l.gdas." + ym
    name = stem + (".grb2" if reanalysis else ".grib2")
    base = "https://www.ncei.noaa.gov/oa/" + prefix
    idx = name + ".inv" if reanalysis else stem + ".inv"
    bucket, key = prefix.split("/", 1)
    with CATALOG_LOCK:
        if month not in CATALOGS:
            try:
                raw = get_small(
                    "https://www.ncei.noaa.gov/oa/" + bucket + "/?list-type=2&max-keys=1000&prefix=" + key,
                    folder / "ncei-catalog.xml",
                )
                root = ET.fromstring(raw)
                CATALOGS[month] = {
                    item.findtext("{*}Key"): int(item.findtext("{*}Size"))
                    for item in root.findall("{*}Contents")
                }
            except (OSError, ValueError, ET.ParseError, http.client.HTTPException):
                CATALOGS[month] = {}
    original = CATALOGS[month].get(key + name)
    if original is None or key + idx not in CATALOGS[month]:
        raise ValueError("Original inventory not listed")
    text = get_small(base + idx, folder / (prod + ".inventory")).decode("ascii")
    physical = []
    for line in text.splitlines():
        cols = line.split(":")
        if len(cols) < 6 or not cols[1].isdigit() or not cols[2].startswith("d="):
            raise ValueError("Unknown NCEI inventory")
        offset = int(cols[1])
        t = int(dt.datetime.strptime(cols[2][2:12], "%Y%m%d%H").replace(tzinfo=UTC).timestamp() // 3600)
        period = cols[5]
        match = re.match(r"(\d+) hour fcst", period)
        if period == "anl":
            lead = 0
        elif match:
            lead = int(match[1])
        else:
            raise ValueError("Unknown instantaneous GRIB time descriptor")
        if physical and physical[-1][0] == offset:
            continue
        physical.append((offset, t, lead, cols[3]))
    for style in ("analysis", "flux", "second-analysis"):
        seen = set()
        offset = 0
        want = []
        for i, (pos, basehour, lead, field) in enumerate(physical):
            length = (physical[i + 1][0] if i + 1 < len(physical) else original) - pos
            if length < 20:
                raise ValueError("Invalid source offsets")
            ident = (basehour, field)
            if lead == 0:
                duplicate = ident in seen
                seen.add(ident)
            else:
                duplicate = False
            if style == "flux":
                keep = 1 <= lead <= 6
            else:
                keep = 1 <= lead <= 5 or (
                    lead == 0 and (duplicate if style == "second-analysis" else not duplicate)
                )
            if keep:
                if basehour + lead in hours:
                    want.append((offset, offset + length - 1))
                offset += length
        if offset == size:
            merged = []
            for start, end in want:
                if merged and merged[-1][1] + 1 == start:
                    merged[-1] = (merged[-1][0], end)
                else:
                    merged.append((start, end))
            return merged
    raise ValueError("GDEX does not use this exact NCEI inventory")


def subset(url, folder, product, ranges):
    signature = hashlib.sha256(repr(ranges).encode()).hexdigest()[:12]
    name = folder / (product + "-" + signature + ".selected.grb2")
    if name.exists():
        return name
    part = Path(str(name) + ".part")
    with part.open("wb") as target:
        for first in range(0, len(ranges), 128):
            spans = ranges[first : first + 128]
            cache = folder / f"{product}-{signature}-range-{spans[0][0]}-{spans[-1][1]}.grib"
            expected = sum(end - start + 1 for start, end in spans)
            if not cache.is_file() or cache.stat().st_size != expected:
                with request(url, {"Range": "bytes=" + ",".join(f"{a}-{b}" for a, b in spans)}) as r:
                    if r.status != 206:
                        raise ValueError("Requested GRIB ranges not served")
                    ctype = r.headers.get("Content-Type", "")
                    raw = r.read()
                    if len(spans) == 1:
                        if not r.headers.get("Content-Range", "").startswith(
                            f"bytes {spans[0][0]}-{spans[0][1]}/"
                        ):
                            raise ValueError("GRIB range identity mismatch")
                        result = raw
                    else:
                        boundary = re.search(r"boundary=\"?([A-Za-z0-9_-]+)", ctype)
                        if not boundary:
                            raise ValueError("Missing multipart GRIB ranges")
                        pieces = {}
                        for block in raw.split(b"--" + boundary[1].encode()):
                            header, sep, body = block.partition(b"\r\n\r\n")
                            if not sep:
                                continue
                            # GDEX's Globus HTTP endpoint omits the unit in the
                            # MIME part header. Always match both byte offsets.
                            m = re.search(rb"content-range:\s*(?:bytes\s+)?(\d+)-(\d+)/", header, re.I)
                            if not m:
                                raise ValueError("Missing GRIB range identity")
                            a, b = map(int, m.groups())
                            n = b - a + 1
                            if len(body) < n or body[n:].strip(b"\r\n"):
                                raise ValueError("Truncated multipart GRIB")
                            pieces[a, b] = body[:n]
                        if set(pieces) != set(spans):
                            raise ValueError("Incomplete GRIB ranges")
                        result = b"".join(pieces[span] for span in spans)
                if len(result) != expected:
                    raise ValueError("Incomplete GRIB subset")
                temp = Path(str(cache) + ".part")
                temp.write_bytes(result)
                os.replace(temp, cache)
            target.write(cache.read_bytes())
    os.replace(part, name)
    return name


def as_hour(date, clock):
    stamp = f"{date:08d}{clock:04d}"
    if not stamp.endswith("00"):
        raise ValueError("Non-hourly GRIB time")
    return int(dt.datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=UTC).timestamp() // 3600)


@contextmanager
def grib_file(selected):
    # CFSv2 often packs the U and V components in one physical message.
    # Each decoder process owns its ecCodes multi-field context.
    ec.codes_grib_multi_support_on()
    with selected.open("rb") as stream:
        try:
            yield stream
        finally:
            ec.codes_grib_multi_support_reset_file(stream)


def native_file(cache, month, product, hours, decoders=None, domain="national"):
    folder = cache / month
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / (product + ".npz")
    if input_ready(output, hours, month):
        return
    low = month < "2026-01" and product != "apcp"
    obj = archive_object(month, product)
    filename = obj.rsplit("/", 1)[1]
    url = f"https://data.gdex.ucar.edu/{obj}"
    with request(url, method="HEAD") as r:
        size = int(r.headers["Content-Length"])
    selected = None
    if low and not (folder / filename).exists():
        try:
            spans = index_ranges(folder, month, product, size, hours)
            if spans:
                selected = subset(url, folder, product, spans)
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            # An absent/different original inventory cannot be used to address
            # bytes. Reading the archive's own complete object is authoritative.
            pass
    if selected is None:
        selected = get_bulk(url, folder / filename, size)
    if decoders is None:
        decode_file(selected, output, month, product, hours, domain)
    else:
        decoders.submit(decode_file, selected, output, month, product, hours, domain).result()


def decode_file(selected, output, month, product, hours, domain="national"):
    specs = {PARAMS[key]: (key, level, scale, add) for key, _, level, _, scale, add in PRODUCTS[product]}
    x, y = geometry(month, product == "apcp", domain)
    geo = {}
    values = {k: {} for k, *_ in PRODUCTS[product]}
    refs = {}
    with grib_file(selected) as f:
        while True:
            g = ec.codes_grib_new_from_file(f)
            if g is None:
                break
            try:
                get = lambda key: ec.codes_get(g, key)
                h = as_hour(get("validityDate"), get("validityTime"))
                if h not in hours:
                    continue
                ref = as_hour(get("dataDate"), get("dataTime"))
                lead = h - ref
                code = (get("parameterCategory"), get("parameterNumber"))
                if (
                    get("edition") != 2
                    or get("discipline") != 0
                    or get("centre") not in ("kwbc", 7)
                    or code not in specs
                    or not 0 <= lead <= 6
                ):
                    raise ValueError("Unexpected CFS GRIB identity")
                key, level, scale, add = specs[code]
                typ = get("typeOfLevel")
                expected = (
                    "isobaricInhPa"
                    if level and level > 100
                    else "heightAboveGround" if level else "meanSea" if key == "msl" else "surface"
                )
                if typ != expected or (level and get("level") != (level // 100 if level > 100 else level)):
                    raise ValueError("Unexpected GRIB level for " + key)
                if get("stepUnits") not in (1, "h") or get("endStep") != lead:
                    raise ValueError("GRIB duration does not match the reference and validity times")
                if key == "rain":
                    if (
                        get("stepType") != "accum"
                        or get("endStep") - get("startStep") != 1
                        or lead != get("endStep")
                    ):
                        raise ValueError("Expected an exact 1-hour accumulation")
                elif get("stepType") != "instant":
                    raise ValueError("Expected instantaneous " + key)
                if h in values[key]:
                    raise ValueError("Duplicate archived GRIB hour")
                nx, ny = get("Ni"), get("Nj")
                identity = (
                    nx,
                    ny,
                    get("latitudeOfFirstGridPointInDegrees"),
                    get("longitudeOfFirstGridPointInDegrees"),
                )
                if identity not in geo:
                    if (
                        get("gridType") not in ("regular_ll", "regular_gg")
                        or get("jPointsAreConsecutive")
                        or get("alternativeRowScanning")
                    ):
                        raise ValueError("Unsupported CFS grid")
                    lon = ec.codes_get_array(g, "longitudes").reshape(ny, nx)[0, :]
                    lat = ec.codes_get_array(g, "latitudes").reshape(ny, nx)[:, 0]
                    # Match the documented spatial sampling used by the DAP reader.
                    sx, lons = spatial_axis(lon, x)
                    sy, lats = spatial_axis(lat, y)

                    def indices(s):
                        lo, step, hi = map(int, s.strip("[]").split(":"))
                        return slice(lo, hi + 1, step)

                    geo[identity] = (indices(sy), indices(sx), lons, lats)
                iy, ix, lon, lat = geo[identity]
                data = ec.codes_get_values(g).reshape(ny, nx)[iy, ix].astype("f4")
                if get("bitmapPresent"):
                    data[data == get("missingValue")] = np.nan
                sampled = resample(data[None], lon, lat, x, y)[0]
                number = np.rint((sampled + add) * scale)
                good = np.isfinite(number)
                if np.any((number[good] > 32767) | (number[good] <= MISSING)):
                    raise ValueError("GRIB quantization overflow")
                values[key][h] = np.where(good, number, MISSING).astype("<i2")
                refs[h] = lead
            finally:
                ec.codes_release(g)
    stamps = sorted(refs)
    if not stamps:
        raise ValueError("The input object has no matching valid times")
    if any(set(d) != set(stamps) for d in values.values()):
        raise ValueError("Incomplete native components")
    with open(str(output) + ".part", "wb") as f:
        np.savez_compressed(
            f,
            requested=np.asarray(sorted(hours), dtype="<i4"),
            hours=np.asarray(stamps, dtype="<i4"),
            leads=np.asarray([refs[h] for h in stamps], dtype="i1"),
            **{k: np.stack([d[h] for h in stamps]) for k, d in values.items()},
        )
    os.replace(str(output) + ".part", output)
