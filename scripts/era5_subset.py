"""Read only the Blosc blocks covering the requested ERA5 coordinates and hours."""

from functools import lru_cache
import datetime as dt
import http.client
import json
import re
import struct
import time
import urllib.error
import numpy as np
from numcodecs import get_codec
from numcodecs.blosc import decompress
from cfs_archive import UTC, utc_hour, interpolation
from cfs_transport import response

WB = "https://storage.googleapis.com/weatherbench2/datasets/era5/1959-2023_01_10-1h-240x121_equiangular_with_poles_conservative.zarr"
ARCO = "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"


def fetch(url, limits=None, with_generation=False):
    for attempt in range(5):
        try:
            headers = {"Range": f"bytes={limits[0]}-{limits[1]}"} if limits else {}
            with response(url, headers, timeout=50) as res:
                if limits:
                    r = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", res.headers.get("Content-Range", ""))
                    if (
                        res.status != 206
                        or not r
                        or int(r[1]) != limits[0]
                        or int(r[2]) != min(limits[1], int(r[3]) - 1)
                    ):
                        raise ValueError("Unexpected Google Cloud object range")
                data = res.read()
                if limits and len(data) != int(r[2]) - int(r[1]) + 1:
                    raise EOFError("Incomplete ERA5 range")
                if with_generation:
                    generation = res.headers.get("x-goog-generation", "")
                    if not generation.isdigit():
                        raise ValueError("Missing ERA5 object generation")
                    return data, generation
                return data
        except (OSError, EOFError, http.client.HTTPException, ValueError) as ex:
            if getattr(ex, "code", None) in (403, 404) or attempt == 4:
                raise
            time.sleep(2**attempt)


