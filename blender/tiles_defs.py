"""Tile definitions for Pop-up Atlas. Coordinates: x east, y north, tile spans [-1, 1]."""
import math
import random
import zlib

from mathutils import Matrix
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
        """Pick the fall side. Cards fold down toward the camera side (south) unless that leaves the tile."""
        outline = G.scaled(G.SHAPES[shape][0], scale)
        best, best_score = 1, 1e9
        for s in (1, -1):
            d = G.rz(heading) @ Vector((0.0, -s, 0.0))
            ax = G.rz(heading) @ Vector((1.0, 0.0, 0.0))
            over = 0.0
            for px, pz in outline:
                wx, wy = x + ax.x * px + d.x * pz, y + ax.y * px + d.y * pz
                over = max(over, abs(wx) - 0.96, abs(wy) - 0.96)
            score = max(over, 0.0) * 100 + (1.0 if d.y > 0 else 0.0)
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

    def nest(self, parent, shape, x, z, tilt, fold, scale=1.0, name=None, rot=None):
        f = G.Flap(name or self._name(shape.split('_')[0]), shape, scale, (x, z),
                   rot if rot is not None else G.rx(math.radians(tilt)),
                   math.radians(fold), parent=parent, delay=round(min(1.0, parent.delay + 0.1), 3))
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
            return (-3.0, 3.0, -1.5, 2.0)[k % 4]
        return -45.0 if x * y > 0 else 45.0

    def prop(self, shape, x, y, scale=1.0, k=0, obstacle=None, occ=0.15):
        return self.add(shape, x, y, heading=self.facing(k, x, y), scale=scale, obstacle=obstacle, occ=occ)

    def clump(self, x, y, items, step=0.11):
        """Overlapping cards at stepped depths, back first. items: (shape, sideways offset, scale)."""
        h = 0.0 if self.sym else self.facing(0, x, y)
        ax = G.rz(h) @ Vector((1.0, 0.0, 0.0))
        nrm = G.rz(h) @ Vector((0.0, -1.0, 0.0))
        if nrm.y > 0:
            nrm = -nrm
        for i, (shape, dx, sc) in enumerate(items):
            px, py = x + ax.x * dx + nrm.x * step * i, y + ax.y * dx + nrm.y * step * i
            self.add(shape, round(px, 3), round(py, 3), heading=h + (self.facing(i) if self.sym else 0.0), scale=sc,
                     obstacle=round(0.13 * sc, 3), occ=0.3)

    def house(self, cx, cy, sc=1.0, wall='cream', roof='terra', tag='house'):
        """Pre-folded box: the front wall rises from its base hinge and carries the roof and both side walls."""
        hs = G.HOUSE
        w, h, d = hs['w'] * sc, hs['h'] * sc, hs['d'] * sc
        base = min(0.6, max(0.0, 0.1 + 0.4 * (1 - (cy + 1) / 2)))
        front = self.add(f'hwall_{wall}', cx, cy, scale=sc, fall=1, name=f'flap_{tag}_front', delay=round(base, 3))
        self.nest(front, f'hroof_{roof}', 0.0, h, -hs['tilt'], hs['tilt'], scale=sc, name=f'flap_{tag}_roof')
        side = Matrix(((0, 1, 0, 0), (0, 0, 1, 0), (1, 0, 0, 0), (0, 0, 0, 1)))
        self.nest(front, f'hside_{wall}', -w / 2, 0.0, 0, -90, scale=sc, name=f'flap_{tag}_left', rot=side)
        self.nest(front, f'hside_{wall}', w / 2, 0.0, 0, 90, scale=sc, name=f'flap_{tag}_right', rot=side)
        self.obstacles.append((cx, round(cy + d / 2, 3), round(0.52 * sc, 3)))
        self.occ.append((cx, cy + d / 2, 0.6 * sc))

    def hills(self, layers):
        n = len(layers)
        for i, (shape, x, y) in enumerate(layers):
            self.add(shape, x, y, fall=1, name=f'flap_hill_{i}', delay=round(0.05 + 0.6 * i / max(1, n - 1), 3))

    def windmill(self, x, y, sc=1.0):
        h = 0.0 if self.sym else self.facing(0, x, y)
        nrm = G.rz(h) @ Vector((0.0, -1.0, 0.0))
        if nrm.y > 0:
            nrm = -nrm
        self.add('mill_tower', x, y, heading=h, scale=sc, name='flap_mill_tower', obstacle=round(0.25 * sc, 3), occ=0.4)
        self.add('mill_sails', round(x + nrm.x * 0.09, 3), round(y + nrm.y * 0.09, 3), heading=h, scale=sc,
                 name='flap_mill_sails')

    def bridge(self):
        """Raised arched deck (three hinged panels) between two arch cards. Path runs east-west."""
        dk = G.DECK
        ramp = self.add('deck_ramp', -(dk['run'] + dk['top'] / 2), 0.0, heading=90, fall=1, tilt=90 - dk['elev'],
                        name='flap_deck_a', delay=0.2)
        top = self.nest(ramp, 'deck_top', 0.0, dk['ramp'], dk['elev'], -dk['elev'], name='flap_deck_b')
        self.nest(top, 'deck_ramp', 0.0, dk['top'], dk['elev'], -dk['elev'], name='flap_deck_c')
        self.add('arch', 0.0, 0.28, fall=-1, name='flap_arch_n', delay=0.1)
        self.add('arch', 0.0, -0.28, fall=1, name='flap_arch_s', delay=0.3)

    def free_spot(self, need=0.3, lim=0.5):
        for _ in range(600):
            x, y = self.rnd.uniform(-lim, lim), self.rnd.uniform(-lim, lim)
            if self.clear(x, y, need, 0.25):
                return round(x, 2), round(y, 2)
        return None


