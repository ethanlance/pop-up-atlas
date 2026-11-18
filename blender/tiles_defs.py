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
            prefer=1, occ=0.1, tilt=0.0):
        if fall is None:
            fall = self._fall(shape, x, y, heading, scale, prefer)
        if delay is None:
            delay = min(1.0, max(0.0, 0.05 + 0.55 * (1 - (y + 1) / 2) + 0.3 * self.rnd.random()))
        f = G.Flap(name or self._name(shape.split('_')[0]), shape, scale, (x, y),
                   G.rz(heading) @ G.rx(math.radians(tilt)), fall * math.pi / 2 - math.radians(tilt),
                   delay=round(delay, 3), tab=tab and tilt == 0.0)
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

    @property
    def sym(self):
        """True when all four sockets match: the world then always draws the tile at rotation 0."""
        return len(set(self.sockets.values())) == 1

    def facing(self, k=0, x=0.0, y=0.0):
        """Heading for a free-standing card: toward the camera on unrotated tiles, else diagonal so it reads at any rotation."""
        if self.sym:
            return (-12.0, 10.0, -6.0, 14.0)[k % 4]
        return -45.0 if x * y > 0 else 45.0

    def prop(self, shape, x, y, scale=1.0, k=0, obstacle=None, occ=0.15):
        return self.add(shape, x, y, heading=self.facing(k, x, y), scale=scale, obstacle=obstacle, occ=occ)

    def place(self, shape, scale=1.0, need=0.2, lim=0.62, obstacle=None, k=0, occ=0.25):
        """Put one prop at a free spot away from the printed path and water."""
        for _ in range(400):
            x, y = self.rnd.uniform(-lim, lim), self.rnd.uniform(-lim, lim)
            if self.clear(x, y, need, 0.2):
                return self.prop(shape, round(x, 2), round(y, 2), scale, k, obstacle, occ)
        return None

    # ---- compound pop-ups

    def tree(self, shape, x, y, scale=1.0, k=0):
        return self.prop(shape, x, y, scale, k, obstacle=round(0.14 * scale, 3), occ=0.25 * scale)

    def vtree(self, x, y, scale=1.0, spread=45.0):
        a = self.add('vtree_r', x, y, heading=spread, scale=scale, fall=1, name=self._name('vtree'), occ=0.3)
        b = self.add('vtree_l', x, y, heading=-spread, scale=scale, fall=1, name=self._name('vtree'),
                     delay=min(1.0, a.delay + 0.08), occ=0.3)
        self.obstacles.append((x, y, round(0.2 * scale, 3)))
        return a, b

    def rock(self, x, y, scale=1.0, spread=45.0):
        self.add('rock_r', x, y, heading=spread, scale=scale, fall=1, name=self._name('rock'), occ=0.3)
        self.add('rock_l', x, y, heading=-spread, scale=scale, fall=1, name=self._name('rock'), occ=0.3)
        self.obstacles.append((x, y, round(0.26 * scale, 3)))

    def house(self, cx, cy, heading=0.0, sc=1.0, tag='house'):
        """Box house. Both gables fall the same way and the side walls fall outward, so no wall crosses another."""
        w, d, h, rise = (G.HOUSE[k] * sc for k in ('w', 'd', 'h', 'rise'))
        r = G.rz(heading)

        def at(lx, ly):
            v = r @ Vector((lx, ly, 0.0))
            return round(cx + v.x, 4), round(cy + v.y, 4)

        base = min(0.6, max(0.0, 0.1 + 0.4 * (1 - (cy + 1) / 2)))
        self.add('house_back', *at(0, d / 2), heading=heading, scale=sc, fall=-1, name=f'flap_{tag}_back', delay=base)
        self.add('house_front', *at(0, -d / 2), heading=heading, scale=sc, fall=-1, name=f'flap_{tag}_front',
                 delay=base + 0.06)
        left = self.add('house_side', *at(-w / 2, 0), heading=heading + 90, scale=sc, fall=-1,
                        name=f'flap_{tag}_left', delay=base + 0.12)
        right = self.add('house_side', *at(w / 2, 0), heading=heading - 90, scale=sc, fall=-1,
                         name=f'flap_{tag}_right', delay=base + 0.16)
        tilt = math.degrees(math.atan2(w / 2, rise))
        self.nest(left, 'house_roof', 0.0, h, tilt, 180 - tilt, scale=sc, name=f'flap_{tag}_roof_l')
        self.nest(right, 'house_roof', 0.0, h, tilt, 180 - tilt, scale=sc, name=f'flap_{tag}_roof_r')
        self.obstacles.append((cx, cy, round(0.56 * sc, 3)))
        self.occ.append((cx, cy, 0.75 * sc))
        self.prints.append(dict(t='plot', x=cx, y=cy, heading=heading, w=w, d=d))

    def hills(self, layers, strut_shapes=()):
        out = []
        n = len(layers)
        for i, (shape, x, y) in enumerate(layers):
            f = self.add(shape, x, y, fall=1, name=f'flap_hill_{i}', delay=round(0.05 + 0.6 * i / max(1, n - 1), 3))
            out.append(f)
        for f, (shape, x, z) in zip(out, strut_shapes):
            self.nest(f, shape, x, z, -150.0, -30.0, name=self._name('strut'))
        return out

    def bridge(self):
        """Raised arched deck (three hinged panels) between two arch cards. Path runs east-west."""
        dk = G.DECK
        ramp = self.add('deck_ramp', -(dk['run'] + dk['top'] / 2), 0.0, heading=90, fall=1, tilt=90 - dk['elev'],
                        name='flap_deck_a', delay=0.2)
        top = self.nest(ramp, 'deck_top', 0.0, dk['ramp'], dk['elev'], -dk['elev'], name='flap_deck_b')
        self.nest(top, 'deck_ramp', 0.0, dk['top'], dk['elev'], -dk['elev'], name='flap_deck_c')
        self.add('arch', 0.0, 0.28, fall=-1, name='flap_arch_n', delay=0.1)
        self.add('arch', 0.0, -0.28, fall=1, name='flap_arch_s', delay=0.3)


