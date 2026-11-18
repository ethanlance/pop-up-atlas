"""Procedural printed-paper art for Pop-up Atlas: base pages, flap art, atlas packing, fibre normal map."""
import math
import random
import zlib

import numpy as np

import tiles_geom as G


def hexc(h):
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (1, 3, 5)])


PALETTE = {
    'page': '#EADFC6', 'core': '#F6F0E1', 'ochre': '#C9994F', 'terracotta': '#B05A40',
    'moss': '#6E7D46', 'sage': '#9FAE84', 'teal': '#5A9292', 'brown': '#74492F',
}
PAGE, CORE, OCHRE, TERRA, MOSS, SAGE, TEAL, BROWN = (hexc(PALETTE[k]) for k in
                                                    ('page', 'core', 'ochre', 'terracotta', 'moss', 'sage', 'teal', 'brown'))
INK = BROWN * 0.7
SKIN = hexc('#E2B588')


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
        period = np.where(m, L / max(1, round(L / 0.2)), period)
    for bx, by, br in blobs:
        rr = np.hypot(X - bx, Y - by)
        m = (rr - br) < sdf
        sdf = np.where(m, rr - br, sdf)
        circ = 2 * math.pi * br
        s = np.where(m, (np.arctan2(Y - by, X - bx) + math.pi) * br, s)
        lat = np.where(m, rr, lat)
        period = np.where(m, circ / max(1, round(circ / 0.2)), period)
        is_blob |= m
    return sdf, s, lat, period, is_blob


def _tick(c, x, y, col, a=0.75):
    for k in (-1, 0, 1):
        ang = math.radians(90 + k * 30)
        ln = 0.05 if k == 0 else 0.04
        c.seg((x + k * 0.018, y), (x + k * 0.018 + ln * math.cos(ang), y + ln * math.sin(ang)), 0.012, col, a)


