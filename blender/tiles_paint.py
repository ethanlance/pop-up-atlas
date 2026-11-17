"""Procedural printed-paper art for Pop-up Atlas: base pages, flap art, atlas packing, fibre normal map."""
import math
import random
import zlib

import numpy as np

import tiles_geom as G


def hexc(h):
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (1, 3, 5)])


PALETTE = {
    'page': '#EFE3C6', 'core': '#FAF4E4', 'ochre': '#D9A441', 'terracotta': '#C4623F',
    'moss': '#6F8448', 'sage': '#A9B58A', 'teal': '#5E9A9A', 'brown': '#6B4A32',
}
PAGE, CORE, OCHRE, TERRA, MOSS, SAGE, TEAL, BROWN = (hexc(PALETTE[k]) for k in
                                                    ('page', 'core', 'ochre', 'terracotta', 'moss', 'sage', 'teal', 'brown'))
INK = BROWN * 0.62


def mix(a, b, t):
    return a + (b - a) * t


def crc(s):
    return zlib.crc32(s.encode()) & 0x7fffffff


def fnoise(h, w, sigma, seed):
    """Periodic smooth noise with unit standard deviation."""
    rs = np.random.RandomState(seed)
    f = np.fft.rfft2(rs.standard_normal((h, w)))
    ky = np.fft.fftfreq(h)[:, None]
    kx = np.fft.rfftfreq(w)[None, :]
    f *= np.exp(-2 * (math.pi * sigma) ** 2 * (kx * kx + ky * ky))
    out = np.fft.irfft2(f, s=(h, w))
    return out / max(out.std(), 1e-9)


def paper(h, w, seed):
    return 0.5 * fnoise(h, w, 0.7, seed) + 0.45 * fnoise(h, w, 2.5, seed + 1) + 0.5 * fnoise(h, w, 11.0, seed + 2)


def sstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def seg_dist(X, Y, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    L2 = vx * vx + vy * vy
    if L2 < 1e-12:
        return np.hypot(X - a[0], Y - a[1]), np.zeros_like(X)
    t = np.clip(((X - a[0]) * vx + (Y - a[1]) * vy) / L2, 0, 1)
    return np.hypot(X - a[0] - vx * t, Y - a[1] - vy * t), t


def line_field(X, Y, pts):
    """Unsigned distance, arc length at the nearest point, and signed side for a polyline."""
    d = np.full(X.shape, 9.0)
    s = np.zeros(X.shape)
    side = np.ones(X.shape)
    acc = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        di, t = seg_dist(X, Y, a, b)
        m = di < d
        d = np.where(m, di, d)
        s = np.where(m, acc + t * L, s)
        cr = (b[0] - a[0]) * (Y - a[1]) - (b[1] - a[1]) * (X - a[0])
        side = np.where(m, np.where(cr >= 0, 1.0, -1.0), side)
        acc += L
    return d, s, side, acc


def poly_sdf(X, Y, pts):
    """Signed distance to a polygon outline, positive inside."""
    d = np.full(X.shape, 9.0)
    inside = np.zeros(X.shape, bool)
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        di, _ = seg_dist(X, Y, a, b)
        d = np.minimum(d, di)
        if a[1] != b[1]:
            cond = (a[1] > Y) != (b[1] > Y)
            xi = a[0] + (Y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            inside ^= cond & (X < xi)
    return np.where(inside, d, -d)


class Canvas:
    def __init__(self, w, h, x0, ytop, ppu, bg):
        self.w, self.h, self.x0, self.ytop, self.ppu = w, h, x0, ytop, ppu
        self.px = 1.0 / ppu
        xs = x0 + (np.arange(w) + 0.5) / ppu
        ys = ytop - (np.arange(h) + 0.5) / ppu
        self.X, self.Y = np.meshgrid(xs, ys)
        self.img = np.empty((h, w, 3))
        self.img[:] = bg

    def cov(self, d, w=0.0):
        return np.clip((w - d) / self.px + 0.5, 0, 1)

    def blend(self, a, col):
        self.img += (np.asarray(col) - self.img) * a[..., None]

    def _win(self, xa, xb, ya, yb, pad):
        i0 = max(0, int((xa - pad - self.x0) * self.ppu))
        i1 = min(self.w, int((xb + pad - self.x0) * self.ppu) + 2)
        j0 = max(0, int((self.ytop - yb - pad) * self.ppu))
        j1 = min(self.h, int((self.ytop - ya + pad) * self.ppu) + 2)
        return slice(j0, j1), slice(i0, i1)

    def _apply(self, sl, a, col):
        sub = self.img[sl]
        sub += (np.asarray(col) - sub) * a[..., None]

    def seg(self, p, q, w, col, a=1.0):
        sl = self._win(min(p[0], q[0]), max(p[0], q[0]), min(p[1], q[1]), max(p[1], q[1]), w + 2 * self.px)
        if self.X[sl].size == 0:
            return
        d, _ = seg_dist(self.X[sl], self.Y[sl], p, q)
        self._apply(sl, self.cov(d, w / 2) * a, col)

    def line(self, pts, w, col, a=1.0, closed=False):
        n = len(pts)
        for i in range(n if closed else n - 1):
            self.seg(pts[i], pts[(i + 1) % n], w, col, a)

    def disc(self, c, r, col, a=1.0):
        sl = self._win(c[0] - r, c[0] + r, c[1] - r, c[1] + r, 2 * self.px)
        if self.X[sl].size == 0:
            return
        d = np.hypot(self.X[sl] - c[0], self.Y[sl] - c[1])
        self._apply(sl, self.cov(d, r) * a, col)

    def ring(self, c, r, w, col, a=1.0):
        sl = self._win(c[0] - r, c[0] + r, c[1] - r, c[1] + r, w + 2 * self.px)
        if self.X[sl].size == 0:
            return
        d = np.abs(np.hypot(self.X[sl] - c[0], self.Y[sl] - c[1]) - r)
        self._apply(sl, self.cov(d, w / 2) * a, col)

    def poly(self, pts, col, a=1.0, outline=None, ow=0.006):
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        sl = self._win(min(xs), max(xs), min(ys), max(ys), 3 * self.px)
        if self.X[sl].size == 0:
            return
        sd = poly_sdf(self.X[sl], self.Y[sl], pts)
        self._apply(sl, self.cov(-sd, 0.0) * a, col)
        if outline is not None:
            self._apply(sl, self.cov(np.abs(sd), ow / 2) * a, outline)

    def rect(self, x0, x1, y0, y1, col, a=1.0, outline=None, ow=0.006):
        self.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], col, a, outline, ow)


# ---------------------------------------------------------------- base pages

