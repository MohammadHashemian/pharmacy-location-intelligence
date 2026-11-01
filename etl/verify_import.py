"""Checks for the Neshan importer that do not need the network.

The importer's risk is not "does HTTP work" — it is "does it keep the right
points": a street called «خیابان داروخانه», the same branch returned by two
search centres, a hospital, a point across the Iraqi border. Each of those is a
assertion here, plus a fixture that runs the real pipeline offline.

    python etl/verify_import.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "import_pharmacies", os.path.join(HOME, "etl", "import_pharmacies.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

fails = 0


def check(name: str, cond: bool) -> None:
    global fails
    if not cond:
        fails += 1
    print(("PASS " if cond else "FAIL ") + name)


# 1. the pharmacy filter -------------------------------------------------------
check("keeps «داروخانه شبانه‌روزی مادر»", m.looks_like_pharmacy("داروخانه شبانه‌روزی مادر", "pharmacy", "health"))
check("keeps an English pharmacy", m.looks_like_pharmacy("Madar Pharmacy", "pharmacy", "health"))
check("drops a street named داروخانه", not m.looks_like_pharmacy("خیابان داروخانه", "street", "road"))
check("drops a square named داروخانه", not m.looks_like_pharmacy("میدان داروخانه", "square", "place"))
check("drops a hospital", not m.looks_like_pharmacy("بیمارستان امام", "hospital", "health"))
check("drops an unrelated POI", not m.looks_like_pharmacy("نانوایی سنگک", "bakery", "shop"))

# 2. name normalisation --------------------------------------------------------
check("ZWNJ/spacing folded", m.normalize_name("داروخانه‌ دکتر  بدری") == m.normalize_name("داروخانه دکتر بدری"))
check("prefix dropped", m.normalize_name("داروخانه دکتر بدری") == m.normalize_name("دکتر بدری"))
check("Arabic letters folded", m.normalize_name("علي") == m.normalize_name("علی"))

# 3. geography -----------------------------------------------------------------
check("Ahvaz is inside", m.inside_outline(31.3189, 48.6842))
check("Basra is outside", not m.inside_outline(30.51, 47.78))
check("Dezful is inside", m.inside_outline(32.38, 48.40))
check("distance Ahvaz-Dezful ≈ 121 km", abs(m.haversine_km(31.3189, 48.6842, 32.378, 48.403) - 121) < 3)

# 4. dedupe --------------------------------------------------------------------
pts = [
    {"name": "داروخانه دکتر بدری", "lat": 31.31890, "lon": 48.68420},
    {"name": "داروخانه دکتر بدری", "lat": 31.31892, "lon": 48.68421},   # same point
    {"name": "دکتر بدری",          "lat": 31.31960, "lon": 48.68420},   # same shop, other title (~70 m)
    {"name": "داروخانه مادر",       "lat": 31.32050, "lon": 48.68420},   # a different shop (~180 m)
]
kept, stats = m.dedupe_points(pts)
check("exact duplicate collapsed", stats["exact"] == 1)
check("same name within 150 m collapsed", stats["same_name"] == 1)
check("two real pharmacies survive", len(kept) == 2)

# 5. fixture: the whole pipeline, offline -------------------------------------
fixture = {
    "items": [
        {"title": "داروخانه شبانه‌روزی مادر", "type": "pharmacy", "category": "health",
         "address": "کیانپارس", "location": {"x": 48.6694, "y": 31.3203}, "poiHash": "a1"},
        {"title": "داروخانه شبانه‌روزی مادر", "type": "pharmacy", "category": "health",
         "address": "کیانپارس", "location": {"x": 48.6694, "y": 31.3203}, "poiHash": "a1"},
        {"title": "خیابان داروخانه", "type": "street", "category": "road",
         "location": {"x": 48.6700, "y": 31.3210}},
        {"title": "بیمارستان امام خمینی", "type": "hospital", "category": "health",
         "location": {"x": 48.6710, "y": 31.3220}},
        {"title": "صيدلية ام قصر", "type": "pharmacy", "category": "health",
         "location": {"x": 47.9191, "y": 30.0370}},   # Basra, outside the province
        {"title": "داروخانه دکتر بدری", "type": "pharmacy", "category": "health",
         "address": "زیتون کارمندی", "location": {"x": 48.6801, "y": 31.3311}, "poiHash": "b2"},
    ]
}
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
    json.dump(fixture, f, ensure_ascii=False)
    path = f.name

points = [p for p in (m.item_to_point(it) for it in fixture["items"]) if p]
check("fixture: street/hospital/Iraqi point dropped", len(points) == 3)
uniq, _ = m.dedupe_points(points)
check("fixture: duplicate branch collapsed", len(uniq) == 2)
check("fixture: names", sorted(p["name"] for p in uniq) == ["داروخانه دکتر بدری", "داروخانه شبانه‌روزی مادر"])

# the CLI path with --fixture must run and write nothing
rc = os.system(f'python "{os.path.join(HOME, "etl", "import_pharmacies.py")}" '
               f'--fixture "{path}" > "{path}.log" 2>&1')
log = open(f"{path}.log", encoding="utf-8").read()
check("CLI --fixture exits 0", rc == 0)
check("CLI dedupes to 2 points", "2 unique pharmacies" in log)
os.unlink(path)
os.unlink(f"{path}.log")

print("\n" + ("verify: OK" if fails == 0 else f"verify: {fails} FAILED"))
raise SystemExit(0 if fails == 0 else 1)