def _reeds_at_ponds(t, n=1, scale=1.0):
    for (px, py, pr) in t.routes['ponds']:
        for k in range(n):
            for _ in range(60):
                a = t.rnd.uniform(0, 2 * math.pi)
                x, y = px + (pr + 0.1) * math.cos(a), py + (pr + 0.1) * math.sin(a)
                if max(abs(x), abs(y)) < 0.7 and t.clear(x, y, 0.05, 0.15):
                    t.prop('reeds', round(x, 2), round(y, 2), scale, k, occ=0.15)
                    break


def _sign_at_path_end(t):
    for (bx, by, br) in t.routes['path_blobs']:
        for _ in range(80):
            a = t.rnd.uniform(0, 2 * math.pi)
            x, y = bx + (br + 0.12) * math.cos(a), by + (br + 0.12) * math.sin(a)
            if max(abs(x), abs(y)) < 0.7 and t.clear(x, y, 0.08, 0.15):
                t.prop('sign', round(x, 2), round(y, 2), 1.5, 0, obstacle=0.08)
                break


def _river_obstacles(t):
    t.obstacles += [(round(x, 3), round(y, 3), round(r, 3)) for x, y, r in G.river_obstacles(t.routes)]


TREES = ['tree_leaf_moss', 'tree_round_ochre', 'tree_leaf_terra', 'conifer', 'tree_leaf_sage', 'tree_round_moss']


