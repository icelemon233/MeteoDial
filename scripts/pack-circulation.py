"""Package real Eurasian 500 hPa maps for every overview and detailed chapter."""

import argparse
from collections import defaultdict
import json
from pathlib import Path
import runpy
import numpy as np
from cfs_archive import ROOT, CORE_PRODUCTS, MISSING, needed_hours, utc_hour, month_for, jobs_for

base = runpy.run_path(str(ROOT / "scripts/pack-subdaily-disasters.py"))
fields = {k: CORE_PRODUCTS[k] for k in ("z500", "pressfc")}


def hours_by_month():
    hs = needed_hours()
    for c in json.loads((ROOT / "assets/data/catalog.json").read_text("utf8")):
        hs.update(utc_hour(c["run"]) + lead for lead in c["leads"])
    months = defaultdict(set)
    for h in hs:
        months[month_for(h)].add(h)
    return months


def build(cache, m, hs):
    data = base["input_data"](cache / "eurasia", m, fields)

    def at(h):
        z, lead = data["height"][h]
        ps, _ = data["ps"][h]
        if z.shape != (33, 69) or ps.shape != z.shape:
            raise ValueError("Wrong Eurasian archive geometry")
        mask = np.where(ps == MISSING, MISSING, ps <= 5000).astype("<i2")
        return {"height": np.where(mask == 0, z, MISSING).astype("<i2"), "terrain": mask}, [lead]

    base["write_month"](
        ROOT / "assets/cases/circulation",
        m,
        hs,
        at,
        ("height", "terrain"),
        b"MDEUR501",
        {"bbox": [10, 0, 180, 80], "step": 2.5, "nx": 69, "ny": 33},
        cadence=1,
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("cache", type=Path)
    p.add_argument("--months", nargs="+")
    a = p.parse_args()
    for m, hs in sorted(hours_by_month().items()):
        if not a.months or m in a.months:
            build(a.cache, m, hs)
            print(m, len(hs), flush=True)


if __name__ == "__main__":
    main()
