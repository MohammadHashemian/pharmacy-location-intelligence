"""Which source files are unreachable from the app's entry points?

A file that nothing imports is either dead or only reachable through a dynamic path this
script cannot see — the second case is rare here, so every orphan is printed for review.

    python tools/dead_code.py [--json]
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


def main() -> int:
    src = os.path.join(ROOT, "src")
    files: list[str] = []
    for dp, _, fs in os.walk(src):
        for f in fs:
            if f.endswith((".ts", ".tsx")):
                files.append(os.path.relpath(os.path.join(dp, f), ROOT).replace(os.sep, "/"))

    def imports(p: str) -> list[str]:
        s = open(os.path.join(ROOT, p), encoding="utf-8").read()
        return re.findall(r"""from\s+["'](@/[^"']+|\.\.?/[^"']+)["']""", s)

    def resolve(p: str, spec: str) -> str | None:
        if spec.startswith("@/"):
            base = "src/" + spec[2:]
        else:
            base = os.path.normpath(os.path.join(os.path.dirname(p), spec)).replace(os.sep, "/")
        for cand in (base + ".ts", base + ".tsx", base + "/index.ts",
                     base + "/page.tsx", base + "/route.ts"):
            if cand in files:
                return cand
        return None

    graph = {p: [r for r in (resolve(p, s) for s in imports(p)) if r] for p in files}
    roots = [p for p in files if p.startswith("src/app/")]
    seen: set[str] = set()
    stack = list(roots)
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        stack.extend(graph.get(p, []))

    orphans = sorted(set(files) - seen)
    rows = []
    for o in orphans:
        n = sum(1 for line in open(os.path.join(ROOT, o), encoding="utf-8") if line.strip())
        rows.append({"file": o, "lines": n})
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=2))
        return 0
    print(f"{len(files)} files · {len(seen)} reachable · {len(orphans)} unreachable")
    for r in rows:
        print(f"  {r['lines']:>5}  {r['file']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
