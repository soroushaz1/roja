"""Pack baked views into the shipped files (hairstyles/<id>/) and read them back.

Per view (yaw v; tag 'yawm30', 'yaw0', 'yawp30'):
  <tag>.hair.webp   full resolution RGBA, lossless:
                      R = S1, G = D, B = S2   premultiplied by coverage, square-root encoded:
                                              X * A = scale[X] * (v / 255)^2
                      A = coverage            A = v / 255
  <tag>.aux.webp    half resolution RGB, lossless (smooth channels, straight):
                      R = M (depth into the hair, 0..1)
                      G = T (tone, 0 dark .. 1 light)
                      B = Z (view depth, head units: z = zmin + (zmax - zmin) * v / 255)
  <tag>.mask.webp   half resolution RGB, lossless:
                      R = shadow (darkening cast on skin / clothes, 0..1)
                      G = scalp  (where to paint the scalp skin under the hair, 0..1)
                      B = head   (the head's silhouette in this view, 0..1)
style.json describes the frame, the views, the channel layout and the scales (FORMAT.md is
the full specification; LAYOUT below is the single source of the layout).

Texture sides are powers of two (WebGL 1 mipmaps); the half-resolution textures are exactly
half of the full ones, texel centres aligned as GPU bilinear sampling expects.  Alpha in the
hair texture is real coverage and its colour channels are premultiplied, so a browser that
premultiplies on decode loses nothing; the aux and mask textures carry no alpha.
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
BITS = dict(S1=6, D=7, S2=6, A=7, M=6, T=6, Z=7, shadow=7, scalp=7, head=6)
LAYOUT = {
    'hair': dict(size='full', mode='RGBA', channels=['S1', 'D', 'S2', 'A'],
                 encoding='R,G,B = sqrt(X * A / scale[X]) * 255 (premultiplied, square-root); A = coverage * 255'),
    'aux': dict(size='half', mode='RGB', channels=['M', 'T', 'Z'],
                encoding='M, T = value * 255 (straight, filled past the hair); Z = (z - z.min) / (z.max - z.min) * 255'),
    'mask': dict(size='half', mode='RGB', channels=['shadow', 'scalp', 'head'],
                 encoding='value * 255'),
}
SQRT = ('D', 'S1', 'S2')


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
    """shared encoding scales of the premultiplied D, S1, S2 over all views."""
    sc = {}
    for k in SQRT:
        vals = np.concatenate([v[k + 'p'][v['A'] > 0.02] for v in views])
        sc[k] = float(max(np.percentile(vals, pct), 1e-4)) if len(vals) else 1.0
    return sc


def encode_view(v, scale, z_range=Z_RANGE, bits=None):
    """float layers of one view (render.finish_view) -> uint8 arrays per texture."""
    b = dict(BITS, **(bits or {}))
    A = v['A']
    vals = dict(A=A, M=v['M'], T=v['T'], Z=(v['Z'] - z_range[0]) / (z_range[1] - z_range[0]),
                shadow=v['shadow'], scalp=v['scalp'], head=v['head'])
    for k in SQRT:
        vals[k] = np.sqrt(np.clip(v[k + 'p'] / scale[k], 0, 1))
    out = {}
    for name, lay in LAYOUT.items():
        out[name] = np.stack([_u8(vals[ch], b[ch]) for ch in lay['channels']], -1)
    hair = out['hair']
    hair[..., :3][hair[..., 3] == 0] = 0          # premultiplied: nothing where there is no coverage
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
    for yaw, v in views:
        tag = view_tag(yaw)
        enc = encode_view(v, scale, bits=bits)
        files = {}
        for name, arr in enc.items():
            fn = f'{tag}.{name}.webp'
            nb = _write_webp(os.path.join(out_dir, fn), arr, LAYOUT[name]['mode'])
            files[name] = fn
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
        anchors=dict(landmarks=canon.ANCHORS, canonical=np.round(H[canon.ANCHORS], 5).tolist(),
                     pivot=canon.PIVOT.tolist()),
        bytes=int(total),
    )
    meta.update(meta_extra or {})
    meta['bytes'] = int(total)
    tmp = os.path.join(out_dir, 'style.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(out_dir, 'style.json'))
    log(f'  {out_dir}: {len(views)} views, {total / 1024:.0f} KB')
    return meta


# ------------------------------------------------------------------------------- reading
def read_style(style_dir):
    """read a packed style back: dict(meta, frame (head.Frame), views=[dict(yaw, A, Dp,
    S1p, S2p (full res, linear, premultiplied), M, T, Z, shadow, scalp, head (half res,
    straight))])."""
    meta = json.load(open(os.path.join(style_dir, 'style.json'), encoding='utf-8'))
    f = meta['frame']
    fr = Frame(f['x0'], f['y0'], f['width'], f['height'], f['res'])
    zr = (meta['z']['min'], meta['z']['max'])
    views = []
    for vm in meta['views']:
        v = dict(yaw=vm['yaw'], anchors=np.array(vm['anchors']))
        for name in ('hair', 'aux', 'mask'):
            arr = np.asarray(Image.open(os.path.join(style_dir, vm[name])).convert(meta['textures'][name]['mode']), np.float32) / 255
            for i, ch in enumerate(meta['textures'][name]['channels']):
                x = arr[..., i]
                if ch in SQRT:
                    v[ch + 'p'] = (x * x * meta['scale'][ch]).astype(np.float32)
                elif ch == 'Z':
                    v['Z'] = (zr[0] + (zr[1] - zr[0]) * x).astype(np.float32)
                else:
                    v[ch] = x
        views.append(v)
    return dict(meta=meta, frame=fr, views=views)


def upsample(view, fr, keys=('M', 'T', 'Z', 'shadow', 'scalp', 'head')):
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