def _union_field(c, lines, blobs, hw):
    X, Y = c.X, c.Y
    sdf = np.full(X.shape, 9.0)
    s = np.zeros(X.shape)
    lat = np.zeros(X.shape)
    period = np.ones(X.shape)
    is_blob = np.zeros(X.shape, bool)
    for ln in lines:
        d, si, side, L = line_field(X, Y, ln)
        m = (d - hw) < sdf
        sdf = np.where(m, d - hw, sdf)
        s = np.where(m, si, s)
        lat = np.where(m, d * side, lat)
        period = np.where(m, L / max(1, round(L / 0.15)), period)
    for bx, by, br in blobs:
        rr = np.hypot(X - bx, Y - by)
        m = (rr - br) < sdf
        sdf = np.where(m, rr - br, sdf)
        circ = 2 * math.pi * br
        s = np.where(m, (np.arctan2(Y - by, X - bx) + math.pi) * br, s)
        lat = np.where(m, rr, lat)
        period = np.where(m, circ / max(1, round(circ / 0.15)), period)
        is_blob |= m
    return sdf, s, lat, period, is_blob


def _tick(c, x, y, rnd, col, a=0.8):
    for k in range(3):
        ang = math.radians(90 + (k - 1) * 28 + rnd.uniform(-8, 8))
        ln = rnd.uniform(0.045, 0.07)
        c.seg((x + (k - 1) * 0.012, y), (x + (k - 1) * 0.012 + ln * math.cos(ang), y + ln * math.sin(ang)), 0.011, col, a)


