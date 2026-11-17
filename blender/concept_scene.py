"""Pop-up Atlas concept frames. Path-traced target look (Blender 5.2, Cycles).

Run:  blender -b -P blender/concept_scene.py -- --frame 1 [--draft]
Axes here are Blender (Z up). Blender (x, y, z) = three.js (x, z_up=y, -z): Blender +Y is north (three.js -Z).
"""
import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FRAME = int(argv[argv.index("--frame") + 1]) if "--frame" in argv else 1
DRAFT = "--draft" in argv

# ---------------------------------------------------------------- palette (sRGB albedo)
PAL = {
    "cream": "#EADFC6",       # page
    "core": "#F6F0E1",        # cut-edge paper core
    "ochre": "#C9994F",
    "terracotta": "#B05A40",
    "moss": "#6E7D46",
    "sage": "#9FAE84",
    "teal": "#5A9292",
    "brown": "#74492F",
    "table": "#3B2416",
    "cover": "#5E3222",
    "skin": "#E2B588",        # light tint of the ochre hue
}
PXH, PYH = 8.4, 6.4          # page half extents (8 x 6 tiles of 2 units + 0.4 margin)
T = 0.016                     # card thickness


def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexs(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32)


def hexl(h):
    return tuple(srgb2lin(float(v)) for v in hexs(h)) + (1.0,)


def blackbody(temp):
    """Linear sRGB colour of a black body, max channel = 1 (Kim et al. CIE xy fit)."""
    t = float(temp)
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    xyz = np.array([x / y, 1.0, (1 - x - y) / y])
    m = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
    rgb = np.clip(m @ xyz, 0, None)
    return rgb / rgb.max()


def light_rgb(temp, wb):
    c = blackbody(temp) / blackbody(wb)
    return tuple(c / c.max())


# ---------------------------------------------------------------- layout functions
def river_x(y):
    return 3.0 + 0.8 * np.sin(0.55 * y + 0.5)


def path_y(x):
    return -1.0 + 0.6 * np.sin(0.5 * x)


BRIDGE = (3.2, -0.4)
HILLS = [  # cx, cy, width, palette back-to-front is reversed below
    ("A", -5.0, 4.0, 4.4, ["sage", "moss", "ochre", "terracotta"]),
    ("B", -1.8, 4.7, 2.8, ["ochre", "sage", "moss"]),
    ("C", 6.0, 2.6, 3.6, ["sage", "ochre", "moss", "brown"]),
    ("D", 5.7, -4.2, 3.2, ["moss", "sage", "terracotta"]),
    ("E", -6.4, -4.5, 2.6, ["sage", "moss", "ochre"]),
    ("F", 1.3, 1.4, 2.4, ["moss", "sage", "ochre"]),
]
HOUSES = [  # x, y, yaw deg, wall, roof
    (-5.4, -0.45, 8, "cream", "terracotta"),
    (-3.95, -0.25, -10, "ochre", "brown"),
    (-2.75, -0.5, 14, "cream", "teal"),
    (-5.0, -3.0, -6, "ochre", "terracotta"),
    (-3.3, -3.1, 12, "cream", "brown"),
    (-6.6, -1.9, 20, "cream", "terracotta"),
    (5.6, 0.45, -12, "cream", "terracotta"),
    (6.7, -1.9, 10, "ochre", "brown"),
    (0.9, -3.4, -8, "cream", "teal"),
]

FRAMES = {
    1: dict(trav=(-1.6, float(path_y(-1.6)), 0), target=(-0.6, -3.3, 0.2), width=12.6, pitch=52, az=252,
            fstop=0.05, radii=(5.2, 7.6), key_dist=15, key_power=9000),
    2: dict(trav=(1.5, float(path_y(1.5)), 0), target=(2.2, -0.4, 0.3), width=4.5, pitch=54, az=252,
            fstop=0.10, radii=(4.6, 6.6), key_dist=10, key_power=4200),
    3: dict(trav=(-4.2, float(path_y(-4.2)), 0), target=(-4.2, -1.35, 0.3), width=6.2, pitch=56, az=281,
            fstop=0.10, radii=(3.9, 5.6), key_dist=10, key_power=4200),
    4: dict(trav=(-5.9, 2.75, 32), target=(-5.0, 3.6, 0.3), width=6.6, pitch=50, az=266,
            fstop=0.12, radii=(3.0, 5.4), key_dist=11, key_power=5000, mid=["A", "B"]),
    5: dict(trav=(-2.3, float(path_y(-2.3)), 0), target=(-2.27, -1.47, 0.27), width=1.55, pitch=50, az=256,
            fstop=0.5, radii=(4.5, 6.5), key_dist=8, key_power=2800),
}
CFG = FRAMES[FRAME]
rng = random.Random(11)


def fold_deg(x, y, tag=None, layer=0):
    """Fold angle in degrees. 90 = fully popped up, ~6 = lying flat on the page."""
    r = random.Random(hash((round(x, 2), round(y, 2), layer)) & 0xFFFF)
    if tag and tag in CFG.get("mid", []):
        return 74 - 12 * layer + r.uniform(-3, 3)
    d = math.hypot(x - CFG["trav"][0], y - CFG["trav"][1])
    r1, r2 = CFG["radii"]
    if d < r1:
        return 90 + r.uniform(-6, 4)
    if d < r2:
        return 60 - 30 * (d - r1) / (r2 - r1) + r.uniform(-5, 5)
    return 6.0


# ---------------------------------------------------------------- scene reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = scene.collection


