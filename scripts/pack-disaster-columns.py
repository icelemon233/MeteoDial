"""Pack the supplementary, terrain-masked CFS fields for every archive frame.

python scripts/pack-disaster-columns.py CACHE [--months YYYY-MM ...]
python scripts/pack-disaster-columns.py CACHE --summaries-only
"""

import argparse
from collections import defaultdict
import gzip
import json
import os
from pathlib import Path
import runpy
import numpy as np
from cfs_archive import ROOT, COLUMN_PRODUCTS, CORE_PRODUCTS, MISSING, event_hours, month_for

base = runpy.run_path(str(ROOT / "scripts/pack-subdaily-disasters.py"))
layout = json.loads((ROOT / "assets/data/disaster-columns.json").read_text())
ORDER = layout["fields"]
LEADS = layout["leadFields"]
MAGIC = layout["magic"].encode()
products = {**COLUMN_PRODUCTS, **{k: CORE_PRODUCTS[k] for k in ("pressfc", "tmp2m", "q700", "t700")}}
folder = ROOT / "assets/cases/disaster-columns"
extra_layers = [
    "autoTransport",
    "autoMoisture",
    "autoUpper",
    "autoNear",
    "wind700",
    "wind500",
    "wind200",
    "div200",
    "height700",
    "temp850",
    "temp700",
    "temp500",
    "moisture850",
    "moisture500",
]


def pack_month(cache, month, times):
    fields = base["input_data"](cache, month, products)

    def frame_at(h):
        data = {}
        refs = {}
        for key in (
            "ps",
            "q2",
            "t2",
            "z700",
            "u700",
            "v700",
            "u500",
            "v500",
            "u200",
            "v200",
            "t850",
            "q850",
            "t700",
            "q700",
            "t500",
            "q500",
        ):
            raw = {"t700": "t", "q700": "q"}.get(key, key)
            if h not in fields[raw]:
                raise ValueError(f"Missing {raw} at {base['iso'](h)}")
            data[key], refs[key] = fields[raw][h]
        for a, b in (
            ("t700", "q700"),
            ("t850", "q850"),
            ("t500", "q500"),
            ("u700", "v700"),
            ("u500", "v500"),
            ("u200", "v200"),
        ):
            if refs[a] != refs[b]:
                raise ValueError(f"Mixed initialization for {a}/{b} at {base['iso'](h)}")
        if fields["t2"][h][1] != refs["q2"]:
            raise ValueError(f"Mixed 2 m initialization at {base['iso'](h)}")
        ps = data["ps"]
        for key in ("2", "850", "500"):
            temperature = data["t" + key]
            humidity = data["q" + key]
            tc = temperature.astype("f8") / (10 if key == "2" else 100)
            q = humidity.astype("f8") / 100000
            p = ps.astype("f8") / 10 if key == "2" else float(key)
            valid = (temperature != MISSING) & (humidity >= 0) & (ps != MISSING)
            tc = np.where(valid, tc, 0)
            q = np.where(valid, q, 0)
            rh = 100 * p * q / (0.622 + 0.378 * q) / (6.112 * np.exp(17.67 * tc / (tc + 243.5)))
            data["rh" + key] = np.where(valid, np.rint(rh * 2), MISSING).astype("<i2")
        for key in ("t850", "t700", "t500", "u700", "v700", "u500", "v500", "u200", "v200"):
            a = data[key]
            data[key] = np.where(a == MISSING, MISSING, np.rint(a * (0.1 if key[0] == "t" else 0.4))).astype(
                "<i2"
            )
        for key in ORDER:
            if key in ("ps", "rh2"):
                continue
            p = int(key.lstrip("uvztrh"))
            data[key] = np.where(ps > p * 10, data[key], MISSING).astype("<i2")
        if any(not np.any(data[k] != MISSING) for k in ORDER):
            raise ValueError(f"National field entirely missing at {base['iso'](h)}")
        return data, [refs[k] for k in LEADS]

    base["write_month"](folder, month, times, frame_at, ORDER, MAGIC)


def summaries(events):
    places = {p[0]: p for p in json.loads((ROOT / "assets/data/places.json").read_text("utf8"))}
    by_time = defaultdict(list)
    values = {}
    cells = {}
    keys = ("ps", "u700", "v700", "u500", "v500", "moisture500")
    for e in events:
        place = places[e["map"]["place"]]
        values[e["id"]] = {k: [] for k in keys}
        for h in event_hours(e):
            m = month_for(h)
            by_time[h].append(e["id"])
            if (e["id"], m) not in cells:
                cells[e["id"], m] = base["cell"](m, (place[5], place[4]))[:2]
    for m in sorted({month_for(h) for h in by_time}):
        for h, fields in base["samples_from_month"](folder / (m + ".bin"), MAGIC, ORDER, len(LEADS)):
            for eid in by_time[h]:
                x, y = cells[eid, m]

                def val(key, scale):
                    v = int(fields[key][y, x])
                    return None if v == MISSING else v / scale

                row = {k: val(k, 10 if k == "ps" else 4) for k in keys[:-1]}
                row["moisture500"] = val("rh500", 2)
                for k in keys:
                    values[eid][k].append(row[k])
    for e in events:
        eid = e["id"]
        f = ROOT / "assets/cases/disasters" / (eid + ".json.gz")
        b = json.loads(gzip.decompress(f.read_bytes()))
        series = values[eid]
        if any(len(a) != b["count"] for a in series.values()):
            raise ValueError("Incomplete event column " + eid)
        b["pointWeather"].update(series)
        index = (base["utc_hour"](b["focus"]) - base["utc_hour"](b["start"])) // 4
        b["atFocus"].update({k: a[index] for k, a in series.items()})
        b["layers"] = list(dict.fromkeys(base["LAYERS"] + extra_layers))
        b["columnVersion"] = 1
        dest = f.with_suffix(".gz.part")
        dest.write_bytes(
            gzip.compress(
                json.dumps(b, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(), mtime=0
            )
        )
        os.replace(dest, f)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--months", nargs="+")
    parser.add_argument("--summaries-only", action="store_true")
    args = parser.parse_args()
    events = json.loads((ROOT / "assets/data/disasters.json").read_text("utf8"))["events"]
    if not args.summaries_only:
        groups = defaultdict(set)
        for e in events:
            for h in event_hours(e):
                groups[month_for(h)].add(h)
        for m, times in sorted(groups.items()):
            if not args.months or m in args.months:
                pack_month(args.cache, m, times)
                print("Packed", m, len(times), flush=True)
    if not args.months:
        summaries(events)


if __name__ == "__main__":
    main()
