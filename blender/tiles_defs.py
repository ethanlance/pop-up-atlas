"""Tile definitions for Pop-up Atlas. Coordinates: x east, y north, tile spans [-1, 1]."""
import math
import random
import zlib

from mathutils import Vector

import tiles_geom as G


class Tile:
    def __init__(self, tid, sockets, weight, blocked=False, page=None, opts=None):
        self.id = tid
        self.sockets = dict(zip('nesw', sockets))
        self.weight = weight
        self.blocked = blocked
        self.page_key = page or tid
        self.opts = opts or {}
        self.routes = G.routes(self.sockets, self.opts)
        self.flaps = []
        self.obstacles = []
        self.prints = []
        self.occ = []
        self.rnd = random.Random(zlib.crc32(tid.encode()))
        self.count = {}
        self.flat_height = 0.0

    def _name(self, kind):
        i = self.count.get(kind, 0)
        self.count[kind] = i + 1
        return f'flap_{kind}_{i}'

    def _fall(self, shape, x, y, heading, scale, prefer):
        outline = G.scaled(G.SHAPES[shape][0], scale)
        best, best_score = 1, 1e9
        for s in (1, -1):
            d = G.rz(heading) @ Vector((0.0, -s, 0.0))
            ax = G.rz(heading) @ Vector((1.0, 0.0, 0.0))
            over = 0.0
            for px, pz in outline:
                wx, wy = x + ax.x * px + d.x * pz, y + ax.y * px + d.y * pz
                over = max(over, abs(wx) - 0.97, abs(wy) - 0.97)
            score = max(over, 0.0) * 100 - 0.3 * (d.x * -x + d.y * -y) - (0.2 if s == prefer else 0.0)
            if score < best_score:
                best, best_score = s, score
        return best

    def add(self, shape, x, y, heading=0.0, scale=1.0, fall=None, name=None, delay=None, tab=True, obstacle=None,
            prefer=1, occ=0.1):
        if fall is None:
            fall = self._fall(shape, x, y, heading, scale, prefer)
        if delay is None:
            delay = min(1.0, max(0.0, 0.05 + 0.55 * (1 - (y + 1) / 2) + 0.3 * self.rnd.random()))
        f = G.Flap(name or self._name(shape.split('_')[0]), shape, scale, (x, y), G.rz(heading), fall * math.pi / 2,
                   delay=round(delay, 3), tab=tab)
        self.flaps.append(f)
        self.occ.append((x, y, occ))
        if obstacle:
            self.obstacles.append((x, y, obstacle))
        return f

    def nest(self, parent, shape, x, z, tilt, fold, scale=1.0, name=None):
        f = G.Flap(name or self._name(shape.split('_')[0]), shape, scale, (x, z), G.rx(math.radians(tilt)),
                   math.radians(fold), parent=parent, delay=round(min(1.0, parent.delay + 0.12), 3))
        self.flaps.append(f)
        return f

    def clear(self, x, y, need, occ_pad=0.1):
        if G.route_clear(self.routes, x, y) < need:
            return False
        return all(math.hypot(x - ox, y - oy) >= r + occ_pad for ox, oy, r in self.occ)

    def scatter(self, shapes, n, need=0.12, lim=0.8, scale=(0.85, 1.15), heading=25.0):
        made = 0
        for _ in range(400):
            if made >= n:
                break
            x, y = self.rnd.uniform(-lim, lim), self.rnd.uniform(-lim, lim)
            if not self.clear(x, y, need):
                continue
            shape = shapes[made % len(shapes)]
            self.add(shape, round(x, 3), round(y, 3), heading=round(self.rnd.uniform(-heading, heading), 1),
                     scale=round(self.rnd.uniform(*scale), 2), prefer=self.rnd.choice((1, -1)))
            made += 1
        return made

    # ---- compound pop-ups

    def tree(self, shape, x, y, scale=1.0, heading=0.0):
        return self.add(shape, x, y, heading=heading, scale=scale, obstacle=round(0.13 * scale, 3), occ=0.2 * scale)

    def vtree(self, x, y, scale=1.0, spread=30.0):
        a = self.add('vtree_r', x, y, heading=spread, scale=scale, fall=1, name=self._name('vtree'), occ=0.3)
        b = self.add('vtree_l', x, y, heading=-spread, scale=scale, fall=1, name=self._name('vtree'),
                     delay=min(1.0, a.delay + 0.08), occ=0.3)
        self.obstacles.append((x, y, round(0.2 * scale, 3)))
        return a, b

    def rock(self, x, y, scale=1.0, spread=24.0, heading=0.0):
        self.add('rock_r', x, y, heading=heading + spread, scale=scale, fall=-1, name=self._name('rock'), occ=0.25)
        self.add('rock_l', x, y, heading=heading - spread, scale=scale, fall=-1, name=self._name('rock'), occ=0.25)
        self.obstacles.append((x, y, round(0.2 * scale, 3)))

    def house(self, cx, cy, heading=0.0, sc=1.0, tag='house'):
        w, d, h, rise = (G.HOUSE[k] * sc for k in ('w', 'd', 'h', 'rise'))
        r = G.rz(heading)

        def at(lx, ly):
            v = r @ Vector((lx, ly, 0.0))
            return round(cx + v.x, 4), round(cy + v.y, 4)

        base = min(0.6, max(0.0, 0.1 + 0.4 * (1 - (cy + 1) / 2)))
        front = self.add('house_front', *at(0, -d / 2), heading=heading, scale=sc, fall=-1, name=f'flap_{tag}_front',
                         delay=base)
        self.add('house_back', *at(0, d / 2), heading=heading, scale=sc, fall=1, name=f'flap_{tag}_back',
                 delay=base + 0.06)
        left = self.add('house_side', *at(-w / 2, 0), heading=heading + 90, scale=sc, fall=1,
                        name=f'flap_{tag}_left', delay=base + 0.12)
        right = self.add('house_side', *at(w / 2, 0), heading=heading - 90, scale=sc, fall=1,
                         name=f'flap_{tag}_right', delay=base + 0.16)
        tilt = math.degrees(math.atan2(w / 2, rise))
        self.nest(left, 'house_roof', 0.0, h, tilt, 180 - tilt, scale=sc, name=f'flap_{tag}_roof_l')
        self.nest(right, 'house_roof', 0.0, h, tilt, 180 - tilt, scale=sc, name=f'flap_{tag}_roof_r')
        self.obstacles.append((cx, cy, round(0.56 * sc, 3)))
        self.occ.append((cx, cy, 0.8 * sc))
        self.prints.append(dict(t='house', x=cx, y=cy, heading=heading, w=w, d=d))
        return front

    def hills(self, layers, strut_shapes=()):
        out = []
        n = len(layers)
        for i, (shape, x, y) in enumerate(layers):
            f = self.add(shape, x, y, fall=1, name=f'flap_hill_{i}', delay=round(0.05 + 0.6 * i / max(1, n - 1), 3))
            out.append(f)
        for f, (shape, x, z) in zip(out, strut_shapes):
            self.nest(f, shape, x, z, -150.0, -30.0, name=self._name('strut'))
        return out


