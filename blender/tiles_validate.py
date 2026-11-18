"""Validate public/assets/tiles.glb and tiles.json against the asset contract. Run: python3 blender/tiles_validate.py"""
import itertools
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(ROOT, 'public', 'assets', 'tiles.glb')
raw = open(path, 'rb').read()
magic, ver, total = struct.unpack_from('<4sII', raw, 0)
jlen, jtype = struct.unpack_from('<I4s', raw, 12)
doc = json.loads(raw[20:20 + jlen])
blen, _ = struct.unpack_from('<I4s', raw, 20 + jlen)
binary = raw[28 + jlen:28 + jlen + blen]
tiles = json.load(open(os.path.join(ROOT, 'public', 'assets', 'tiles.json')))
errors = []
nodes, meshes, acc = doc['nodes'], doc['meshes'], doc['accessors']


def tris(i):
    n = nodes[i]
    t = sum(acc[p['indices']]['count'] // 3 for p in meshes[n['mesh']]['primitives']) if 'mesh' in n else 0
    return t + sum(tris(c) for c in n.get('children', []))


def walk(i, depth=0):
    yield i, depth
    for c in nodes[i].get('children', []):
        yield from walk(c, depth + 1)


def y_range(i):
    a = acc[meshes[nodes[i]['mesh']]['primitives'][0]['attributes']['POSITION']]
    return a['min'][1], a['max'][1]


roots = {nodes[i]['name']: i for i in doc['scenes'][0]['nodes']}
ids = [t['id'] for t in tiles['tiles']]
if tiles.get('cell') != 2 or tiles.get('sockets') != ['g', 'p', 'r']:
    errors.append('tiles.json header')
worst = 0
flaps_total = 0
for t in tiles['tiles']:
    for k in ('id', 'sockets', 'weight', 'rotations', 'blocked', 'obstacles'):
        if k not in t:
            errors.append(f"{t.get('id')}: json key {k} missing")
    if sorted(t['sockets']) != ['e', 'n', 's', 'w'] or any(v not in 'gpr' for v in t['sockets'].values()):
        errors.append(f"{t['id']}: sockets")
    name = 'tile_' + t['id']
    if name not in roots:
        errors.append(f'{name} missing from glb')
        continue
    kids = [nodes[c]['name'] for c in nodes[roots[name]].get('children', [])]
    if kids.count('base') != 1:
        errors.append(f'{name}: needs exactly one base child')
    else:
        lo, hi = y_range(next(c for c in nodes[roots[name]]['children'] if nodes[c]['name'] == 'base'))
        if lo < 0 or hi > 0.0051:
            errors.append(f'{name}: base y range {lo}..{hi}')
    for i, depth in walk(roots[name]):
        n = nodes[i]
        if depth == 0 or n['name'] == 'base':
            continue
        if not n['name'].startswith('flap_'):
            errors.append(f"{name}: unexpected node {n['name']}")
        ex = n.get('extras', {})
        if not all(k in ex for k in ('foldAngle', 'delay', 'mass')):
            errors.append(f"{name}/{n['name']}: extras missing")
        elif ex.get('free') not in (0, 1):
            errors.append(f"{name}/{n['name']}: free must be 0 or 1, got {ex.get('free')!r}")
        elif not (0 <= ex['delay'] <= 1 and 0.5 <= ex['mass'] <= 2 and ex['foldAngle'] != 0):
            errors.append(f"{name}/{n['name']}: extras out of range {ex}")
        flaps_total += 1
    n_t = tris(roots[name])
    worst = max(worst, n_t)
    if n_t > 2500:
        errors.append(f'{name}: {n_t} tris')
for name in roots:
    if name.startswith('tile_') and name[5:] not in ids:
        errors.append(f'{name} has no json entry')
if 'traveller' not in roots:
    errors.append('traveller missing')
else:
    kids = sorted(nodes[c]['name'] for c in nodes[roots['traveller']]['children'])
    if kids != sorted(['body', 'legL', 'legR', 'armL', 'armR', 'stand']):
        errors.append(f'traveller children {kids}')
    ys = [y_range(c) for c in nodes[roots['traveller']]['children']]
    offs = [nodes[c].get('translation', [0, 0, 0])[1] for c in nodes[roots['traveller']]['children']]
    print('traveller height', round(max(y[1] + o for y, o in zip(ys, offs)), 3), 'tris', tris(roots['traveller']))
for m in doc['materials']:
    pbr = m['pbrMetallicRoughness']
    if pbr.get('roughnessFactor', 1) < 0.85 or pbr.get('metallicFactor', 1) != 0 or 'normalTexture' not in m:
        errors.append(f"material {m['name']}")
if len(raw) > 6e6:
    errors.append('glb over 6 MB')


def canon(s):
    return min(s[i:] + s[:i] for i in range(4))


have = {canon(''.join(t['sockets'][k] for k in 'nesw')) for t in tiles['tiles']}
allc = {canon(''.join(c)) for c in itertools.product('gpr', repeat=4)}
print(f"{len(ids)} tiles, {flaps_total} flaps, max tile tris {worst}, glb {len(raw) / 1e6:.2f} MB, "
      f"images {[im['mimeType'] for im in doc['images']]}, materials {len(doc['materials'])}")
print(f'socket necklaces covered {len(have)}/{len(allc)}; missing: {sorted(allc - have) or "none"}')
print('ERRORS:' if errors else 'OK')
for e in errors:
    print(' ', e)
sys.exit(1 if errors else 0)
