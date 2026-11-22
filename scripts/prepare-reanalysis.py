"""Build the ERA5 vertical-structure chapters from actual hourly WeatherBench 2 fields."""

import concurrent.futures
import datetime as dt
import http.client
import json
import os
import ssl
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from numcodecs import get_codec
from numcodecs.blosc import decompress

ROOT = Path(__file__).resolve().parents[1]
BASE = (
    "https://storage.googleapis.com/weatherbench2/datasets/era5/"
    "1959-2023_01_10-1h-240x121_equiangular_with_poles_conservative.zarr"
)
CACHE = Path(os.getenv("GUANXIANG_BUILD_CACHE", ROOT / ".data-cache")) / "weatherbench2-hourly"
BOUNDS = json.loads((ROOT / "assets/data/archive-domain.json").read_text(encoding="utf8"))
EPOCH = dt.datetime(1959, 1, 1, tzinfo=dt.timezone.utc)
F = {
    "temp2": [("2m_temperature", None)],
    "temp925": [("temperature", 925)],
    "temp850": [("temperature", 850)],
    "pressure": [("mean_sea_level_pressure", None)],
    "height500": [("geopotential", 500)],
    "wind850": [("u_component_of_wind", 850), ("v_component_of_wind", 850)],
}


def fetch(key, span=None):
    file = CACHE / key
    if span:
        file = Path(str(file) + f"-{span[0]}-{span[1]}")
    if file.is_file():
        return file.read_bytes()
    file.parent.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context(cafile=os.getenv("CFS_CA_FILE"))
    handlers = [urllib.request.HTTPSHandler(context=ctx)]
    if os.getenv("CFS_DIRECT") == "1":
        handlers.append(urllib.request.ProxyHandler({}))
    opener = urllib.request.build_opener(*handlers)
    headers = {"User-Agent": "MeteoDial historical archive builder", "Accept-Encoding": "identity"}
    if span:
        headers["Range"] = f"bytes={span[0]}-{span[1]}"
    for attempt in range(5):
        try:
            with opener.open(urllib.request.Request(BASE + "/" + key, headers=headers), timeout=85) as r:
                if span and (
                    r.status != 206
                    or not r.headers.get("Content-Range", "").startswith(f"bytes {span[0]}-{span[1]}/")
                ):
                    raise ValueError("Unexpected ERA5 byte range")
                data = r.read()
            if span and len(data) != span[1] - span[0] + 1:
                raise ValueError("Incomplete ERA5 block")
            temp = Path(str(file) + ".part")
            temp.write_bytes(data)
            temp.replace(file)
            return data
        except (OSError, ValueError, http.client.HTTPException):
            if attempt == 4:
                raise
            time.sleep(2**attempt)


def coordinate(meta, var, key="0"):
    spec = meta[var + "/.zarray"]
    return np.frombuffer(
        get_codec(spec["compressor"]).decode(fetch(var + "/" + key)), dtype=spec["dtype"]
    )


def get_blocks(file, needed):
    # Blosc blocks are independent. Fetch only the compressed blocks touching
    # the selected pressure level, time and geographic window.
    prefix = fetch(file, (0, 1023))
    _, _, flags, _, nbytes, blocksize, cbytes = struct.unpack_from("<BBBBIII", prefix)
    count = (nbytes + blocksize - 1) // blocksize
    if flags & 2:
        return {
            i: fetch(file, (16 + i * blocksize, 15 + min((i + 1) * blocksize, nbytes)))
            for i in needed(blocksize)
        }, blocksize
    end = 16 + 4 * count
    header = prefix if end <= len(prefix) else fetch(file, (0, end - 1))
    starts = struct.unpack_from("<" + "I" * count, header, 16)
    if len(set(starts)) != count or min(starts) < end or max(starts) >= cbytes:
        raise ValueError("Invalid Blosc directory")
    seq = sorted(starts) + [cbytes]
    stops = dict(zip(seq, seq[1:]))
    result = {}
    for i in needed(blocksize):
        chunk = fetch(file, (starts[i], stops[starts[i]] - 1))
        size = min(blocksize, nbytes - i * blocksize)
        single = prefix[:4] + struct.pack("<IIII", size, blocksize, 20 + len(chunk), 20) + chunk
        value = decompress(single)
        if len(value) != size:
            raise ValueError("Unexpected decoded block length")
        result[i] = value
    return result, blocksize


