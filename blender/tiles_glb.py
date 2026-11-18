"""Minimal GLB writer. Input geometry is Z-up; this module converts to glTF Y-up: (x, y, z) -> (x, z, -y)."""
import json
import struct

import numpy as np


def yup(a):
    a = np.asarray(a, np.float32)
    return np.stack([a[..., 0], a[..., 2], -a[..., 1]], axis=-1)


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []
        self.meshes = []
        self.nodes = []
        self.images = []
        self.textures = []
        self.samplers = []
        self.materials = []
        self.roots = []

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin += data
        self.views.append(v)
        return len(self.views) - 1

    def _acc(self, arr, ctype, kind, target, bounds=False):
        a = {'bufferView': self._view(arr.tobytes(), target), 'componentType': ctype, 'count': int(arr.shape[0]),
             'type': kind}
        if bounds:
            a['min'] = [float(v) for v in arr.min(axis=0)]
            a['max'] = [float(v) for v in arr.max(axis=0)]
        self.accessors.append(a)
        return len(self.accessors) - 1

    def add_mesh(self, name, mesh, material=0):
        pos, nor, uv0, uv1, idx, col = mesh
        pos = np.ascontiguousarray(yup(pos), np.float32)
        nor = yup(nor)
        nor = np.ascontiguousarray(nor / np.maximum(np.linalg.norm(nor, axis=1, keepdims=True), 1e-9), np.float32)
        if len(pos) < 65536:
            ia = self._acc(np.ascontiguousarray(idx, np.uint16), 5123, 'SCALAR', 34963)
        else:
            ia = self._acc(np.ascontiguousarray(idx, np.uint32), 5125, 'SCALAR', 34963)
        prim = {'attributes': {
            'POSITION': self._acc(pos, 5126, 'VEC3', 34962, True),
            'NORMAL': self._acc(nor, 5126, 'VEC3', 34962),
            'TEXCOORD_0': self._acc(np.ascontiguousarray(uv0, np.float32), 5126, 'VEC2', 34962),
            'TEXCOORD_1': self._acc(np.ascontiguousarray(uv1, np.float32), 5126, 'VEC2', 34962),
        }, 'indices': ia, 'material': material, 'mode': 4}
        self.meshes.append({'name': name, 'primitives': [prim]})
        return len(self.meshes) - 1

    def add_node(self, name, mesh=None, translation=None, quat=None, extras=None, root=False):
        """translation is a Z-up vector, quat is a Z-up mathutils Quaternion (w, x, y, z)."""
        n = {'name': name}
        if mesh is not None:
            n['mesh'] = mesh
        if translation is not None:
            t = yup(np.array(translation, np.float32))
            if float(np.abs(t).max()) > 0:
                n['translation'] = [round(float(v), 6) for v in t]
        if quat is not None:
            q = [quat.x, quat.z, -quat.y, quat.w]
            if abs(quat.w) < 0.9999999:
                n['rotation'] = [round(float(v), 7) for v in q]
        if extras:
            n['extras'] = extras
        self.nodes.append(n)
        i = len(self.nodes) - 1
        if root:
            self.roots.append(i)
        return i

    def add_child(self, parent, child):
        self.nodes[parent].setdefault('children', []).append(child)

    def add_texture(self, data, mime, repeat):
        self.images.append({'bufferView': self._view(data), 'mimeType': mime})
        wrap = 10497 if repeat else 33071
        self.samplers.append({'magFilter': 9729, 'minFilter': 9987, 'wrapS': wrap, 'wrapT': wrap})
        self.textures.append({'source': len(self.images) - 1, 'sampler': len(self.samplers) - 1})
        return len(self.textures) - 1

    def add_material(self, name, base_tex, normal_tex, roughness=0.92, normal_scale=0.7):
        self.materials.append({
            'name': name,
            'pbrMetallicRoughness': {'baseColorTexture': {'index': base_tex, 'texCoord': 0}, 'metallicFactor': 0.0,
                                     'roughnessFactor': roughness},
            'normalTexture': {'index': normal_tex, 'texCoord': 1, 'scale': normal_scale},
            'doubleSided': False,
        })
        return len(self.materials) - 1

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        doc = {
            'asset': {'version': '2.0', 'generator': 'pop-up-atlas blender/build_tiles.py'},
            'scene': 0, 'scenes': [{'name': 'tiles', 'nodes': self.roots}],
            'nodes': self.nodes, 'meshes': self.meshes, 'materials': self.materials, 'textures': self.textures,
            'images': self.images, 'samplers': self.samplers, 'accessors': self.accessors,
            'bufferViews': self.views, 'buffers': [{'byteLength': len(self.bin)}],
        }
        js = json.dumps(doc, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<4sII', b'glTF', 2, total))
            f.write(struct.pack('<I4s', len(js), b'JSON'))
            f.write(js)
            f.write(struct.pack('<I4s', len(self.bin), b'BIN\x00'))
            f.write(self.bin)
        return total