def build_tiles():
    tiles = []

    def tile(*a, **k):
        t = Tile(*a, **k)
        tiles.append(t)
        return t

    # ---- grass (always drawn at rotation 0, so cards face the camera)
    t = tile('meadow_a', 'gggg', 6.0)
    t.prop('hay', -0.35, 0.3, 1.3, 0, obstacle=0.2)
    t.prop('tuft', 0.45, -0.3, 1.2, 1)
    t.prop('flower', 0.2, 0.45, 1.0, 2)

    t = tile('meadow_b', 'gggg', 5.0)
    t.prop('sheep', 0.15, 0.35, 2.2, 0, obstacle=0.2)
    t.prop('sheep', -0.4, -0.3, 1.8, 1, obstacle=0.17)
    t.prop('bush', 0.5, -0.4, 1.0, 2, obstacle=0.2)

    t = tile('tree_single', 'gggg', 3.0)
    t.vtree(0.0, 0.3, 0.9)
    t.prop('tuft', -0.5, -0.45, 1.2, 1)

    t = tile('forest', 'gggg', 2.5)
    for k, (shape, x, y, sc) in enumerate([('conifer', -0.55, 0.55, 1.0), ('tree_leaf_sage', 0.1, 0.62, 1.0),
                                          ('tree_round_ochre', 0.62, 0.3, 1.0), ('tree_leaf_moss', -0.25, 0.05, 0.95),
                                          ('tree_leaf_terra', 0.3, -0.35, 1.0), ('conifer', -0.6, -0.45, 0.8)]):
        t.tree(shape, x, y, sc, k)

    t = tile('hill_small', 'gggg', 2.0)
    t.prints.append(dict(t='contour', bumps=[(0.0, 0.0, 0.85, 0.6, 1.0)], levels=[0.3, 0.6]))
    t.hills([('hillsmall_1', 0.1, 0.42), ('hillsmall_2', -0.04, 0.08), ('hillsmall_3', 0.14, -0.26)])
    t.obstacles += [(-0.45, 0.08, 0.4), (0.45, 0.08, 0.4), (0.0, 0.08, 0.42)]

    t = tile('hill_big', 'gggg', 1.2)
    t.prints.append(dict(t='contour', bumps=[(0.0, 0.1, 0.95, 0.75, 1.0)], levels=[0.25, 0.5, 0.75]))
    t.hills([('hillbig_1', -0.1, 0.66), ('hillbig_2', 0.02, 0.4), ('hillbig_3', -0.04, 0.14),
             ('hillbig_4', 0.02, -0.12), ('hillbig_5', 0.25, -0.38)], [('strut_a', 0.0, 0.55), ('strut_b', -0.3, 0.4)])
    t.obstacles += [(-0.55, 0.15, 0.45), (0.0, 0.15, 0.55), (0.55, 0.15, 0.45)]

    t = tile('house', 'gggg', 1.0)
    t.house(0.0, -0.38)
    t.tree('tree_leaf_moss', -0.68, 0.5, 0.85, 0)
    t.prop('fence', 0.55, 0.42, 1.2, 1, obstacle=0.14)

    t = tile('village', 'gggg', 0.6)
    t.prints.append(dict(t='lanes', pts=[[(-0.9, -0.38), (0.0, -0.3), (0.9, -0.42)], [(0.0, -0.3), (0.02, 0.9)]]))
    t.house(-0.36, 0.14, sc=0.58, tag='house_a')
    t.house(0.34, 0.02, sc=0.58, tag='house_b')
    t.house(-0.1, -0.68, sc=0.5, tag='house_c')
    t.tree('tree_round_ochre', 0.62, -0.7, 0.6, 1)

    t = tile('pond', 'gggg', 0.7, opts=dict(ponds=[(0.0, 0.0, 0.5)]))
    t.prop('reeds', -0.55, 0.3, 1.0, 0)
    t.prop('reeds', 0.45, -0.5, 0.8, 1)
    t.rock(0.6, 0.45, 0.7)
    t.obstacles.append((0.0, 0.0, 0.52))

    t = tile('rock', 'gggg', 1.0)
    t.rock(-0.05, 0.25, 1.5)
    t.prop('tuft', 0.5, -0.4, 1.2, 1)

    # ---- paths (rotated by the world: free-standing cards sit diagonally)
    t = tile('path_straight', 'pgpg', 4.0)
    t.tree('tree_leaf_moss', -0.6, 0.1, 0.95, 0)
    t.prop('tuft', 0.55, -0.45, 1.1, 1)

    t = tile('path_corner', 'ppgg', 2.5)
    t.tree('tree_round_ochre', -0.4, -0.35, 1.0, 1)

    t = tile('path_t', 'pppg', 0.9)
    t.prop('sign', -0.45, -0.1, 1.6, 0, obstacle=0.08)
    t.prop('bush', -0.6, 0.55, 1.0, 1, obstacle=0.2)

    t = tile('path_cross', 'pppp', 0.4)
    t.prop('sign', 0.48, 0.48, 1.6, 0, obstacle=0.08)
    t.tree('tree_leaf_terra', -0.58, -0.52, 0.8, 1)

    t = tile('path_end', 'pggg', 0.5)
    t.prop('sign', 0.52, -0.1, 1.6, 0, obstacle=0.08)
    t.prop('hay', -0.55, -0.35, 1.3, 1, obstacle=0.2)

    t = tile('house_with_path', 'ggpg', 0.8, opts=dict(path_end_r=0.72, path_blob=False))
    t.house(0.0, -0.38)
    t.tree('conifer', -0.7, 0.45, 0.8, 0)

    # ---- rivers (blocked)
    t = tile('river_straight', 'rgrg', 3.0, blocked=True)
    t.prop('reeds', -0.62, 0.35, 1.0, 0)
    t.tree('tree_leaf_sage', 0.66, -0.2, 0.8, 1)

    t = tile('river_corner', 'rrgg', 1.6, blocked=True)
    t.tree('tree_leaf_moss', -0.5, -0.45, 1.0, 0)
    t.prop('reeds', -0.15, 0.5, 1.0, 1)

    t = tile('river_source', 'rggg', 0.4, blocked=True)
    t.rock(-0.05, -0.62, 1.1)
    t.prop('reeds', 0.62, 0.3, 1.0, 1)

    t = tile('river_t', 'rrrg', 0.3, blocked=True)
    t.prop('reeds', -0.55, 0.45, 1.0, 0)
    t.tree('conifer', -0.6, -0.5, 0.75, 1)

    t = tile('river_cross', 'rrrr', 0.1, blocked=True)
    t.prop('reeds', -0.62, 0.62, 1.0, 0)
    t.prop('reeds', 0.62, -0.62, 0.9, 1)

    # ---- bridge: river north-south, path east-west
    t = tile('bridge', 'rprp', 1.2)
    t.bridge()
    for sx in (-1, 1):
        for sy in (-1, 1):
            t.obstacles.append((sx * 0.5, sy * 0.36, 0.1))
        t.obstacles.append((0.0, sx * 0.72, 0.42))
        t.obstacles.append((0.0, sx * 0.38, 0.1))
    t.prop('reeds', 0.62, 0.72, 0.9, 0)

    # ---- mixed sockets: every remaining necklace of g/p/r, so the solver never dead-ends
    mixed = [
        ('spring_path_a', 'prgg', 0.25), ('spring_path_b', 'rpgg', 0.25), ('spring_path_c', 'pgrg', 0.25),
        ('corner_spring_a', 'pprg', 0.25), ('straight_spring', 'prpg', 0.3), ('corner_spring_b', 'rppg', 0.25),
        ('landing_corner_a', 'rrpg', 0.25), ('landing_straight', 'rprg', 0.3), ('landing_corner_b', 'prrg', 0.25),
        ('junction_spring', 'pppr', 0.2), ('twin_corners', 'pprr', 0.4), ('landing_t', 'prrr', 0.2),
    ]
    for n, (tid, socks, w) in enumerate(mixed):
        t = tile(tid, socks, w)
        _river_obstacles(t)
        _sign_at_path_end(t)
        _reeds_at_ponds(t, 1)
        t.place(TREES[n % len(TREES)], 0.85, need=0.22, obstacle=0.12, k=n)

    for t in tiles:
        t.flat_height = G.finalize(t.flaps, t.id)
    return tiles
