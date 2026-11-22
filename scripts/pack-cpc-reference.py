"""Pack the separate, date-labelled CPC gauge reference. Its values are never split into hours."""

import datetime as dt
import gzip
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote
import numpy as np
from cfs_archive import ROOT, MISSING, cached, dap_arrays


def main(cache):
    events = json.loads((ROOT / "assets/data/disasters.json").read_text(encoding="utf8"))["events"]
    days = defaultdict(set)
    for e in events:
        date = dt.date.fromisoformat(e["map"]["from"])
        end = dt.date.fromisoformat(e["map"]["to"])
        while date <= end:
            days[date.year].add(date)
            date += dt.timedelta(days=1)
    out = ROOT / "assets/cases/gauge-days"
    out.mkdir(parents=True, exist_ok=True)
    for y, selected in sorted(days.items()):
        start = dt.date(y, 1, 1)
        last = (max(selected) - start).days
        file = cache / (str(y) + "-rainDay.dap")
        url = f"https://psl.noaa.gov/thredds/dodsC/Datasets/cpc_global_precip/precip.{y}.nc.dods?" + quote(
            f"precip[0:1:{last}][29:2:179][104:2:330]", safe=""
        )
        file.parent.mkdir(parents=True, exist_ok=True)
        src = dap_arrays(cached(url, file, dap_arrays))
        stamp = (start - dt.date(1900, 1, 1)).days * 24
        if len(src["time"]) <= last or not np.array_equal(
            src["time"], stamp + np.arange(len(src["time"])) * 24
        ):
            raise ValueError("Invalid CPC dates")
        x, yaxis = src["lon"], src["lat"]
        if not np.allclose(np.diff(x), 1) or not np.allclose(np.diff(yaxis), -1):
            raise ValueError("CPC grid orientation mismatch")
        grouped = defaultdict(dict)
        for date in sorted(selected):
            a = src["precip"][(date - start).days].astype("f4")
            a = np.rint(np.where((a >= 0) & (a < 2500), a * 10, MISSING)).astype("<i2")
            grouped[date.strftime("%Y-%m")][date.day] = a
        import base64

        for month, frames in grouped.items():
            # Each row remains in source order (north to south). The browser
            # opens this small month file only when a gauge comparison is requested.
            result = {
                "month": month,
                "bbox": [float(x[0]), float(yaxis[-1]), float(x[-1]), float(yaxis[0])],
                "nx": len(x),
                "ny": len(yaxis),
                "days": {d: base64.b64encode(a.tobytes()).decode("ascii") for d, a in frames.items()},
            }
            target = out / (month + ".json.gz")
            temp = Path(str(target) + ".part")
            temp.write_bytes(
                gzip.compress(
                    json.dumps(result, separators=(",", ":")).encode("ascii"), compresslevel=6, mtime=0
                )
            )
            os.replace(temp, target)
        print(y, len(selected), flush=True)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