def _reeds_at_ponds(t, scale=1.2):
    for (px, py, pr) in t.routes['ponds']:
        for _ in range(80):
            a = t.rnd.uniform(0, 2 * math.pi)
            x, y = px + (pr + 0.1) * math.cos(a), py + (pr + 0.1) * math.sin(a)
            if max(abs(x), abs(y)) < 0.6 and t.clear(x, y, 0.05, 0.15):
                t.prop('reeds', round(x, 2), round(y, 2), scale, 0, occ=0.15)
                break


def _sign_at_path_end(t):
    for (bx, by, br) in t.routes['path_blobs']:
        for _ in range(80):
            a = t.rnd.uniform(0, 2 * math.pi)
            x, y = bx + (br + 0.12) * math.cos(a), by + (br + 0.12) * math.sin(a)
            if max(abs(x), abs(y)) < 0.6 and t.clear(x, y, 0.08, 0.15):
                t.prop('sign', round(x, 2), round(y, 2), 1.7, 0, obstacle=0.08)
                break


def _river_obstacles(t):
    t.obstacles += [(round(x, 3), round(y, 3), round(r, 3)) for x, y, r in G.river_obstacles(t.routes)]


PAIRS = [[('tree_leaf_moss', -0.14, 1.1), ('tree_round_ochre', 0.14, 0.9)],
         [('conifer', -0.12, 1.0), ('tree_leaf_terra', 0.16, 0.95)],
         [('tree_leaf_sage', 0.12, 1.0), ('tree_round_moss', -0.16, 0.8)]]