def _reeds_at_ponds(t, n=2):
    for (px, py, pr) in t.routes['ponds']:
        for k in range(n):
            for _ in range(40):
                a = t.rnd.uniform(0, 2 * math.pi)
                x, y = px + (pr + 0.07) * math.cos(a), py + (pr + 0.07) * math.sin(a)
                if max(abs(x), abs(y)) < 0.85 and t.clear(x, y, 0.03, 0.06):
                    t.add('reeds_a' if k % 2 == 0 else 'reeds_b', round(x, 3), round(y, 3),
                          heading=round(t.rnd.uniform(-30, 30), 1), occ=0.06)
                    break


def _sign_at_path_end(t):
    for (bx, by, br) in t.routes['path_blobs']:
        for _ in range(60):
            a = t.rnd.uniform(0, 2 * math.pi)
            x, y = bx + (br + 0.1) * math.cos(a), by + (br + 0.1) * math.sin(a)
            if max(abs(x), abs(y)) < 0.8 and t.clear(x, y, 0.06, 0.1):
                t.add('sign', round(x, 3), round(y, 3), heading=round(t.rnd.uniform(-20, 20), 1), obstacle=0.07)
                break


def _river_obstacles(t):
    t.obstacles += [(round(x, 3), round(y, 3), round(r, 3)) for x, y, r in G.river_obstacles(t.routes)]