class Store:
    def __init__(self, url):
        self.url = url
        self.meta = json.loads(fetch(url + "/.zmetadata"))["metadata"]
        self.x = self.coordinate("longitude", 0)
        self.y = self.coordinate("latitude", 0)
        self.levels = self.coordinate("level", 0)
        attrs = self.meta["time/.zattrs"]
        match = re.fullmatch(r"hours since (\d{4}-\d\d-\d\d)(?:[ T]00:00:00(?:\.0*)?)?", attrs["units"])
        if not match:
            raise ValueError("Unknown ERA5 time coordinate")
        self.epoch = utc_hour(match[1])
        self.first = int(self.coordinate("time", 0)[0]) + self.epoch
        self.tsize = self.meta["time/.zarray"]["chunks"][0]

    @lru_cache(maxsize=48)
    def coordinate(self, name, chunk):
        spec = self.meta[name + "/.zarray"]
        data = fetch(self.url + f"/{name}/{chunk}")
        if spec["compressor"]:
            data = get_codec(spec["compressor"]).decode(data)
        return np.frombuffer(data, dtype=spec["dtype"])

    def hour_index(self, h):
        i = h - self.first
        if (
            i < 0
            or i >= self.meta["time/.zarray"]["shape"][0]
            or self.epoch + int(self.coordinate("time", i // self.tsize)[i % self.tsize]) != h
        ):
            raise ValueError("Missing ERA5 hour " + str(h))
        stop = self.meta[".zattrs"].get("valid_time_stop_era5t")
        if stop and dt.datetime.fromtimestamp(h * 3600, UTC).date() > dt.date.fromisoformat(stop[:10]):
            raise ValueError("Requested hour exceeds the published ERA5T coverage")
        return i

    def read(self, field, hours, levels, x, y, units):
        spec = self.meta[field + "/.zarray"]
        attrs = self.meta[field + "/.zattrs"]
        dims = attrs["_ARRAY_DIMENSIONS"]
        if (
            attrs.get("units") != units
            or spec["order"] != "C"
            or spec["dtype"] != "<f4"
            or spec["compressor"].get("id") != "blosc"
        ):
            raise ValueError("Unexpected ERA5 units or packing for " + field)
        shape = spec["chunks"]
        indices = [self.hour_index(int(h)) for h in hours]
        chunk = indices[0] // shape[0]
        if any(i // shape[0] != chunk for i in indices):
            raise ValueError("Split the request at storage chunk boundaries")
        xx, wx = interpolation(self.x, x)
        yy, wy = interpolation(self.y, y)
        spatial = []
        weights = []
        for dy, w1 in ((0, 1 - wy), (1, wy)):
            for dx, w2 in ((0, 1 - wx), (1, wx)):
                weight = w1[:, None] * w2[None, :]
                if not np.any(weight):
                    continue
                if dims[-2:] == ["latitude", "longitude"]:
                    s = (yy[:, None] + dy) * len(self.x) + xx + dx
                elif dims[-2:] == ["longitude", "latitude"]:
                    s = (xx[None, :] + dx) * len(self.y) + yy[:, None] + dy
                else:
                    raise ValueError("Unknown ERA5 horizontal coordinates")
                spatial.append(s.astype("i8"))
                weights.append(weight)
        lvl = [int(np.flatnonzero(self.levels == p).item()) for p in levels] if levels else [0]
        stride = len(self.x) * len(self.y)
        offsets = np.array(
            [[(i % shape[0] * (shape[1] if levels else 1) + j) * stride for j in lvl] for i in indices],
            dtype="i8",
        )
        flat = offsets[:, :, None, None, None] + np.stack(spatial)[None, None, :, :, :]
        url = self.url + "/" + field + "/" + ".".join(map(str, [chunk] + [0] * (len(shape) - 1)))
        vals = read_positions(url, flat, np.prod(shape, dtype="i8") * 4)
        weighted = np.zeros((len(hours), len(lvl), len(y), len(x)), dtype="f4")
        for i, weight in enumerate(weights):
            weighted += np.where(weight != 0, vals[:, :, i] * weight, 0)
        return weighted


def read_positions(url, indexes, expected):
    prefix, generation = fetch(url, (0, 4095), True)
    url += "?generation=" + generation
    _, _, flags, item, nbytes, bs, size = struct.unpack_from("<BBBBIII", prefix)
    if item != 4 or nbytes != expected or bs <= 0 or size < 16:
        raise ValueError("Unexpected ERA5 Blosc header")
    count = (nbytes + bs - 1) // bs
    bytepos = indexes.ravel() * 4
    blocks, group = np.unique(bytepos // bs, return_inverse=True)
    if flags & 2:
        spans = {int(k): (16 + int(k) * bs, 16 + min((int(k) + 1) * bs, nbytes)) for k in blocks}
    else:
        stop = 16 + count * 4
        header = prefix if stop <= len(prefix) else fetch(url, (0, stop - 1))
        starts = struct.unpack_from("<" + "I" * count, header, 16)
        if min(starts) < stop or max(starts) >= size or len(set(starts)) != count:
            raise ValueError("Invalid ERA5 block offsets")
        sorted_starts = sorted(starts) + [size]
        ends = dict(zip(sorted_starts, sorted_starts[1:]))
        spans = {int(k): (starts[k], ends[starts[k]]) for k in blocks}
    # Nearby blocks share a single range request, bounded to limit RAM on busy builds.
    batches = []
    for k, (a, b) in sorted(spans.items(), key=lambda pair: pair[1][0]):
        if batches and a - batches[-1][1] <= 196608 and b - batches[-1][0] <= 6 * 1024**2:
            batches[-1][1] = b
            batches[-1][2].append(k)
        else:
            batches.append([a, b, [k]])
    perm = np.argsort(group, kind="stable")
    by_block = {}
    for k, indices in zip(blocks, np.split(perm, np.cumsum(np.bincount(group))[:-1])):
        by_block[int(k)] = indices
    out = np.empty(bytepos.shape, dtype="f4")
    for a, b, keys in batches:
        body = prefix[a:b] if b <= len(prefix) else fetch(url, (a, b - 1))
        for k in keys:
            lo, hi = spans[k]
            raw = body[lo - a : hi - a]
            length = min(bs, nbytes - k * bs)
            if not (flags & 2):
                raw = decompress(prefix[:4] + struct.pack("<IIII", length, bs, 20 + len(raw), 20) + raw)
            if len(raw) != length:
                raise ValueError("Wrong ERA5 block length")
            where = by_block[k]
            out[where] = np.frombuffer(raw, dtype="<f4")[(bytepos[where] - k * bs) // 4]
    return out.reshape(indexes.shape)