def build_tiles():
    tiles = []

    def tile(*a, **k):
        t = Tile(*a, **k)
        tiles.append(t)
        return t

    # ---- grass (always drawn at rotation 0, so cards face the camera and fold down toward it)
    t = tile('meadow_a', 'gggg', 3.0)
    t.clump(0.0, 0.62, [('tree_round_moss', -0.5, 1.2), ('tree_leaf_sage', 0.05, 1.35), ('tree_round_ochre', 0.5, 1.15),
                        ('tree_leaf_terra', -0.2, 0.95), ('conifer', 0.3, 0.75)])
    t.clump(-0.5, -0.25, [('hay', 0.0, 1.5), ('hay', 0.3, 1.1)])
    t.prop('bush', 0.55, -0.4, 1.3, 1, obstacle=0.2)

    t = tile('meadow_b', 'gggg', 3.0)
    t.windmill(0.35, 0.62, 1.1)
    t.clump(-0.5, 0.45, [('fence', 0.0, 1.6), ('tree_leaf_moss', -0.25, 0.9)])
    t.prop('sheep', -0.3, -0.25, 2.4, 0, obstacle=0.2)
    t.prop('sheep', 0.35, -0.5, 2.0, 1, obstacle=0.17)
    t.prop('sheep', 0.6, -0.1, 1.7, 2, obstacle=0.15)

    t = tile('tree_single', 'gggg', 3.0)
    t.clump(0.0, 0.62, [('tree_round_moss', 0.0, 1.45), ('tree_leaf_terra', -0.5, 0.95), ('conifer', 0.52, 0.9)])
    t.clump(0.45, -0.35, [('hay', 0.0, 1.5), ('bush', -0.35, 1.2)])
    t.prop('bush', -0.55, -0.45, 1.4, 1, obstacle=0.2)

    t = tile('forest', 'gggg', 3.0)
    t.clump(0.0, 0.78, [('conifer', -0.55, 1.2), ('tree_leaf_sage', -0.1, 1.4), ('tree_round_ochre', 0.5, 1.3)])
    t.clump(0.0, 0.5, [('tree_leaf_moss', -0.4, 1.15), ('conifer', 0.25, 1.1), ('tree_leaf_terra', 0.62, 1.0)])
    t.clump(-0.1, 0.2, [('tree_round_moss', -0.5, 0.82), ('tree_leaf_sage', 0.1, 0.78), ('conifer', 0.55, 0.65)])

    t = tile('hill_small', 'gggg', 2.5)
    t.hills([('hillsmall_1', 0.1, 0.52), ('hillsmall_2', -0.04, 0.39), ('hillsmall_3', 0.06, 0.26),
             ('hillsmall_4', -0.2, 0.13)])
    t.obstacles += [(-0.5, 0.32, 0.4), (0.5, 0.32, 0.4), (0.0, 0.32, 0.45)]
    t.clump(0.5, -0.18, [('conifer', 0.0, 0.6), ('bush', -0.3, 1.2)])
    t.prop('bush', -0.5, -0.4, 1.3, 1, obstacle=0.2)

    t = tile('hill_big', 'gggg', 1.5)
    t.hills([('hillbig_1', -0.12, 0.76), ('hillbig_2', 0.04, 0.63), ('hillbig_3', -0.04, 0.5),
             ('hillbig_4', 0.02, 0.37), ('hillbig_5', 0.2, 0.24)])
    t.obstacles += [(-0.55, 0.5, 0.45), (0.0, 0.5, 0.55), (0.55, 0.5, 0.45)]
    t.clump(-0.45, -0.25, [('conifer', 0.0, 0.62), ('conifer', 0.3, 0.5)])
    t.prop('bush', 0.5, -0.45, 1.3, 1, obstacle=0.2)

    t = tile('house', 'gggg', 1.5)
    t.house(-0.1, 0.5)
    t.clump(0.74, 0.5, [('tree_leaf_moss', 0.0, 1.25), ('tree_round_ochre', -0.1, 0.8)])
    t.clump(0.0, -0.4, [('fence', -0.45, 1.4), ('fence', 0.45, 1.4)], step=0.0)
    t.prop('bush', -0.6, -0.05, 1.2, 1, obstacle=0.18)

    t = tile('village', 'gggg', 1.0)
    t.prints.append(dict(t='lanes', pts=[[(-0.9, -0.5), (0.0, -0.45), (0.9, -0.55)]]))
    t.house(-0.5, 0.6, sc=0.68, wall='ochre', roof='brown', tag='house_a')
    t.house(0.28, 0.66, sc=0.72, wall='cream', roof='teal', tag='house_b')
    t.house(-0.1, 0.22, sc=0.7, wall='cream', roof='terra', tag='house_c')
    t.house(0.6, 0.12, sc=0.6, wall='teal', roof='terra', tag='house_d')
    t.clump(-0.68, 0.1, [('tree_round_ochre', 0.0, 0.85), ('conifer', 0.2, 0.6)])

    t = tile('pond', 'gggg', 0.7, opts=dict(ponds=[(0.0, -0.1, 0.5)]))
    t.clump(0.0, 0.72, [('tree_leaf_sage', -0.4, 1.2), ('tree_round_moss', 0.1, 1.0), ('tree_leaf_terra', 0.55, 0.9)])
    t.prop('reeds', -0.62, 0.0, 1.3, 0)
    t.prop('reeds', 0.6, -0.3, 1.1, 1)
    t.obstacles.append((0.0, -0.1, 0.52))

    t = tile('rock', 'gggg', 1.0)
    t.clump(0.0, 0.45, [('rock_a', -0.1, 1.6), ('rock_b', 0.3, 1.6), ('rock_a', -0.45, 0.8)], step=0.13)
    t.obstacles.append((0.0, 0.35, 0.6))
    t.clump(0.5, -0.4, [('conifer', 0.0, 0.6), ('bush', -0.3, 1.2)])

    # ---- paths (rotated by the world: free-standing cards sit diagonally)
    t = tile('path_straight', 'pgpg', 4.0)
    t.clump(-0.62, 0.25, PAIRS[0])
    t.clump(0.62, 0.3, [('bush', 0.0, 1.3), ('tree_leaf_terra', 0.15, 0.8)])

    t = tile('path_corner', 'ppgg', 2.5)
    t.clump(-0.4, 0.0, [('tree_round_moss', -0.1, 1.05), ('tree_leaf_sage', 0.2, 0.95), ('conifer', -0.3, 0.7)])

    t = tile('path_t', 'pppg', 0.9)
    t.clump(-0.62, 0.3, PAIRS[1])
    t.prop('sign', -0.45, -0.45, 1.7, 0, obstacle=0.08)

    t = tile('path_cross', 'pppp', 0.4)
    t.clump(-0.62, 0.62, [('tree_leaf_terra', 0.0, 0.8), ('bush', 0.2, 1.1)])
    t.prop('sign', 0.5, 0.5, 1.7, 0, obstacle=0.08)
    t.prop('hay', 0.6, -0.55, 1.3, 1, obstacle=0.2)
    t.prop('bush', -0.6, -0.55, 1.3, 1, obstacle=0.2)

    t = tile('path_end', 'pggg', 0.5)
    t.windmill(-0.5, 0.38, 0.95)
    t.prop('sign', 0.52, -0.1, 1.7, 0, obstacle=0.08)
    t.clump(0.55, 0.45, [('hay', 0.0, 1.4), ('hay', 0.25, 1.0)])

    t = tile('house_with_path', 'ggpg', 0.8, opts=dict(path_end_r=-0.48, path_blob=False))
    t.house(0.0, 0.5, wall='ochre', roof='terra')
    t.clump(-0.72, 0.3, [('conifer', 0.0, 0.9), ('bush', 0.15, 1.1)])

    # ---- rivers (blocked)
    t = tile('river_straight', 'rgrg', 3.0, blocked=True)
    t.clump(-0.68, 0.3, PAIRS[2])
    t.prop('reeds', 0.58, 0.4, 1.3, 0)
    t.prop('bush', 0.62, -0.4, 1.2, 1)

    t = tile('river_corner', 'rrgg', 1.6, blocked=True)
    t.clump(-0.4, 0.0, [('tree_leaf_moss', -0.1, 1.05), ('tree_round_ochre', 0.2, 0.9), ('conifer', -0.3, 0.7)])
    t.prop('reeds', 0.45, 0.5, 1.2, 1)

    t = tile('river_source', 'rggg', 0.4, blocked=True)
    t.clump(-0.62, 0.2, [('rock_a', 0.0, 1.2), ('rock_b', 0.15, 1.1)], step=0.13)
    t.prop('reeds', 0.62, 0.3, 1.3, 1)
    t.clump(0.6, -0.55, [('bush', 0.0, 1.2)])

    t = tile('river_t', 'rrrg', 0.3, blocked=True)
    t.clump(-0.62, 0.3, PAIRS[1])
    t.prop('reeds', -0.55, -0.5, 1.3, 0)

    t = tile('river_cross', 'rrrr', 0.1, blocked=True)
    t.prop('reeds', -0.62, 0.62, 1.3, 0)
    t.prop('reeds', 0.62, -0.62, 1.2, 1)
    t.prop('bush', 0.62, 0.62, 1.2, 2)

    # ---- bridge: river north-south, path east-west
    t = tile('bridge', 'rprp', 1.2)
    t.bridge()
    for sx in (-1, 1):
        for sy in (-1, 1):
            t.obstacles.append((sx * 0.5, sy * 0.36, 0.1))
        t.obstacles.append((0.0, sx * 0.72, 0.42))
        t.obstacles.append((0.0, sx * 0.38, 0.1))
    t.clump(-0.62, 0.66, [('tree_leaf_sage', 0.0, 0.8), ('bush', 0.2, 1.0)])
    t.prop('reeds', 0.62, -0.7, 1.1, 0)

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
        _reeds_at_ponds(t)
        spot = t.free_spot(0.22, 0.55) or t.free_spot(0.12, 0.6)
        if spot:
            t.clump(spot[0], spot[1], PAIRS[n % 3])
        spot = t.free_spot(0.12, 0.62)
        if spot:
            t.prop('bush', spot[0], spot[1], 1.2, 1, obstacle=0.18, occ=0.3)

    for t in tiles:
        t.flat_height = G.finalize(t.flaps, t.id)
    return tiles
