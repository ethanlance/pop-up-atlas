"""Geometry for Pop-up Atlas tiles: outlines, flaps, flat-state layering, card meshes, routes.

All coordinates here are Z-up (x east, y north, z up). The GLB writer converts to glTF Y-up.
A flap card lies in its local XZ plane: local +X = hinge axis, local +Z = up the card, local Y = card normal.
"""
import math
import random

import numpy as np
from mathutils import Matrix
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

T_CARD = 0.016
GAP = 0.0015
PAGE_TOP = 0.0045
EDGE = {'n': (0.0, 1.0), 'e': (1.0, 0.0), 's': (0.0, -1.0), 'w': (-1.0, 0.0)}
ORDER = 'nesw'
PATH_HW = 0.25
RIVER_HW = 0.35


def rz(deg):
    return Matrix.Rotation(math.radians(deg), 4, 'Z')


def rx(rad):
    return Matrix.Rotation(rad, 4, 'X')


def area(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return a / 2


def ccw(pts):
    pts = [(float(a), float(b)) for a, b in pts]
    return pts if area(pts) > 0 else pts[::-1]


def scaled(pts, s):
    return [(x * s, z * s) for x, z in pts]


# ---------------------------------------------------------------- outlines (x, z), hinge on z = 0

def o_tree_round(r=0.27, h=0.86, tw=0.035, lobes=7, phase=0.0, n=20):
    cz = h - r
    a0 = -math.pi / 2 + math.asin(tw / r)
    pts = [(-tw, 0), (tw, 0)]
    for i in range(n + 1):
        a = a0 + (2 * math.pi - 2 * (a0 + math.pi / 2)) * i / n
        m = 1 + 0.075 * math.cos(lobes * a + phase)
        if i in (0, n):
            m = 1
        pts.append((r * m * math.cos(a), cz + r * m * math.sin(a)))
    return pts


def o_tree_oval(rx_=0.2, h=1.1, tw=0.035, n=18):
    rz_ = h * 0.36
    cz = h - rz_
    a0 = -math.pi / 2 + math.asin(tw / rx_)
    pts = [(-tw, 0), (tw, 0)]
    for i in range(n + 1):
        a = a0 + (2 * math.pi - 2 * (a0 + math.pi / 2)) * i / n
        m = 1 + (0.05 * math.cos(9 * a) if 0 < i < n else 0)
        pts.append((rx_ * m * math.cos(a), cz + rz_ * m * math.sin(a)))
    return pts


def o_conifer(w=0.42, h=1.05, tw=0.035, th=0.16, tiers=4):
    right = [(tw, 0), (tw, th)]
    step = (h - th) / tiers
    for i in range(tiers):
        wo = w / 2 * (1 - 0.72 * i / tiers)
        wi = w / 2 * (1 - 0.72 * (i + 1) / tiers) * 0.5
        right.append((wo, th + i * step - (0.02 if i else 0)))
        if i < tiers - 1:
            right.append((wi, th + (i + 1) * step))
    pts = right + [(0.0, h)] + [(-x, z) for x, z in reversed(right)]
    return pts


def o_bush(w=0.36, h=0.22, lobes=4, n=14):
    pts = [(-w / 2, 0), (w / 2, 0)]
    for i in range(1, n):
        a = math.pi * i / n
        m = 1 + 0.12 * abs(math.sin(lobes * a))
        pts.append((w / 2 * math.cos(a) * m, h * math.sin(a) * m))
    return pts


def o_tuft(w=0.2, h=0.15, n=5, seed=1):
    rnd = random.Random(seed)
    pts = [(-w / 2, 0), (w / 2, 0)]
    for i in range(n):
        f = 1 - (i + 0.5) / n
        x = -w / 2 + w * f
        lean = (f - 0.5) * 0.09 + rnd.uniform(-0.012, 0.012)
        hh = h * (0.62 + 0.38 * math.sin(math.pi * f)) * rnd.uniform(0.85, 1.0)
        pts.append((x + lean, hh))
        if i < n - 1:
            pts.append((x - w / n / 2, h * 0.22))
    return pts


def o_flower(h=0.24, r=0.05, sw=0.011):
    pts = [(-sw, 0), (sw, 0), (sw, h * 0.28), (sw + 0.05, h * 0.42), (sw, h * 0.47)]
    cz = h - r
    a0 = -math.pi / 2 + math.asin(sw / r)
    n = 12
    for i in range(n + 1):
        a = a0 + (2 * math.pi - 2 * (a0 + math.pi / 2)) * i / n
        m = 1 + (0.16 * math.cos(6 * a) if 0 < i < n else 0)
        pts.append((r * m * math.cos(a), cz + r * m * math.sin(a)))
    pts += [(-sw, h * 0.36), (-sw - 0.045, h * 0.3), (-sw, h * 0.2)]
    return pts


def o_reeds(w=0.14, h=0.36, seed=3):
    return o_tuft(w, h, 4, seed)


def o_hill(w, h, seed, n=26, jag=0.0, skew=0.0):
    rnd = random.Random(seed)
    f1, f2 = rnd.uniform(1.2, 2.2), rnd.uniform(3.0, 4.5)
    p1, p2 = rnd.uniform(0, 6.3), rnd.uniform(0, 6.3)
    zs = []
    for i in range(n + 1):
        t = i / n
        tt = min(1.0, max(0.0, t + skew * math.sin(math.pi * t)))
        base = math.sin(math.pi * tt) ** 0.75
        b = 1 + 0.16 * math.sin(2 * math.pi * f1 * t + p1) + 0.07 * math.sin(2 * math.pi * f2 * t + p2)
        if jag:
            b += jag * (abs(((t * 7 + p1) % 1.0) - 0.5) * 2 - 0.5)
        zs.append(base * b)
    m = max(zs)
    top = [(-w / 2 + w * i / n, h * zs[i] / m) for i in range(n + 1)]
    top[0] = (-w / 2, 0.0)
    top[-1] = (w / 2, 0.0)
    return top[::-1]


def o_peak(w, h, seed):
    rnd = random.Random(seed)
    xs = [-0.5, -0.36, -0.22, -0.1, 0.02, 0.14, 0.27, 0.4, 0.5]
    zs = [0, 0.34, 0.3, 0.74, 1.0, 0.62, 0.7, 0.3, 0]
    pts = [(xs[i] * w + (rnd.uniform(-0.02, 0.02) if 0 < i < 8 else 0), zs[i] * h) for i in range(9)]
    return pts[::-1]


def o_rect(x0, x1, z0, z1):
    return [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]


HOUSE = dict(w=0.9, d=0.66, h=0.56, rise=0.45)


def o_gable(chimney=False):
    w, h, rise = HOUSE['w'], HOUSE['h'], HOUSE['rise']
    pts = [(-w / 2, 0), (w / 2, 0), (w / 2, h)]
    if chimney:
        x0, x1, zt = 0.3, 0.19, h + rise + 0.1
        pts += [(x0, h + rise * (1 - x0 / (w / 2))), (x0, zt), (x1, zt), (x1, h + rise * (1 - x1 / (w / 2)))]
    pts += [(0, h + rise), (-w / 2, h)]
    return pts


def o_parapet(length=1.24, hend=0.13, hmid=0.3, a=0.33, ah=0.17, n=10):
    pts = [(-length / 2, 0), (-a, 0)]
    for i in range(1, n):
        t = math.pi * (1 - i / n)
        pts.append((a * math.cos(t), ah * math.sin(t)))
    pts += [(a, 0), (length / 2, 0), (length / 2, hend + 0.05), (length / 2 - 0.07, hend + 0.05), (length / 2 - 0.07, hend)]
    m = 12
    x_in = length / 2 - 0.07
    for i in range(1, m):
        x = x_in - 2 * x_in * i / m
        pts.append((x, hend + (hmid - hend) * math.cos(math.pi / 2 * x / x_in) ** 1.2))
    pts += [(-x_in, hend), (-x_in, hend + 0.05), (-length / 2, hend + 0.05)]
    return pts


def o_rock(w=0.34, h=0.26, right=True):
    pts = [(0, 0), (w, 0), (w * 0.92, h * 0.38), (w * 0.62, h * 0.82), (w * 0.3, h), (0, h * 0.9)]
    return pts if right else [(-x, z) for x, z in pts]


def o_half_tree(r=0.42, h=1.3, tw=0.05, right=True, n=12):
    cz = h - r * 1.05
    pts = [(0, 0), (tw, 0)]
    a0 = -math.pi / 2 + math.asin(tw / r)
    for i in range(n + 1):
        a = a0 + (math.pi / 2 - a0) * i / n
        m = 1 + (0.08 * math.cos(7 * a + 1.0) if 0 < i < n else 0)
        pts.append((r * m * math.cos(a), cz + r * 1.05 * m * math.sin(a)))
    pts[-1] = (0.0, h)
    return pts if right else [(-x, z) for x, z in pts]


def o_sign():
    return [(-0.016, 0), (0.016, 0), (0.016, 0.25), (0.19, 0.25), (0.235, 0.297), (0.19, 0.345), (0.016, 0.345),
            (0.016, 0.385), (-0.016, 0.385), (-0.016, 0.345), (-0.07, 0.345), (-0.07, 0.25), (-0.016, 0.25)]


def o_fence(w=0.56, h=0.17, n=6):
    pts = [(-w / 2, 0), (w / 2, 0)]
    pw = w / n
    for i in range(n):
        xr = w / 2 - i * pw
        pts += [(xr - pw * 0.08, h * 0.82), (xr - pw * 0.4, h), (xr - pw * 0.72, h * 0.82)]
        if i < n - 1:
            pts += [(xr - pw * 0.72, h * 0.6), (xr - pw * 1.08, h * 0.6)]
    pts[2] = (w / 2, h * 0.82)
    pts[-1] = (-w / 2, h * 0.82)
    return pts


def o_milestone(w=0.1, h=0.15):
    return [(-w / 2, 0), (w / 2, 0), (w / 2, h * 0.7), (w * 0.3, h * 0.94), (0, h), (-w * 0.3, h * 0.94), (-w / 2, h * 0.7)]


def slope_len():
    return math.hypot(HOUSE['w'] / 2, HOUSE['rise'])


# name -> (outline, style, margin)
SHAPES = {
    'tree_round_a': (o_tree_round(0.27, 0.86, phase=0.4), 'tree_round', 0.012),
    'tree_round_b': (o_tree_round(0.32, 1.02, lobes=8, phase=2.0), 'tree_round', 0.012),
    'tree_oval': (o_tree_oval(), 'tree_oval', 0.012),
    'conifer_a': (o_conifer(0.44, 1.08), 'conifer', 0.012),
    'conifer_b': (o_conifer(0.36, 0.88, tiers=3), 'conifer', 0.012),
    'bush_a': (o_bush(0.38, 0.22), 'bush', 0.01),
    'hay': (o_bush(0.3, 0.26, lobes=1), 'hay', 0.01),
    'tuft_a': (o_tuft(0.2, 0.15, 5, 1), 'tuft', 0.006),
    'tuft_b': (o_tuft(0.26, 0.12, 6, 2), 'tuft', 0.006),
    'tuft_c': (o_tuft(0.15, 0.19, 4, 5), 'tuft', 0.006),
    'flower_a': (o_flower(0.24, 0.05), 'flower_a', 0.006),
    'flower_b': (o_flower(0.19, 0.044), 'flower_b', 0.006),
    'reeds_a': (o_reeds(0.14, 0.36, 3), 'reeds', 0.006),
    'reeds_b': (o_reeds(0.17, 0.28, 8), 'reeds', 0.006),
    'rock_r': (o_rock(0.34, 0.26, True), 'rock', 0.01),
    'rock_l': (o_rock(0.27, 0.2, False), 'rock', 0.01),
    'vtree_r': (o_half_tree(right=True), 'vtree', 0.012),
    'vtree_l': (o_half_tree(right=False), 'vtree', 0.012),
    'sign': (o_sign(), 'sign', 0.007),
    'fence': (o_fence(), 'fence', 0.007),
    'milestone': (o_milestone(), 'milestone', 0.007),
    'house_front': (o_gable(False), 'wall_front', 0.012),
    'house_back': (o_gable(True), 'wall_back', 0.012),
    'house_side': (o_rect(-HOUSE['d'] / 2, HOUSE['d'] / 2, 0, HOUSE['h']), 'wall_side', 0.012),
    'house_roof': (o_rect(-HOUSE['d'] / 2 - 0.06, HOUSE['d'] / 2 + 0.06, -0.08, slope_len() + 0.012), 'roof', 0.01),
    'parapet': (o_parapet(), 'parapet', 0.01),
    'hillbig_1': (o_peak(1.5, 1.2, 4), 'hill_peak', 0.014),
    'hillbig_2': (o_hill(1.84, 0.9, 12, jag=0.1, skew=0.12), 'hill_far', 0.014),
    'hillbig_3': (o_hill(1.88, 0.6, 7, skew=-0.15), 'hill_mid', 0.014),
    'hillbig_4': (o_hill(1.6, 0.34, 21), 'hill_near', 0.014),
    'hillsmall_1': (o_hill(1.2, 0.56, 31, skew=0.1), 'hill_far', 0.014),
    'hillsmall_2': (o_hill(1.42, 0.4, 33, skew=-0.1), 'hill_mid', 0.014),
    'hillsmall_3': (o_hill(1.1, 0.24, 35), 'hill_near', 0.014),
    'strut_a': (o_rect(-0.09, 0.09, 0, 0.55 / math.sin(math.radians(60))), 'strut', 0.0),
    'strut_b': (o_rect(-0.09, 0.09, 0, 0.4 / math.sin(math.radians(60))), 'strut', 0.0),
}

# traveller card outlines, in the card plane (x forward, z up), relative to the part's joint
TRAV_T = 0.012
HIP_Z = 0.19
SHOULDER_Z = 0.33


def o_trav_body():
    hc, hr = (0.005, 0.225), 0.065

    def arc(a0, a1, n):
        return [(hc[0] + hr * math.cos(math.radians(a0 + (a1 - a0) * k / n)),
                 hc[1] + hr * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]

    pts = [(-0.075, -0.045), (0.07, -0.045), (0.058, 0.06), (0.056, 0.148), (0.026, 0.158)]
    front = arc(-72, 48, 8)
    front[4] = (front[4][0] + 0.012, front[4][1])
    pts += front
    pts += [(0.125, 0.268), (0.125, 0.283), (0.064, 0.29), (0.058, 0.348), (0.03, 0.362), (0.0, 0.352), (-0.03, 0.362),
            (-0.058, 0.348), (-0.064, 0.29), (-0.12, 0.283), (-0.12, 0.268)]
    pts += arc(132, 212, 5)
    pts += [(-0.11, 0.2), (-0.165, 0.176), (-0.156, 0.157), (-0.105, 0.17), (-0.052, 0.152), (-0.06, 0.145),
            (-0.054, 0.066), (-0.13, 0.066), (-0.14, 0.056), (-0.14, -0.015), (-0.13, -0.025), (-0.071, -0.025)]
    return pts


def o_trav_leg():
    return [(-0.032, 0.02), (0.032, 0.02), (0.028, -0.13), (0.08, -0.146), (0.09, -0.178), (-0.03, -0.178)]


def o_trav_arm():
    pts = [(-0.023, 0.02), (0.023, 0.02), (0.021, -0.105)]
    for i in range(7):
        a = math.pi / 2 * 0.6 - (math.pi * 1.2) * i / 6
        pts.append((0.0 + 0.027 * math.cos(a), -0.125 + 0.027 * math.sin(a)))
    pts.append((-0.021, -0.105))
    return pts


def o_trav_stand(n=14):
    return [(0.19 * math.cos(2 * math.pi * i / n), 0.115 * math.sin(2 * math.pi * i / n)) for i in range(n)]


def o_sheep():
    pts = [(-0.075, 0), (-0.05, 0), (-0.05, 0.045), (0.035, 0.045), (0.035, 0), (0.06, 0), (0.06, 0.05),
           (0.1, 0.07), (0.135, 0.072), (0.142, 0.11), (0.108, 0.136)]
    for i in range(9):
        a = math.radians(25 + 175 * i / 8)
        m = 1 + 0.1 * math.cos(6 * a)
        pts.append((0.1 * m * math.cos(a), 0.105 + 0.062 * m * math.sin(a)))
    pts += [(-0.1, 0.07), (-0.075, 0.05)]
    return pts


SHAPES['sheep'] = (o_sheep(), 'sheep', 0.006)
TRAV_SHAPES = {
    'trav_body': (o_trav_body(), 'trav_body', 0.006),
    'trav_leg': (o_trav_leg(), 'trav_leg', 0.005),
    'trav_arm': (o_trav_arm(), 'trav_arm', 0.005),
    'trav_stand': (o_trav_stand(), 'trav_stand', 0.006),
    'trav_tab': (o_rect(-0.07, 0.07, 0, 0.075), 'strut', 0.0),
}


# ---------------------------------------------------------------- routes printed on the base page

def _arc(a, b, n=64):
    ea, eb = EDGE[a], EDGE[b]
    cx, cy = ea[0] + eb[0], ea[1] + eb[1]
    return [(cx - eb[0] * math.cos(p) - ea[0] * math.sin(p), cy - eb[1] * math.cos(p) - ea[1] * math.sin(p))
            for p in [math.pi / 2 * i / n for i in range(n + 1)]]


def _line(p, q, n=1, meander=0.0):
    pts = []
    L = math.hypot(q[0] - p[0], q[1] - p[1])
    nx, ny = -(q[1] - p[1]) / L, (q[0] - p[0]) / L
    for i in range(n + 1):
        t = i / n
        off = meander * math.sin(2 * math.pi * t) * math.sin(math.pi * t) ** 2
        pts.append((p[0] + (q[0] - p[0]) * t + nx * off, p[1] + (q[1] - p[1]) * t + ny * off))
    return pts


def _lines(sides, end_r, meander=0.0):
    """Polylines for one socket type. Returns (lines, single_end_point_or_None)."""
    k = len(sides)
    if k == 0:
        return [], None
    idx = sorted(ORDER.index(s) for s in sides)
    if k == 1:
        e = EDGE[sides[0]]
        end = (e[0] * end_r, e[1] * end_r)
        return [_line(e, end)], end
    if k == 2:
        a, b = ORDER[idx[0]], ORDER[idx[1]]
        if idx[1] - idx[0] == 2:
            return [_line(EDGE[a], EDGE[b], 32 if meander else 1, meander)], None
        if idx == [0, 3]:
            a, b = b, a
        return [_arc(a, b)], None
    if k == 3:
        missing = [s for s in ORDER if s not in sides][0]
        third = ORDER[(ORDER.index(missing) + 2) % 4]
        pair = [s for s in sides if s != third]
        return [_line(EDGE[pair[0]], EDGE[pair[1]]), _line(EDGE[third], (0.0, 0.0))], None
    return [_line(EDGE['n'], EDGE['s']), _line(EDGE['e'], EDGE['w'])], None


def routes(sockets, opts=None):
    opts = opts or {}
    ps = [s for s in ORDER if sockets[s] == 'p']
    rs = [s for s in ORDER if sockets[s] == 'r']
    mixed = bool(ps) and bool(rs)
    out = dict(path_lines=[], path_blobs=[], river_lines=[], ponds=[])
    p_end = opts.get('path_end_r', 0.62 if mixed else 0.0)
    lines, end = _lines(ps, p_end)
    out['path_lines'] = lines
    if end is not None and opts.get('path_blob', True):
        out['path_blobs'].append((end[0], end[1], 0.27 if mixed else 0.34))
    r_end = 0.62 if mixed else 0.0
    lines, end = _lines(rs, r_end, meander=0.0 if mixed else opts.get('meander', 0.11))
    out['river_lines'] = lines
    if end is not None:
        out['ponds'].append((end[0], end[1], 0.3 if mixed else 0.44))
    if len(rs) == 4:
        out['ponds'].append((0.0, 0.0, 0.52))
    for p in opts.get('ponds', []):
        out['ponds'].append(p)
    return out


def _seg_d(px, py, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - a[0]) * vx + (py - a[1]) * vy) / L2))
    return math.hypot(px - a[0] - vx * t, py - a[1] - vy * t)