def paint_base(t, n):
    """Printed base page for one tile, n x n pixels, row 0 = north edge. Calm: grid, a few ticks, path, river."""
    c = Canvas(n, n, -1.0, 1.0, n / 2.0, PAGE)
    X, Y = c.X, c.Y
    seed = crc(t.page_key)
    rnd = random.Random(seed)
    border = np.minimum(1 - np.abs(X), 1 - np.abs(Y))
    winb = sstep((border - 0.045) / 0.07)
    rt = t.routes
    psdf, ps, plat, pper, pblob = _union_field(c, rt['path_lines'], rt['path_blobs'], G.PATH_HW)
    wsdf, ws, wlat, wper, wblob = _union_field(c, rt['river_lines'], rt['ponds'], G.RIVER_HW)
    if rt['path_lines'] or rt['path_blobs']:
        c.blend(c.cov(psdf, 0.0), mix(PAGE, OCHRE, 0.45))
        dots = np.zeros(X.shape)
        for k, lane in enumerate((-0.1, 0.1)):
            sk = (ps / 0.3 + 0.5 * k) % 1.0
            dots = np.maximum(dots, c.cov(np.hypot((sk - 0.5) * 0.3, plat - lane), 0.022))
        c.blend(dots * (~pblob) * c.cov(psdf, -0.04) * winb * 0.5, mix(OCHRE, BROWN, 0.15))
        dash = np.clip((np.cos(2 * math.pi * ps / pper) + 0.1) * 6 + 0.5, 0, 1)
        c.blend(c.cov(np.abs(psdf - 0.012), 0.009) * dash * 0.85, BROWN)
    if rt['river_lines'] or rt['ponds']:
        c.blend(c.cov(wsdf, 0.0), TEAL)
        inner = c.cov(wsdf, -0.07) * winb
        sk = ((ws / 0.42) % 1.0 - 0.5) * 0.42
        wave = c.cov(np.abs(sk - 0.06 * np.sin(math.pi * wlat / 0.26)), 0.013) * (np.abs(wlat) < 0.25) * (~wblob)
        c.blend(wave * inner * 0.85, mix(PAGE, CORE, 0.5))
        for bx, by, br in rt['ponds']:
            rr = np.hypot(X - bx, Y - by)
            th = np.arctan2(Y - by, X - bx)
            for k in (1, 2):
                gate = sstep((np.sin(2 * th + k * 2.1) - 0.2) * 4)
                mark = c.cov(np.abs(rr - br * (0.25 + 0.27 * k)), 0.011) * gate * (rr < br - 0.07) * inner
                c.blend(mark * 0.85, mix(PAGE, CORE, 0.5))
        c.blend(c.cov(np.abs(wsdf), 0.008) * 0.55, mix(BROWN, OCHRE, 0.3))
    common = c.img.copy()

    def free(x, y, need_p=0.08, need_w=0.1):
        j = min(n - 1, max(0, int((1 - y) / 2 * n)))
        i = min(n - 1, max(0, int((x + 1) / 2 * n)))
        return psdf[j, i] > need_p and wsdf[j, i] > need_w

    for p in t.prints:
        kind = p['t']
        if kind == 'contour':
            f = np.zeros(X.shape)
            for bx, by, brx, bry, bh in p['bumps']:
                f += bh * np.exp(-((X - bx) / brx) ** 2 - ((Y - by) / bry) ** 2)
            gy, gx = np.gradient(f, c.px)
            g = np.hypot(gx, gy) + 1e-6
            c.blend(np.clip((f - 0.2) * 2, 0, 1) * 0.22, SAGE)
            for lv in p['levels']:
                c.blend(c.cov(np.abs(f - lv) / g, 0.005) * 0.4, mix(BROWN, OCHRE, 0.4))
        elif kind == 'lanes':
            for ln in p['pts']:
                d, s, side, L = line_field(X, Y, ln)
                c.blend(c.cov(d, 0.08), mix(PAGE, OCHRE, 0.45))
        elif kind == 'plot':
            r = G.rz(p['heading'])
            hw_, hd_ = p['w'] / 2 + 0.06, p['d'] / 2 + 0.06
            pts = []
            for lx, ly in ((-hw_, -hd_), (hw_, -hd_), (hw_, hd_), (-hw_, hd_)):
                v = r @ G.Vector((lx, ly, 0.0))
                pts.append((p['x'] + v.x, p['y'] + v.y))
            c.poly(pts, mix(PAGE, OCHRE, 0.22), 1.0)

    made = 0
    for _ in range(200):
        if made >= 6:
            break
        x, y = rnd.uniform(-0.82, 0.82), rnd.uniform(-0.82, 0.82)
        if not free(x, y):
            continue
        made += 1
        _tick(c, x, y, mix(SAGE, MOSS, 0.35) if made % 3 else mix(OCHRE, PAGE, 0.3))

    img = common + (c.img - common) * winb[..., None]
    win = sstep(border / 0.1)
    img *= 1 + (0.011 * fnoise(n, n, 0.7, seed % 1000 + 3))[..., None] * win[..., None]
    c.img = img
    c.blend(c.cov(border, 0.004) * 0.22, mix(BROWN, OCHRE, 0.4))
    return np.clip(c.img, 0, 1)


# ---------------------------------------------------------------- flap art (flat, bold colour)

def _bbox(o):
    xs, zs = [p[0] for p in o], [p[1] for p in o]
    return min(xs), max(xs), min(zs), max(zs)


def _tone(col, k):
    """Tone-on-tone ink: the same hue, darker (k < 0) or lighter (k > 0)."""
    return col * (1 + k) if k < 0 else mix(col, CORE, k)


