"""Build public/assets/tiles.glb and tiles.json for Pop-up Atlas.

Run: blender -b -P blender/build_tiles.py
"""
import json
import math
import os
import random
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import tiles_defs as D  # noqa: E402
import tiles_geom as G  # noqa: E402
import tiles_glb  # noqa: E402
import tiles_paint as P  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'public', 'assets')
DEBUG = os.path.join(HERE, 'tiles_out')
PAD = 3
BASE_Z = 0.003
TAB_Z = 0.0042


def save_image(path, arr, fmt='JPEG', quality=92, non_color=False):
    h, w, _ = arr.shape
    img = bpy.data.images.new('tmp_' + os.path.basename(path), w, h, alpha=False)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = arr[::-1]
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = fmt
    try:
        img.save(quality=quality)
    except TypeError:
        bpy.context.scene.render.image_settings.quality = quality
        img.save()
    bpy.data.images.remove(img)


def tris(mesh):
    return len(mesh[4]) // 3


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(DEBUG, exist_ok=True)
    tiles = D.build_tiles()
    atlas = P.Atlas()
    S = float(atlas.SIZE)

    # ---- base pages
    for t in tiles:
        atlas.base_rect(t.page_key)
    edge_rows = {}
    for t in tiles:
        img = P.paint_base(t, atlas.INNER)
        atlas.put_base(t.page_key, img)
        # Rotate each edge so it reads left-to-right when seen from the tile centre.
        for side, row in (('n', img[0, ::-1]), ('e', img[::-1, -1]), ('s', img[-1, :]), ('w', img[:, 0])):
            edge_rows.setdefault(t.sockets[side], []).append((t.id, side, row))
    worst = 0.0
    for sock, rows in edge_rows.items():
        ref = rows[0][2]
        for tid, side, row in rows:
            d = max(float(np.abs(row - ref).max()), float(np.abs(row - ref[::-1]).max()))
            if d > 0.004:
                print(f'  edge differs: socket {sock} {tid}.{side} by {d:.4f}')
            worst = max(worst, d)
    print(f'edge mismatch (max abs, 0..1): {worst:.5f}')

    # ---- flap art
    shapes = {}
    for t in tiles:
        for f in t.flaps:
            shapes[f.shape] = G.SHAPES[f.shape]
    shapes.update(G.TRAV_SHAPES)
    shapes['core'] = (G.o_rect(0, 0.4, 0, 0.1), 'core', 0.0)
    shapes['tab'] = (G.o_rect(0, 0.3, 0, 0.07), 'tab', 0.0)
    ppu = None
    for cand in (240, 224, 208, 192, 176, 168, 160, 152, 144, 136, 128, 120, 112, 104, 96):
        sizes = {k: P.art_size(G.ccw(o), P.art_ppu(k, cand), PAD) for k, (o, s, m) in shapes.items()}
        if atlas.pack(sizes):
            ppu = cand
            break
    if ppu is None:
        raise RuntimeError('flap art does not fit the atlas')
    print(f'flap art: {len(shapes)} pieces at {ppu} px/unit')
    boxes = {}
    for k, (o, style, margin) in shapes.items():
        o = G.ccw(o)
        atlas.put(k, P.paint_flap(k, o, style, margin, P.art_ppu(k, ppu), PAD))
        boxes[k] = P._bbox(o)

    def uvmap(key):
        rx_, ry_, w, h = atlas.rects[key]
        x0, x1, z0, z1 = boxes[key]
        q = P.art_ppu(key, ppu)
        return lambda x, z: ((rx_ + PAD + (x - x0) * q) / S, (ry_ + PAD + (z1 - z) * q) / S)

    cx, cy, cw, ch = atlas.rects['core']
    core_uv = ((cx + PAD + 1) / S, (cy + PAD + 1) / S, (cx + cw - PAD - 1) / S, (cy + ch - PAD - 1) / S)
    tx, ty, tw, th = atlas.rects['tab']
    tab_uv = ((tx + PAD) / S, (ty + PAD) / S, (tx + tw - PAD) / S, (ty + th - PAD) / S)

    nmap, _ = P.normal_map(1024)
    albedo_path = os.path.join(DEBUG, 'atlas.jpg')
    normal_path = os.path.join(DEBUG, 'fibre_normal.jpg')
    save_image(albedo_path, atlas.img, 'JPEG', 93)
    save_image(normal_path, nmap, 'JPEG', 90, non_color=True)
    save_image(os.path.join(DEBUG, 'atlas.png'), atlas.img, 'PNG')

    glb = tiles_glb.Glb()
    with open(albedo_path, 'rb') as fh:
        tex_a = glb.add_texture(fh.read(), 'image/jpeg', repeat=False)
    with open(normal_path, 'rb') as fh:
        tex_n = glb.add_texture(fh.read(), 'image/jpeg', repeat=True)
    glb.add_material('paper', tex_a, tex_n, roughness=0.92, normal_scale=0.45)

    report = []
    doc = {'cell': 2, 'sockets': ['g', 'p', 'r'], 'tiles': []}
    rnd = random.Random(5)
    for t in tiles:
        root = glb.add_node(f'tile_{t.id}', root=True)
        bx, by = atlas.base_rect(t.page_key)
        n = atlas.INNER

        def buv(x, y):
            return ((bx + (x + 1) / 2 * n) / S, (by + (1 - y) / 2 * n) / S)

        pos = [(-1, -1, BASE_Z), (1, -1, BASE_Z), (1, 1, BASE_Z), (-1, 1, BASE_Z)]
        white = np.ones((4, 3), np.float32)
        base = (np.array(pos, np.float32), np.array([(0, 0, 1)] * 4, np.float32),
                np.array([buv(x, y) for x, y, _ in pos], np.float32),
                np.array([((x + 1) / 2, (1 - y) / 2) for x, y, _ in pos], np.float32),
                np.array([0, 1, 2, 0, 2, 3], np.uint32), white)
        parts = [base]
        for f in t.flaps:
            if not f.tab:
                continue
            xs = [x for x, z in f.outline if abs(z) < 1e-6]
            if len(xs) < 2 or max(xs) - min(xs) < 0.05:
                continue
            w = 0.72 * (max(xs) - min(xs))
            xc = (max(xs) + min(xs)) / 2
            s = 1.0 if f.fold > 0 else -1.0
            m = Matrix.Translation(f.origin) @ f.rot
            quad = [(xc - w / 2, 0.0), (xc + w / 2, 0.0), (xc + w / 2 - 0.012, s * 0.06), (xc - w / 2 + 0.012, s * 0.06)]
            if s < 0:
                quad = quad[::-1]
            wp = [m @ G.Vector((qx, qy, 0.0)) for qx, qy in quad]
            if max(max(abs(v.x), abs(v.y)) for v in wp) > 0.99:
                continue
            u0, v0, u1, v1 = tab_uv
            uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)]
            if s < 0:
                uvs = uvs[::-1]
            parts.append((np.array([(v.x, v.y, TAB_Z) for v in wp], np.float32), np.array([(0, 0, 1)] * 4, np.float32),
                          np.array(uvs, np.float32), np.array([((v.x + 1) / 2, (1 - v.y) / 2) for v in wp], np.float32),
                          np.array([0, 1, 2, 0, 2, 3], np.uint32), white))
        base_mesh = G.merge_meshes(parts)
        glb.add_child(root, glb.add_node('base', glb.add_mesh(f'{t.id}_base', base_mesh)))
        total = tris(base_mesh)
        nodes = {}
        for f in t.flaps:
            up = tuple(f.m_rest.to_3x3().inverted() @ G.Vector((0.0, 0.0, 1.0)))
            mesh = G.card_mesh(f.outline, f.uv_outline, f.slab[0], f.slab[1], uvmap(f.shape), core_uv, rnd, up=up)
            total += tris(mesh)
            extras = {'foldAngle': round(f.fold, 5), 'delay': f.delay, 'mass': round(f.mass, 3)}
            node = glb.add_node(f.name, glb.add_mesh(f'{t.id}_{f.name}', mesh), f.origin, f.rot.to_quaternion(), extras)
            nodes[f] = node
            glb.add_child(nodes[f.parent] if f.parent else root, node)
        names = [f.name for f in t.flaps]
        assert len(set(names)) == len(names), f'duplicate flap names in {t.id}'
        doc['tiles'].append({
            'id': t.id, 'sockets': t.sockets, 'weight': t.weight, 'rotations': [0, 1, 2, 3], 'blocked': t.blocked,
            'obstacles': [{'x': round(x, 3), 'z': round(-y, 3), 'r': round(r, 3)} for x, y, r in t.obstacles],
        })
        report.append((t.id, ''.join(t.sockets[s] for s in 'nesw'), len(t.flaps), total, t.flat_height))

    # ---- traveller: figure faces local +X, card normal is local Z (glTF), limbs swing about local Z
    trav = glb.add_node('traveller', root=True)
    tt, kk = G.TRAV_T, G.TRAV_K
    ttris = 0

    def tcard(shape, ya, yb, up=(0.0, 0.0, 1.0)):
        o = G.ccw(G.TRAV_SHAPES[shape][0])
        return G.card_mesh(G.scaled(o, kk), o, ya, yb, uvmap(shape), core_uv, rnd, up=up)

    def part(name, mesh, origin=None):
        nonlocal ttris
        ttris += tris(mesh)
        glb.add_child(trav, glb.add_node(name, glb.add_mesh(f'traveller_{name}', mesh), origin))

    hip, sh = G.HIP_Z, G.SHOULDER_Z
    part('body', tcard('trav_body', -tt / 2, tt / 2), (0, 0, hip))
    part('legL', tcard('trav_leg', 0.009, 0.009 + tt), (-0.022, 0, hip))
    part('legR', tcard('trav_leg', -0.009 - tt, -0.009), (0.022, 0, hip))
    part('armL', tcard('trav_arm', 0.025, 0.025 + tt), (0.0, 0, sh))
    part('armR', tcard('trav_arm_stick', -0.025 - tt, -0.025), (0.0, 0, sh))
    stand = G.transform_mesh(tcard('trav_stand', -0.014, -0.002, up=(0.0, -1.0, 0.0)), Matrix.Rotation(-math.pi / 2, 4, 'X'))
    tab = G.transform_mesh(tcard('trav_tab', 0.045, 0.045 + tt), Matrix.Translation((0.0, 0.0, 0.014)))
    part('stand', G.merge_meshes([stand, tab]))

    size = glb.write(os.path.join(OUT, 'tiles.glb'))
    with open(os.path.join(OUT, 'tiles.json'), 'w') as fh:
        json.dump(doc, fh, indent=1)
    with open(os.path.join(DEBUG, 'report.json'), 'w') as fh:
        json.dump({'ppu': ppu, 'glb_bytes': size, 'traveller_tris': ttris, 'edge_mismatch': worst,
                   'palette': P.PALETTE,
                   'tiles': [dict(id=a, sockets=b, flaps=c, tris=d, flat_height=round(e, 4)) for a, b, c, d, e in report]},
                  fh, indent=1)
    print(f'{"tile":22s} nesw flaps  tris  flat_h')
    for a, b, c, d, e in report:
        print(f'{a:22s} {b}  {c:4d} {d:5d}  {e:.3f}')
    print(f'traveller tris {ttris}; glb {size / 1e6:.2f} MB; {len(tiles)} tiles; {time.time() - t0:.1f}s')


main()
