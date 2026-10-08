"""Bake one style module into the shipped sprite files.

    cd tools/hair-bake
    python3 -m hairbake.bake <style>            # id (styles/<id>.py), a path, or demo:<name>
            [--q 1.0] [--seed 1] [--views -30,0,30] [--res 256] [--out ../../hairstyles]
            [--no-cache] [--no-preview]

Steps (each logged with its time):
  1. groom: the module's build(rng, q) -> Hair; merged into (N, m, 3) strands + attributes.
     Cached in build/bake/<id>/groom-<key>.npz (key: the style source, the groom library
     sources, q, seed), so re-baking after a shading change skips the groom.
  2. the sprite frame: the hair's bounds over all views + the cranium + margin, at
     RENDER['res'] px per head unit, power-of-two texture sides (render.sprite_frame).
  3. shading (shade.Shader): view-independent parts once (hair + body ambient occlusion per
     direction), then per view the key-light deep shadow and the highlight lobes.
  4. per view: the strands turned by the view's yaw, rasterised against the turned body
     (render.render_hair), the body layers (cast shadow, scalp, head; render.body_layers),
     combined into the shipped channels (render.finish_view).  Each finished view is cached
     in build/bake/<id>/ so a bake killed half way resumes where it stopped.
  5. exposure: one gain for all views, from the front view (median diffuse of the visible
     hair = 0.6), so the views match when the runtime cross-fades them.
  6. pack (pack.write_style): lossless WebP per view + style.json into <out>/<id>/.
  7. preview: build/bake/<id>/preview.png - the packed files read back, every view in a
     dark and a light shade and neutral grey, over the shaded MakeHuman body.

A style module may define RENDER = dict(...) to override render.RENDER (res, taper,
fine_ao_*, soft_r, spec, ...) and LIGHT = dict(...) to override shade.LIGHT.
"""
import argparse, hashlib, json, os, pickle, sys, time
import numpy as np
from . import canon, head, render, shade, pack
from .hair import load_style, PER_STRAND, PER_VERTEX, ROOT as BAKE_ROOT
from .native import BUILD

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DEFAULT = os.path.join(canon.REPO, 'hairstyles')
VIEWS = (-30.0, 0.0, 30.0)
GROOM_SOURCES = ('canon.py', 'head.py', 'scalp.py', 'grow.py', 'strands.py', 'features.py', 'hair.py', 'groom.py', 'demos.py')
RENDER_SOURCES = ('shade.py', 'render.py', 'volume.py', 'raster.c', 'native.py')
PACK_ONLY = ('bits', 'spec')          # RENDER keys that do not change the rendered layers


def _style_path(name):
    if name.startswith('demo:'):
        return os.path.join(HERE, 'demos.py')
    return name if (os.path.sep in name or name.endswith('.py')) else os.path.join(BAKE_ROOT, 'styles', name + '.py')


def _hash(*parts):
    h = hashlib.sha1()
    for p in parts:
        h.update(p if isinstance(p, bytes) else repr(p).encode())
    return h.hexdigest()[:12]


def groom_key(name, q, seed):
    src = [open(_style_path(name), 'rb').read()] + [open(os.path.join(HERE, f), 'rb').read() for f in GROOM_SOURCES]
    return _hash(name, float(q), int(seed), *src)


def groom(mod, name, q, seed, work, cache=True, log=print):
    """(S, attrs, scalp, info) of the style, from the cache when it is current."""
    key = groom_key(name, q, seed)
    path = os.path.join(work, f'groom-{key}.npz')
    spath = os.path.join(work, f'groom-{key}.scalp.pkl')
    if cache and os.path.exists(path) and os.path.exists(spath):
        z = np.load(path)
        S = z['S']
        attrs = {k[2:]: z[k] for k in z.files if k.startswith('a_')}
        scalp = pickle.load(open(spath, 'rb'))
        info = json.loads(str(z['info']))
        log(f'groom: cached {path} ({S.shape[0]} strands x {S.shape[1]})')
        return S, attrs, scalp, info
    t0 = time.time()
    hair = mod.build(np.random.default_rng(seed), q=q, log=log)
    stats, fails = hair.check()
    S, attrs = hair.merged()
    info = dict(strands=int(S.shape[0]), vertices=int(S.shape[1]), seconds=round(time.time() - t0, 1),
                check=dict(stats=stats, fails=fails))
    log(f'groom: {S.shape[0]} strands x {S.shape[1]} vertices in {time.time() - t0:.1f}s; check {"OK" if not fails else fails}')
    if cache:
        try:
            blob = pickle.dumps(hair.scalp)
        except Exception as e:                      # e.g. a lambda in Scalp.exclude
            blob = None
            log(f'groom: not cached (the scalp does not pickle: {e})')
        if blob is not None:
            os.makedirs(work, exist_ok=True)
            for old in os.listdir(work):
                if old.startswith('groom-') and key not in old:
                    os.remove(os.path.join(work, old))
            tmp = path + '.tmp.npz'
            np.savez(tmp, S=S, info=json.dumps(info), **{'a_' + k: v for k, v in attrs.items()})
            os.replace(tmp, path)
            with open(spath + '.tmp', 'wb') as f:
                f.write(blob)
            os.replace(spath + '.tmp', spath)
    return S, attrs, hair.scalp, info