def route_clear(rt, x, y):
    """Distance from (x, y) to the nearest printed path or water edge. Negative means inside."""
    d = 9.0
    for ln in rt['path_lines']:
        for i in range(len(ln) - 1):
            d = min(d, _seg_d(x, y, ln[i], ln[i + 1]) - PATH_HW)
    for bx, by, br in rt['path_blobs']:
        d = min(d, math.hypot(x - bx, y - by) - br)
    for ln in rt['river_lines']:
        for i in range(len(ln) - 1):
            d = min(d, _seg_d(x, y, ln[i], ln[i + 1]) - RIVER_HW)
    for bx, by, br in rt['ponds']:
        d = min(d, math.hypot(x - bx, y - by) - br)
    return d


def river_obstacles(rt, step=0.3):
    obs = []
    for ln in rt['river_lines']:
        acc = 0.0
        last = None
        for i in range(len(ln) - 1):
            a, b = ln[i], ln[i + 1]
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            n = max(1, int(math.ceil(L / 0.05)))
            for j in range(n + 1):
                p = (a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n)
                if last is None or math.hypot(p[0] - last[0], p[1] - last[1]) >= step:
                    obs.append((p[0], p[1], RIVER_HW + 0.03))
                    last = p
            acc += L
    for bx, by, br in rt['ponds']:
        obs.append((bx, by, br + 0.03))
    return obs