def paint_base(t, n):
    """Printed base page for one tile, n x n pixels, row 0 = north edge."""
    c = Canvas(n, n, -1.0, 1.0, n / 2.0, PAGE)
    X, Y = c.X, c.Y
    seed = crc(t.page_key)
    rnd = random.Random(seed)
    border = np.minimum(1 - np.abs(X), 1 - np.abs(Y))
    winb = sstep((border - 0.045) / 0.07)
    rt = t.routes

    # paths
    psdf, ps, plat, pper, pblob = _union_field(c, rt['path_lines'], rt['path_blobs'], G.PATH_HW)
    wsdf, ws, wlat, wper, wblob = _union_field(c, rt['river_lines'], rt['ponds'], G.RIVER_HW)
    if rt['path_lines'] or rt['path_blobs']:
        pathc = mix(PAGE, OCHRE, 0.4)
        c.blend(c.cov(psdf, 0.0), pathc)
        grav = fnoise(n, n, 0.8, 77)
        c.blend(c.cov(psdf, -0.02) * np.clip(grav - 1.1, 0, 1) * 0.5 * winb, BROWN)
        rut = c.cov(np.abs(np.abs(plat) - 0.09), 0.004) * (~pblob) * c.cov(psdf, -0.03)
        c.blend(rut * 0.22, BROWN)
        dash = np.clip((np.cos(2 * math.pi * ps / pper) + 0.15) * 5 + 0.5, 0, 1)
        c.blend(c.cov(np.abs(psdf), 0.0075) * dash * 0.9, INK)
    if rt['river_lines'] or rt['ponds']:
        bank = np.clip(1 - wsdf / 0.07, 0, 1) * (wsdf > 0)
        c.blend(bank * 0.38, SAGE)
        water = mix(PAGE, TEAL, 0.74)
        c.blend(c.cov(wsdf, 0.0), water)
        c.blend(c.cov(wsdf, 0.0) * np.clip(-wsdf / 0.35, 0, 1) * 0.16, CORE)
        inner = c.cov(wsdf, -0.05) * winb
        for k, lane in enumerate((-0.22, -0.075, 0.075, 0.22)):
            wav = 0.017 * np.sin(2 * math.pi * ws / 0.15 + k * 1.7)
            gate = sstep((0.42 - np.abs(((ws / 0.46 + k * 0.37) % 1.0) - 0.5) * 2) * 6)
            mark = c.cov(np.abs(wlat - lane - wav), 0.005) * gate * inner * (~wblob)
            c.blend(mark * (0.8 if k % 2 == 0 else 0.55), CORE if k % 2 == 0 else TEAL * 0.62)
        for bx, by, br in rt['ponds']:
            rr = np.hypot(X - bx, Y - by)
            th = np.arctan2(Y - by, X - bx)
            for k in range(1, 4):
                gate = sstep((np.sin(3 * th + k * 2.1) - 0.1) * 4)
                mark = c.cov(np.abs(rr - br * (0.22 + 0.2 * k)), 0.005) * gate * (rr < br - 0.05) * inner
                c.blend(mark * 0.7, CORE if k % 2 else TEAL * 0.62)
        c.blend(c.cov(np.abs(wsdf), 0.009) * 0.9, TEAL * 0.55)
    common = c.img.copy()

    # tile-specific prints (kept away from the border so every edge stays identical)
    grass_ink = mix(SAGE, MOSS, 0.55)

    def free(x, y, need_p=0.05, need_w=0.08):
        j = min(n - 1, max(0, int((1 - y) / 2 * n)))
        i = min(n - 1, max(0, int((x + 1) / 2 * n)))
        return psdf[j, i] > need_p and wsdf[j, i] > need_w

    tint = sstep((fnoise(n, n, 14.0, seed % 997 + 21) - 0.25) * 1.4) * (psdf > 0.04) * (wsdf > 0.08)
    c.blend(tint * 0.2, SAGE)
    for p in t.prints:
        kind = p['t']
        if kind == 'contour':
            f = np.zeros(X.shape)
            for bx, by, brx, bry, bh in p['bumps']:
                f += bh * np.exp(-((X - bx) / brx) ** 2 - ((Y - by) / bry) ** 2)
            gy, gx = np.gradient(f, c.px)
            g = np.hypot(gx, gy) + 1e-6
            c.blend(np.clip(f - 0.12, 0, 1) * 0.22, SAGE)
            levels = np.linspace(0.14, 0.92 * f.max(), p['levels'])
            for k, lv in enumerate(levels):
                w = 0.0075 if k % 3 == 0 else 0.0045
                c.blend(c.cov(np.abs(f - lv) / g, w) * (0.75 if k % 3 == 0 else 0.55), mix(BROWN, MOSS, 0.35))
        elif kind == 'forest':
            f = fnoise(n, n, 16.0, seed + 5)
            c.blend(sstep((f + 0.6) * 0.9) * 0.2, SAGE)
            for _ in range(22):
                x, y = rnd.uniform(-0.86, 0.86), rnd.uniform(-0.86, 0.86)
                c.seg((x, y), (x, y + 0.03), 0.008, BROWN, 0.6)
                c.ring((x, y + 0.055), 0.026, 0.008, MOSS, 0.75)
        elif kind == 'shade':
            rr = np.hypot(X - p['x'], (Y - p['y']) * 1.3)
            c.blend(np.clip(1 - rr / p['r'], 0, 1) ** 1.5 * 0.4, SAGE)
            for k in range(14):
                a = 2 * math.pi * k / 14
                r0, r1 = p['r'] * 0.45, p['r'] * rnd.uniform(0.6, 0.78)
                c.seg((p['x'] + r0 * math.cos(a), p['y'] + r0 * math.sin(a) / 1.3),
                      (p['x'] + r1 * math.cos(a), p['y'] + r1 * math.sin(a) / 1.3), 0.006, MOSS, 0.4)
        elif kind == 'compass':
            cx, cy, r = p['x'], p['y'], p['r']
            c.ring((cx, cy), r, 0.006, INK, 0.5)
            c.ring((cx, cy), r * 0.72, 0.004, INK, 0.35)
            for k in range(16):
                a = math.pi / 8 * k
                r1 = r * (1.18 if k % 4 == 0 else 0.7 if k % 2 == 0 else 0.4)
                c.seg((cx, cy), (cx + r1 * math.cos(a), cy + r1 * math.sin(a)), 0.005, INK, 0.5)
            for k in range(4):
                a = math.pi / 2 * k
                tip = (cx + r * 1.18 * math.cos(a), cy + r * 1.18 * math.sin(a))
                l = (cx + r * 0.16 * math.cos(a + math.pi / 2), cy + r * 0.16 * math.sin(a + math.pi / 2))
                c.poly([tip, l, (cx, cy)], TERRA if k == 1 else INK, 0.55)
            c.disc((cx, cy), 0.016, PAGE)
        elif kind == 'survey':
            a, b = (-0.82, -0.55), (0.74, 0.78)
            for k in range(30):
                u0, u1 = k / 30, (k + 0.5) / 30
                c.seg((a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0),
                      (a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1), 0.005, TERRA, 0.55)
            for (x, y) in ((-0.3, -0.105), (0.42, 0.51)):
                c.poly([(x - 0.04, y - 0.03), (x + 0.04, y - 0.03), (x, y + 0.045)], PAGE, 1.0, INK, 0.007)
                c.disc((x, y - 0.006), 0.008, INK, 0.8)
        elif kind == 'house':
            r = G.rz(p['heading'])
            hw_, hd_ = p['w'] / 2 + 0.05, p['d'] / 2 + 0.05
            pts = []
            for lx, ly in ((-hw_, -hd_), (hw_, -hd_), (hw_, hd_), (-hw_, hd_)):
                v = r @ G.Vector((lx, ly, 0.0))
                pts.append((p['x'] + v.x, p['y'] + v.y))
            c.poly(pts, mix(PAGE, BROWN, 0.2), 1.0, INK, 0.007)
            for k in range(1, 6):
                u = k / 6
                a0 = (pts[0][0] + (pts[3][0] - pts[0][0]) * u, pts[0][1] + (pts[3][1] - pts[0][1]) * u)
                a1 = (pts[1][0] + (pts[2][0] - pts[1][0]) * u, pts[1][1] + (pts[2][1] - pts[1][1]) * u)
                c.seg(a0, a1, 0.004, INK, 0.3)
        elif kind == 'yard':
            x0, x1, y0, y1 = p['x0'], p['x1'], p['y0'], p['y1']
            per = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            for i in range(4):
                a, b = per[i], per[(i + 1) % 4]
                m = 22
                for k in range(m):
                    u0, u1 = k / m, (k + 0.55) / m
                    c.seg((a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0),
                          (a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1), 0.006, INK, 0.45)
            for row in range(5):
                yy = -0.2 + row * 0.085
                for k in range(6):
                    xx = -0.8 + k * 0.045
                    c.seg((xx, yy), (xx + 0.02, yy + 0.03), 0.01, MOSS, 0.7)
                c.seg((-0.82, yy - 0.012), (-0.54, yy - 0.012), 0.004, BROWN, 0.4)
        elif kind == 'lanes':
            for ln in p['pts']:
                d, s, side, L = line_field(X, Y, ln)
                c.blend(c.cov(d, 0.075), mix(PAGE, OCHRE, 0.4))
            for ln in p['pts']:
                d, s, side, L = line_field(X, Y, ln)
                c.blend(c.cov(np.abs(d - 0.075), 0.004) * 0.0, INK)
        elif kind == 'scree':
            for _ in range(30):
                a, r = rnd.uniform(0, 6.28), rnd.uniform(0.25, 0.7)
                x, y = p['x'] + r * math.cos(a), p['y'] + r * math.sin(a) * 0.8
                if max(abs(x), abs(y)) < 0.86:
                    c.disc((x, y), rnd.uniform(0.008, 0.02), mix(PAGE, BROWN, 0.45), 0.8)
        elif kind == 'deck':
            x0, x1, hw_ = p['x0'], p['x1'], p['hw']
            c.rect(x0, x1, -hw_, hw_, mix(OCHRE, BROWN, 0.45), 1.0, INK, 0.008)
            k = x0 + 0.065
            while k < x1 - 0.02:
                c.seg((k, -hw_), (k, hw_), 0.005, INK, 0.55)
                k += 0.065
            for sy in (-1, 1):
                c.seg((x0, sy * (hw_ - 0.035)), (x1, sy * (hw_ - 0.035)), 0.006, INK, 0.5)

    # scattered map marks
    made = 0
    for _ in range(300):
        if made >= 34:
            break
        x, y = rnd.uniform(-0.88, 0.88), rnd.uniform(-0.88, 0.88)
        if not free(x, y):
            continue
        made += 1
        if made % 7 == 0:
            for k in range(3):
                c.disc((x + 0.03 * math.cos(k * 2.1), y + 0.03 * math.sin(k * 2.1)), 0.008, mix(OCHRE, BROWN, 0.4), 0.6)
        elif made % 11 == 0:
            c.seg((x - 0.022, y), (x + 0.022, y), 0.005, INK, 0.45)
            c.seg((x, y - 0.022), (x, y + 0.022), 0.005, INK, 0.45)
        else:
            _tick(c, x, y, rnd, grass_ink)

    # glue-tab seat marks under each hinge
    img = common + (c.img - common) * winb[..., None]

    # paper mottle, faded to nothing at the border, then the graticule
    m = paper(n, n, seed % 1000 + 3)
    blot = np.clip(fnoise(n, n, 22.0, seed % 1000 + 9), -1.5, 1.5)
    win = sstep(border / 0.1)
    img *= 1 + (0.028 * m + 0.02 * blot)[..., None] * win[..., None]
    c.img = img
    c.blend(c.cov(border, 0.0055) * 0.42, INK)
    for q in (-0.5, 0.5):
        tick = (c.cov(np.abs(X - q), 0.004) * (np.abs(Y) > 0.94) + c.cov(np.abs(Y - q), 0.004) * (np.abs(X) > 0.94))
        c.blend(np.clip(tick, 0, 1) * 0.4, INK)
    for q in (-0.75, -0.25, 0.25, 0.75):
        tick = (c.cov(np.abs(X - q), 0.003) * (np.abs(Y) > 0.972) + c.cov(np.abs(Y - q), 0.003) * (np.abs(X) > 0.972))
        c.blend(np.clip(tick, 0, 1) * 0.35, INK)
    return np.clip(c.img, 0, 1)


