"""Prepare offline China boundary lines and the world's land and physical coastline."""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from urllib.request import urlopen

import shapefile
from shapely.geometry import LineString

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://api.github.com/repos/nmcdev/nmc_met_graphics/contents/nmc_met_graphics/resources/maps/'
REVISION = '4fcbfdd'
NATURAL_EARTH = {
    'land': '0b8e670cf80dce9cbebe2a193bc44ba5602758c22e1fa603980553646d7ff162',
    'coastline': '640f805509b822f57f4840a2e18d9ff2412cf1cf6976124701c2789436166fde',
}


def parts(shape):
    ends = list(shape.parts) + [len(shape.points)]
    for start, end in zip(ends, ends[1:]):
        yield shape.points[start:end]


def coordinates(vertices):
    # The source polygons are cut at ±180°. Keep long straight pole edges in
    # short segments as well, so no exported edge can be interpreted as a wrap.
    line = LineString(vertices).simplify(0.008).segmentize(12)
    return [[round(x, 4), round(y, 4)] for x, y in line.coords]


def write_paths(name, paths):
    (ROOT / 'assets/data' / name).write_text(
        json.dumps(paths, separators=(',', ':')) + '\n', encoding='utf8')


def pack_basemap():
    folder = ROOT / 'assets/data'
    output = bytearray(b'MDG1')
    for filename in ('land.json', 'coastlines.json', 'china-boundaries.json'):
        lines = json.loads((folder / filename).read_text('utf8'))
        output.extend(struct.pack('<I', len(lines)))
        for line in lines:
            points = [(round(lon * 10000), round(lat * 10000)) for lon, lat in line]
            lons, lats = zip(*points)
            output.extend(struct.pack('<I4i', len(points), min(lons), min(lats), max(lons), max(lats)))
            output.extend(b''.join(struct.pack('<2i', *point) for point in points))
    tmp = folder / 'basemap-v1.bin.part'
    tmp.write_bytes(output)
    tmp.replace(folder / 'basemap-v1.bin')


def world_paths(folder, layer):
    name = f'ne_50m_{layer}.zip'
    file = folder / name
    expected = NATURAL_EARTH[layer]
    if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
        with urlopen('https://naturalearth.s3.amazonaws.com/50m_physical/' + name, timeout=60) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f'Expected Natural Earth 4.1.0 in {file}')
        tmp = file.with_suffix('.part')
        tmp.write_bytes(content)
        tmp.replace(file)
    with shapefile.Reader(str(file)) as reader:
        return [coordinates(points) for shape in reader.iterShapes() for points in parts(shape)]


def source_file(folder, name):
    file = folder / name
    if not file.exists():
        with urlopen(f'{SOURCE}{name}?ref={REVISION}', timeout=40) as response:
            meta = json.load(response)
        with urlopen(meta['download_url'], timeout=60) as response:
            content = response.read()
        blob = b'blob ' + str(len(content)).encode() + b'\0' + content
        if hashlib.sha1(blob).hexdigest() != meta['sha']:
            raise ValueError(f'Unexpected source file: {name}')
        file.write_bytes(content)
    return file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=ROOT / '.data-cache' / 'nmc-boundaries')
    folder = parser.parse_args().source_dir
    folder.mkdir(parents=True, exist_ok=True)
    for ext in ('shp', 'shx', 'dbf'):
        source_file(folder, 'bou1_4l.' + ext)
    paths = []
    with shapefile.Reader(str(folder / 'bou1_4l.shp')) as reader:
        for feature in reader.iterShapeRecords():
            # The source's national boundary and physical shore / island linework.
            if feature.record['GBCODE'] not in (61010, 61020, 26010, 26080, 26100):
                continue
            paths.extend(coordinates(points) for points in parts(feature.shape))
    write_paths('china-boundaries.json', paths)
    write_paths('land.json', world_paths(folder, 'land'))
    write_paths('coastlines.json', world_paths(folder, 'coastline'))
    pack_basemap()


if __name__ == '__main__':
    main()
