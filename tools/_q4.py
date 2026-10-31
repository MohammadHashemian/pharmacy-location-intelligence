import json
g = json.load(open('web/public/geo/khuzestan_places.geojson', encoding='utf-8'))
rows = []
for f in g['features']:
    p = f['properties']
    if p.get('county') and 'اهواز' in p['county']:
        rows.append(p)
print('Ahvaz county places', len(rows))
rows.sort(key=lambda p: -(p.get('population_best') or 0))
for p in rows[:15]:
    print('%9s %-22s %-14s ph=%s src=%s' % (p.get('population_best'), p['name'][:22], p.get('place_kind'), p.get('n_pharmacy_total'), p.get('pop_ref_source')))
tot = sum(p.get('population_best') or 0 for p in rows)
print('sum of population_best in Ahvaz county:', tot)
kinds = {}
for p in rows:
    kinds[p.get('place_kind')] = kinds.get(p.get('place_kind'), 0) + (p.get('population_best') or 0)
print('by kind', kinds)