def st_crown(c, D, o, rnd, col=MOSS):
    x0, x1, z0, z1 = _bbox(o)
    wide = [z for x, z in o if abs(x) > 0.08]
    zb = min(wide)
    c.img[:] = col
    for k in range(1, 5):
        zz = zb + (z1 - zb) * k / 5
        wav = zz + 0.02 * np.sin(c.X * 22 + k * 1.3)
        c.blend(c.cov(np.abs(c.Y - wav), 0.006) * 0.5, _tone(col, -0.16))
    c.blend(c.cov(c.Y, zb + 0.01) * 1.0, BROWN)
    c.seg((0, zb), (0, zb + (z1 - zb) * 0.45), 0.02, BROWN, 0.9)


def st_conifer(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    th = sorted(set(round(z, 4) for x, z in o))[1]
    c.img[:] = MOSS
    step = (z1 - th) / 3
    fr = ((c.Y - th) / step) % 1.0
    c.blend(np.clip(0.35 - fr, 0, 0.35) * 0.9, _tone(MOSS, -0.2))
    c.blend(c.cov(c.Y, th + 0.004), BROWN)


def st_vtree(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    zb = min(z for x, z in o if abs(x) > 0.1)
    right = x1 > 0.1
    c.img[:] = MOSS if right else mix(MOSS, SAGE, 0.35)
    for k in range(1, 6):
        zz = zb + (z1 - zb) * k / 6
        c.blend(c.cov(np.abs(c.Y - zz - 0.02 * np.sin(c.X * 20 + k)), 0.006) * 0.5, _tone(MOSS, -0.18))
    for _ in range(9):
        c.disc((rnd.uniform(x0 + 0.06, x1 - 0.06), rnd.uniform(zb + 0.12, z1 - 0.2)), 0.024, TERRA)
    c.blend(c.cov(np.abs(c.X), 0.06) * c.cov(c.Y, zb + 0.02), BROWN)
    c.blend(c.cov(np.abs(c.X), 0.022) * c.cov(c.Y, zb + (z1 - zb) * 0.5), BROWN)


def st_bush(c, D, o, rnd):
    c.img[:] = SAGE
    x0, x1, z0, z1 = _bbox(o)
    for _ in range(7):
        c.disc((rnd.uniform(x0 + 0.06, x1 - 0.06), rnd.uniform(0.06, z1 - 0.07)), 0.022, TERRA)


def st_hay(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = OCHRE
    for k in (0.3, 0.6):
        c.blend(c.cov(np.abs(c.Y - z1 * k), 0.007) * 0.6, _tone(OCHRE, -0.22))
    for k in range(5):
        x = x0 + (x1 - x0) * (k + 0.5) / 5
        c.seg((x, 0.02), (x * 0.85, z1 * 0.28), 0.007, _tone(OCHRE, -0.22), 0.6)


def st_tuft(c, D, o, rnd):
    c.img[:] = MOSS


def st_flower(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    heads = [z for x, z in o if z > z1 * 0.6]
    r = (max(heads) - min(heads)) / 2
    hc = (0.0, z1 - r)
    c.img[:] = MOSS
    rr = np.hypot(c.X - hc[0], c.Y - hc[1])
    c.blend(c.cov(rr, r * 1.4), TERRA)
    c.disc(hc, r * 0.4, OCHRE)


def st_reeds(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(MOSS, SAGE, 0.3)
    for x, z in sorted([p for p in o if p[1] > z1 * 0.5], key=lambda p: -p[1])[:2]:
        c.seg((x * 0.86, z * 0.62), (x * 0.95, z * 0.9), 0.04, BROWN, 1.0)


def st_hill(c, D, o, rnd, col=MOSS):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = col
    k = 0
    zz = 0.09
    while zz < z1:
        wav = zz + 0.022 * np.sin(c.X * 9 + k * 1.9) + 0.012 * np.sin(c.X * 21 + k)
        c.blend(c.cov(np.abs(c.Y - wav), 0.005) * 0.55, _tone(col, -0.14))
        zz += 0.11
        k += 1


def _window(c, x0, x1, z0, z1):
    c.rect(x0 - 0.014, x1 + 0.014, z0 - 0.014, z1 + 0.014, CORE, 1.0, INK, 0.006)
    c.rect(x0, x1, z0, z1, TEAL, 1.0)
    c.seg(((x0 + x1) / 2, z0), ((x0 + x1) / 2, z1), 0.011, CORE)
    c.seg((x0, (z0 + z1) / 2), (x1, (z0 + z1) / 2), 0.011, CORE)
    c.rect(x0 - 0.022, x1 + 0.022, z0 - 0.034, z0 - 0.014, TERRA, 1.0)


def _wall(c, h, x0, x1):
    c.img[:] = mix(CORE, OCHRE, 0.2)
    c.blend(c.cov(c.Y, 0.06), BROWN)


def st_wall_front(c, D, o, rnd):
    w, h, rise = G.HOUSE['w'], G.HOUSE['h'], G.HOUSE['rise']
    _wall(c, h, -w / 2, w / 2)
    gable = h + rise * (1 - np.abs(c.X) / (w / 2))
    ch = c.cov(gable - c.Y, -0.012) * (c.X > 0.1)
    c.blend(ch, mix(TERRA, BROWN, 0.5))
    c.blend(ch * c.cov(np.abs(c.Y - (h + rise + 0.055)), 0.016), BROWN)
    c.seg((-w / 2, h), (w / 2, h), 0.024, BROWN)
    for sx in (-1, 1):
        c.seg((sx * (w / 2 - 0.03), 0.05), (sx * (w / 2 - 0.03), h), 0.022, BROWN)
        c.seg((sx * w / 2, h), (0, h + rise), 0.055, BROWN)
    c.rect(-0.105, 0.105, 0.0, 0.32, BROWN, 1.0)
    c.rect(-0.08, 0.08, 0.02, 0.29, TERRA, 1.0, INK, 0.005)
    for k in range(1, 4):
        c.seg((-0.08 + 0.04 * k, 0.02), (-0.08 + 0.04 * k, 0.29), 0.004, INK, 0.5)
    c.disc((0.05, 0.16), 0.014, OCHRE)
    for sx in (-1, 1):
        _window(c, sx * 0.255 - 0.07, sx * 0.255 + 0.07, 0.16, 0.33)
    c.disc((0, h + 0.17), 0.072, CORE)
    c.disc((0, h + 0.17), 0.054, TEAL)
    c.ring((0, h + 0.17), 0.072, 0.007, INK)
    c.seg((-0.05, h + 0.17), (0.05, h + 0.17), 0.008, CORE)
    c.seg((0, h + 0.12), (0, h + 0.22), 0.008, CORE)


def st_wall_back(c, D, o, rnd):
    w, h, rise = G.HOUSE['w'], G.HOUSE['h'], G.HOUSE['rise']
    _wall(c, h, -w / 2, w / 2)
    c.seg((-w / 2, h), (w / 2, h), 0.024, BROWN)
    for sx in (-1, 1):
        c.seg((sx * (w / 2 - 0.03), 0.05), (sx * (w / 2 - 0.03), h), 0.022, BROWN)
        c.seg((sx * w / 2, h), (0, h + rise), 0.055, BROWN)
    for sx in (-1, 0, 1):
        _window(c, sx * 0.24 - 0.06, sx * 0.24 + 0.06, 0.16, 0.33)
    _window(c, -0.055, 0.055, h + 0.1, h + 0.24)


def st_wall_side(c, D, o, rnd):
    d, h = G.HOUSE['d'], G.HOUSE['h']
    _wall(c, h, -d / 2, d / 2)
    c.seg((-d / 2, h - 0.012), (d / 2, h - 0.012), 0.03, BROWN)
    for sx in (-1, 1):
        c.seg((sx * (d / 2 - 0.03), 0.05), (sx * (d / 2 - 0.03), h), 0.022, BROWN)
        _window(c, sx * 0.15 - 0.065, sx * 0.15 + 0.065, 0.16, 0.33)


def st_roof(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = TERRA
    row = 0.09
    k = np.floor(c.Y / row)
    fz = c.Y / row - k
    fx = ((c.X / 0.1) + 0.5 * (k % 2)) % 1.0
    scal = 0.5 + 0.42 * np.sqrt(np.clip(1 - (2 * fx - 1) ** 2, 0, 1))
    c.blend(c.cov(np.abs(fz - (1 - scal)) * row, 0.0045) * 0.6, _tone(TERRA, -0.3))
    c.blend(c.cov(c.Y, z0 + 0.03), _tone(TERRA, -0.25))


def st_arch(c, D, o, rnd):
    c.img[:] = TERRA
    er = np.sqrt((c.X / 0.38) ** 2 + (np.maximum(c.Y, 0) / 0.2) ** 2)
    for k in range(1, 4):
        c.blend(c.cov(np.abs(er - 1 - 0.28 * k) * 0.2, 0.005) * 0.55, _tone(TERRA, -0.2))
    c.blend(c.cov(D, 0.03) * (c.Y > 0.02), mix(TERRA, BROWN, 0.55))


def st_deck(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = OCHRE
    zz = 0.06
    while zz < z1:
        c.seg((x0, zz), (x1, zz), 0.007, _tone(OCHRE, -0.25), 0.8)
        zz += 0.085
    for sx in (-1, 1):
        c.seg((sx * 0.21, z0), (sx * 0.21, z1), 0.02, mix(OCHRE, BROWN, 0.6))


def st_rock(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    sg = 1 if x1 > 0.1 else -1
    w = max(abs(x0), abs(x1))
    c.img[:] = mix(BROWN, CORE, 0.45) if sg > 0 else mix(BROWN, CORE, 0.3)
    c.poly([(sg * w * 0.45, z1 * 0.55), (sg * w * 0.92, z1 * 0.38), (sg * w, 0), (sg * w * 0.2, 0)], BROWN, 0.35)
    c.line([(sg * w * 0.3, z1), (sg * w * 0.45, z1 * 0.55), (sg * w * 0.2, 0)], 0.008, BROWN, 0.7)


def st_sign(c, D, o, rnd):
    c.img[:] = BROWN
    board = (c.Y > 0.25) & (c.Y < 0.35)
    c.blend(board * 1.0, CORE)
    for k, (a, b) in enumerate(((0.03, 0.17), (0.03, 0.12))):
        c.seg((a, 0.32 - k * 0.035), (b, 0.32 - k * 0.035), 0.01, BROWN, 0.9)
    c.seg((-0.055, 0.3), (-0.02, 0.3), 0.012, TERRA)


def st_fence(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = mix(CORE, OCHRE, 0.3)
    pw = (x1 - x0) / 6
    fx = ((c.X - x0) / pw) % 1.0
    c.blend(c.cov(np.abs(fx - 0.9) * pw, pw * 0.14) * 1.0, BROWN)
    for zz in (z1 * 0.28, z1 * 0.56):
        c.seg((x0, zz), (x1, zz), 0.02, BROWN, 0.9)


def st_strut(c, D, o, rnd):
    x0, x1, z0, z1 = _bbox(o)
    c.img[:] = CORE
    for zz in (z0 + 0.05, z1 - 0.05):
        dash = ((c.X * 40) % 1.0) < 0.55
        c.blend(c.cov(np.abs(c.Y - zz), 0.003) * dash * 0.35, BROWN)


def st_tab(c, D, o, rnd):
    c.img[:] = CORE
    c.blend(c.cov(D, 0.01) * 0.25, BROWN)


def st_core(c, D, o, rnd):
    c.img[:] = CORE


def st_sheep(c, D, o, rnd):
    c.img[:] = CORE
    c.blend(c.cov(c.Y, 0.046) * 1.0, BROWN)
    c.blend(((c.X > 0.088) & (c.Y < 0.15)) * 1.0, BROWN)
    c.disc((0.122, 0.105), 0.007, CORE)


def st_trav_body(c, D, o, rnd):
    X, Z = c.X, c.Y
    c.img[:] = TERRA
    c.rect(-0.08, 0.08, 0.04, 0.058, BROWN, 1.0)
    # satchel and strap
    c.blend(((X < -0.055) & (Z < 0.075)) * 1.0, OCHRE)
    c.rect(-0.145, -0.055, 0.035, 0.075, BROWN, 1.0)
    c.seg((-0.1, 0.07), (0.045, 0.146), 0.018, BROWN)
    # scarf
    c.blend(((Z > 0.138) & (Z < 0.176)) * 1.0, TEAL)
    c.blend(((X < -0.05) & (Z > 0.138)) * 1.0, TEAL)
    # head
    hc = (0.005, 0.225)
    rr = np.hypot(X - hc[0], Z - hc[1])
    head = (rr < 0.08) & (Z > 0.17) & (Z < 0.268)
    c.blend(head * 1.0, SKIN)
    c.disc((0.042, 0.228), 0.011, BROWN)
    # hat
    hat = Z >= 0.268
    c.blend(hat * 1.0, BROWN)
    c.blend(hat * (Z > 0.287) * (Z < 0.308) * 1.0, OCHRE)
    c.blend(hat * (Z > 0.287) * (Z < 0.308) * (np.abs(X) > 0.068) * 1.0, BROWN)


def st_trav_leg(c, D, o, rnd):
    c.img[:] = BROWN
    c.blend(c.cov(c.Y, -0.135) * 1.0, BROWN * 0.72)


def st_trav_arm(c, D, o, rnd):
    c.img[:] = mix(TERRA, BROWN, 0.18)
    hand = np.hypot(c.X - 0.045, c.Y + 0.118) < 0.032
    c.blend(hand * (c.X < 0.062) * 1.0, SKIN)
    c.blend((c.X > 0.062) * 1.0, mix(BROWN, OCHRE, 0.25))


def st_trav_stand(c, D, o, rnd):
    c.img[:] = CORE
    c.blend(c.cov(D, 0.008) * 0.2, BROWN)


STYLES = {
    'crown_moss': lambda c, D, o, r: st_crown(c, D, o, r, MOSS),
    'crown_sage': lambda c, D, o, r: st_crown(c, D, o, r, SAGE),
    'crown_terra': lambda c, D, o, r: st_crown(c, D, o, r, TERRA),
    'crown_ochre': lambda c, D, o, r: st_crown(c, D, o, r, OCHRE),
    'vtree': st_vtree, 'bush': st_bush, 'conifer': st_conifer, 'hay': st_hay, 'tuft': st_tuft, 'flower': st_flower,
    'reeds': st_reeds,
    'hill_terra': lambda c, D, o, r: st_hill(c, D, o, r, TERRA),
    'hill_ochre': lambda c, D, o, r: st_hill(c, D, o, r, OCHRE),
    'hill_moss': lambda c, D, o, r: st_hill(c, D, o, r, MOSS),
    'hill_sage': lambda c, D, o, r: st_hill(c, D, o, r, SAGE),
    'wall_front': st_wall_front, 'wall_back': st_wall_back, 'wall_side': st_wall_side, 'roof': st_roof,
    'arch': st_arch, 'deck': st_deck, 'rock': st_rock, 'sign': st_sign, 'fence': st_fence,
    'strut': st_strut, 'tab': st_tab, 'core': st_core, 'sheep': st_sheep,
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
    c.img *= 1 + 0.014 * fnoise(h, w, 0.7, crc(key) % 1000)[..., None]
    if margin > 0:
        white = CORE
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
