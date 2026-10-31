import json
d = json.load(open('data/derived/geo_density.json', encoding='utf-8'))
c = d['cells']
print(d['meta'])
import statistics
dens = [x['dens'] for x in c]
print('dens: min %.2f p25 %.2f med %.2f p75 %.2f max %.2f' % (
    min(dens), statistics.quantiles(dens, n=4)[0], statistics.median(dens),
    statistics.quantiles(dens, n=4)[2], max(dens)))
top = sorted(c, key=lambda x: -x['gap'])[:8]
for x in top:
    print('gap %7.1f pop %8d ph %3d dens %6.2f  %s / %s' % (
        x['gap'], x['pop'], x['ph'], x['dens'], x['name'], x['county']))
print('--- most saturated')
for x in sorted(c, key=lambda x: -x['dens'])[:5]:
    print('dens %7.2f pop %8d ph %3d  %s / %s' % (x['dens'], x['pop'], x['ph'], x['name'], x['county']))
print('--- near Ahvaz (31.32,48.67)')
near = sorted(c, key=lambda x: (x['lat']-31.32)**2 + (x['lon']-48.669)**2)[:5]
for x in near:
    print('%.3f,%.3f pop %8d ph %3d dens %6.2f gap %.1f %s' % (x['lat'], x['lon'], x['pop'], x['ph'], x['dens'], x['gap'], x['name']))
print('counties', len({x['county'] for x in c}))