def extract_job(meta, field, chunk, requests, spatial):
    spec = meta[field + "/.zarray"]
    shape = spec["chunks"]
    dtype = np.dtype(spec["dtype"])
    if dtype != np.dtype("<f4") or spec["order"] != "C":
        raise ValueError("Unexpected ERA5 storage order")
    key = field + "/" + ".".join(map(str, [chunk] + [0] * (len(shape) - 1)))
    stride = shape[-2] * shape[-1]
    indices = {
        r: spatial + (h % shape[0] * (shape[1] if len(shape) == 4 else 1) + (lev or 0)) * stride
        for r, h, lev in requests
    }

    def needed(blocksize):
        return sorted(
            {int(i) for idx in indices.values() for i in np.unique(idx * (dtype.itemsize) // blocksize)}
        )

    parts, bs = get_blocks(key, needed)
    out = {}
    for identity, idx in indices.items():
        group = idx * 4 // bs
        loc = (idx * 4 % bs) // 4
        values = np.empty(idx.shape, dtype=dtype)
        for i in np.unique(group):
            mask = group == i
            values[mask] = np.frombuffer(parts[int(i)], dtype=dtype)[loc[mask]]
        out[identity] = values.astype(float)
    return out


def main():
    meta = json.loads(fetch(".zmetadata"))["metadata"]
    lat, lon, levels = [coordinate(meta, n) for n in ["latitude", "longitude", "level"]]
    west, south, east, north = BOUNDS
    xi = np.flatnonzero((lon >= west) & (lon <= east))
    yi = np.flatnonzero((lat >= south) & (lat <= north))
    yi = yi[np.argsort(-lat[yi])]
    if not np.allclose([lon[xi[0]], lat[yi[-1]], lon[xi[-1]], lat[yi[0]]], BOUNDS):
        raise ValueError("Wrong ERA5 domain")
    spatial = (xi[None, :] * len(lat) + yi[:, None]).ravel()
    for c in json.loads((ROOT / "assets/data/catalog.json").read_text(encoding="utf8")):
        if c.get("dataMode") != "reanalysis":
            continue
        root = ROOT / "assets/cases" / c["id"]
        root.mkdir(parents=True, exist_ok=True)
        base = dt.datetime.fromisoformat(c["run"]).replace(tzinfo=dt.timezone.utc)
        fields = {pair for k in c["layers"] for pair in F.get(k, [])} | {("surface_pressure", None)}
        jobs = {}
        for lead in c["leads"]:
            stamp = base + dt.timedelta(hours=lead)
            h = int((stamp - EPOCH).total_seconds() // 3600)
            tsize = meta["time/.zarray"]["chunks"][0]
            if coordinate(meta, "time", str(h // tsize))[h % tsize] != h:
                raise ValueError("Wrong ERA5 valid hour")
            for field, p in fields:
                j = meta[field + "/.zarray"]["chunks"][0]
                jobs.setdefault((field, h // j), []).append(
                    ((lead, field, p), h, None if p is None else int(np.flatnonzero(levels == p).item()))
                )
        extracted = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [
                pool.submit(extract_job, meta, k[0], k[1], req, spatial) for k, req in jobs.items()
            ]
            for f in concurrent.futures.as_completed(futures):
                extracted.update(f.result())
        for lead in c["leads"]:
            stamp = base + dt.timedelta(hours=lead)
            ps = extracted[lead, "surface_pressure", None] / 100
            for layer in c["layers"]:
                if layer not in F:
                    continue
                grid = {
                    "layer": layer,
                    "bbox": BOUNDS,
                    "step": c["step"],
                    "nx": len(xi),
                    "ny": len(yi),
                    "valid": stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    "type": "再分析",
                    "source": "ECMWF ERA5 · WeatherBench 2",
                    "resolution": "1.5°",
                }
                for j, (field, p) in enumerate(F[layer]):
                    a = extracted[lead, field, p].copy()
                    if "temperature" in field:
                        a -= 273.15
                    if field == "geopotential":
                        a /= 9.80665
                    if field == "mean_sea_level_pressure":
                        a /= 100
                    if p:
                        below = np.isfinite(ps) & (ps <= p)
                        grid["terrainMask"] = below.astype(int).tolist()
                        a[below | ~np.isfinite(ps)] = np.nan
                    grid["v" if j else "values"] = [
                        round(float(v), 1) if np.isfinite(v) else None for v in a
                    ]
                file = root / f"{layer}-{lead}.json"
                tmp = Path(str(file) + ".part")
                tmp.write_text(
                    json.dumps(grid, ensure_ascii=False, separators=(",", ":")), encoding="utf8"
                )
                tmp.replace(file)
        print(c["id"], len(c["leads"]), "hourly-source frames", flush=True)


if __name__ == "__main__":
    main()
