"""Render a contact sheet of public/assets/tiles.glb, re-imported through Blender's glTF importer.

Run: blender -b -P blender/preview_tiles.py -- --fold 0 --out blender/tiles_out/popped.png
Options: --fold F (0 popped, 1 flat), --tiles a,b,c, --cols N, --elev DEG, --azim DEG, --res WxH, --zoom Z,
         --neighbours (lay the tiles edge to edge), --samples N
"""
import math
import os
import sys

import bpy
from mathutils import Quaternion
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = dict(fold='0', out=os.path.join(ROOT, 'blender', 'tiles_out', 'preview.png'), tiles='', cols='7', elev='52',
           azim='0', res='2000x1300', zoom='1', samples='40', spacing='2.3')
flags = set()
i = 0
while i < len(argv):
    k = argv[i].lstrip('-')
    if k in opt:
        opt[k] = argv[i + 1]
        i += 2
    else:
        flags.add(k)
        i += 1

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'public', 'assets', 'tiles.glb'))
roots = [o for o in bpy.context.scene.objects if o.parent is None]
tiles = [o for o in roots if o.name.startswith('tile_')]
trav = [o for o in roots if o.name.startswith('traveller')]
if opt['tiles']:
    want = opt['tiles'].split(',')
    keep = [next(o for o in tiles if o.name == 'tile_' + w) for w in want]
    for o in tiles:
        if o not in keep:
            for c in list(o.children_recursive) + [o]:
                bpy.data.objects.remove(c)
    tiles = keep
fold = float(opt['fold'])
for o in bpy.context.scene.objects:
    if 'foldAngle' in o.keys():
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = o.rotation_quaternion @ Quaternion((1, 0, 0), o['foldAngle'] * fold)
cols = int(opt['cols'])
sp = 2.0 if 'neighbours' in flags else float(opt['spacing'])
rows = (len(tiles) + cols - 1) // cols
for n, o in enumerate(tiles):
    o.location = Vector(((n % cols - (cols - 1) / 2) * sp, ((rows - 1) / 2 - n // cols) * sp, 0))
if trav:
    trav[0].location = Vector(((cols - 1) / 2 * sp - (0.0 if len(tiles) % cols else -0.0), -((rows - 1) / 2) * sp - 0.2, 0.0))
    if len(tiles) % cols == 0 and 'neighbours' not in flags:
        trav[0].location = Vector((0.0, -((rows - 1) / 2) * sp - 0.75, 0.0))
    if 'trav_scale' in flags:
        trav[0].scale = (3, 3, 3)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = int(opt['samples'])
scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = 'GPU'
except Exception as e:  # noqa: BLE001
    print('GPU not used:', e)
w, h = (int(v) for v in opt['res'].split('x'))
scene.render.resolution_x, scene.render.resolution_y = w, h
scene.view_settings.view_transform = 'Standard'

world = bpy.data.worlds.new('w')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.62, 0.7, 0.85, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.55
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.4
sun.data.color = (1.0, 0.86, 0.68)
sun.data.angle = math.radians(4)
sun.rotation_euler = (math.radians(48), 0, math.radians(-52))
scene.collection.objects.link(sun)

bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.02))
table = bpy.context.object
mat = bpy.data.materials.new('table')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.16, 0.1, 0.07, 1)
mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.7
table.data.materials.append(mat)

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.type = 'ORTHO'
ext_x = cols * sp + 0.4
ext_y = rows * sp + 1.2
elev, azim = math.radians(float(opt['elev'])), math.radians(float(opt['azim']))
cam.data.ortho_scale = max(ext_x, (ext_y * math.sin(elev) + 1.4 * math.cos(elev)) * w / h) / float(opt['zoom'])
d = Vector((math.sin(azim) * math.cos(elev), -math.cos(azim) * math.cos(elev), math.sin(elev)))
target = Vector((0, -0.2, 0.25))
cam.location = target + d * 60
cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
cam.data.clip_end = 200
scene.render.filepath = opt['out']
bpy.ops.render.render(write_still=True)
print('wrote', opt['out'])
