"""Pack baked views into the shipped files (hairstyles/<id>/) and read them back.

Per view (yaw v; tag 'yawm30', 'yaw0', 'yawp30'), four lossless WebP images, all RGB with NO
alpha channel (so no browser can premultiply or drop data on decode):
  <tag>.hair.webp   full resolution:
                      R = S1   primary highlight   } premultiplied by coverage and square-root
                      G = D    diffuse light       } encoded: X * A = scale[X] * (v / 255)^2
                      B = A    coverage            A = v / 255
  <tag>.aux.webp    half resolution (straight values, filled outward past the hair):
                      R = M    depth into the hair, 0..1           M = v / 255
                      G = T    tone, 0 dark .. 1 light             T = v / 255
                      B = S2   secondary highlight per unit coverage, square-root encoded:
                               S2 = scale.S2 * (v / 255)^2   (the runtime multiplies by A)
  <tag>.mask.webp   half resolution:
                      R = shadow  darkening the hair casts on skin / clothes, 0..1
                      G = scalp   where to paint the scalp skin under the hair, 0..1
                      B = head    the head's silhouette (skull, ears, face) in this view, 0..1
  <tag>.depth.webp  half resolution:
                      R = Z       view depth, head units: z = z.min + (z.max - z.min) * v / 255
                      G = face    the canonical face mesh's silhouette in this view, 0..1
                      B = body    the neck, torso and arms of the proxy body, 0..1
style.json describes the frame, the views, the channel layout and the scales (FORMAT.md is
the full specification; LAYOUT below is the single source of the layout).

Texture sides are powers of two (WebGL 1 mipmaps); the half-resolution textures are exactly
half of the full ones, texel centres aligned as GPU bilinear sampling expects.  Each channel
uses only BITS[ch] bits of its 8-bit code (evenly spaced levels, 0 and 255 included; the
runtime always reads v / 255): fewer levels make the lossless files much smaller and the
hair's strand noise hides the steps.
"""
import hashlib, json, os, time
import numpy as np
from PIL import Image
from . import canon
from .head import Frame

FORMAT = 'roja-hairstyle'
VERSION = 1
Z_RANGE = (-1.0, 0.6)
# Default precision of each channel (bits of the 8-bit code actually used; the runtime always
# reads v / 255).  Fewer levels make the lossless files much smaller; the hair's own strand
# noise hides the steps (RMS error under one 8-bit sRGB level on the composite).  A style can
# override them with RENDER['bits'].
BITS = dict(S1=6, D=6, A=7, M=5, T=5, S2=5, Z=7, shadow=6, scalp=7, head=6, face=6, body=6)
LAYOUT = {
    'hair': dict(size='full', mode='RGB', channels=['S1', 'D', 'A'],
                 encoding='S1, D: premultiplied, square-root: X * A = scale[X] * (v/255)^2; A = v/255'),
    'aux': dict(size='half', mode='RGB', channels=['M', 'T', 'S2'],
                encoding='M, T = v/255 (straight); S2 = scale.S2 * (v/255)^2 per unit coverage (straight)'),
    'mask': dict(size='half', mode='RGB', channels=['shadow', 'scalp', 'head'], encoding='v/255'),
    'depth': dict(size='half', mode='RGB', channels=['Z', 'face', 'body'],
                  encoding='Z = z.min + (z.max - z.min) * v/255 (head units, + toward the camera); face, body = v/255'),
}
SQRT_PREMUL = ('D', 'S1')            # full res, premultiplied by A, square-root encoded
SQRT_STRAIGHT = ('S2',)              # half res, straight, square-root encoded
SQRT = SQRT_PREMUL + SQRT_STRAIGHT


def view_tag(yaw):
    y = int(round(yaw))
    return 'yaw0' if y == 0 else ('yawm%d' % -y if y < 0 else 'yawp%d' % y)


