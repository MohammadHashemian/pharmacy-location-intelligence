import json, collections
g = json.load(open('web/public/geo/khuzestan_places.geojson', encoding='utf-8'))
c = collections.Counter()
for f in g['features']:
    for flag in (f['properties'].get('dq_flags') or '').split(','):
        flag = flag.strip()
        if flag:
            c[flag] += 1
for k, v in c.most_common():
    print('%5d %s' % (v, k))
print('--- big pops')
big = [f['properties'] for f in g['features'] if (f['properties'].get('population_best') or 0) > 200000]
for p in sorted(big, key=lambda p: -p['population_best']):
    print('%9s %-24s %-14s %s' % (p['population_best'], p['name'][:24], p['place_kind'], p.get('dq_flags')))
