"""Rebuild upper_body.npz from the MakeHuman 1.x base mesh (hm08).

    python3 extract.py <dir with human_full_size.json and mediapipe_to_makehuman.json>

Source: npm makehuman-data-v1@0.0.2 (MakeHuman 1.x system assets: models/human_full_size.json,
three.js JSON format 3).  MakeHuman released its bundled graphical assets as CC0; credit
"MakeHuman team".  mediapipe_to_makehuman.json maps each MediaPipe face landmark to a point on
the base mesh (from a front render, made for Roja).

Kept: body vertices only (index < 13380; the rest is helper geometry), the head, neck, torso
and upper arms (no forearms or hands, no legs), as triangles.  Stored in MakeHuman units
(decimetres, Y up, Z forward); hairbake/head.py fits them to the canonical head frame.
"""
import json, os, sys
import numpy as np

REGIONS = {'head': 0, 'neck': 1, 'torso': 2, 'arm': 3}


def region_of(bone):
    b = bone.split('____')[0]
    if b.startswith('neck'):
        return 'neck'
    if b.startswith(('spine', 'clavicle', 'breast', 'shoulder', 'pelvis', 'root')):
        return 'torso'
    if b.startswith('upperarm'):
        return 'arm'
    if b.startswith(('lowerarm', 'wrist', 'finger', 'metacarpal', 'upperleg', 'lowerleg', 'foot', 'toe')):
        return None
    return 'head'


def main(src):
    b = json.load(open(os.path.join(src, 'human_full_size.json')))
    V = np.array(b['vertices'], np.float64).reshape(-1, 3)
    names = [x['name'] for x in b['bones']]
    SI = np.array(b['skinIndices']).reshape(-1, 4); SW = np.array(b['skinWeights']).reshape(-1, 4)
    dom = SI[np.arange(len(SI)), SW.argmax(1)]
    reg = np.array([REGIONS.get(region_of(names[i]), 255) for i in dom], np.uint8)
    F = b['faces']; nuv = len(b.get('uvs') or [])
    i = 0; tris = []
    while i < len(F):
        t = F[i]; i += 1; n = 4 if t & 1 else 3
        vs = F[i:i + n]; i += n
        if t & 2: i += 1
        for _ in range(nuv):
            if t & 4: i += 1
            if t & 8: i += n
        if t & 16: i += 1
        if t & 32: i += n
        if t & 64: i += 1
        if t & 128: i += n
        if max(vs) >= 13380 or any(reg[v] == 255 for v in vs):
            continue
        tris += [[vs[0], vs[1], vs[2]], [vs[0], vs[2], vs[3]]] if n == 4 else [list(vs)]
    T = np.array(tris, np.int64)
    used = np.unique(T)
    remap = -np.ones(len(V), np.int64); remap[used] = np.arange(len(used))
    m = json.load(open(os.path.join(src, 'mediapipe_to_makehuman.json')))['map']
    lm = np.full((468, 3), np.nan, np.float32)
    for k, e in enumerate(m[:468]):
        if e is not None and e.get('p') is not None:
            lm[k] = e['p']
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'upper_body.npz')
    np.savez_compressed(out, V=V[used].astype(np.float32), T=remap[T].astype(np.int32), region=reg[used],
                        landmarks=lm, region_names=np.array(list(REGIONS)))
    print(out, len(used), 'vertices', len(T), 'triangles')


if __name__ == '__main__':
    main(sys.argv[1])
