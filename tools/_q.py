import sqlite3
c = sqlite3.connect('db/pharmacy.sqlite')
print('admin units:', c.execute('select unit_kind, admin_level, count(*) from geo_admin_unit group by 1,2').fetchall())
print('places:', c.execute('select count(*) from geo_places').fetchone())
print('v_geo_place cols:', [r[1] for r in c.execute('pragma table_info(v_geo_place)')])
print('tables:', [r[0] for r in c.execute("select name from sqlite_master where type='table' and name like 'geo%'")])
print('views:', [r[0] for r in c.execute("select name from sqlite_master where type='view'")])