def new_obj(name, verts, faces, mats, face_mats=None, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    for m in mats:
        me.materials.append(m)
    if face_mats is not None:
        me.polygons.foreach_set("material_index", face_mats)
    if smooth:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()
    ob = bpy.data.objects.new(name, me)
    COL.objects.link(ob)
    return ob


def solidify(ob, thickness=T, offset=0.0):
    m = ob.modifiers.new("card", "SOLIDIFY")
    m.thickness = thickness
    m.offset = offset
    m.use_rim = True
    m.material_offset_rim = 1
    return ob


# ---------------------------------------------------------------- materials
def paper_nodes(mat, base_socket_fn, bump=0.5, mottle=0.10, rough=0.93, transl=0.07, fibre_scale=1.0, wavy=0.0,
                printed=None):
    nt = mat.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    L = nt.links.new
    tc = N("ShaderNodeTexCoord")
    fine = N("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 190 * fibre_scale
    fine.inputs["Detail"].default_value = 4
    fine.inputs["Roughness"].default_value = 0.65
    L(tc.outputs["Object"], fine.inputs["Vector"])
    mp = N("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (70 * fibre_scale, 300 * fibre_scale, 300 * fibre_scale)
    mp.inputs["Rotation"].default_value = (0.3, 0.2, 0.5)
    L(tc.outputs["Object"], mp.inputs["Vector"])
    fib = N("ShaderNodeTexNoise")
    fib.inputs["Scale"].default_value = 1.0
    fib.inputs["Detail"].default_value = 3
    L(mp.outputs["Vector"], fib.inputs["Vector"])
    low = N("ShaderNodeTexNoise")
    low.inputs["Scale"].default_value = 2.6
    low.inputs["Detail"].default_value = 6
    low.inputs["Roughness"].default_value = 0.6
    L(tc.outputs["Object"], low.inputs["Vector"])
    hsum = N("ShaderNodeMath")
    hsum.operation = "ADD"
    L(fine.outputs["Fac"], hsum.inputs[0])
    L(fib.outputs["Fac"], hsum.inputs[1])
    if wavy:
        wv = N("ShaderNodeMath")
        wv.operation = "MULTIPLY_ADD"
        wv.inputs[1].default_value = wavy
        L(low.outputs["Fac"], wv.inputs[0])
        L(hsum.outputs[0], wv.inputs[2])
        hsum = wv
    bmp = N("ShaderNodeBump")
    bmp.inputs["Strength"].default_value = bump
    bmp.inputs["Distance"].default_value = 0.006
    L(hsum.outputs[0], bmp.inputs["Height"])
    # colour: base * low-frequency mottle * fibre flecks
    r1 = N("ShaderNodeValToRGB")
    r1.color_ramp.elements[0].position = 0.3
    r1.color_ramp.elements[0].color = (1 - mottle,) * 3 + (1,)
    r1.color_ramp.elements[1].position = 0.7
    r1.color_ramp.elements[1].color = (1 + mottle * 0.4,) * 3 + (1,)
    L(low.outputs["Fac"], r1.inputs["Fac"])
    r2 = N("ShaderNodeValToRGB")
    r2.color_ramp.elements[0].position = 0.32
    r2.color_ramp.elements[0].color = (0.92, 0.91, 0.89, 1)
    r2.color_ramp.elements[1].position = 0.5
    r2.color_ramp.elements[1].color = (1, 1, 1, 1)
    L(fib.outputs["Fac"], r2.inputs["Fac"])
    m1 = N("ShaderNodeMix")
    m1.data_type = "RGBA"
    m1.blend_type = "MULTIPLY"
    m1.inputs[0].default_value = 1.0
    base_socket_fn(nt, m1.inputs[6])
    L(r1.outputs["Color"], m1.inputs[7])
    m2 = N("ShaderNodeMix")
    m2.data_type = "RGBA"
    m2.blend_type = "MULTIPLY"
    m2.inputs[0].default_value = 1.0
    L(m1.outputs[2], m2.inputs[6])
    L(r2.outputs["Color"], m2.inputs[7])
    if printed:  # printed ink detail: (kind, scale, darkness)
        kind, pscale, dark = printed
        if kind == "dots":
            pt = N("ShaderNodeTexVoronoi")
            pt.inputs["Scale"].default_value = pscale
            L(tc.outputs["Object"], pt.inputs["Vector"])
            psock, lo, hi = pt.outputs["Distance"], 0.16, 0.24
        else:
            pt = N("ShaderNodeTexWave")
            pt.wave_type = "BANDS"
            pt.bands_direction = kind
            pt.inputs["Scale"].default_value = pscale
            pt.inputs["Distortion"].default_value = 2.2
            pt.inputs["Detail"].default_value = 2
            pt.inputs["Detail Scale"].default_value = 1.3
            L(tc.outputs["Object"], pt.inputs["Vector"])
            psock, lo, hi = pt.outputs["Fac"], 0.07, 0.13
        r3 = N("ShaderNodeValToRGB")
        r3.color_ramp.elements[0].position = lo
        r3.color_ramp.elements[0].color = (dark, dark, dark * 0.96, 1)
        r3.color_ramp.elements[1].position = hi
        r3.color_ramp.elements[1].color = (1, 1, 1, 1)
        L(psock, r3.inputs["Fac"])
        m3 = N("ShaderNodeMix")
        m3.data_type = "RGBA"
        m3.blend_type = "MULTIPLY"
        m3.inputs[0].default_value = 1.0
        L(m2.outputs[2], m3.inputs[6])
        L(r3.outputs["Color"], m3.inputs[7])
        m2 = m3
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    bsdf.inputs["Sheen Weight"].default_value = 0.25
    bsdf.inputs["Sheen Roughness"].default_value = 0.6
    L(m2.outputs[2], bsdf.inputs["Base Color"])
    L(bmp.outputs["Normal"], bsdf.inputs["Normal"])
    tr = N("ShaderNodeBsdfTranslucent")
    L(m2.outputs[2], tr.inputs["Color"])
    L(bmp.outputs["Normal"], tr.inputs["Normal"])
    mix = N("ShaderNodeMixShader")
    mix.inputs[0].default_value = transl
    L(bsdf.outputs[0], mix.inputs[1])
    L(tr.outputs[0], mix.inputs[2])
    out = N("ShaderNodeOutputMaterial")
    L(mix.outputs[0], out.inputs["Surface"])
    return m1


def flat_colour(rgba):
    def fn(nt, sock):
        sock.default_value = rgba
    return fn


MATS = {}


def paper(name, **kw):
    """Card material for a palette colour, plus its lighter core material (name + '_core')."""
    key = (name, kw.get("printed"))
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    paper_nodes(m, flat_colour(hexl(PAL[name])), **kw)
    core = bpy.data.materials.new(name + "_core")
    core.use_nodes = True
    mixed = 0.14 * hexs(PAL[name]) + 0.86 * hexs(PAL["core"])
    paper_nodes(core, flat_colour(tuple(srgb2lin(float(v)) for v in mixed) + (1,)), bump=0.9, mottle=0.16)
    MATS[key] = (m, core)
    return MATS[key]


def pm(*names, printed=None):
    out = []
    for n in names:
        out.extend(paper(n, printed=printed) if printed else paper(n))
    return out


# ---------------------------------------------------------------- printed page image
def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def paint_page():
    W = 4096
    H = int(W * PYH / PXH)
    xs = np.linspace(-PXH, PXH, W, dtype=np.float32)
    ys = np.linspace(-PYH, PYH, H, dtype=np.float32)
    X, Y = np.meshgrid(xs, ys)
    img = np.empty((H, W, 3), dtype=np.float32)
    img[:] = hexs(PAL["cream"])
    nr = np.random.default_rng(5)

    def blend(mask, col, a=1.0):
        m = (mask * a)[..., None]
        img[:] = img * (1 - m) + hexs(PAL[col]) * m

    # soft printed sage wash and atlas contour lines under each hill cluster
    field = np.zeros_like(X)
    for _, cx, cy, w, _p in HILLS:
        field += np.exp(-(((X - cx) / (w * 0.62)) ** 2 + ((Y - cy - 0.2) / 1.25) ** 2))
    wob = 0.06 * np.sin(X * 3.1 + 1.3 * np.sin(Y * 2.3)) + 0.05 * np.sin(Y * 4.3 + X * 1.7)
    f = field + wob
    wash = hexs(PAL["sage"]) * 0.55 + hexs(PAL["cream"]) * 0.45
    m = ss(0.30, 0.42, f)
    img[:] = img * (1 - 0.8 * m[..., None]) + wash * 0.8 * m[..., None]
    blend(ss(0.28, 0.33, f) * (1 - ss(0.33, 0.40, f)), "moss", 0.30)
    cont = (np.abs(((f * 4.0) % 1.0) - 0.5) < 0.035) & (f > 0.45)
    blend(cont.astype(np.float32), "brown", 0.28)
    # meadow tufts
    px = W / (2 * PXH)
    for _ in range(1500):
        tx, ty = nr.uniform(-PXH + 0.4, PXH - 0.4), nr.uniform(-PYH + 0.4, PYH - 0.4)
        if abs(tx - river_x(ty)) < 0.75 or abs(ty - path_y(tx)) < 0.38 or abs(tx) < 0.5:
            continue
        ci, ri = int((tx + PXH) * px), int((ty + PYH) * px)
        s = 14
        sx, sy = X[ri - s:ri + s, ci - s:ci + s] - tx, Y[ri - s:ri + s, ci - s:ci + s] - ty
        mk = np.zeros_like(sx)
        for k in (-1, 0, 1):
            mk = np.maximum(mk, 1 - ss(0.004, 0.010, np.abs(sx - k * 0.016 - k * 0.5 * sy)) * 1.0)
        mk *= (sy > 0) * (sy < 0.045 - 0.0 * sx)
        c = hexs(PAL["moss"] if nr.random() < 0.7 else PAL["ochre"])
        img[ri - s:ri + s, ci - s:ci + s] = img[ri - s:ri + s, ci - s:ci + s] * (1 - 0.6 * mk[..., None]) + c * 0.6 * mk[..., None]
    # path: pale ochre band with a dashed brown edge
    slope = 0.3 * np.cos(0.5 * X)
    dp = np.abs(Y - path_y(X)) / np.sqrt(1 + slope**2)
    pathc = hexs(PAL["ochre"]) * 0.45 + hexs(PAL["cream"]) * 0.55
    m = 1 - ss(0.20, 0.215, dp)
    img[:] = img * (1 - m[..., None]) + pathc * m[..., None]
    dash = (np.abs(dp - 0.235) < 0.011) & (((X * 4.0) % 1.0) < 0.6)
    blend(dash.astype(np.float32), "brown", 0.65)
    pebble = (np.sin(X * 23 + 2 * np.sin(Y * 9)) * np.sin(Y * 29 + X * 3) > 0.86) & (dp < 0.17)
    blend(pebble.astype(np.float32), "ochre", 0.55)
    # river: dusty teal band, lighter wave lines, darker bank line
    rs = 0.44 * np.cos(0.55 * Y + 0.5)
    dr = np.abs(X - river_x(Y)) / np.sqrt(1 + rs**2)
    blend(1 - ss(0.50, 0.515, dr), "teal", 1.0)
    waves = (np.sin(Y * 15 + 2.5 * np.sin(X * 6.0)) > 0.90) & (dr < 0.42)
    blend(waves.astype(np.float32), "core", 0.55)
    deep = (np.sin(Y * 7 + 3.0 * np.sin(X * 3.0) + 1.0) > 0.8) & (dr < 0.3)
    blend(deep.astype(np.float32), "moss", 0.18)
    blend(((dr > 0.50) & (dr < 0.535)).astype(np.float32), "brown", 0.55)
    # tile score lines every 2 units and a double printed border
    dx = np.abs(((X + 1) % 2) - 1)
    dy = np.abs(((Y + 1) % 2) - 1)
    blend(1 - ss(0.005, 0.013, np.minimum(dx, dy)), "brown", 0.16)
    d = np.minimum(PXH - np.abs(X), PYH - np.abs(Y))
    blend((np.abs(d - 0.26) < 0.014).astype(np.float32), "brown", 0.6)
    blend((np.abs(d - 0.33) < 0.005).astype(np.float32), "brown", 0.5)
    # aged edges
    img *= (0.90 + 0.10 * ss(0.0, 1.3, d))[..., None]
    rgba = np.concatenate([np.clip(img, 0, 1), np.ones((H, W, 1), np.float32)], axis=2)
    im = bpy.data.images.new("page_print", W, H, alpha=False)
    im.pixels.foreach_set(rgba.ravel())
    im.pack()
    return im


def page_material():
    im = paint_page()
    mat = bpy.data.materials.new("page")
    mat.use_nodes = True

    def fn(nt, sock):
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Location"].default_value = (0.5, 0.5, 0)
        mp.inputs["Scale"].default_value = (1 / (2 * PXH), 1 / (2 * PYH), 1)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = im
        tex.extension = "EXTEND"
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], sock)
    paper_nodes(mat, fn, bump=0.55, mottle=0.07, wavy=2.0)
    return mat


def simple_mat(name, hexcol, rough=0.6, wood=False, stripes=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Base Color"].default_value = hexl(hexcol)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    if wood:
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (0.05, 1.0, 1.0)
        mp.inputs["Rotation"].default_value = (0, 0, 0.35)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 1.4
        nz.inputs["Detail"].default_value = 8
        nz.inputs["Roughness"].default_value = 0.62
        nz.inputs["Distortion"].default_value = 1.2
        nt.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.25
        ramp.color_ramp.elements[0].color = hexl("#22130B")
        ramp.color_ramp.elements[1].position = 0.75
        ramp.color_ramp.elements[1].color = hexl("#55331E")
        nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        r2 = nt.nodes.new("ShaderNodeMapRange")
        r2.inputs["To Min"].default_value = 0.32
        r2.inputs["To Max"].default_value = 0.55
        nt.links.new(nz.outputs["Fac"], r2.inputs["Value"])
        nt.links.new(r2.outputs[0], bsdf.inputs["Roughness"])
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = 0.15
        nt.links.new(nz.outputs["Fac"], bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
    if stripes:  # stacked page edges
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (0.4, 0.4, 150.0)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 1.0
        nz.inputs["Detail"].default_value = 2
        nt.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.3
        ramp.color_ramp.elements[0].color = hexl("#B9A27A")
        ramp.color_ramp.elements[1].position = 0.7
        ramp.color_ramp.elements[1].color = hexl("#EFE4CB")
        nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = 0.6
        bmp.inputs["Distance"].default_value = 0.01
        nt.links.new(nz.outputs["Fac"], bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


# ---------------------------------------------------------------- book and table
def gutter_z(x):
    return -0.30 * math.exp(-abs(x) / 0.16) - 0.05 * max(0.0, abs(x) - 7.6) ** 2


def build_book():
    xs = sorted(set([round(-PXH + i * 0.2, 3) for i in range(int(2 * PXH / 0.2) + 1)]
                    + [round(s * v, 3) for s in (-1, 1) for v in (0.02, 0.05, 0.1, 0.15, 0.25, 0.35, 0.5, 0.7)] + [0.0]))
    ys = [-PYH + i * 0.4 for i in range(int(2 * PYH / 0.4) + 1)]
    verts, faces, fm = [], [], []
    nx, ny = len(xs), len(ys)
    for x in xs:
        for y in ys:
            verts.append((x, y, gutter_z(x)))
    for i in range(nx - 1):
        for j in range(ny - 1):
            a = i * ny + j
            faces.append((a, a + ny, a + ny + 1, a + 1))
            fm.append(0)
    base = len(verts)
    zb = -0.5
    # skirt: south, north, west, east sides of the page block
    for i, x in enumerate(xs):
        verts.append((x, -PYH, zb))
        verts.append((x, PYH, zb))
    for i in range(nx - 1):
        faces.append((i * ny, base + 2 * i, base + 2 * (i + 1), (i + 1) * ny))
        fm.append(1)
        faces.append((i * ny + ny - 1, (i + 1) * ny + ny - 1, base + 2 * (i + 1) + 1, base + 2 * i + 1))
        fm.append(1)
    b2 = len(verts)
    verts += [(-PXH, -PYH, zb), (-PXH, PYH, zb), (PXH, -PYH, zb), (PXH, PYH, zb)]
    faces.append((0, ny - 1, b2 + 1, b2))
    fm.append(1)
    faces.append(((nx - 1) * ny, b2 + 2, b2 + 3, (nx - 1) * ny + ny - 1))
    fm.append(1)
    page = new_obj("page", verts, faces, [page_material(), simple_mat("page_edges", "#E2D6BC", 0.9, stripes=True)], fm)
    for p in page.data.polygons:
        p.use_smooth = p.material_index == 0
    # cover board and table
    cx, cy = PXH + 0.3, PYH + 0.3
    v = [(-cx, -cy, zb - 0.1), (cx, -cy, zb - 0.1), (cx, cy, zb - 0.1), (-cx, cy, zb - 0.1),
         (-cx, -cy, zb), (cx, -cy, zb), (cx, cy, zb), (-cx, cy, zb)]
    fcs = [(4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    cover_mats = paper("cover", bump=1.0, rough=0.8, transl=0.0)
    new_obj("cover", v, fcs, [cover_mats[0]])
    s = 70
    new_obj("table", [(-s, -s, zb - 0.1), (s, -s, zb - 0.1), (s, s, zb - 0.1), (-s, s, zb - 0.1)], [(0, 1, 2, 3)],
            [simple_mat("table", PAL["table"], 0.45, wood=True)])


# ---------------------------------------------------------------- pop-up pieces
def place_flap(ob, x, y, angle, yaw=0.0, lift=0.006):
    ob.location = (x, y, lift)
    ob.rotation_euler = (-math.radians(90 - angle), 0, math.radians(yaw))


def glue_tab(name, x, y, w, mats, yaw=0.0, depth=0.11):
    v = [(-w / 2, -depth, 0), (w / 2, -depth, 0), (w / 2, 0, 0), (-w / 2, 0, 0)]
    ob = solidify(new_obj(name, v, [(0, 1, 2, 3)], mats), T * 0.8)
    ob.location = (x, y, 0.007)
    ob.rotation_euler = (0, 0, math.radians(yaw))


def profile_flap(name, us, hs, mats, rows=6, curl=0.03, bow=0.012):
    """Card silhouette standing in local XZ. The top edge follows hs(us). Local +Y is the back."""
    verts, faces = [], []
    hmax = max(hs)
    u0, u1 = us[0], us[-1]
    n = len(us)
    for i, (u, h) in enumerate(zip(us, hs)):
        for j in range(rows + 1):
            v = h * j / rows
            yy = curl * (v / hmax) ** 2 + bow * math.sin(math.pi * (u - u0) / (u1 - u0)) * (v / hmax)
            verts.append((u, yy, v))
    for i in range(n - 1):
        for j in range(rows):
            a = i * (rows + 1) + j
            faces.append((a, a + rows + 1, a + rows + 2, a + 1))
    return solidify(new_obj(name, verts, faces, mats, smooth=True))


def width_flap(name, rows, mats, curl=0.03, cols=4):
    """Card silhouette symmetric about local Z. rows = [(v, half_width, mat_slot)]."""
    verts, faces, fm = [], [], []
    hmax = rows[-1][0]
    for v, w, _ in rows:
        for c in range(cols + 1):
            s = -1 + 2 * c / cols
            verts.append((w * s, curl * (v / hmax) ** 2, v))
    for k in range(len(rows) - 1):
        for c in range(cols):
            a = k * (cols + 1) + c
            faces.append((a, a + 1, a + cols + 2, a + cols + 1))
            fm.append(rows[k + 1][2])
    return solidify(new_obj(name, verts, faces, mats, fm, smooth=True))


def build_hills(tag, cx, cy, width, colours):
    r = random.Random(hash(tag) & 0xFFF)
    n = len(colours)
    for i, colname in enumerate(colours):       # i = 0 is the back layer
        layer = n - 1 - i                       # 0 = front
        w = width * (1.0 - 0.13 * layer)
        hpeak = 1.2 - 0.26 * layer
        us = np.linspace(-w / 2, w / 2, 64)
        t = (us + w / 2) / w
        f1, p1, f2, p2 = r.uniform(0.8, 1.7), r.uniform(0, 6.3), r.uniform(2.2, 3.6), r.uniform(0, 6.3)
        shape = 0.62 + 0.26 * np.sin(2 * math.pi * f1 * t + p1) + 0.12 * np.sin(2 * math.pi * f2 * t + p2)
        hs = hpeak * np.sin(math.pi * t) ** 0.55 * shape + 0.03
        hs += np.array([r.uniform(-0.004, 0.004) for _ in us])
        ob = profile_flap(f"hill_{tag}_{i}", list(us), list(hs), pm(colname, printed=("Z", 2.6, 0.80)), curl=r.uniform(0.01, 0.05))
        y = cy + 0.24 * (i - (n - 1) / 2) + r.uniform(-0.02, 0.02)
        x = cx + r.uniform(-0.25, 0.25)
        ang = fold_deg(cx, cy, tag, layer)
        place_flap(ob, x, y, ang, yaw=r.uniform(-2.5, 2.5))
        glue_tab(f"hilltab_{tag}_{i}", x, y, w * 0.5, pm(colname))


def build_tree(idx, x, y):
    r = random.Random(idx * 7 + 3)
    hgt = r.uniform(0.7, 1.35)
    kind = r.choice(["round", "round", "conifer", "conifer", "poplar"])
    leaf = r.choice(["moss", "moss", "sage", "sage", "ochre", "terracotta"] if kind != "conifer" else ["moss", "moss", "sage"])
    rows = []
    if kind == "round":
        th, rad = 0.36 * hgt, 0.32 * hgt
        rows += [(0, 0.035, 2), (th, 0.03, 2)]
        c = hgt - rad
        for k in range(1, 17):
            v = (c - rad) + 2 * rad * k / 17 + 0.004
            w = rad * math.sqrt(max(1e-4, 1 - ((v - c) / rad) ** 2)) * (1 + 0.07 * math.sin(k * 1.9 + idx))
            rows.append((max(v, th + 0.004 * k), w, 0))
    elif kind == "poplar":
        th = 0.25 * hgt
        rows += [(0, 0.03, 2), (th, 0.028, 2)]
        for k in range(1, 15):
            q = k / 15
            v = th + (hgt - th) * q
            rows.append((v, 0.17 * hgt * math.sin(math.pi * min(1.0, q * 1.05)) ** 0.7 + 0.012, 0))
    else:
        th = 0.2 * hgt
        rows += [(0, 0.035, 2), (th, 0.032, 2)]
        tiers = 3
        for k in range(tiers):
            v0 = th + (hgt - th) * k / tiers
            v1 = th + (hgt - th) * (k + 1.25) / tiers if k < tiers - 1 else hgt
            wide = 0.30 * hgt * (1 - 0.22 * k)
            rows += [(v0 + 0.004 * (k + 1), wide, 0), (min(v1, hgt), 0.03 if k < tiers - 1 else 0.004, 0)]
        rows = sorted(rows, key=lambda q: q[0]) if False else rows
        # keep v monotonic for the grid
        fixed, last = [], -1
        for v, w, m in rows:
            v = max(v, last + 0.003)
            fixed.append((v, w, m))
            last = v
        rows = fixed
    ob = width_flap(f"tree_{idx}", rows, pm(leaf, printed=("dots", 16.0, 0.84)) + pm("brown"), curl=r.uniform(-0.02, 0.06))
    yaw = r.uniform(-14, 14)
    place_flap(ob, x, y, fold_deg(x, y), yaw=yaw)
    glue_tab(f"treetab_{idx}", x, y, 0.16, pm("brown"), yaw=yaw, depth=0.09)


def build_house(idx, x, y, yaw, wallc, roofc):
    r = random.Random(idx * 13 + 1)
    w, d, h, rh = r.uniform(0.8, 1.0), r.uniform(0.6, 0.72), r.uniform(0.56, 0.68), r.uniform(0.36, 0.44)
    a = math.radians(fold_deg(x, y))
    ca, sa = math.cos(a), math.sin(a)

    def sh(p):  # box pop-ups collapse as a parallelogram
        return (p[0] + p[2] * ca, p[1], p[2] * sa)
    hw, hd, o = w / 2, d / 2, 0.07
    v = [(-hw, -hd, 0), (hw, -hd, 0), (hw, hd, 0), (-hw, hd, 0),
         (-hw, -hd, h), (hw, -hd, h), (hw, hd, h), (-hw, hd, h),
         (-hw, 0, h + rh), (hw, 0, h + rh)]
    f = [(0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 9, 5), (3, 0, 4, 8, 7)]
    fm = [0, 0, 0, 0]
    # roof: one folded sheet with overhang
    k = (hd + o) / hd
    zo = h + rh - rh * k
    rv = [(-hw - o, -hd - o, zo), (hw + o, -hd - o, zo), (hw + o, 0, h + rh + 0.012), (-hw - o, 0, h + rh + 0.012),
          (hw + o, hd + o, zo), (-hw - o, hd + o, zo)]
    rv = [(px_, py_, pz_ + 0.024) for px_, py_, pz_ in rv]  # the roof sheet sits on top of the walls
    b = len(v)
    v += rv
    f += [(b, b + 1, b + 2, b + 3), (b + 3, b + 2, b + 4, b + 5)]
    fm += [2, 2]
    ob = solidify(new_obj(f"house_{idx}", [sh(p) for p in v], f, pm(wallc) + pm(roofc, printed=("Y", 3.6, 0.74)), fm), T, offset=-1)
    ob.location = (x, y, 0.004)
    ob.rotation_euler = (0, 0, math.radians(yaw))
    # printed door and windows on the south and east walls
    e = 0.0015
    dv, df, dm = [], [], []

    def quad(pts, mi):
        s = len(dv)
        dv.extend(sh(p) for p in pts)
        df.append((s, s + 1, s + 2, s + 3))
        dm.append(mi)
    yq = -hd - e
    dx = r.uniform(-0.12, 0.12)
    quad([(dx - 0.07, yq, 0.0), (dx + 0.07, yq, 0.0), (dx + 0.07, yq, 0.30), (dx - 0.07, yq, 0.30)], 0)
    for wx in (-hw + 0.17, hw - 0.17):
        if abs(wx - dx) > 0.2:
            quad([(wx - 0.07, yq, 0.27), (wx + 0.07, yq, 0.27), (wx + 0.07, yq, 0.43), (wx - 0.07, yq, 0.43)], 1)
    xq = hw + e
    quad([(xq, -0.09, 0.27), (xq, 0.09, 0.27), (xq, 0.09, 0.43), (xq, -0.09, 0.43)], 1)
    xq = -hw - e
    quad([(xq, 0.09, 0.27), (xq, -0.09, 0.27), (xq, -0.09, 0.43), (xq, 0.09, 0.43)], 1)
    dec = new_obj(f"house_print_{idx}", dv, df, [paper("brown")[0], paper("teal")[0]], dm)
    dec.location = ob.location
    dec.rotation_euler = ob.rotation_euler
    glue_tab(f"housetab_{idx}", x - 0.0, y - hd * math.cos(math.radians(yaw)), w * 0.7, pm(wallc), yaw=yaw, depth=0.1)


def build_bridge(x, y):
    a = math.radians(fold_deg(x, y))
    zs = max(0.08, math.sin(a))
    length, wd = 2.1, 0.56
    n = 40
    us = np.linspace(-length / 2, length / 2, n)
    deck = 0.50 * np.cos(math.pi * us / length) ** 0.9
    verts, faces = [], []
    for u, z in zip(us, deck):
        verts += [(u, -wd / 2, z * zs), (u, wd / 2, z * zs)]
    for i in range(n - 1):
        faces.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
    ob = solidify(new_obj("bridge_deck", verts, faces, pm("ochre"), smooth=True), T, offset=-1)
    ob.location = (x, y, 0.004)
    # side walls: band from the arch opening up to a parapet above the deck
    ro, ho = 0.62, 0.33
    for side in (-1, 1):
        verts, faces = [], []
        rows = 5
        for u, z in zip(us, deck):
            lo = ho * math.sqrt(max(0.0, 1 - (u / ro) ** 2)) if abs(u) < ro else 0.0
            hi = z + 0.15 * (0.35 + 0.65 * math.cos(math.pi * u / length))
            hi = max(hi, lo + 0.05)
            for j in range(rows + 1):
                verts.append((u, side * (wd / 2 + 0.012), (lo + (hi - lo) * j / rows) * zs))
        for i in range(n - 1):
            for j in range(rows):
                q = i * (rows + 1) + j
                faces.append((q, q + rows + 1, q + rows + 2, q + 1))
        wall = solidify(new_obj(f"bridge_wall_{side}", verts, faces, pm("terracotta", printed=("Z", 4.5, 0.78)), smooth=True))
        wall.location = (x, y, 0.004)
    for sx in (-1, 1):
        glue_tab(f"bridgetab_{sx}", x + sx * (length / 2 + 0.0), y, 0.5, pm("ochre"), yaw=90 * sx, depth=0.14)


def build_traveller(x, y, yaw):
    root = bpy.data.objects.new("traveller", None)
    COL.objects.link(root)
    root.location = (x, y, 0.012)
    root.rotation_euler = (math.radians(-20), math.radians(5), math.radians(yaw))

    def piece(name, polys, col, layer, th=0.013):
        verts, faces = [], []
        for poly in polys:
            s = len(verts)
            verts += [(px, 0.0, pz) for px, pz in poly]
            faces.append(tuple(range(s, s + len(poly))))
        ob = solidify(new_obj("trav_" + name, verts, faces, pm(col)), th)
        ob.parent = root
        ob.location = (0, -0.0125 * layer, 0)
        return ob

    def leg(hx, ax, lift=0.0):
        return [(hx - 0.022, 0.20), (hx + 0.022, 0.20), (ax + 0.02, 0.055 + lift), (ax + 0.075, 0.022 + lift),
                (ax - 0.022, 0.022 + lift), (ax - 0.022, 0.055 + lift)]

    def circle(cx, cz, rad, n=18, sx=1.0):
        return [(cx + rad * sx * math.cos(2 * math.pi * k / n), cz + rad * math.sin(2 * math.pi * k / n)) for k in range(n)]
    piece("base", [[(-0.15, 0.0), (0.16, 0.0), (0.16, 0.026), (-0.15, 0.026)]], "cream", 0)
    piece("legs", [leg(-0.012, -0.085, 0.012), leg(0.004, 0.068)], "brown", 0)
    piece("coat", [[(-0.068, 0.165), (0.062, 0.172), (0.052, 0.30), (0.04, 0.392), (-0.036, 0.392), (-0.058, 0.30)]],
          "terracotta", 1)
    piece("head", [circle(0.012, 0.452, 0.058)], "skin", 1)
    piece("strap", [[(0.018, 0.392), (0.04, 0.392), (-0.034, 0.262), (-0.056, 0.262)]], "brown", 2)
    piece("hat", [[(-0.098, 0.494), (0.124, 0.486), (0.118, 0.510), (-0.092, 0.518)],
                  [(-0.046, 0.514), (0.056, 0.510), (0.044, 0.584), (-0.034, 0.588)]], "brown", 2)
    piece("scarf", [[(-0.038, 0.384), (0.046, 0.384), (0.046, 0.412), (-0.038, 0.412)],
                    [(-0.03, 0.408), (-0.135, 0.436), (-0.128, 0.388), (-0.03, 0.39)]], "teal", 3)
    piece("satchel", [[(-0.082, 0.186), (0.002, 0.182), (0.006, 0.262), (-0.08, 0.266)]], "ochre", 4)
    piece("satchel_flap", [[(-0.084, 0.228), (0.008, 0.224), (0.008, 0.268), (-0.082, 0.272)]], "brown", 5, th=0.01)
    piece("staff", [[(0.088, 0.43), (0.102, 0.43), (0.146, 0.03), (0.132, 0.03)]], "brown", 3)
    piece("arm", [[(0.0, 0.368), (0.036, 0.376), (0.112, 0.275), (0.086, 0.252)]], "terracotta", 4)
    piece("eye", [circle(0.04, 0.458, 0.0075, 8)], "brown", 2, th=0.003)
    piece("hatband", [[(-0.044, 0.516), (0.055, 0.512), (0.053, 0.530), (-0.042, 0.534)]], "ochre", 3, th=0.004)
    piece("hand", [circle(0.103, 0.262, 0.02, 12)], "skin", 5, th=0.01)
    # fold-out tab base: glued flat on the page behind the figure
    tab = solidify(new_obj("trav_tab", [(-0.15, 0.0, 0), (0.16, 0.0, 0), (0.14, 0.2, 0), (-0.13, 0.2, 0)], [(0, 1, 2, 3)],
                           pm("cream")), 0.013)
    tab.location = (x, y + 0.004, 0.012)
    tab.rotation_euler = (math.radians(4), 0, math.radians(yaw))
    return root


def scatter_trees():
    r = random.Random(4)
    placed = []
    tries = 0
    forced = [(-1.5, -0.75), (-2.9, -2.2), (-3.0, -1.1), (2.0, 0.5), (1.2, -1.6), (4.6, -1.4), (-5.9, -1.0), (-4.5, -0.1),
              (-4.3, -2.6), (-6.9, 3.3), (-7.3, 1.7), (-4.4, 2.5), (-3.3, 3.0)]
    for fx, fy in forced:
        placed.append((fx, fy))
    while len(placed) < 44 and tries < 4000:
        tries += 1
        x, y = r.uniform(-PXH + 0.8, PXH - 0.8), r.uniform(-PYH + 0.8, PYH - 1.6)
        if abs(x) < 0.7 or abs(x - river_x(y)) < 0.85 or abs(y - path_y(x)) < 0.5:
            continue
        if any(math.hypot(x - hx, y - hy) < 0.95 for hx, hy, *_ in HOUSES):
            continue
        if any(abs(x - cx) < w / 2 + 0.2 and -0.9 < y - cy < 1.0 for _, cx, cy, w, _p in HILLS):
            continue
        if any(math.hypot(x - px, y - py) < 0.6 for px, py in placed):
            continue
        if math.hypot(x - CFG["trav"][0], y - CFG["trav"][1]) < 0.7:
            continue
        placed.append((x, y))
    for i, (x, y) in enumerate(placed):
        if math.hypot(x - CFG["trav"][0], y - (CFG["trav"][1] - 0.6)) < 0.55:
            continue  # never hide the traveller behind a tree
        build_tree(i, x, y)


# ---------------------------------------------------------------- build
build_book()
for tag, cx, cy, w, cols in HILLS:
    build_hills(tag, cx, cy, w, cols)
for i, hdef in enumerate(HOUSES):
    build_house(i, *hdef)
build_bridge(*BRIDGE)
scatter_trees()
tx, ty, tyaw = CFG["trav"]
build_traveller(tx, ty, tyaw)

# ---------------------------------------------------------------- light
WB = 3900                      # camera white balance, kelvin
KEY_T, FILL_T = 3000, 8000
KEY_AZ, KEY_EL = 212, 32       # azimuth: direction from target to light, 270 = south (toward camera)
tgt = Vector(CFG["target"])


def aim(ob, at):
    ob.rotation_euler = (Vector(at) - ob.location).to_track_quat("-Z", "Y").to_euler()


def sph(az, el, dist):
    a, e = math.radians(az), math.radians(el)
    return Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e))) * dist


kd = bpy.data.lights.new("key", "AREA")
kd.shape = "DISK"
kd.size = 3.2
kd.energy = CFG["key_power"]
kd.color = light_rgb(KEY_T, WB)
key = bpy.data.objects.new("key", kd)
COL.objects.link(key)
key.location = tgt + sph(KEY_AZ, KEY_EL, CFG["key_dist"])
aim(key, tgt)

fd = bpy.data.lights.new("fill", "AREA")
fd.shape = "RECTANGLE"
fd.size = 14
fd.size_y = 14
fd.energy = CFG["key_power"] * 0.13
fd.color = light_rgb(FILL_T, WB)
fill = bpy.data.objects.new("fill", fd)
COL.objects.link(fill)
fill.location = tgt + sph(40, 62, CFG["key_dist"] * 1.4)
aim(fill, tgt)

world = bpy.data.worlds.new("w")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = tuple(0.5 * np.array(light_rgb(FILL_T, WB))) + (1,)
bg.inputs["Strength"].default_value = 0.035
scene.world = world

# ---------------------------------------------------------------- camera
FOCAL = 100.0
cd = bpy.data.cameras.new("cam")
cd.lens = FOCAL
cd.sensor_width = 36
cd.clip_start = 0.5
cd.clip_end = 400
cam = bpy.data.objects.new("cam", cd)
COL.objects.link(cam)
dist = CFG["width"] * FOCAL / 36.0
cam.location = tgt + sph(CFG["az"], CFG["pitch"], dist)
aim(cam, tgt)
focus_pt = Vector((tx, ty - 0.02, 0.30))
cd.dof.use_dof = True
cd.dof.focus_distance = (focus_pt - cam.location).dot((tgt - cam.location).normalized())
cd.dof.aperture_fstop = CFG["fstop"]
cd.dof.aperture_blades = 7
scene.camera = cam

# ---------------------------------------------------------------- render
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dv in prefs.devices:
        dv.use = True
    scene.cycles.device = "GPU"
except Exception as exc:  # CPU fallback
    print("GPU not available:", exc)
scene.cycles.samples = 64 if DRAFT else 320
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.02 if DRAFT else 0.008
scene.cycles.use_denoising = True
scene.cycles.denoiser = "OPENIMAGEDENOISE"
scene.cycles.max_bounces = 6
scene.cycles.filter_width = 1.6
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.resolution_percentage = 60 if DRAFT else 100
scene.render.image_settings.file_format = "PNG"
scene.view_settings.view_transform = "AgX"
for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        pass
scene.view_settings.exposure = -1.0
out_dir = os.path.join(ROOT, "reference", "concept", "drafts" if DRAFT else "")
os.makedirs(out_dir, exist_ok=True)
tagv = argv[argv.index("--tag") + 1] if "--tag" in argv else ""
out = os.path.join(out_dir, f"concept_{FRAME:02d}{tagv}.png")
scene.render.filepath = out
bpy.ops.render.render(write_still=True)

# ---------------------------------------------------------------- photographic finish: vignette + fine grain
im = bpy.data.images.load(out)
w, h = im.size
px = np.empty(w * h * 4, dtype=np.float32)
im.pixels.foreach_get(px)
px = px.reshape(h, w, 4)
yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
rr = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (w / 2)) ** 2)
vig = 1 - 0.20 * np.clip(rr, 0, 1.2) ** 2.2
g = np.random.default_rng(FRAME).normal(0, 0.011, (h, w, 1)).astype(np.float32)
px[..., :3] = np.clip(px[..., :3] * vig[..., None] + g * (0.6 + 0.8 * (1 - px[..., :3])), 0, 1)
im.pixels.foreach_set(px.ravel())
im.filepath_raw = out
im.file_format = "PNG"
im.save()
print("WROTE", out, "focus", cd.dof.focus_distance, "dist", dist)
