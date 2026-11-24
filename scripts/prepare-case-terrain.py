"""Trace actual terrain contours for the circulation and Henan evidence views."""

import argparse, io, gzip, json, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image
import contourpy
import requests
from shapely.geometry import LineString

ROOT = Path(__file__).resolve().parents[1]


def region(cache, bounds, step, zoom):
    west, south, east, north = bounds
    n = 2**zoom
    x = np.linspace(west, east, round((east - west) / step) + 1)
    y = np.linspace(south, north, round((north - south) / step) + 1)
    xm = np.minimum(np.floor((x + 180) / 360 * n * 256).astype(int), n * 256 - 1)
    ym = np.floor((1 - np.arcsinh(np.tan(np.radians(y))) / np.pi) * 0.5 * n * 256).astype(int)
    heights = np.full((len(y), len(x)), np.nan)

    def tile(pos):
        tx, ty = pos
        dest = cache / f"{zoom}-{tx}-{ty}.png"
        for attempt in range(4):
            try:
                if dest.is_file():
                    b = dest.read_bytes()
                else:
                    url = f"https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{zoom}/{tx}/{ty}.png"
                    res = requests.get(url, timeout=(12, 35))
                    res.raise_for_status()
                    b = res.content
                im = Image.open(io.BytesIO(b))
                im.load()
                if im.size != (256, 256):
                    raise ValueError("Wrong DEM tile dimensions")
                if not dest.exists():
                    dest.write_bytes(b)
                a = np.asarray(im.convert("RGB")).astype("f4")
                return tx, ty, a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768
            except (OSError, requests.RequestException, ValueError):
                if attempt == 3:
                    raise
                time.sleep(2**attempt)

    with ThreadPoolExecutor(max_workers=8) as pool:
        for tx, ty, dem in pool.map(
            tile, [(a, b) for a in np.unique(xm // 256) for b in np.unique(ym // 256)]
        ):
            xx = np.flatnonzero(xm // 256 == tx)
            yy = np.flatnonzero(ym // 256 == ty)
            heights[np.ix_(yy, xx)] = dem[np.ix_(ym[yy] % 256, xm[xx] % 256)]
    if not np.isfinite(heights).all():
        raise ValueError("Incomplete DEM")
    generator = contourpy.contour_generator(x=x, y=y, z=heights, line_type="Separate")
    lines = []
    for level in (200, 500, 1000, 2000, 4000):
        for points in generator.lines(level):
            line = LineString(points)
            if line.length < step * 6:
                continue
            coords = np.round(np.asarray(line.simplify(step * 0.7).coords), 3)
            if len(coords) > 1:
                lines.append([level, *[round(v, 3) for v in line.bounds], coords.ravel().tolist()])
    return {"bbox": bounds, "step": step, "lines": lines}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("cache", type=Path)
    args = p.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    out = {
        "source": "Mapzen Terrain Tiles",
        "url": "https://registry.opendata.aws/terrain-tiles/",
        "asia": region(args.cache, [10, 0, 180, 80], 0.25, 4),
        "henan": region(args.cache, [109, 30, 118, 39], 0.025, 7),
    }
    target = ROOT / "assets/data/relief-contours.json.gz"
    tmp = target.with_suffix(".part")
    tmp.write_bytes(gzip.compress(json.dumps(out, separators=(",", ":")).encode(), mtime=0))
    tmp.replace(target)
    print([(k, len(out[k]["lines"])) for k in ("asia", "henan")], flush=True)
