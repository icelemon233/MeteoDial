"""Regional projections from NCAR's hourly ERA5 netCDF mirror."""

import calendar
import datetime as dt
from functools import lru_cache
import numpy as np
from cfs_archive import UTC, utc_hour, dap_url, dap_arrays, read_url, attr

ORIGIN = "https://tds.gdex.ucar.edu/thredds/dodsC/files/d633000/"
PARAMS = {
    "u_component_of_wind": ("131_u", "U", "uv"),
    "v_component_of_wind": ("132_v", "V", "uv"),
    "vertical_velocity": ("135_w", "W", "sc"),
    "temperature": ("130_t", "T", "sc"),
    "specific_humidity": ("133_q", "Q", "sc"),
    "surface_pressure": ("134_sp", "SP", "sc"),
    "geopotential": ("129_z", "Z", "sc"),
}
LEVELS = [
    1,
    2,
    3,
    5,
    7,
    10,
    20,
    30,
    50,
    70,
    100,
    125,
    150,
    175,
    200,
    225,
    250,
    300,
    350,
    400,
    450,
    500,
    550,
    600,
    650,
    700,
    750,
    775,
    800,
    825,
    850,
    875,
    900,
    925,
    950,
    975,
    1000,
]
EPOCH = utc_hour("1900-01-01")


def projection(ids):
    if len(ids) == 1:
        return f"[{ids[0]}]"
    step = ids[1] - ids[0]
    if any(b - a != step for a, b in zip(ids, ids[1:])):
        raise ValueError("Selections must have regular native coordinates")
    return f"[{ids[0]}:{step}:{ids[-1]}]"


@lru_cache(maxsize=256)
def check(month, var, url, units):
    das = read_url(url + ".das", attempts=2).decode("ascii")
    if attr(das, var, "units") != units or not attr(das, "time", "units").startswith(
        "hours since 1900-01-01"
    ):
        raise ValueError("Unexpected ERA5 netCDF units")
    return True


class Daily:
    def read(self, field, hours, levels, x, y, units):
        date = dt.datetime.fromtimestamp(hours[0] * 3600, UTC)
        ym = date.strftime("%Y%m")
        ymd = date.strftime("%Y%m%d")
        code, var, grid = PARAMS[field]
        group = "pl" if levels else "sfc"
        if levels:
            interval = ymd + "00_" + ymd + "23"
            first = (hours[0] // 24) * 24
        else:
            interval = ym + "0100_" + ym + str(calendar.monthrange(date.year, date.month)[1]) + "23"
            first = utc_hour(date.strftime("%Y-%m-01"))
        url = f"{ORIGIN}e5.oper.an.{group}/{ym}/e5.oper.an.{group}.128_{code}.ll025{grid}.{interval}.nc"
        # Unit definitions are shared by the variable's monthly collection.
        check(
            ym,
            var,
            url if not levels else url.replace(ymd + "00_" + ymd + "23", ym + "0100_" + ym + "0123"),
            units,
        )
        selected = list(range(hours[0], hours[-1] + 1, 4))
        native = sorted(levels)
        indices = [LEVELS.index(p) for p in native]
        if len(indices) > 2 and len(set(np.diff(indices))) > 1:
            indices = list(range(min(indices), max(indices) + 1))
        returned = [LEVELS[i] for i in indices]
        vertical = projection(indices) if levels else ""
        ix = np.rint(x * 4).astype(int)
        iy = np.rint((90 - y) * 4).astype(int)
        query = (
            var
            + projection([h - first for h in selected])
            + vertical
            + projection(list(iy))
            + projection(list(ix))
        )
        vals = dap_arrays(read_url(dap_url(url, query), attempts=2))
        if not (
            np.array_equal(vals["time"], np.array(selected) - EPOCH)
            and np.array_equal(vals["latitude"], y)
            and np.array_equal(vals["longitude"], x)
        ):
            raise ValueError("ERA5 netCDF selection did not return the requested dates and grid")
        a = vals[var].reshape(len(selected), len(returned) or 1, len(y), len(x)).astype("f4")
        if levels:
            if list(vals["level"]) != returned:
                raise ValueError("ERA5 level mismatch")
            a = a[:, [returned.index(p) for p in levels]]
        return np.where(np.abs(a) < 1e15, a, np.nan)[[selected.index(h) for h in hours]]
