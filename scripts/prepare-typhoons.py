"""Bundle JMA's published RSMC best tracks, including the observed In-fa positions."""

import argparse, datetime as dt, gzip, io, json, re, zipfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
URL = "https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/Besttracks/bst_all.zip"


def parse(text):
    storms = []
    current = None
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "66666":
            if current and len(current["points"]) != current["count"]:
                raise ValueError("Truncated JMA track")
            m = re.fullmatch(r"66666\s+(\d{4})\s+(\d+)\s+.*", line)
            if not m:
                raise ValueError("Invalid JMA header")
            current = {"id": m[1], "count": int(m[2]), "name": line[30:50].strip(), "points": []}
            storms.append(current)
            continue
        if current is None or not re.fullmatch(r"\d{8}", parts[0]):
            raise ValueError("Invalid JMA position")
        clock = parts[0]
        yy = int(clock[:2])
        year = (1900 if yy >= 51 else 2000) + yy
        t = dt.datetime.strptime(str(year) + clock[2:], "%Y%m%d%H").replace(tzinfo=dt.timezone.utc)
        lat = int(parts[3]) / 10
        lon = int(parts[4]) / 10
        hp = int(parts[5])
        kt = int(line[33:36].strip() or "0")
        if not (-90 <= lat <= 90 and 0 <= lon < 360):
            raise ValueError("Invalid JMA coordinates")
        current["points"].append(
            [
                int(t.timestamp() // 3600),
                lon - 360 if lon > 180 else lon,
                lat,
                int(parts[2]),
                hp or None,
                kt or None,
            ]
        )
    if not current or len(current["points"]) != current["count"]:
        raise ValueError("Truncated final track")
    return storms


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--file", type=Path)
    o = p.parse_args()
    raw = o.file.read_bytes() if o.file else urllib.request.urlopen(URL, timeout=60).read()
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        storms = parse(z.read(next(n for n in z.namelist() if n.lower().endswith(".txt"))).decode("ascii"))
    folder = ROOT / "assets/data/typhoons"
    folder.mkdir(exist_ok=True)
    years = {}
    for s in storms:
        year = (1900 if int(s["id"][:2]) >= 51 else 2000) + int(s["id"][:2])
        years.setdefault(year, []).append(s)
    for year, rows in years.items():
        (folder / f"{year}.json.gz").write_bytes(
            gzip.compress(json.dumps(rows, separators=(",", ":")).encode(), mtime=0)
        )
    (folder / "index.json").write_text(
        json.dumps(
            {
                "years": sorted(years, reverse=True),
                "source": "日本气象厅 RSMC 东京最佳路径",
                "url": "https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/besttrack.html",
            },
            ensure_ascii=False,
        ),
        encoding="utf8",
    )
    print(len(storms), "tracks", min(years), max(years))