# ---------------------------------------------------------------- flap art

def _bbox(o):
    xs, zs = [p[0] for p in o], [p[1] for p in o]
    return min(xs), max(xs), min(zs), max(zs)


def _shade(c, cx, cz, r):
    return np.clip(0.5 + 0.55 * (-(c.X - cx) + (c.Y - cz)) / (2 * r), 0, 1)


def _leaves(c, D, rnd, n, dark, light, size=0.03, zmin=-9.0):
    x0, x1, z0, z1 = c.X.min(), c.X.max(), c.Y.min(), c.Y.max()
    for k in range(n):
        x, z = rnd.uniform(x0, x1), rnd.uniform(max(z0, zmin), z1)
        a = rnd.uniform(-0.6, 0.6)
        s = size * rnd.uniform(0.7, 1.2)
        col, al = (dark, 0.55) if k % 3 else (light, 0.6)
        c.seg((x - s * math.cos(a), z + s * 0.5), (x, z - s * 0.2), 0.008, col, al)
        c.seg((x, z - s * 0.2), (x + s * math.cos(a), z + s * 0.5), 0.008, col, al)


def st_foliage(c, D, o, rnd, base=MOSS, trunk=True, berries=None, n_leaf=None, spine=False):
    x0, x1, z0, z1 = _bbox(o)
    wide = [z for x, z in o if abs(x) > 0.07]
    zb = min(wide) if (wide and trunk) else z0
    cx, cz, r = (x0 + x1) / 2, (zb + z1) / 2, max(x1 - x0, z1 - zb) / 2
    s = _shade(c, cx, cz, r)
    light, dark = mix(base, SAGE, 0.5), mix(base, BROWN, 0.3)
    c.img[:] = mix(dark, light, s[..., None])
    if n_leaf is None:
        n_leaf = int(260 * (x1 - x0) * (z1 - zb))
    _leaves(c, D, rnd, n_leaf, mix(base, BROWN, 0.55), mix(SAGE, CORE, 0.3), zmin=zb)
    if berries is not None:
        for _ in range(int(60 * (x1 - x0) * (z1 - zb))):
            c.disc((rnd.uniform(x0, x1), rnd.uniform(zb + 0.03, z1)), 0.014, berries, 0.9)
    if trunk:
        tm = c.cov(np.abs(c.X - (0 if not spine else 0)), 0.045 if not spine else 0.06) * c.cov(c.Y, zb + 0.015)
        c.blend(tm, mix(BROWN, OCHRE, 0.15))
        top = zb + (z1 - zb) * 0.55
        c.seg((0, zb), (0, top), 0.016, BROWN, 0.8)
        for sgn, f in ((1, 0.25), (-1, 0.42), (1, 0.6)):
            zz = zb + (top - zb) * f
            c.seg((0, zz), (sgn * (x1 - x0) * 0.22, zz + (z1 - zb) * 0.16), 0.011, BROWN, 0.75)
        c.seg((-0.015, z0), (-0.015, zb), 0.005, INK, 0.5)
    if spine:
        for k in range(24):
            zz = z0 + (z1 - z0) * k / 24
            c.seg((0.012 * (1 if x1 > 0.1 else -1), zz), (0.012 * (1 if x1 > 0.1 else -1), zz + (z1 - z0) / 48), 0.004, INK, 0.4)


