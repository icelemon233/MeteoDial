"""Choose a real, geographically relevant MODIS observation for each 2:1 case cover."""
import json
from datetime import date, datetime
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
FOCUS = {
    'ice-2008': (112.9, 28.2), 'cold-2016': (113.3, 24.0), 'henan-2021': (113.7, 34.8),
    'beijing-snow': (116.2, 39.8),
    'bohai': (121.1, 38.0), 'bohai22': (121.0, 38.0),
    'ridge': (111.0, 30.0), 'trough': (100.3, 25.3),
    'coldpool': (89.2, 47.0), 'front': (116.4, 39.9), 'terrain': (114.12, 22.41),
}
CASE_DAY = {'ice-2008':'2008-01-26','cold-2016':'2016-01-24','henan-2021':'2021-07-20','beijing-snow':'2023-12-11', 'bohai':'2023-12-20', 'bohai22':'2022-12-22', 'doksuri':'2023-07-26',
            'ridge':'2022-08-18', 'trough':'2022-02-19', 'coldpool':'2022-11-27',
            'front':'2022-11-28', 'terrain':'2023-07-04'}

def focus_for(case, observation):
    if case['id'] != 'doksuri':
        return FOCUS[case['id']]
    track = json.loads((ASSETS / 'cases/doksuri/track.json').read_text(encoding='utf8'))
    noon = datetime.fromisoformat(observation + 'T06:00:00+00:00')
    point = min(track['storms'][0]['analyses'], key=lambda p: abs(
        (datetime.fromisoformat(p['time'].replace('Z', '+00:00')) - noon).total_seconds()))
    return point['lon'], point['lat']

def candidates(case, file):
    west, south, east, north = case['bbox']
    lon, lat = focus_for(case, file.stem)
    with Image.open(file) as source:
        size = source.size
        small = source.convert('RGB')
        small.thumbnail((200,180), Image.Resampling.BOX)
    w, h = small.size
    x0, y0 = (lon-west)/(east-west)*w, (north-lat)/(north-south)*h
    data = np.asarray(small)
    # Exclude low-signal / fill areas from the thumbnail selection only.
    dark = (data.max(axis=2) < 18).astype(np.int32)
    integral = np.pad(dark, ((1,0),(1,0))).cumsum(0).cumsum(1)
    for fraction in (1, .9, .8, .7, .6, .5, .4):
        cw = min(w, round(w*fraction))
        ch = max(8, round(cw*size[0]/w/2*h/size[1]))
        if ch>h:
            continue
        for cy in np.linspace(.23,.77,7):
            for cx in np.linspace(.23,.77,7):
                x = min(max(0, round(x0-cx*cw)), w-cw)
                y = min(max(0, round(y0-cy*ch)), h-ch)
                if not (x <= x0 <= x+cw and y <= y0 <= y+ch):
                    continue
                missing = (integral[y+ch,x+cw]-integral[y,x+cw]-integral[y+ch,x]+integral[y,x]) / (cw*ch)
                distance = ((x+cw/2-x0)/w)**2 + ((y+ch/2-y0)/h)**2
                day_gap=abs((date.fromisoformat(file.stem)-date.fromisoformat(CASE_DAY[case['id']])).days)
                score = 1800*missing + 1.4*distance + .45*(1-fraction) + .14*day_gap
                box=(round(x/w*size[0]),round(y/h*size[1]),round((x+cw)/w*size[0]),round((y+ch)/h*size[1]))
                yield score, file, box, float(missing)

def main():
    catalog = json.loads((ASSETS/'data/catalog.json').read_text(encoding='utf8'))
    provenance = {}
    for case in catalog:
        if case.get('climate'):
            continue
        folder = ASSETS/'cases'/case['id']
        source_files = sorted(folder.glob('????-??-??.jpg'))
        options = (candidate for file in source_files for candidate in candidates(case,file))
        _, file, box, missing = min(options,key=lambda c:c[0])
        with Image.open(file) as img:
            crop=img.crop(box)
            crop.resize((800,400), Image.Resampling.LANCZOS).convert('RGB').save(folder/'cover.jpg', quality=91, optimize=True)
        provenance[case['id']] = {'source':'NASA GIBS · Terra/MODIS Corrected Reflectance (True Color)',
            'utcDate':file.stem,'sourceFrame':file.name,'sourceImageBounds':case['bbox'],'cropPixels':list(box),
            'width':800,'height':400,'screenedDarkFraction':round(missing,5)}
        print(case['id'],file.stem,'dark fraction',round(missing,5))
    (ASSETS/'data/covers.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
if __name__=='__main__':
    main()

