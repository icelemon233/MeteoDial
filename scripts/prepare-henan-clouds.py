"""Build the ten-minute Henan AHI B13 observation sequence from official HSD segments.

Requires Satpy, pyresample, numpy and Pillow. The output retains calibrated
brightness temperatures on a geographic grid and the original observation time.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import gzip
import json
from pathlib import Path
import time
import xml.etree.ElementTree as ET
import numpy as np
import requests
from satpy import Scene

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/cases/henan-clouds"
BOUNDS = [109.5, 30.5, 118.0, 38.0]
STEP = 0.025
START = datetime(2021, 7, 20, 1, tzinfo=timezone.utc)
TIMES = [START + timedelta(minutes=10 * i) for i in range(73)]


def fetch_segment(cache, t, n):
    date = t.strftime("%Y%m%d")
    clock = t.strftime("%H%M")
    name = f"HS_H08_{date}_{clock}_B13_FLDK_R20_S{n:02d}10.DAT.bz2"
    dest = cache / name
    if dest.is_file():
        return dest
    url = "https://noaa-himawari8.s3.amazonaws.com/AHI-L1b-FLDK/" + t.strftime("%Y/%m/%d/%H%M/") + name
    for attempt in range(5):
        try:
            r = requests.get(url, timeout=(15, 75))
            r.raise_for_status()
            if len(r.content) < 20000 or not r.content.startswith(b"BZh"):
                raise ValueError("Incomplete HSD segment")
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(r.content)
            tmp.replace(dest)
            return dest
        except (ValueError, requests.RequestException):
            if attempt == 4:
                raise
            time.sleep(2**attempt)


def build(cache, t):
    stamp = t.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    dest = OUT / (t.strftime("%H%M") + ".bin.gz")
    segments = [fetch_segment(cache, t, n) for n in (2, 3)]
    west, south, east, north = BOUNDS
    lon, lat = np.meshgrid(
        np.linspace(west, east, round((east - west) / STEP) + 1),
        np.linspace(north, south, round((north - south) / STEP) + 1),
    )
    if not dest.exists():
        scn = Scene(reader="ahi_hsd", filenames=[str(f) for f in segments])
        scn.load(["B13"], calibration="brightness_temperature")
        bands = scn["B13"]
        a = bands.attrs
        valid = a["start_time"].replace(tzinfo=timezone.utc)
        if abs((valid - t).total_seconds()) > 70 or a["platform_name"] != "Himawari-8" or a["units"] != "K":
            raise ValueError(f"Wrong satellite channel or scan time {a.get('start_time')}")
        area = a["area"]
        ix, iy = area.get_array_indices_from_lonlat(lon, lat)
        if np.any(np.ma.getmaskarray(ix)) or np.any(np.ma.getmaskarray(iy)):
            raise ValueError("Incomplete HSD footprint")
        values = (
            np.asarray(bands.data.compute(scheduler="synchronous"))[np.asarray(iy), np.asarray(ix)] - 273.15
        )
        good = np.isfinite(values) & (values > -130) & (values < 80)
        if good.mean() < 0.99 or np.ptp(values[good]) < 8:
            raise ValueError("Empty or uncalibrated source scan")
        raw = np.where(good, np.rint(values * 10), -32768).astype("<i2").tobytes()
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(gzip.compress(raw, compresslevel=8, mtime=0))
        tmp.replace(dest)
    if len(gzip.decompress(dest.read_bytes())) != lon.size * 2:
        raise ValueError("Incomplete exported scan")
    return {"time": stamp, "file": dest.name}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("cache", type=Path)
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--sample", action="store_true")
    opts = p.parse_args()
    opts.cache.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    q = {"list-type": "2", "prefix": "AHI-L1b-FLDK/2021/07/20/", "delimiter": "/", "max-keys": "1000"}
    info = requests.get("https://noaa-himawari8.s3.amazonaws.com/", params=q, timeout=40)
    info.raise_for_status()
    xml = ET.fromstring(info.content)
    if xml.findtext("{*}IsTruncated") != "false":
        raise ValueError("Incomplete source inventory")
    published = {
        item.findtext("{*}Prefix").rstrip("/").split("/")[-1] for item in xml.findall("{*}CommonPrefixes")
    }
    times = [TIMES[42]] if opts.sample else [t for t in TIMES if t.strftime("%H%M") in published]
    if len(times) < (1 if opts.sample else 65):
        raise ValueError("Insufficient published observations")
    with ThreadPoolExecutor(max_workers=opts.workers) as pool:
        frames = []
        for f in pool.map(lambda t: build(opts.cache, t), times):
            frames.append(f)
            print(f["time"], flush=True)
    if not opts.sample:
        manifest = {
            "source": "JMA 葵花8号 AHI B13 · NOAA 开放归档",
            "sourceUrl": "https://registry.opendata.aws/noaa-himawari/",
            "bbox": BOUNDS,
            "step": STEP,
            "nx": round((BOUNDS[2] - BOUNDS[0]) / STEP) + 1,
            "ny": round((BOUNDS[3] - BOUNDS[1]) / STEP) + 1,
            "frames": frames,
            "gaps": [
                t.isoformat(timespec="milliseconds").replace("+00:00", "Z") for t in TIMES if t not in times
            ],
        }
        tmp = OUT / "index.json.part"
        tmp.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
        tmp.replace(OUT / "index.json")


if __name__ == "__main__":
    main()