TUFTS = ['tuft_a', 'tuft_b', 'tuft_c']
BLOOM = ['flower_a', 'tuft_a', 'flower_b', 'tuft_c']


def build_tiles():
    tiles = []

    def tile(*a, **k):
        t = Tile(*a, **k)
        tiles.append(t)
        return t

    # ---- grass
    t = tile('meadow_a', 'gggg', 6.0)
    t.prints.append(dict(t='compass', x=0.5, y=-0.52, r=0.2))
    t.scatter(TUFTS, 5)
    t.scatter(['flower_a', 'flower_b'], 2)

    t = tile('meadow_b', 'gggg', 5.0)
    t.prints.append(dict(t='survey'))
    t.add('bush_a', -0.45, 0.4, heading=12, obstacle=0.15, occ=0.25)
    t.add('hay', 0.5, -0.35, heading=-8, obstacle=0.14, occ=0.2)
    t.add('sheep', 0.1, 0.35, heading=-15, obstacle=0.1, occ=0.2)
    t.add('sheep', -0.35, -0.4, heading=160, scale=0.85, obstacle=0.09, occ=0.2)
    t.scatter(['flower_b', 'flower_a', 'flower_a'], 3)
    t.scatter(TUFTS, 3)

    t = tile('tree_single', 'gggg', 3.0, page='meadow_c')
    t.prints.append(dict(t='shade', x=0.0, y=0.3, r=0.5))
    t.vtree(0.0, 0.3)
    t.scatter(BLOOM, 4)

    t = tile('forest', 'gggg', 2.5)
    t.prints.append(dict(t='forest'))
    for shape, x, y, sc, hd in [('conifer_a', -0.6, 0.62, 1.0, 8), ('tree_round_a', -0.05, 0.68, 0.95, -6),
                                ('conifer_b', 0.56, 0.52, 1.1, -5), ('tree_round_b', -0.62, 0.1, 0.95, 10),
                                ('conifer_a', 0.08, 0.12, 0.84, 4), ('tree_oval', 0.64, -0.14, 0.88, -8),
                                ('tree_round_a', -0.32, -0.56, 0.85, 6), ('conifer_b', 0.36, -0.62, 0.9, -8)]:
        t.tree(shape, x, y, sc, hd)
    t.scatter(['bush_a', 'tuft_c'], 2, need=0.1)

    t = tile('hill_small', 'gggg', 2.0)
    t.prints.append(dict(t='contour', bumps=[(0.0, 0.0, 0.75, 0.5, 1.0), (0.3, 0.12, 0.3, 0.25, 0.5)], levels=4))
    t.hills([('hillsmall_1', 0.08, 0.3), ('hillsmall_2', -0.06, 0.0), ('hillsmall_3', 0.12, -0.3)])
    t.obstacles += [(-0.35, 0.0, 0.36), (0.35, 0.0, 0.36), (0.0, 0.0, 0.36)]
    t.occ.append((0, 0, 0.75))
    t.scatter(TUFTS, 2)

    t = tile('hill_big', 'gggg', 1.2)
    t.prints.append(dict(t='contour', bumps=[(0.0, 0.05, 0.95, 0.72, 1.0), (-0.1, 0.3, 0.45, 0.3, 0.8)], levels=7))
    t.hills([('hillbig_1', -0.08, 0.55), ('hillbig_2', 0.02, 0.22), ('hillbig_3', -0.02, -0.12),
             ('hillbig_4', 0.1, -0.45)], [('strut_a', 0.1, 0.55), ('strut_b', -0.35, 0.4)])
    t.obstacles += [(-0.55, 0.05, 0.42), (0.0, 0.05, 0.5), (0.55, 0.05, 0.42)]
    t.occ.append((0, 0, 0.95))
    t.add('conifer_b', -0.72, -0.72, scale=0.5, heading=8, obstacle=0.07)
    t.add('conifer_b', 0.78, -0.66, scale=0.42, heading=-8, obstacle=0.06)

    t = tile('house', 'gggg', 1.0)
    t.house(0.0, 0.08)
    t.prints.append(dict(t='yard', x0=-0.86, x1=0.86, y0=-0.84, y1=0.84))
    t.add('fence', -0.56, -0.74, heading=0, fall=-1, obstacle=0.12, occ=0.3)
    t.add('fence', 0.56, -0.74, heading=0, fall=-1, obstacle=0.12, occ=0.3)
    t.tree('tree_round_a', 0.78, 0.74, 0.75, -10)
    t.add('hay', -0.78, 0.7, scale=0.9, obstacle=0.13, occ=0.2)
    t.scatter(['flower_a', 'flower_b', 'tuft_a'], 3, need=0.05)

    t = tile('village', 'gggg', 0.6)
    t.prints.append(dict(t='lanes', pts=[[(-0.9, -0.1), (-0.2, -0.12), (0.1, 0.1), (0.9, -0.2)], [(0.1, 0.1), (0.0, 0.9)],
                                         [(-0.2, -0.12), (-0.3, -0.9)]]))
    t.house(-0.5, 0.42, heading=0, sc=0.6, tag='house_a')
    t.house(0.5, 0.36, heading=90, sc=0.56, tag='house_b')
    t.house(0.28, -0.46, heading=0, sc=0.62, tag='house_c')
    t.tree('tree_round_a', -0.6, -0.55, 0.7, 10)
    t.scatter(['tuft_a', 'flower_a'], 2, need=0.05)

    t = tile('pond', 'gggg', 0.7, opts=dict(ponds=[(0.0, 0.0, 0.48)]))
    _reeds_at_ponds(t, 4)
    t.rock(0.62, -0.5, 0.7)
    t.obstacles.append((0.0, 0.0, 0.5))
    t.scatter(TUFTS, 3)

    t = tile('rock', 'gggg', 1.0)
    t.prints.append(dict(t='scree', x=0.0, y=0.0))
    t.rock(-0.1, 0.1, 1.5)
    t.rock(0.42, -0.25, 0.8, heading=-20)
    t.scatter(['tuft_c', 'tuft_a', 'flower_b'], 4)

    # ---- paths
    t = tile('path_straight', 'pgpg', 4.0)
    t.add('milestone', 0.36, 0.3, heading=-90, obstacle=0.06)
    t.scatter(BLOOM, 5)

    t = tile('path_corner', 'ppgg', 2.5)
    t.tree('tree_round_a', -0.45, -0.45, 1.0, 10)
    t.scatter(BLOOM, 4)

    t = tile('path_t', 'pppg', 0.9)
    t.add('sign', -0.4, -0.3, heading=10, obstacle=0.07)
    t.add('bush_a', -0.6, 0.5, heading=-10, obstacle=0.15, occ=0.25)
    t.scatter(TUFTS, 3)

    t = tile('path_cross', 'pppp', 0.4)
    t.add('sign', 0.42, 0.42, heading=-15, obstacle=0.07)
    t.add('milestone', -0.4, -0.4, heading=45, obstacle=0.06)
    t.scatter(BLOOM, 4)

    t = tile('path_end', 'pggg', 0.5)
    t.add('sign', 0.46, -0.1, heading=170, obstacle=0.07)
    t.add('fence', 0.0, -0.5, heading=0, fall=-1, obstacle=0.12, occ=0.3)
    t.obstacles += [(-0.2, -0.5, 0.1), (0.2, -0.5, 0.1)]
    t.add('hay', -0.6, -0.2, obstacle=0.14, occ=0.2)
    t.scatter(BLOOM, 4)

    t = tile('house_with_path', 'ggpg', 0.8, opts=dict(path_end_r=0.3, path_blob=False))
    t.house(0.0, 0.14)
    t.tree('conifer_b', -0.76, 0.66, 0.9, 6)
    t.add('fence', -0.62, -0.42, heading=0, fall=-1, obstacle=0.12, occ=0.3)
    t.scatter(['flower_a', 'tuft_a', 'flower_b'], 3, need=0.06)

    # ---- rivers (blocked)
    t = tile('river_straight', 'rgrg', 3.0, blocked=True)
    t.add('reeds_a', -0.5, 0.45, heading=15, occ=0.06)
    t.add('reeds_b', 0.52, -0.4, heading=-20, occ=0.06)
    t.add('reeds_a', 0.5, 0.62, heading=5, occ=0.06)
    t.scatter(TUFTS, 3)

    t = tile('river_corner', 'rrgg', 1.6, blocked=True)
    t.add('reeds_a', -0.12, 0.42, heading=30, occ=0.06)
    t.add('reeds_b', 0.4, -0.14, heading=-40, occ=0.06)
    t.tree('tree_oval', -0.55, -0.5, 0.9, 8)
    t.scatter(TUFTS, 3)

    t = tile('river_source', 'rggg', 0.4, blocked=True)
    _reeds_at_ponds(t, 4)
    t.rock(-0.62, -0.55, 0.9)
    t.scatter(TUFTS, 3)

    t = tile('river_t', 'rrrg', 0.3, blocked=True)
    t.add('reeds_a', -0.5, 0.3, heading=80, occ=0.06)
    t.add('reeds_b', -0.48, -0.4, heading=100, occ=0.06)
    t.scatter(TUFTS, 3)

    t = tile('river_cross', 'rrrr', 0.1, blocked=True)
    _reeds_at_ponds(t, 3)
    t.scatter(TUFTS, 3)

    # ---- bridge: river north-south, path east-west
    t = tile('bridge', 'rprp', 1.2)
    t.prints.append(dict(t='deck', x0=-0.52, x1=0.52, hw=0.27))
    t.add('parapet', 0.0, 0.3, fall=1, name='flap_parapet_n', delay=0.15, obstacle=None)
    t.add('parapet', 0.0, -0.3, fall=-1, name='flap_parapet_s', delay=0.3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            t.obstacles.append((sx * 0.45, sy * 0.33, 0.09))
        t.obstacles.append((0.0, sx * 0.72, 0.42))
        t.obstacles.append((0.0, sx * 0.36, 0.1))
    t.add('reeds_a', 0.5, 0.7, heading=10, occ=0.06)
    t.add('reeds_b', -0.52, -0.72, heading=-10, occ=0.06)
    t.scatter(TUFTS, 3)

    # ---- mixed sockets: every remaining necklace of g/p/r, so the solver never dead-ends
    mixed = [
        ('spring_path_a', 'prgg', 0.25), ('spring_path_b', 'rpgg', 0.25), ('spring_path_c', 'pgrg', 0.25),
        ('corner_spring_a', 'pprg', 0.25), ('straight_spring', 'prpg', 0.3), ('corner_spring_b', 'rppg', 0.25),
        ('landing_corner_a', 'rrpg', 0.25), ('landing_straight', 'rprg', 0.3), ('landing_corner_b', 'prrg', 0.25),
        ('junction_spring', 'pppr', 0.2), ('twin_corners', 'pprr', 0.4), ('landing_t', 'prrr', 0.2),
    ]
    for tid, socks, w in mixed:
        t = tile(tid, socks, w)
        _river_obstacles(t)
        _reeds_at_ponds(t, 2)
        _sign_at_path_end(t)
        if tid == 'twin_corners':
            t.tree('tree_round_a', 0.0, 0.0, 0.8, 0)
        t.scatter(BLOOM, 4)

    for t in tiles:
        t.flat_height = G.finalize(t.flaps, t.id)
    return tiles
