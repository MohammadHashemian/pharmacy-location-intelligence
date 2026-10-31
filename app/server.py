"""
Local web app for the FDA pharmacy-capacity dataset.

    python app/server.py            # -> http://127.0.0.1:8765

Serves:
  * the analysis workspace (static RTL Persian UI) at /
  * a JSON API over data/pharmacy.sqlite (see src/analyze.py for the scoring model)
"""
from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import analyze  # noqa: E402
from db import DB_PATH, connect  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Pharmacy Site Finder (FDA ظرفیت)", version="1.0")


def con():
    if not Path(DB_PATH).exists():
        raise HTTPException(503, f"database not built yet: {DB_PATH} — run "
                                 f"`python src/load_db.py`")
    return connect(DB_PATH)


def filters_from_query(province_id=None, county_id=None, org_id=None, kind=None,
                       min_pop=None, max_pop=None, max_dk=None, min_dk=None,
                       max_entry=None, min_entry=None, q=None, with_apps=False,
                       exclude_ambiguous=True) -> dict:
    return {"province_id": province_id, "county_id": county_id, "org_id": org_id,
            "kind": kind, "min_pop": min_pop, "max_pop": max_pop, "max_dk": max_dk,
            "min_dk": min_dk, "max_entry": max_entry, "min_entry": min_entry,
            "q": q, "with_apps": with_apps, "exclude_ambiguous": exclude_ambiguous}


@app.get("/api/meta")
def api_meta():
    c = con()
    try:
        m = analyze.meta(c)
        m["db_path"] = str(DB_PATH)
        return m
    finally:
        c.close()


@app.get("/api/cities")
def api_cities(province_id: int | None = None, county_id: int | None = None,
               org_id: int | None = None, kind: str | None = None,
               min_pop: int | None = None, max_pop: int | None = None,
               max_dk: int | None = None, min_dk: int | None = None,
               max_entry: int | None = None, min_entry: int | None = None,
               q: str | None = None, with_apps: bool = False,
               exclude_ambiguous: bool = True,
               w_demand: float | None = None, w_access: float | None = None,
               w_spare: float | None = None, w_comp: float | None = None,
               w_entry: float | None = None,
               target: float = analyze.DEFAULT_TARGET_POP_PER_PHARMACY,
               sort: str = "score", limit: int = Query(100, le=5000), offset: int = 0):
    c = con()
    try:
        weights = None
        if any(v is not None for v in (w_demand, w_access, w_spare, w_comp, w_entry)):
            weights = {"demand": w_demand or 0, "access_gap": w_access or 0,
                       "spare": w_spare or 0, "competition": w_comp or 0,
                       "entry": w_entry or 0}
        return analyze.query(c, filters_from_query(
            province_id, county_id, org_id, kind, min_pop, max_pop, max_dk, min_dk,
            max_entry, min_entry, q, with_apps, exclude_ambiguous), weights, target,
            sort, limit, offset)
    finally:
        c.close()


@app.get("/api/city/{shahr_id}")
def api_city(shahr_id: int):
    c = con()
    try:
        d = analyze.city_detail(c, shahr_id)
        if not d:
            raise HTTPException(404, "city not found")
        d["history"] = analyze.history(c, shahr_id)
        for h in d["history"]:
            import json
            h["payload"] = json.loads(h["payload"])
        return d
    finally:
        c.close()


@app.get("/api/provinces")
def api_provinces(province_id: int | None = None, county_id: int | None = None,
                  org_id: int | None = None, kind: str | None = None,
                  min_pop: int | None = None, max_dk: int | None = None,
                  q: str | None = None, with_apps: bool = False,
                  exclude_ambiguous: bool = True,
                  target: float = analyze.DEFAULT_TARGET_POP_PER_PHARMACY):
    c = con()
    try:
        return analyze.province_summary(c, filters_from_query(
            province_id, county_id, org_id, kind, min_pop, None, max_dk, None,
            None, None, q, with_apps, exclude_ambiguous), target)
    finally:
        c.close()


@app.get("/api/export.csv")
def api_export(province_id: int | None = None, county_id: int | None = None,
               org_id: int | None = None, kind: str | None = None,
               min_pop: int | None = None, max_pop: int | None = None,
               max_dk: int | None = None, min_dk: int | None = None,
               max_entry: int | None = None, q: str | None = None,
               with_apps: bool = False, exclude_ambiguous: bool = True,
               w_demand: float | None = None, w_access: float | None = None,
               w_spare: float | None = None, w_comp: float | None = None,
               w_entry: float | None = None,
               target: float = analyze.DEFAULT_TARGET_POP_PER_PHARMACY,
               sort: str = "score"):
    c = con()
    try:
        weights = None
        if any(v is not None for v in (w_demand, w_access, w_spare, w_comp, w_entry)):
            weights = {"demand": w_demand or 0, "access_gap": w_access or 0,
                       "spare": w_spare or 0, "competition": w_comp or 0,
                       "entry": w_entry or 0}
        res = analyze.query(c, filters_from_query(
            province_id, county_id, org_id, kind, min_pop, max_pop, max_dk, min_dk,
            max_entry, None, q, with_apps, exclude_ambiguous), weights, target,
            sort, 10 ** 9, 0)
        body = analyze.to_csv(res["rows"])
        return Response(body, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition":
                                 'attachment; filename="pharmacy_sites.csv"'})
    finally:
        c.close()


@app.get("/", response_class=HTMLResponse)
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
