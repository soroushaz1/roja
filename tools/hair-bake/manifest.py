#!/usr/bin/env python3
"""Write hairstyles/index.json: the list of baked styles the mirror offers.

    cd tools/hair-bake && python3 manifest.py            # scan, render new thumbnails, write
    python3 manifest.py --check                          # exit 1 if index.json is out of date
    python3 manifest.py --no-thumbs                      # list only (keeps thumbnails it has)

Run it after baking, adding or removing a style. The mirror (hairstyle.js) reads only this
file to build its women's and men's grids, and loads a style's own files when it is picked.

Every hairstyles/<id>/ with a valid style.json (FORMAT.md section 7) and all of its view
textures is listed; anything else is skipped with a note, so a style that is being baked
right now never reaches the site half written. A style lists:

    id, name (Persian; the id when style.json has none), group ('women' / 'men'),
    views (the baked yaws), bytes (its textures), rev, thumb

* rev: the first 12 hex digits of the SHA-1 of style.json and every texture it names. The
  mirror adds it to the files' addresses (?r=rev), so a rebaked style is never mixed with
  an older copy from a browser or service-worker cache.
* thumb: a small WebP picture (data: URL, about 2-4 KB) of the style on a plain mannequin
  head, drawn by the reference runtime (hairbake/runtime.py) in a neutral brown and mirrored
  like the mirror itself. It is rendered again only when rev changes.

Order: women first, then men; inside a group by style.json "order" (a number, optional),
then by id.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
STYLES = os.path.join(REPO, 'hairstyles')
INDEX = 'index.json'
FORMAT, VERSION = 'roja-hairstyle', 1
GROUPS = ('women', 'men')
KINDS = ('hair', 'aux', 'mask', 'depth')

THUMB_W, THUMB_H = 160, 200          # px; the grid shows them at about half that, for 2x screens
THUMB_YAW = 0.0                      # a baked view, so the picture is that view exactly
THUMB_SHADE = '#4E3326'              # catalog.js HAIR "chocolate": reads as hair on any screen
THUMB_QUALITY = 80


def note(*a):
    print(*a, file=sys.stderr, flush=True)


def read_style(sdir, sid):
    """(meta, files) of a complete, valid style, or (None, reason)."""
    p = os.path.join(sdir, 'style.json')
    if not os.path.isfile(p):
        return None, 'no style.json'
    try:
        with open(p, encoding='utf-8') as f:
            meta = json.load(f)
    except (OSError, ValueError) as e:
        return None, f'style.json unreadable ({e})'
    if meta.get('format') != FORMAT or meta.get('version') != VERSION:
        return None, f"format {meta.get('format')!r} version {meta.get('version')!r}"
    if meta.get('id') != sid:
        return None, f"id {meta.get('id')!r} is not the folder name"
    if meta.get('group') not in GROUPS:
        return None, f"group {meta.get('group')!r}"
    views = meta.get('views') or []
    if not views:
        return None, 'no views'
    files = ['style.json']
    for v in views:
        for k in KINDS:
            fn = v.get(k)
            if not fn or '/' in fn or '\\' in fn or not os.path.isfile(os.path.join(sdir, fn)):
                return None, f'view {v.get("yaw")}: {k} texture {fn!r} missing'
            files.append(fn)
    fr = meta.get('frame') or {}
    for k in ('x0', 'y0', 'x1', 'y1', 'res', 'width', 'height'):
        if not isinstance(fr.get(k), (int, float)):
            return None, f'frame.{k} missing'
    return meta, files


def revision(sdir, files):
    h = hashlib.sha1()
    for fn in files:
        h.update(fn.encode())
        with open(os.path.join(sdir, fn), 'rb') as f:
            h.update(f.read())
    return h.hexdigest()[:12]


def thumbnail(sdir):
    """the style on a mannequin head, as a data: URL (WebP)."""
    sys.path.insert(0, HERE)
    import numpy as np
    from PIL import Image
    from scipy import ndimage
    from hairbake import canon, colour, head, shade
    from hairbake import runtime as rt

    sp = rt.load_sprite(sdir)
    res = 2.2 * THUMB_W / 1.72                      # px per head unit: ~2.2x the thumbnail, then reduced
    wu, hu = 1.72, 1.72 * THUMB_H / THUMB_W         # head units shown: x -0.36..1.36
    fr = head.Frame(0.5 - wu / 2, -0.56, int(round(wu * res)), int(round(hu * res)), res)
    yaw = THUMB_YAW
    # A plain studio mannequin: lit skin head and neck, a dark top whose collar is smoothed
    # (the proxy body's polygon edge is jagged), on the mirror's own dark ground.
    _, part, n = head.occluder(fr, yaw, normals=True)
    L = np.asarray(shade.LIGHT['key'], np.float64)
    L /= np.linalg.norm(L)
    lam = np.clip((n * L).sum(-1), 0, 1)[..., None]
    skin = colour.srgb_to_lin(np.array([0.80, 0.63, 0.53]))
    cloth = colour.srgb_to_lin(np.array([0.20, 0.17, 0.19]))
    yy, xx = np.mgrid[0:fr.H, 0:fr.W]
    rr = np.hypot((xx / fr.W - 0.5) * 1.1, (yy / fr.H - 0.42))
    ground = colour.srgb_to_lin(np.array([0.135, 0.095, 0.115]))[None, None, :] * \
        np.clip(1.15 - 0.9 * rr, 0.45, 1.1)[..., None]
    body = ndimage.gaussian_filter((part >= 0).astype(np.float32), 0.004 * res)
    clo = ndimage.gaussian_filter(((part == head.REGION['torso']) | (part == head.REGION['arm'])).astype(np.float32),
                                  0.045 * res)              # a round neckline instead of the mesh's zigzag
    body = np.clip((body - 0.5) * 3 + 0.5, 0, 1)[..., None]
    clo = np.clip((clo - 0.45) * 0.7 * res / 8 + 0.5, 0, 1)[..., None]
    lit = 0.32 + 0.72 * lam
    person = skin * lit * (1 - clo) + cloth * (0.6 + 0.5 * lam) * clo
    img = colour.lin_to_srgb(ground * (1 - body) + person * body).astype(np.float32)

    H, _ = canon.face_mesh()
    P = canon.rotate_yaw(H, yaw)
    px, py = fr.to_px(P[:, 0], P[:, 1])
    lm = np.zeros((478, 3))
    lm[:468, 0], lm[:468, 1] = px, py
    lm[:468, 2] = -P[:, 2] * fr.res / rt.LANDMARK_Z
    out, _ = rt.composite(img, dict(L=lm, M=None), sp, THUMB_SHADE, opts=dict(rt.DEFAULTS, hide=False, grain=0), yaw=yaw)
    im = Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8))
    im = im.transpose(Image.FLIP_LEFT_RIGHT).resize((THUMB_W, THUMB_H), Image.LANCZOS)   # as the mirror shows it
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=THUMB_QUALITY, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def build(root, old, thumbs=True):
    by_id = {s['id']: s for s in (old or {}).get('styles', []) if isinstance(s, dict) and 'id' in s}
    styles = []
    for sid in sorted(os.listdir(root)):
        sdir = os.path.join(root, sid)
        if not os.path.isdir(sdir) or sid.startswith('.'):
            continue
        meta, files = read_style(sdir, sid)
        if meta is None:
            note(f'manifest: skipped {sid}: {files}')
            continue
        rev = revision(sdir, files)
        prev = by_id.get(sid, {})
        thumb = prev.get('thumb') if prev.get('rev') == rev else None
        if thumbs and not thumb:
            note(f'manifest: thumbnail for {sid}')
            thumb = thumbnail(sdir)
        elif not thumb:
            thumb = prev.get('thumb')                 # --no-thumbs keeps an older picture
        name = meta.get('name') if isinstance(meta.get('name'), str) and meta.get('name').strip() else sid
        entry = dict(id=sid, name=name.strip(), group=meta['group'],
                     views=sorted(float(v['yaw']) for v in meta['views']),
                     bytes=int(meta.get('bytes') or sum(os.path.getsize(os.path.join(sdir, f)) for f in files[1:])),
                     rev=rev)
        if isinstance(meta.get('order'), (int, float)):
            entry['order'] = meta['order']
        if thumb:
            entry['thumb'] = thumb
        styles.append(entry)
    styles.sort(key=lambda s: (GROUPS.index(s['group']), s.get('order', 1e9), s['id']))
    return dict(format='roja-hairstyles', version=1,
                note='Written by tools/hair-bake/manifest.py; run it again after baking a style.',
                styles=styles)


def dumps(doc):
    return json.dumps(doc, ensure_ascii=False, indent=1) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=STYLES, help='the hairstyles folder (default <repo>/hairstyles)')
    ap.add_argument('--check', action='store_true', help='exit 1 if index.json is out of date')
    ap.add_argument('--no-thumbs', action='store_true', help='do not render missing thumbnails')
    a = ap.parse_args()
    path = os.path.join(a.root, INDEX)
    old = None
    if os.path.isfile(path):
        try:
            with open(path, encoding='utf-8') as f:
                old = json.load(f)
        except (OSError, ValueError):
            old = None
    if a.check:
        doc = build(a.root, old, thumbs=False)
        stale = [s['id'] for s in doc['styles'] if 'thumb' not in s]
        ok = old is not None and dumps(doc) == dumps(old) and not stale
        if not ok:
            note('manifest: hairstyles/index.json is out of date: run python3 tools/hair-bake/manifest.py')
        return 0 if ok else 1
    doc = build(a.root, old, thumbs=not a.no_thumbs)
    text = dumps(doc)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)
    groups = {g: sum(s['group'] == g for s in doc['styles']) for g in GROUPS}
    note(f'manifest: {path}: {len(doc["styles"])} styles ({groups["women"]} women, {groups["men"]} men), '
         f'{len(text.encode()) / 1024:.0f} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