def strand_bounds(S, yaws, step=3, res=48.0, tol=0.03):
    """front-view x0, y0, x1, y1 covering the VISIBLE strands in all these views (hair hidden
    behind the head, neck or body in every view does not widen the frame)."""
    P = np.concatenate([S[:, ::step].reshape(-1, 3), S[:, -1]]).astype(np.float64)
    fr = head.Frame(-1.6, -1.4, int(4.2 * res), int(5.0 * res), res)
    lo = np.array([np.inf, np.inf]); hi = -lo
    for y in yaws:
        Q = canon.rotate_yaw(P, y)
        z, part = head.occluder(fr, y)
        px, py = fr.to_px(Q[:, 0], Q[:, 1])
        ix = np.clip(px.astype(int), 0, fr.W - 1); iy = np.clip(py.astype(int), 0, fr.H - 1)
        vis = Q[:, 2] >= z[iy, ix] - tol
        V = Q[vis, :2] if vis.sum() > 100 else Q[:, :2]
        lo = np.minimum(lo, np.percentile(V, 0.01, axis=0)); hi = np.maximum(hi, np.percentile(V, 99.99, axis=0))
    return float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1])


def exposure_gain(views, target=0.6):
    """one gain for every view: the front view's median diffuse over the solid hair -> target."""
    yaw, v = min(views, key=lambda t: abs(t[0]))
    A = v['A']; m = A > 0.5
    if m.sum() < 50:
        m = A > 0.1
    med = float(np.median(v['Dp'][m] / A[m])) if m.any() else target
    return target / max(med, 1e-4)


def bake(name, q=1.0, seed=1, yaws=VIEWS, res=None, out_root=OUT_DEFAULT, cache=True, preview=True, log=print):
    t_all = time.time()
    mod = load_style(name)
    style = dict(mod.STYLE)
    sid = style['id'].replace(':', '_')
    work = os.path.join(BUILD, 'bake', sid)
    os.makedirs(work, exist_ok=True)
    kw = render.render_kw(getattr(mod, 'RENDER', None), res=res)
    light = dict(shade.LIGHT, **getattr(mod, 'LIGHT', {}))
    S, attrs, scalp, ginfo = groom(mod, name, q, seed, work, cache, log)
    bounds = strand_bounds(S, yaws)
    fr = render.sprite_frame(bounds, kw['res'], kw['margin'], kw['max_side'])
    log(f'frame: {fr} (hair bounds {np.round(bounds, 3).tolist()})')
    rkw = {kk: vv for kk, vv in kw.items() if kk not in PACK_ONLY}
    rkey = _hash(groom_key(name, q, seed), fr.as_list(), sorted(rkw.items()), sorted(light.items()),
                 *[open(os.path.join(HERE, f), 'rb').read() for f in RENDER_SOURCES])
    sh = None
    views = []
    for yaw in yaws:
        vpath = os.path.join(work, f'view-{pack.view_tag(yaw)}-{rkey}.npz')
        if cache and os.path.exists(vpath):
            z = np.load(vpath)
            views.append((yaw, {k: z[k] for k in z.files}))
            log(f'view {yaw:+g}: cached')
            continue
        if sh is None:
            sh = shade.Shader(S, attrs, light=light, log=log)
        t0 = time.time()
        shading = sh.view(yaw)
        hl = render.render_hair(S, attrs, shading, fr, yaw, kw, log=log)
        del shading
        bl = render.body_layers(fr.scaled(0.5), yaw, scalp, shader=sh, log=log)
        v = render.finish_view(hl, bl, fr, pack.Z_RANGE)
        del hl, bl
        if cache:
            tmp = vpath + '.tmp.npz'
            np.savez(tmp, **v)
            os.replace(tmp, vpath)
        views.append((yaw, v))
        log(f'view {yaw:+g}: done in {time.time() - t0:.1f}s')
    del sh
    if cache:                                             # drop view caches of older bakes
        for old in os.listdir(work):
            if old.startswith('view-') and rkey not in old:
                os.remove(os.path.join(work, old))
    k = exposure_gain(views)
    for _, v in views:
        for c in ('Dp', 'S1p', 'S2p'):
            v[c] = v[c] * k
    log(f'exposure gain {k:.3f}')
    out_dir = os.path.join(out_root, style['id'])
    srcp = _style_path(name)
    extra = dict(
        look=dict(spec=float(kw.get('spec', 1.0))),
        light=dict(key=list(light['key']), note='view space: x right, y down, z toward the camera; the direction toward the light'),
        bake=dict(q=q, seed=seed, strands=ginfo['strands'], vertices=ginfo['vertices'],
                  res=round(fr.res, 3), exposure_gain=round(k, 5), source=os.path.relpath(srcp, canon.REPO),
                  source_sha1=hashlib.sha1(open(srcp, 'rb').read()).hexdigest()[:12],
                  render={kk: (list(vv) if isinstance(vv, tuple) else vv) for kk, vv in kw.items()},
                  date=time.strftime('%Y-%m-%d'), seconds=round(time.time() - t_all, 1)),
    )
    meta = pack.write_style(out_dir, style, fr, views, extra, bits=kw.get('bits'), log=log)
    if preview:
        p = os.path.join(work, 'preview.png')
        preview_sheet(out_dir, p, log=log)
    log(f'bake {style["id"]}: {meta["bytes"] / 1024:.0f} KB in {time.time() - t_all:.1f}s -> {out_dir}')
    return out_dir


