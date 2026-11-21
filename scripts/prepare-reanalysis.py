"""Build the offline ERA5 case grids. Requires numpy and numcodecs."""
import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
from numcodecs import get_codec

ROOT = Path(__file__).resolve().parents[1]
BASE = ('https://storage.googleapis.com/weatherbench2/datasets/era5/'
        '1959-2023_01_10-6h-240x121_equiangular_with_poles_conservative.zarr')
CACHE = Path(os.getenv('GUANXIANG_BUILD_CACHE', ROOT / '.data-cache')) / 'weatherbench2'
VARIABLES = {
    'temp2': [('2m_temperature', None)], 'temp850': [('temperature', 850)],
    'temp925': [('temperature', 925)], 'height500': [('geopotential', 500)],
    'pressure': [('mean_sea_level_pressure', None)],
    'wind850': [('u_component_of_wind', 850), ('v_component_of_wind', 850)],
}

def fetch(key):
    target = CACHE / key
    if target.is_file():
        return target.read_bytes()
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            with urlopen(Request(BASE + '/' + key, headers={'User-Agent': 'MeteoDial archive builder'}), timeout=90) as response:
                data = response.read()
            tmp = target.with_name(target.name + '.part')
            tmp.write_bytes(data)
            tmp.replace(target)
            return data
        except (HTTPError, URLError, TimeoutError) as exc:
            if attempt == 2 or isinstance(exc, HTTPError) and exc.code not in (429, 500, 502, 503, 504):
                raise
            time.sleep(2 ** (attempt + 1))

def chunk(meta, field, key):
    config = meta[field + '/.zarray']
    data = get_codec(config['compressor']).decode(fetch(field + '/' + key))
    return np.frombuffer(data, dtype=config['dtype']).reshape(config['chunks'], order=config['order'])

def main():
    meta = json.loads(fetch('.zmetadata'))['metadata']
    lat, lon, levels = [chunk(meta, name, '0') for name in ('latitude', 'longitude', 'level')]
    for case in json.loads((ROOT / 'assets/data/catalog.json').read_text('utf8')):
        if case.get('dataMode') != 'reanalysis':
            continue
        folder = ROOT / 'assets/cases' / case['id']
        folder.mkdir(parents=True, exist_ok=True)
        west, south, east, north = case['bbox']
        xi = np.where((lon >= west - 0.00001) & (lon <= east + 0.00001))[0]
        yi = np.where((lat >= south - 0.00001) & (lat <= north + 0.00001))[0]
        yi = yi[np.argsort(-lat[yi])]
        assert np.allclose([lon[xi[0]], lat[yi[-1]], lon[xi[-1]], lat[yi[0]]],case['bbox'])
        for lead in case['leads']:
            stamp = datetime.fromisoformat(case['run']).replace(tzinfo=timezone.utc) + timedelta(hours=lead)
            index = int((stamp - datetime(1959, 1, 1, tzinfo=timezone.utc)).total_seconds() // 21600)
            def extract(field, level):
                spec = meta[field + '/.zarray']
                tlen = spec['chunks'][0]
                key = '.'.join([str(index // tlen)] + ['0'] * (len(spec['shape']) - 1))
                arr = chunk(meta, field, key)[index % tlen]
                if level is not None:
                    arr = arr[np.where(levels == level)[0].item()]
                return arr[np.ix_(xi, yi)].T.astype(float).ravel()
            ps = extract('surface_pressure', None) / 100
            for layer in case['layers']:
                if layer not in VARIABLES:
                    continue
                grid = {'layer': layer, 'bbox': case['bbox'], 'step': case['step'], 'nx': len(xi), 'ny': len(yi),
                        'valid': stamp.isoformat(timespec='milliseconds').replace('+00:00','Z'),
                        'type': '再分析', 'source': 'ECMWF ERA5 · WeatherBench 2', 'resolution': '1.5°'}
                for j, (field, level) in enumerate(VARIABLES[layer]):
                    vals = extract(field, level)
                    if 'temperature' in field: vals -= 273.15
                    if field == 'geopotential': vals /= 9.80665
                    if field == 'mean_sea_level_pressure': vals /= 100
                    if level:
                        underground = np.isfinite(ps) & (ps <= level)
                        grid['terrainMask'] = underground.astype(int).tolist()
                        vals[underground | ~np.isfinite(ps)] = np.nan
                    grid['v' if j else 'values'] = [round(float(v),1) if np.isfinite(v) else None for v in vals]
                (folder / f'{layer}-{lead}.json').write_text(json.dumps(grid,ensure_ascii=False,separators=(',',':')),encoding='utf8')
            print(case['id'], stamp.isoformat(), flush=True)
if __name__ == '__main__':
    main()
