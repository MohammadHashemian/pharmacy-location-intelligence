import json
p = json.load(open('web/public/geo/khuzestan_places.geojson', encoding='utf-8'))
print('features', len(p['features']))
print('props', list(p['features'][0]['properties']))
a = json.load(open('data/raw/osm/khuzestan_admin7.json', encoding='utf-8'))['elements']
rels = [e for e in a if e['type'] == 'relation']
withgeom = [e for e in rels if any(m.get('geometry') for m in e.get('members', []))]
print('admin7 elements', len(a), 'relations', len(rels), 'with member geometry', len(withgeom))
print('names sample', [(e.get('tags') or {}).get('name') for e in rels[:5]])
print('boundary kinds', set((e.get('tags') or {}).get('boundary') for e in rels))
print('has label members', sum(1 for e in rels if any(m.get('role') == 'label' for m in e.get('members', []))))
print('admin_levels', set((e.get('tags') or {}).get('admin_level') for e in rels))
import numpy
print('numpy', numpy.__version__)