def _u8(x, bits=8):
    """0..1 -> 8-bit codes using only 2^bits evenly spaced levels (0 and 255 included)."""
    L = (1 << int(bits)) - 1
    q = np.round(np.clip(np.asarray(x, np.float64), 0, 1) * L) / L
    return np.clip(np.round(q * 255), 0, 255).astype(np.uint8)


def _write_webp(path, arr, mode):
    tmp = path + '.tmp'
    Image.fromarray(arr, mode).save(tmp, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    os.replace(tmp, path)
    return os.path.getsize(path)


def scales_for(views, pct=99.9):
    """shared encoding scales of D, S1 (premultiplied, full res) and S2 (straight, half res)
    over all views: the pct percentile over the covered texels."""
    sc = {}
    for k in SQRT_PREMUL:
        vals = np.concatenate([v[k + 'p'][v['A'] > 0.02] for v in views])
        sc[k] = float(max(np.percentile(vals, pct), 1e-4)) if len(vals) else 1.0
    import cv2
    vals = []
    for v in views:
        Ah = cv2.resize(v['A'], (v['S2'].shape[1], v['S2'].shape[0]), interpolation=cv2.INTER_AREA)
        vals.append(v['S2'][Ah > 0.05])
    vals = np.concatenate(vals)
    sc['S2'] = float(max(np.percentile(vals, pct), 1e-4)) if len(vals) else 1.0
    return sc


def encode_view(v, scale, z_range=Z_RANGE, bits=None):
    """float layers of one view (render.finish_view) -> uint8 arrays per texture."""
    b = dict(BITS, **(bits or {}))
    A = v['A']
    vals = dict(A=A, Z=(v['Z'] - z_range[0]) / (z_range[1] - z_range[0]))
    for k in ('M', 'T', 'shadow', 'scalp', 'head', 'face', 'body'):
        vals[k] = v[k]
    for k in SQRT_PREMUL:
        vals[k] = np.sqrt(np.clip(v[k + 'p'] / scale[k], 0, 1))
    for k in SQRT_STRAIGHT:
        vals[k] = np.sqrt(np.clip(v[k] / scale[k], 0, 1))
    out = {}
    for name, lay in LAYOUT.items():
        out[name] = np.stack([_u8(vals[ch], b[ch]) for ch in lay['channels']], -1)
    hair = out['hair']
    hair[..., :2][hair[..., 2] == 0] = 0          # premultiplied: nothing where there is no coverage
    return out


def head_outline(head_half, fr, eps_px=0.8):
    """the head silhouette of a view as a closed polygon in head units (from the half-res
    head mask), for runtimes that prefer geometry to the mask channel."""
    import cv2
    m = (head_half > 0.5).astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return []
    c = max(cs, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, eps_px, True)[:, 0, :].astype(np.float64)
    res = fr.res / 2
    return np.round(np.stack([fr.x0 + (c[:, 0] + 0.5) / res, fr.y0 + (c[:, 1] + 0.5) / res], -1), 4).tolist()


def write_style(out_dir, style, fr, views, meta_extra=None, bits=None, log=print):
    """write every view's textures and style.json into out_dir.
    style: STYLE dict (id, name, group); fr: the sprite Frame; views: list of
    (yaw, float layers from render.finish_view), D/S1/S2 already exposure-normalised."""
    os.makedirs(out_dir, exist_ok=True)
    scale = scales_for([v for _, v in views])
    total = 0
    vmeta = []
    written = {'style.json'}
    for yaw, v in views:
        tag = view_tag(yaw)
        enc = encode_view(v, scale, bits=bits)
        files = {}
        for name, arr in enc.items():
            fn = f'{tag}.{name}.webp'
            nb = _write_webp(os.path.join(out_dir, fn), arr, LAYOUT[name]['mode'])
            files[name] = fn
            written.add(fn)
            total += nb
            log(f'  {fn}: {arr.shape[1]}x{arr.shape[0]} {nb / 1024:.0f} KB')
        vmeta.append(dict(yaw=float(yaw), **files,
                          anchors=np.round(canon.anchors_xy(yaw), 5).tolist(),
                          head_outline=head_outline(v['head'], fr)))
    H, _ = canon.face_mesh()
    meta = dict(
        format=FORMAT, version=VERSION,
        id=style['id'], name=style.get('name', style['id']), group=style.get('group', ''),
        frame=dict(x0=round(fr.x0, 6), y0=round(fr.y0, 6), x1=round(fr.x1, 6), y1=round(fr.y1, 6),
                   res=round(fr.res, 6), width=fr.W, height=fr.H),
        half=dict(width=fr.W // 2, height=fr.H // 2),
        views=vmeta,
        textures=LAYOUT,
        bits=dict(BITS, **(bits or {})),
        scale={k: round(v, 6) for k, v in scale.items()},
        z=dict(min=Z_RANGE[0], max=Z_RANGE[1]),
        units=('head units: the facemesh.js CANON frame (x across the face, image right; y = CANON_y * '
               'CANON_ASPECT, down; z toward the camera); 1 unit = %.4f cm' % canon.frame_constants()[2]),
        anchors=dict(landmarks=canon.ANCHORS, canonical=np.round(H[canon.ANCHORS], 5).tolist(),
                     pivot=canon.PIVOT.tolist()),
        crossfade=dict(by='head yaw (measure.js pose().yaw, degrees, + = face turned toward image right)',
                       rule='linear between the two nearest view yaws; the outermost view alone beyond them'),
        bytes=int(total),
    )
    meta.update(meta_extra or {})
    meta['bytes'] = int(total)
    tmp = os.path.join(out_dir, 'style.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(out_dir, 'style.json'))
    for old in os.listdir(out_dir):                  # files of an older bake (other views / layout)
        if old not in written and (old.endswith('.webp') or old.endswith('.tmp')):
            os.remove(os.path.join(out_dir, old))
    log(f'  {out_dir}: {len(views)} views, {total / 1024:.0f} KB')
    return meta


# ------------------------------------------------------------------------------- reading
def read_style(style_dir):
    """read a packed style back: dict(meta, frame (head.Frame), views=[dict(yaw, anchors,
    A, Dp, S1p (full res, linear, premultiplied), M, T, S2 (straight), Z, shadow, scalp,
    head, face, body (half res))])."""
    meta = json.load(open(os.path.join(style_dir, 'style.json'), encoding='utf-8'))
    f = meta['frame']
    fr = Frame(f['x0'], f['y0'], f['width'], f['height'], f['res'])
    zr = (meta['z']['min'], meta['z']['max'])
    views = []
    for vm in meta['views']:
        v = dict(yaw=vm['yaw'], anchors=np.array(vm['anchors']))
        for name, lay in meta['textures'].items():
            arr = np.asarray(Image.open(os.path.join(style_dir, vm[name])).convert(lay['mode']), np.float32) / 255
            for i, ch in enumerate(lay['channels']):
                x = arr[..., i]
                if ch in SQRT_PREMUL:
                    v[ch + 'p'] = (x * x * meta['scale'][ch]).astype(np.float32)
                elif ch in SQRT_STRAIGHT:
                    v[ch] = (x * x * meta['scale'][ch]).astype(np.float32)
                elif ch == 'Z':
                    v['Z'] = (zr[0] + (zr[1] - zr[0]) * x).astype(np.float32)
                else:
                    v[ch] = x
        views.append(v)
    return dict(meta=meta, frame=fr, views=views)


def upsample(view, fr, keys=('M', 'T', 'S2', 'Z', 'shadow', 'scalp', 'head', 'face', 'body')):
    """the half-resolution channels of a read view bilinearly upsampled to full resolution
    (texel centres aligned, as the GPU samples them)."""
    import cv2
    out = dict(view)
    for k in keys:
        out[k] = cv2.resize(view[k], (fr.W, fr.H), interpolation=cv2.INTER_LINEAR)
    return out


def file_hash(paths):
    h = hashlib.sha1()
    for p in paths:
        h.update(open(p, 'rb').read())
    return h.hexdigest()[:12]