def st_conifer(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    th = sorted(set(round(z, 4) for x, z in o))[1]
    base = mix(MOSS, TEAL, 0.38) * 0.92
    tiers = 4 if z1 > 1.0 else 3
    step = (z1 - th) / tiers
    fr = ((c.Y - th) / step) % 1.0
    c.img[:] = mix(mix(base, BROWN, 0.35), mix(base, SAGE, 0.35), np.clip(fr * 1.2, 0, 1)[..., None])
    c.blend(np.clip(0.4 - c.X / (x1 - x0) * 1.2, 0, 0.5) * 0.5, mix(SAGE, CORE, 0.2))
    for k in range(int(120 * (x1 - x0) * (z1 - z0))):
        x, z = rnd.uniform(x0, x1), rnd.uniform(th, z1)
        c.seg((x, z), (x + rnd.uniform(-0.012, 0.012), z - 0.035), 0.006, mix(base, BROWN, 0.6), 0.5)
    c.blend(c.cov(c.Y, th + 0.004), mix(BROWN, OCHRE, 0.15))


def st_hay(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(mix(OCHRE, BROWN, 0.25), mix(OCHRE, CORE, 0.3), np.clip(c.Y / z1, 0, 1)[..., None])
    for k in range(60):
        x, z = rnd.uniform(x0, x1), rnd.uniform(z0, z1)
        c.seg((x, z), (x + rnd.uniform(-0.02, 0.02), z + 0.05), 0.006, BROWN if k % 2 else CORE, 0.45)
    c.seg((x0, z1 * 0.45), (x1, z1 * 0.45), 0.008, BROWN, 0.5)


def st_tuft(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(mix(MOSS, BROWN, 0.12), mix(SAGE, OCHRE, 0.15), np.clip(c.Y / z1, 0, 1)[..., None] ** 1.2)
    for k in range(8):
        x = x0 + (x1 - x0) * (k + 0.5) / 8
        c.seg((x, 0), (x + (x - (x0 + x1) / 2) * 0.35, z1 * 0.7), 0.006, mix(MOSS, BROWN, 0.5), 0.45)


def st_flower(c, D, o, rnd, petal=OCHRE):
    x0, x1, z0, z1 = _bbox(o)
    heads = [z for x, z in o if z > z1 * 0.6]
    r = (max(heads) - min(heads)) / 2
    hc = (0.0, z1 - r)
    c.img[:] = mix(MOSS, SAGE, 0.25)
    c.seg((0, 0), (0, z1 - 2 * r), 0.005, mix(MOSS, BROWN, 0.5), 0.6)
    rr = np.hypot(c.X - hc[0], c.Y - hc[1])
    c.blend(c.cov(rr, r * 1.35), petal)
    th = np.arctan2(c.Y - hc[1], c.X - hc[0])
    c.blend(c.cov(rr, r * 1.35) * sstep((np.abs(np.sin(3 * th)) - 0.85) * 12) * 0.5, mix(petal, BROWN, 0.5))
    c.disc(hc, r * 0.38, mix(BROWN, OCHRE, 0.3))
    c.disc(hc, r * 0.16, CORE, 0.7)


def st_reeds(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(mix(MOSS, TEAL, 0.25), mix(SAGE, OCHRE, 0.2), np.clip(c.Y / z1, 0, 1)[..., None])
    tips = sorted([p for p in o if p[1] > z1 * 0.5], key=lambda p: -p[1])[:2]
    for x, z in tips:
        c.seg((x * 0.86, z * 0.62), (x * 0.95, z * 0.9), 0.03, BROWN, 0.95)


def st_hill(c, D, o, rnd, base=MOSS, light=SAGE, trees=6, snow=False, ink=None):
    x0, x1, z0, z1 = _bbox(o)
    ink = ink if ink is not None else mix(base, BROWN, 0.6)
    g = np.clip(c.Y / z1, 0, 1)
    c.img[:] = mix(mix(base, BROWN, 0.1), mix(base, light, 0.75), g[..., None] ** 0.8)
    c.blend(np.clip(-c.X / (x1 - x0) + 0.1, 0, 0.5) * 0.35, mix(light, CORE, 0.3))
    if snow:
        tri = np.abs(((c.X * 9.0) % 1.0) - 0.5) * 2
        line = z1 * (0.66 + 0.1 * tri)
        c.blend(c.cov(line - c.Y, 0.0), CORE)
        c.blend(c.cov(np.abs(line - c.Y), 0.004) * 0.5, TEAL * 0.7)
        for x, z in o:
            if z > z1 * 0.25:
                c.seg((x, z), (x + 0.07, z - z1 * 0.3), 0.006, ink, 0.5)
                c.seg((x, z), (x - 0.1, z - z1 * 0.42), 0.005, ink, 0.35)
                for k in range(6):
                    zz = z - 0.05 - k * 0.045
                    c.seg((x + 0.02 + k * 0.012, zz), (x + 0.06 + k * 0.016, zz - 0.03), 0.005, TEAL * 0.75, 0.45)
    per = 0.07
    fr = np.abs(((D - 0.05) % per) - per / 2)
    fade = np.clip(1 - D / 0.42, 0, 1) * np.clip(c.Y / 0.08, 0, 1) * (D > 0.03)
    c.blend(c.cov(per / 2 - fr, 0.0035) * fade * 0.6, ink)
    for _ in range(trees):
        for _try in range(30):
            x, z = rnd.uniform(x0 + 0.1, x1 - 0.1), rnd.uniform(0.03, z1 * 0.5)
            j, i = int((c.ytop - z) * c.ppu), int((x - c.x0) * c.ppu)
            if 0 <= j < c.h and 0 <= i < c.w and D[j, i] > 0.09:
                s = rnd.uniform(0.8, 1.2)
                c.seg((x, z), (x, z + 0.03 * s), 0.007, BROWN, 0.8)
                c.poly([(x - 0.03 * s, z + 0.025 * s), (x + 0.03 * s, z + 0.025 * s), (x, z + 0.1 * s)],
                       mix(MOSS, BROWN, 0.35), 0.85)
                break


def _window(c, x0, x1, z0, z1, arch=False):
    c.rect(x0 - 0.012, x1 + 0.012, z0 - 0.012, z1 + 0.012, CORE, 1.0, INK, 0.006)
    c.rect(x0, x1, z0, z1, mix(TEAL, BROWN, 0.3), 1.0)
    c.poly([(x0, z0), (x1, z1), (x1, z1 - 0.03), (x0 + 0.03, z0)], mix(TEAL, CORE, 0.45), 0.6)
    c.seg(((x0 + x1) / 2, z0), ((x0 + x1) / 2, z1), 0.009, CORE)
    c.seg((x0, (z0 + z1) / 2), (x1, (z0 + z1) / 2), 0.009, CORE)
    c.rect(x0 - 0.02, x1 + 0.02, z0 - 0.03, z0 - 0.012, TERRA, 1.0, INK, 0.004)


def _wall(c, rnd, h, x0, x1):
    c.img[:] = mix(CORE, OCHRE, 0.16)
    c.blend(np.clip(0.3 - c.Y / h * 0.3, 0, 0.3), mix(OCHRE, TERRA, 0.3))
    for k in range(26):
        x, z = rnd.uniform(x0, x1), rnd.uniform(0.02, h * 1.7)
        c.seg((x, z), (x + 0.03, z), 0.004, INK, 0.2)
    c.blend(c.cov(c.Y, 0.05), mix(BROWN, TERRA, 0.3))
    c.seg((x0, 0.05), (x1, 0.05), 0.006, INK, 0.7)


def st_wall_front(c, D, o, rnd):
    w, h, rise = G.HOUSE['w'], G.HOUSE['h'], G.HOUSE['rise']
    _wall(c, rnd, h, -w / 2, w / 2)
    c.seg((-w / 2, h), (w / 2, h), 0.022, BROWN, 0.9)
    for sx in (-1, 1):
        c.seg((sx * (w / 2 - 0.03), 0.05), (sx * (w / 2 - 0.03), h), 0.02, BROWN, 0.9)
        c.seg((sx * w / 2, h), (0, h + rise), 0.05, BROWN, 0.9)
        c.seg((sx * 0.12, h), (0, h + rise * 0.55), 0.014, BROWN, 0.8)
    c.rect(-0.105, 0.105, 0.0, 0.34, BROWN, 1.0, INK, 0.007)
    c.rect(-0.08, 0.08, 0.02, 0.31, mix(TERRA, BROWN, 0.35), 1.0, INK, 0.005)
    for k in range(1, 4):
        c.seg((-0.08 + 0.04 * k, 0.02), (-0.08 + 0.04 * k, 0.31), 0.004, INK, 0.5)
    c.disc((0.05, 0.16), 0.013, OCHRE)
    c.rect(-0.14, 0.14, 0.0, 0.025, mix(CORE, BROWN, 0.3), 1.0, INK, 0.004)
    for sx in (-1, 1):
        _window(c, sx * 0.3 - 0.075, sx * 0.3 + 0.075, 0.2, 0.38)
    c.disc((0, h + 0.17), 0.07, CORE)
    c.disc((0, h + 0.17), 0.052, mix(TEAL, BROWN, 0.3))
    c.ring((0, h + 0.17), 0.07, 0.007, INK)
    c.seg((-0.05, h + 0.17), (0.05, h + 0.17), 0.007, CORE)
    c.seg((0, h + 0.12), (0, h + 0.22), 0.007, CORE)


def st_wall_back(c, D, o, rnd):
    w, h, rise = G.HOUSE['w'], G.HOUSE['h'], G.HOUSE['rise']
    _wall(c, rnd, h, -w / 2, w / 2)
    gable = h + rise * (1 - np.abs(c.X) / (w / 2))
    ch = c.cov(gable - c.Y, -0.012) * (c.X > 0.1)
    c.blend(ch, mix(TERRA, BROWN, 0.35))
    for k in range(8):
        zz = h + 0.12 + k * 0.045
        c.seg((0.17, zz), (0.32, zz), 0.004, INK, 0.5 * 1.0)
    c.blend(ch * c.cov(np.abs(c.Y - (h + rise + 0.075)), 0.016), BROWN)
    c.seg((-w / 2, h), (w / 2, h), 0.022, BROWN, 0.9)
    for sx in (-1, 1):
        c.seg((sx * (w / 2 - 0.03), 0.05), (sx * (w / 2 - 0.03), h), 0.02, BROWN, 0.9)
        c.seg((sx * w / 2, h), (0, h + rise), 0.05, BROWN, 0.9)
    for sx in (-1, 0, 1):
        _window(c, sx * 0.27 - 0.065, sx * 0.27 + 0.065, 0.2, 0.38)
    _window(c, -0.055, 0.055, h + 0.1, h + 0.24)


def st_wall_side(c, D, o, rnd):
    d, h = G.HOUSE['d'], G.HOUSE['h']
    _wall(c, rnd, h, -d / 2, d / 2)
    c.seg((-d / 2, h - 0.012), (d / 2, h - 0.012), 0.03, BROWN, 0.9)
    for sx in (-1, 1):
        c.seg((sx * (d / 2 - 0.03), 0.05), (sx * (d / 2 - 0.03), h), 0.02, BROWN, 0.9)
        _window(c, sx * 0.15 - 0.065, sx * 0.15 + 0.065, 0.2, 0.38)


def st_roof(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(TERRA, BROWN, 0.12)
    row = 0.075
    k = np.floor(c.Y / row)
    fz = c.Y / row - k
    fx = ((c.X / 0.085) + 0.5 * (k % 2)) % 1.0
    scal = 0.5 + 0.42 * np.sqrt(np.clip(1 - (2 * fx - 1) ** 2, 0, 1))
    c.blend(np.clip((1 - fz) * 0.5, 0, 0.5) * 0.55, mix(TERRA, OCHRE, 0.5))
    c.blend(c.cov(np.abs(fz - (1 - scal)) * row, 0.0045) * 0.75, INK)
    c.blend(c.cov(np.abs(fx - 0.0) * 0.085, 0.003) * (fz > 1 - scal) * 0.5, INK)
    c.blend(c.cov(z1 - 0.05 - c.Y, 0.0), mix(BROWN, TERRA, 0.3))
    c.seg((x0, z1 - 0.05), (x1, z1 - 0.05), 0.006, INK, 0.7)
    c.blend(c.cov(c.Y, z0 + 0.035), mix(TERRA, BROWN, 0.5))
    hinge = c.cov(np.abs(c.Y), 0.003) * (((c.X * 30) % 1.0) < 0.5)
    c.blend(hinge * 0.3, INK)


def st_parapet(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    stone = mix(CORE, BROWN, 0.34)
    c.img[:] = stone
    row = 0.05
    k = np.floor(c.Y / row)
    fx = ((c.X / 0.11) + 0.5 * (k % 2)) % 1.0
    tone = (np.sin(k * 12.9 + np.floor(c.X / 0.11 + 0.5 * (k % 2)) * 78.2) * 0.5 + 0.5)
    c.blend(tone * 0.25, mix(OCHRE, BROWN, 0.4))
    c.blend(c.cov(np.abs((c.Y / row - k) - 0.0) * row, 0.003) * 0.55, INK)
    c.blend(c.cov(np.abs(fx - 0.5) * 0.11, 0.003) * 0.5, INK)
    a, ah = 0.33, 0.17
    er = np.sqrt((c.X / a) ** 2 + (np.maximum(c.Y, 0) / ah) ** 2)
    ringm = (er > 1.0) & (er < 1.32)
    c.blend(ringm * 1.0, mix(CORE, OCHRE, 0.3))
    th = np.arctan2(c.Y / ah, c.X / a)
    c.blend(ringm * c.cov(np.abs(((th / math.pi * 11) % 1.0) - 0.5), 0.06 * c.ppu / 150) * 0.6, INK)
    c.blend(c.cov(np.abs(er - 1.32) * 0.2, 0.004) * 0.7, INK)
    c.blend(c.cov(0.035 - D, 0.0) * (c.Y > 0.11) * (er > 1.4), mix(BROWN, TERRA, 0.25))


def st_rock(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    base = mix(CORE, BROWN, 0.42)
    s = np.clip(0.5 + (-(c.X - (x0 + x1) / 2) * 1.5 + (c.Y - z1 / 2)) / z1 * 0.6, 0, 1)
    c.img[:] = mix(mix(base, BROWN, 0.35), mix(base, CORE, 0.45), s[..., None])
    sg = 1 if x1 > 0.1 else -1
    w = max(abs(x0), abs(x1))
    c.line([(sg * w * 0.3, z1), (sg * w * 0.45, z1 * 0.55), (sg * w * 0.2, 0)], 0.006, INK, 0.6)
    c.line([(sg * w * 0.45, z1 * 0.55), (sg * w * 0.92, z1 * 0.38)], 0.006, INK, 0.5)
    c.poly([(sg * w * 0.45, z1 * 0.55), (sg * w * 0.92, z1 * 0.38), (sg * w, 0), (sg * w * 0.2, 0)], BROWN, 0.22)
    for _ in range(12):
        x, z = rnd.uniform(x0, x1), rnd.uniform(0, z1)
        c.seg((x, z), (x + 0.02, z - 0.012), 0.005, INK, 0.35)
    c.blend(c.cov(c.Y, 0.03) * 0.6, mix(MOSS, SAGE, 0.4))


def st_sign(c, D, o, rnd):
    c.img[:] = mix(BROWN, OCHRE, 0.25)
    board = (c.Y > 0.25) & (c.Y < 0.345)
    c.blend(board * 1.0, mix(CORE, OCHRE, 0.12))
    c.rect(-0.07, 0.24, 0.25, 0.345, CORE, 0.0, INK, 0.006)
    for k, (a, b) in enumerate(((0.02, 0.16), (0.02, 0.12))):
        c.seg((a, 0.315 - k * 0.035), (b, 0.315 - k * 0.035), 0.008, INK, 0.75)
    c.seg((-0.05, 0.297), (-0.02, 0.297), 0.008, TERRA, 0.9)
    c.blend(((np.abs(c.X) < 0.016) & (c.Y > 0.25) & (c.Y < 0.345)) * 0.5, BROWN)


def st_fence(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(CORE, BROWN, 0.3)
    pw = (x1 - x0) / 6
    fx = ((c.X - x0) / pw) % 1.0
    c.blend(c.cov(np.abs(fx - 0.9) * pw, 0.008) * (c.Y > z1 * 0.3) * 0.0, INK)
    c.blend(((fx > 0.08) & (fx < 0.72)) * 0.45, mix(CORE, OCHRE, 0.2))
    c.blend(c.cov(np.abs(fx - 0.08) * pw, 0.003) * 0.6 + c.cov(np.abs(fx - 0.72) * pw, 0.003) * 0.6, INK)
    for zz in (z1 * 0.28, z1 * 0.56):
        c.seg((x0, zz), (x1, zz), 0.018, mix(BROWN, OCHRE, 0.2), 0.85)


def st_milestone(c, D, o, rnd):
    c.img[:] = mix(CORE, BROWN, 0.25)
    c.seg((-0.02, 0.09), (0.02, 0.09), 0.007, INK, 0.8)
    c.seg((-0.02, 0.065), (0.012, 0.065), 0.007, TERRA, 0.8)
    c.blend(c.cov(c.Y, 0.022) * 0.7, mix(MOSS, SAGE, 0.4))


def st_strut(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(CORE, PAGE, 0.5)
    for zz in (z0 + 0.05, z1 - 0.05):
        dash = ((c.X * 40) % 1.0) < 0.55
        c.blend(c.cov(np.abs(c.Y - zz), 0.003) * dash * 0.45, INK)


def st_tab(c, D, o, rnd):
    c.img[:] = mix(CORE, PAGE, 0.35)
    c.blend(c.cov(D, 0.012) * 0.35, INK)


def st_core(c, D, o, rnd):
    c.img[:] = CORE


def st_trav_body(c, D, o, rnd):
    X, Z = c.X, c.Y
    coat = mix(TERRA, BROWN, 0.06)
    c.img[:] = coat
    c.blend(np.clip(0.3 - X * 3.0, 0, 0.45) * 0.5, mix(TERRA, OCHRE, 0.45))
    c.seg((0.014, -0.045), (0.022, 0.148), 0.005, INK, 0.6)
    for zz in (-0.01, 0.025, 0.09, 0.122):
        c.disc((0.036, zz), 0.0075, OCHRE)
    c.rect(-0.08, 0.08, 0.046, 0.064, BROWN, 1.0)
    c.rect(0.02, 0.046, 0.042, 0.068, OCHRE, 1.0, INK, 0.004)
    c.blend(c.cov(Z, -0.032) * 0.6, mix(BROWN, TERRA, 0.4))
    # satchel and strap
    c.blend(((X < -0.056) & (Z < 0.07)) * 1.0, mix(OCHRE, BROWN, 0.2))
    c.rect(-0.14, -0.058, 0.03, 0.066, mix(OCHRE, BROWN, 0.5), 1.0, INK, 0.004)
    c.disc((-0.098, 0.03), 0.008, CORE)
    c.seg((-0.098, 0.062), (0.046, 0.146), 0.015, BROWN, 0.95)
    # scarf
    c.blend(((Z > 0.14) & (Z < 0.172) & (X > -0.07)) * 1.0, TEAL)
    c.blend(((X < -0.048) & (Z > 0.14)) * 1.0, TEAL)
    c.seg((-0.06, 0.168), (-0.15, 0.168), 0.004, TEAL * 0.6, 0.8)
    c.seg((-0.03, 0.156), (0.04, 0.156), 0.004, TEAL * 0.6, 0.6)
    # head
    hc = (0.005, 0.225)
    rr = np.hypot(X - hc[0], Z - hc[1])
    head = (rr < 0.085) & (Z > 0.166) & (Z < 0.268) & (X > -0.075)
    c.blend(head * 1.0, mix(CORE, OCHRE, 0.36))
    c.blend(head * c.cov(X, -0.018) * 1.0, mix(BROWN, OCHRE, 0.12))
    c.disc((0.04, 0.232), 0.0095, INK)
    c.disc((0.043, 0.235), 0.003, CORE)
    c.disc((0.03, 0.202), 0.016, mix(TERRA, CORE, 0.4), 0.65)
    c.seg((0.042, 0.19), (0.06, 0.196), 0.005, INK, 0.75)
    # hat
    hat = Z >= 0.268
    c.blend(hat * 1.0, mix(BROWN, OCHRE, 0.14))
    c.blend(hat * (Z > 0.288) * (Z < 0.308) * (np.abs(X) < 0.07) * 1.0, TERRA)
    c.blend(hat * np.clip(0.3 - X * 4, 0, 0.4) * 0.5, mix(BROWN, OCHRE, 0.5))
    c.seg((-0.12, 0.286), (0.125, 0.286), 0.004, INK, 0.55)
    for jx, jz in ((0.0, 0.0), (0.0, 0.14)):
        c.disc((jx, jz), 0.011, mix(OCHRE, CORE, 0.3))
        c.ring((jx, jz), 0.011, 0.004, INK)


def st_trav_leg(c, D, o, rnd):
    c.img[:] = mix(TEAL, BROWN, 0.28)
    c.blend(np.clip(0.4 - c.X * 12, 0, 0.5) * 0.4, mix(TEAL, CORE, 0.3))
    c.blend(c.cov(c.Y, -0.112) * 1.0, BROWN)
    c.seg((-0.03, -0.112), (0.03, -0.112), 0.01, mix(BROWN, OCHRE, 0.5))
    c.seg((-0.03, -0.17), (0.09, -0.17), 0.01, INK, 0.8)
    c.disc((0.0, 0.0), 0.01, mix(OCHRE, CORE, 0.3))
    c.ring((0.0, 0.0), 0.01, 0.004, INK)


def st_trav_arm(c, D, o, rnd):
    c.img[:] = mix(TERRA, BROWN, 0.22)
    c.blend(np.clip(0.4 - c.X * 14, 0, 0.5) * 0.4, mix(TERRA, OCHRE, 0.4))
    c.blend(c.cov(c.Y, -0.103) * 1.0, mix(CORE, OCHRE, 0.36))
    c.seg((-0.022, -0.098), (0.022, -0.098), 0.012, OCHRE)
    c.disc((0.0, 0.0), 0.009, mix(OCHRE, CORE, 0.3))
    c.ring((0.0, 0.0), 0.009, 0.004, INK)


def st_sheep(c, D, o, rnd):
    c.img[:] = CORE
    for _ in range(26):
        x, z = rnd.uniform(-0.1, 0.1), rnd.uniform(0.05, 0.165)
        c.ring((x, z), 0.014, 0.004, mix(CORE, BROWN, 0.5), 0.7)
    dark = mix(BROWN, INK, 0.3)
    c.blend(c.cov(c.Y, 0.046) * 1.0, dark)
    c.blend(((c.X > 0.088) & (c.Y < 0.15)) * 1.0, dark)
    c.disc((0.122, 0.105), 0.006, CORE)


def st_trav_stand(c, D, o, rnd):
    c.img[:] = mix(PAGE, SAGE, 0.55)
    rr = np.hypot(c.X / 0.19, c.Y / 0.115)
    c.blend(c.cov(np.abs(rr - 0.8) * 0.115, 0.003) * 0.5, MOSS)
    for k in range(10):
        a = rnd.uniform(0, 6.28)
        r = rnd.uniform(0.1, 0.7)
        x, y = 0.19 * r * math.cos(a), 0.115 * r * math.sin(a)
        c.seg((x, y), (x + 0.006, y + 0.02), 0.006, MOSS, 0.7)


STYLES = {
    'tree_round': lambda c, D, o, r: st_foliage(c, D, o, r, MOSS),
    'tree_oval': lambda c, D, o, r: st_foliage(c, D, o, r, mix(MOSS, OCHRE, 0.38)),
    'vtree': lambda c, D, o, r: st_foliage(c, D, o, r, mix(MOSS, SAGE, 0.1), berries=TERRA, spine=True),
    'bush': lambda c, D, o, r: st_foliage(c, D, o, r, mix(MOSS, SAGE, 0.2), trunk=False, berries=TERRA),
    'conifer': st_conifer, 'hay': st_hay, 'tuft': st_tuft,
    'flower_a': lambda c, D, o, r: st_flower(c, D, o, r, OCHRE),
    'flower_b': lambda c, D, o, r: st_flower(c, D, o, r, TERRA),
    'reeds': st_reeds,
    'hill_peak': lambda c, D, o, r: st_hill(c, D, o, r, mix(SAGE, TEAL, 0.55), CORE, trees=0, snow=True, ink=TEAL * 0.6),
    'hill_far': lambda c, D, o, r: st_hill(c, D, o, r, mix(SAGE, TEAL, 0.3), CORE, trees=3),
    'hill_mid': lambda c, D, o, r: st_hill(c, D, o, r, mix(MOSS, SAGE, 0.45), SAGE, trees=7),
    'hill_near': lambda c, D, o, r: st_hill(c, D, o, r, MOSS, mix(SAGE, OCHRE, 0.25), trees=5),
    'wall_front': st_wall_front, 'wall_back': st_wall_back, 'wall_side': st_wall_side, 'roof': st_roof,
    'parapet': st_parapet, 'rock': st_rock, 'sign': st_sign, 'fence': st_fence, 'milestone': st_milestone,
    'strut': st_strut, 'tab': st_tab, 'core': st_core,
    'sheep': st_sheep,
    'trav_body': st_trav_body, 'trav_leg': st_trav_leg, 'trav_arm': st_trav_arm, 'trav_stand': st_trav_stand,
}


def art_ppu(key, ppu):
    return ppu * 2.5 if key.startswith('trav_') else ppu


def art_size(outline, ppu, pad):
    x0, x1, z0, z1 = _bbox(outline)
    return int(math.ceil((x1 - x0) * ppu)) + 2 * pad, int(math.ceil((z1 - z0) * ppu)) + 2 * pad


def paint_flap(key, outline, style, margin, ppu, pad):
    x0, x1, z0, z1 = _bbox(outline)
    w, h = art_size(outline, ppu, pad)
    c = Canvas(w, h, x0 - pad / ppu, z1 + pad / ppu, ppu, CORE)
    D = poly_sdf(c.X, c.Y, outline)
    rnd = random.Random(crc(key))
    STYLES[style](c, D, outline, rnd)
    c.img *= 1 + 0.04 * paper(h, w, crc(key) % 1000)[..., None]
    if margin > 0:
        white = mix(CORE, PAGE, 0.25)
        c.blend(c.cov(D, margin), white)
        c.blend(c.cov(np.abs(D - margin - 0.004), 0.0045) * 0.85, INK)
    return np.clip(c.img, 0, 1)


# ---------------------------------------------------------------- atlas

class Atlas:
    SIZE = 2048
    PITCH = 292
    INNER = 284
    COLS = 7
    ROWS = 5
    X0 = 2

    def __init__(self):
        self.img = np.empty((self.SIZE, self.SIZE, 3))
        self.img[:] = CORE
        self.base_slots = {}
        self.rects = {}

    def base_rect(self, key):
        if key not in self.base_slots:
            i = len(self.base_slots)
            if i >= self.COLS * self.ROWS:
                raise RuntimeError('too many base pages for the atlas')
            m = (self.PITCH - self.INNER) // 2
            self.base_slots[key] = (self.X0 + (i % self.COLS) * self.PITCH + m, (i // self.COLS) * self.PITCH + m)
        return self.base_slots[key]

    def put_base(self, key, img):
        x, y = self.base_rect(key)
        m = (self.PITCH - self.INNER) // 2
        self.img[y - m:y + self.INNER + m, x - m:x + self.INNER + m] = np.pad(img, ((m, m), (m, m), (0, 0)), mode='edge')

    def pack(self, sizes):
        """Shelf-pack {key: (w, h)} into the free area. Returns False when it does not fit."""
        used = len(self.base_slots)
        regions = [(0, self.ROWS * self.PITCH + 2, self.SIZE, self.SIZE)]
        for i in range(used, self.COLS * self.ROWS):
            x, y = self.X0 + (i % self.COLS) * self.PITCH, (i // self.COLS) * self.PITCH
            regions.append((x + 2, y + 2, x + self.PITCH - 2, y + self.PITCH - 2))
        state = [dict(x=r[0], y=r[1], h=0) for r in regions]
        rects = {}
        for key, (w, h) in sorted(sizes.items(), key=lambda kv: (-kv[1][1], -kv[1][0], str(kv[0]))):
            placed = False
            for r, st in zip(regions, state):
                if w > r[2] - r[0]:
                    continue
                if st['x'] + w > r[2]:
                    nx, ny, nh = r[0], st['y'] + st['h'], 0
                else:
                    nx, ny, nh = st['x'], st['y'], st['h']
                if ny + h > r[3]:
                    continue
                st['x'], st['y'], st['h'] = nx + w, ny, max(nh, h)
                rects[key] = (nx, ny, w, h)
                placed = True
                break
            if not placed:
                return False
        self.rects = rects
        return True

    def put(self, key, img):
        x, y, w, h = self.rects[key]
        self.img[y:y + h, x:x + w] = img


def normal_map(n=1024, seed=11):
    """Tileable paper-fibre normal map."""
    rs = np.random.RandomState(seed)
    h = np.zeros((n, n))
    for _ in range(7000):
        x, y = rs.uniform(0, n, 2)
        a = rs.uniform(0, math.pi)
        ln = rs.uniform(10, 44)
        curve = rs.uniform(-0.012, 0.012)
        m = int(ln)
        ts = np.arange(m)
        ang = a + curve * ts
        xs = (x + np.cumsum(np.cos(ang))).astype(int) % n
        ys = (y + np.cumsum(np.sin(ang))).astype(int) % n
        np.add.at(h, (ys, xs), rs.uniform(0.5, 1.0) * rs.choice((-1.0, 1.0, 1.0)))
    f = np.fft.rfft2(h)
    ky = np.fft.fftfreq(n)[:, None]
    kx = np.fft.rfftfreq(n)[None, :]
    f *= np.exp(-2 * (math.pi * 1.1) ** 2 * (kx * kx + ky * ky))
    h = np.fft.irfft2(f, s=(n, n))
    h = h / h.std()
    h = 0.75 * h + 0.5 * fnoise(n, n, 1.6, seed + 1) + 0.3 * fnoise(n, n, 9.0, seed + 2) + 0.3 * fnoise(n, n, 40.0, seed + 3)
    k = 0.24
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * k
    dy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) * k
    nz = np.ones_like(h)
    ln = np.sqrt(dx * dx + dy * dy + 1)
    out = np.stack([-dx / ln, -dy / ln, nz / ln], axis=-1) * 0.5 + 0.5
    return np.clip(out, 0, 1), h