# ---------------------------------------------------------------- flaps

class Flap:
    def __init__(self, name, shape, scale, pos, rot, fold, parent=None, t=T_CARD, delay=0.3, mass=None, tab=True,
                 shapes=SHAPES):
        base, style, margin = shapes[shape]
        self.name = name
        self.shape = shape
        self.style = style
        self.scale = scale
        self.uv_outline = ccw(base)
        self.outline = scaled(self.uv_outline, scale)
        self.pos = pos
        self.rot = rot
        self.fold = fold
        self.parent = parent
        self.t = t
        self.delay = delay
        self.mass = mass if mass is not None else max(0.5, min(2.0, 0.5 + 2.2 * abs(area(self.outline))))
        self.tab = tab and parent is None
        self.children = []
        self.slab = (0.0, t)
        self.top_y = t
        self.origin = None
        self.m_flat = None
        if parent is not None:
            parent.children.append(self)


_GN = 160
_GEXT = 1.6
_g = (np.arange(_GN) + 0.5) / _GN * 2 * _GEXT - _GEXT
_GX, _GY = np.meshgrid(_g, _g)


def _pip(poly):
    inside = np.zeros(_GX.shape, bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if y0 == y1:
            continue
        cond = (y0 > _GY) != (y1 > _GY)
        xi = x0 + (_GY - y0) * (x1 - x0) / (y1 - y0)
        inside ^= cond & (_GX < xi)
    return inside


def _layer(flaps, tile_id, shifts):
    hm = np.full(_GX.shape, PAGE_TOP)
    warn = []
    for f in flaps:
        if f.parent is None:
            f.origin = Vector((f.pos[0], f.pos[1], 0.0)) + f.rot @ Vector((0.0, shifts.get(f, 0.0), 0.0))
            mp = Matrix.Identity(4)
        else:
            f.origin = Vector((f.pos[0], f.parent.top_y, f.pos[1] + shifts.get(f, 0.0)))
            mp = f.parent.m_flat
        f.m_flat = mp @ Matrix.Translation(f.origin) @ f.rot @ rx(f.fold)
        sig = f.m_flat[2][1]
        if abs(abs(sig) - 1.0) > 1e-4:
            raise RuntimeError(f'{tile_id}/{f.name}: flap does not lie flat (normal z = {sig})')
        sig = 1.0 if sig > 0 else -1.0
        poly = []
        for x, z in f.outline:
            v = f.m_flat @ Vector((x, 0.0, z))
            poly.append((v.x, v.y))
            if max(abs(v.x), abs(v.y)) > 1.0:
                warn.append(f.name)
        mask = _pip(poly)
        if not mask.any():
            cx = sum(p[0] for p in poly) / len(poly)
            cy = sum(p[1] for p in poly) / len(poly)
            mask = (np.abs(_GX - cx) < 0.03) & (np.abs(_GY - cy) < 0.03)
        m = mask.copy()
        m[1:, :] |= mask[:-1, :]
        m[:-1, :] |= mask[1:, :]
        m[:, 1:] |= mask[:, :-1]
        m[:, :-1] |= mask[:, 1:]
        h = float(hm[m].max()) + GAP
        oh = f.m_flat.translation.z
        y0, y1 = sig * (h - oh), sig * (h + f.t - oh)
        f.slab = (min(y0, y1), max(y0, y1))
        f.near_y = y0
        f.top_y = y1
        f.sigma = sig
        hm[m] = h + f.t
    return float(hm.max()), warn


def finalize(flaps, tile_id=''):
    """Give every flap a slab offset so the fully folded tile is a clean stack with no z-fighting.

    The hinge of each flap is then moved by that offset, so the popped card stands exactly on its design line.
    """
    shifts = {}
    top, warn = 0.0, []
    for _ in range(3):
        top, warn = _layer(flaps, tile_id, shifts)
        for f in flaps:
            if f.parent is None:
                shifts[f] = -f.near_y
            else:
                # Normal of the child card in the parent frame is (0, cos(tilt), sin(tilt)).
                ny, nz = f.rot[1][1], f.rot[2][1]
                if abs(nz) > 0.25:
                    shifts[f] = -(f.near_y + ny * (f.parent.top_y - f.parent.near_y)) / nz
    top, warn = _layer(flaps, tile_id, shifts)
    if warn:
        print(f'  WARN {tile_id}: flat footprint leaves the tile: {sorted(set(warn))}')
    return top


def card_mesh(outline, uv_outline, ya, yb, uvmap, core_uv, rnd, fibre_scale=0.5):
    """Extruded card in local XZ, slab from ya to yb along Y. Returns pos, nor, uv0, uv1, idx arrays."""
    n = len(outline)
    tris = tessellate_polygon([[Vector((x, z, 0.0)) for x, z in outline]])
    pos, nor, uv0, uv1, idx = [], [], [], [], []
    ox, oz = rnd.random(), rnd.random()
    for y, ny in ((ya, -1.0), (yb, 1.0)):
        base = len(pos)
        for (x, z), (ux, uz) in zip(outline, uv_outline):
            pos.append((x, y, z))
            nor.append((0.0, ny, 0.0))
            uv0.append(uvmap(ux, uz))
            uv1.append((x * fibre_scale + ox, z * fibre_scale + oz))
        for a, b, c in tris:
            pa, pb, pc = outline[a], outline[b], outline[c]
            cr = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            # In XZ, a counter-clockwise triangle has its normal along -Y.
            flip = (cr > 0) != (ny < 0)
            idx += [base + a, base + c, base + b] if flip else [base + a, base + b, base + c]
    s = 0.0
    cu0, cv0, cu1, cv1 = core_uv
    for i in range(n):
        (x0, z0), (x1, z1) = outline[i], outline[(i + 1) % n]
        L = math.hypot(x1 - x0, z1 - z0)
        if L < 1e-9:
            continue
        nx, nz = (z1 - z0) / L, -(x1 - x0) / L
        base = len(pos)
        f0 = rnd.random() * 0.5
        f1 = min(1.0, f0 + L / 0.4)
        for (x, z, y, fu, fv) in ((x0, z0, ya, f0, 0.0), (x1, z1, ya, f1, 0.0), (x1, z1, yb, f1, 1.0), (x0, z0, yb, f0, 1.0)):
            pos.append((x, y, z))
            nor.append((nx, 0.0, nz))
            uv0.append((cu0 + (cu1 - cu0) * fu, cv0 + (cv1 - cv0) * fv))
            uv1.append(((s + (L if fu == f1 else 0.0)) * fibre_scale, y * fibre_scale + fv * 0.01))
        # Outward winding: the normal must equal cross(p1 - p0, p3 - p0).
        e1 = (x1 - x0, 0.0, z1 - z0)
        e2 = (0.0, yb - ya, 0.0)
        cx_ = e1[1] * e2[2] - e1[2] * e2[1]
        cz_ = e1[0] * e2[1] - e1[1] * e2[0]
        if cx_ * nx + cz_ * nz > 0:
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
        else:
            idx += [base, base + 2, base + 1, base, base + 3, base + 2]
        s += L
    return (np.array(pos, np.float32), np.array(nor, np.float32), np.array(uv0, np.float32),
            np.array(uv1, np.float32), np.array(idx, np.uint32))


def transform_mesh(mesh, m):
    pos, nor, uv0, uv1, idx = mesh
    m3 = np.array(m.to_3x3(), np.float32)
    t = np.array(m.translation, np.float32)
    return (pos @ m3.T + t, nor @ m3.T, uv0, uv1, idx)


def merge_meshes(meshes):
    pos, nor, uv0, uv1, idx = [], [], [], [], []
    off = 0
    for p, n, a, b, i in meshes:
        pos.append(p)
        nor.append(n)
        uv0.append(a)
        uv1.append(b)
        idx.append(i + off)
        off += len(p)
    return (np.concatenate(pos), np.concatenate(nor), np.concatenate(uv0), np.concatenate(uv1), np.concatenate(idx))