# ------------------------------------------------------------------------------- preview
PREVIEW_SHADES = (('neutral', '#8A8A8A'), ('dark brown', '#35251E'), ('light blonde', '#CBB088'))


def composite_view(v, fr, dye, base_lin, spec=1.0, shadow_k=0.32, skin=None):
    """a read-back view (pack.read_style + pack.upsample) composited over base_lin (H, W, 3
    linear): scalp skin, cast shadow, recoloured hair.  Reference for the runtime."""
    import cv2
    from .colour import recolour
    A = v['A'][..., None]
    base = base_lin.copy()
    if skin is None:
        skin = np.array([0.45, 0.30, 0.24])
    sa = np.clip(v['scalp'], 0, 1)[..., None]
    sh = np.clip(v['shadow'], 0, 1)[..., None]
    base = base * (1 - sa) + (skin * (0.80 + 0.20 * (1 - sh))) * sa
    shb = cv2.GaussianBlur(v['shadow'], (0, 0), 0.02 * fr.res)[..., None]
    base = base * (1 - shadow_k * shb)
    hair = recolour(v['Dp'], v['S1p'], v['S2p'], v['M'], v['T'], dye, spec=spec)
    return hair + base * (1 - A)


def body_backdrop(fr, yaw):
    """a plain shaded body (skin head and neck, grey-blue clothes) in this view, linear RGB,
    lit by the bake's key light: the preview's stand-in for a photo."""
    from .colour import srgb_to_lin
    z, part, n = head.occluder(fr, yaw, normals=True)
    L = np.asarray(shade.LIGHT['key'], np.float64); L /= np.linalg.norm(L)
    lam = np.clip((n * L).sum(-1), 0, 1)
    skin = srgb_to_lin(np.array([0.78, 0.60, 0.50])); cloth = srgb_to_lin(np.array([0.36, 0.40, 0.48]))
    col = np.where(((part == head.REGION['torso']) | (part == head.REGION['arm']))[..., None], cloth, skin)
    img = col * (0.30 + 0.75 * lam[..., None])
    img[part < 0] = srgb_to_lin(np.array([0.16, 0.16, 0.17]))
    return img.astype(np.float32), skin


def preview_sheet(style_dir, out_png, shades=PREVIEW_SHADES, log=print):
    """the packed files read back and composited (reference recolour) in every view and
    shade over a plain shaded body; rows = shades, columns = views."""
    from PIL import Image, ImageDraw
    from . import preview as pv
    from .colour import lin_to_srgb
    st = pack.read_style(style_dir)
    fr = st['frame']
    spec = st['meta'].get('look', {}).get('spec', 1.0)
    tiles = []
    for v in st['views']:
        vu = pack.upsample(v, fr)
        bg_lin, skin = body_backdrop(fr, v['yaw'])
        for label, dye in shades:
            img = composite_view(vu, fr, dye, bg_lin, spec=spec, skin=skin * 0.8)
            im = Image.fromarray((lin_to_srgb(img) * 255 + 0.5).clip(0, 255).astype(np.uint8))
            d = ImageDraw.Draw(im)
            txt = f"{st['meta']['id']} yaw {v['yaw']:+g} {label}"
            d.rectangle([2, 2, 8 + 6 * len(txt), 15], fill=(0, 0, 0)); d.text((5, 3), txt, fill=(255, 255, 255))
            tiles.append(im)
    n = len(shades)
    sheet = pv.sheet([tiles[i * n + j] for j in range(n) for i in range(len(st['views']))], len(st['views']))
    sc = min(1.0, 2400 / sheet.width)
    if sc < 1:
        sheet = sheet.resize((int(sheet.width * sc), int(sheet.height * sc)), Image.LANCZOS)
    sheet.save(out_png)
    log(f'preview -> {out_png}')
    return out_png


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('style')
    ap.add_argument('--q', type=float, default=1.0)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--views', default=','.join('%g' % v for v in VIEWS))
    ap.add_argument('--res', type=float, default=None, help='px per head unit (default: the style RENDER res or 256)')
    ap.add_argument('--out', default=OUT_DEFAULT, help='output root (default: <repo>/hairstyles)')
    ap.add_argument('--no-cache', action='store_true')
    ap.add_argument('--no-preview', action='store_true')
    a = ap.parse_args()
    yaws = tuple(float(v) for v in a.views.split(','))
    bake(a.style, q=a.q, seed=a.seed, yaws=yaws, res=a.res, out_root=a.out, cache=not a.no_cache,
         preview=not a.no_preview, log=lambda *x: print(*x, flush=True))


if __name__ == '__main__':
    main()
