"""Self-test renders of the library core, to look at after any change to canon / head / native.

    python3 -m hairbake.selftest [--out build/selftest] [--only views,sdf,raster,portraits]
            [--portraits DIR_OF_DETECT_JSON]

views.png      the occluder (MakeHuman head/neck/torso/arms + the canonical face) at yaw
               -30 / 0 / +30, shaded, with the rotated landmarks (white), the anchors (red),
               the canonical frame lines x = 0, .5, 1 and y = 0, CANON_ASPECT (blue), and the
               padded neck outline (cyan).
sdf.png        slices of the collision SDF: inside blue, outside orange, iso lines every
               .05 head units, the surface in black.
raster.png     3000 synthetic long strands grown with gravity and SDF collision, rendered by
               the C rasterizer at the three yaws over the shaded body: back hair must hide
               behind the neck, hair must drape on the shoulders, never cut into the face.
portraits.png  each detected portrait with the fitted head (yellow: skull and face outline,
               cyan: neck) placed by the anchor fit at the photo's own yaw, and the same skull
               placed through the transformation matrix (magenta dashes), anchors red.
"""
import argparse, glob, json, os, time
import numpy as np
import cv2
from PIL import Image, ImageDraw
from . import canon, head
from .native import raster, BUILD

LIGHT = np.array([-0.35, -0.55, 0.76]); LIGHT /= np.linalg.norm(LIGHT)
PART_RGB = {0: (0.86, 0.70, 0.60), 1: (0.80, 0.64, 0.55), 2: (0.55, 0.60, 0.70), 3: (0.50, 0.56, 0.66),
            head.FACE_ID: (0.92, 0.62, 0.62)}


def test_frame(res=160):
    return head.Frame(-0.75, -0.80, int(2.5 * res), int(3.3 * res), res)


def shaded_body(fr, yaw, neck_pad=0.0):
    z, part, n = head.occluder(fr, yaw, neck_pad=neck_pad, normals=True)
    lam = np.clip((n * LIGHT).sum(-1), 0, 1)
    base = np.zeros(part.shape + (3,))
    for k, c in PART_RGB.items():
        base[part == k] = c
    img = base * (0.22 + 0.78 * lam[..., None])
    img[part < 0] = (0.12, 0.12, 0.13)
    return img, z, part


def _u8(img):
    return (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)


def _label(im, text, xy=(6, 4)):
    d = ImageDraw.Draw(im)
    d.rectangle([xy[0] - 2, xy[1] - 1, xy[0] + 7 * len(text) + 2, xy[1] + 12], fill=(0, 0, 0))
    d.text(xy, text, fill=(255, 255, 255))
    return im


def _sheet(ims, cols, pad=4, bg=(30, 30, 30)):
    w = max(i.width for i in ims); h = max(i.height for i in ims)
    rows = (len(ims) + cols - 1) // cols
    S = Image.new('RGB', (cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad), bg)
    for k, im in enumerate(ims):
        S.paste(im, (pad + (k % cols) * (w + pad), pad + (k // cols) * (h + pad)))
    return S


# --------------------------------------------------------------------------------- views
def views(out, yaws=(-30, 0, 30)):
    fr = test_frame(160)
    H, _ = canon.face_mesh()
    ims = []
    for yaw in yaws:
        img, z, part = shaded_body(fr, yaw)
        _, partp = head.occluder(fr, yaw, neck_pad=head.NECK_PAD)
        im = Image.fromarray(_u8(img))
        a = np.array(im)
        # padded neck/torso outline
        m = (partp >= 1) & (partp <= 3)
        cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(a, cs, -1, (0, 220, 255), 1)
        im = Image.fromarray(a)
        d = ImageDraw.Draw(im)
        for x in (0, 0.5, 1):
            px, _ = fr.to_px(x, 0); d.line([(px, 0), (px, fr.H)], fill=(60, 90, 200))
        for y in (0, canon.ASPECT):
            _, py = fr.to_px(0, y); d.line([(0, py), (fr.W, py)], fill=(60, 90, 200))
        Hv = canon.rotate_yaw(H, yaw)
        vis = _visible(Hv, fr, z)
        for (x, y), v in zip(Hv[:, :2], vis):
            if v:
                px, py = fr.to_px(x, y); d.point((px, py), fill=(255, 255, 255))
        for x, y in canon.anchors_xy(yaw):
            px, py = fr.to_px(x, y); d.ellipse([px - 2.5, py - 2.5, px + 2.5, py + 2.5], fill=(255, 40, 40))
        ims.append(_label(im, f'yaw {yaw:+d}'))
    S = _sheet(ims, len(ims))
    S.save(os.path.join(out, 'views.png'))
    return S


def _visible(P, fr, z, eps=0.02):
    px, py = fr.to_px(P[:, 0], P[:, 1])
    ix = np.clip(px.astype(int), 0, fr.W - 1); iy = np.clip(py.astype(int), 0, fr.H - 1)
    return P[:, 2] >= z[iy, ix] - eps


# --------------------------------------------------------------------------------- sdf
def _slice_img(D, vox, extent_px=2):
    """D (rows, cols) signed distances -> RGB with iso lines."""
    t = np.clip(np.abs(D) / 0.6, 0, 1)
    inside = np.stack([0.15 + 0.2 * (1 - t), 0.25 + 0.35 * (1 - t), 0.55 + 0.45 * (1 - t)], -1)
    outside = np.stack([0.55 + 0.45 * (1 - t), 0.35 + 0.35 * (1 - t), 0.15 + 0.2 * (1 - t)], -1)
    img = np.where((D < 0)[..., None], inside, outside)
    ph = np.abs(((D / 0.05) + 0.5) % 1 - 0.5)                   # distance to the nearest iso line (in .05 units)
    g = np.hypot(*np.gradient(D / 0.05)) + 1e-6
    line = np.clip(1 - ph / (0.8 * g), 0, 1)
    img = img * (1 - 0.35 * line[..., None])
    zero = np.clip(1 - np.abs(D) / (0.8 * vox), 0, 1)
    return img * (1 - zero[..., None])


def sdf(out, res=140):
    s = head.body_sdf()
    ims = []

    def grid(u0, u1, v0, v1):
        us = np.linspace(u0, u1, int((u1 - u0) * res)); vs = np.linspace(v0, v1, int((v1 - v0) * res))
        return np.meshgrid(us, vs)
    # sagittal x = .5: horizontal axis z (front at right), vertical y down
    Z, Y = grid(-1.3, 0.75, -0.8, 2.2)
    D = s(np.stack([np.full(Z.shape, 0.5), Y, Z], -1))
    ims.append(_label(Image.fromarray(_u8(_slice_img(D, 1 / res))), 'sagittal x=.5 (front right)'))
    # coronal z = -.3: x across, y down
    X, Y = grid(-0.9, 1.9, -0.8, 2.2)
    D = s(np.stack([X, Y, np.full(X.shape, -0.3)], -1))
    ims.append(_label(Image.fromarray(_u8(_slice_img(D, 1 / res))), 'coronal z=-.3'))
    # coronal z = +.15 (through the face)
    D = s(np.stack([X, Y, np.full(X.shape, 0.15)], -1))
    ims.append(_label(Image.fromarray(_u8(_slice_img(D, 1 / res))), 'coronal z=+.15 (face)'))
    for yy in (0.0, 0.45, 1.35):
        X, Z = grid(-0.9, 1.9, -1.3, 0.75)
        D = s(np.stack([X, np.full(X.shape, yy), Z], -1))
        ims.append(_label(Image.fromarray(_u8(_slice_img(D, 1 / res))[::-1]), f'axial y={yy} (front up)'))
    S = _sheet(ims, 3)
    S.save(os.path.join(out, 'sdf.png'))
    return S


# --------------------------------------------------------------------------------- raster
def synthetic_hair(n=3000, length=1.35, steps=36, seed=1):
    """roots on the scalp, grown along the normal then pulled down by gravity, pushed out of
    the body each step: a crude long groom for exercising the core, not a style."""
    s = head.body_sdf()
    c, r = head.skull()
    rng = np.random.default_rng(seed)
    k = np.arange(4 * n) + 0.5
    phi = np.arccos(1 - 2 * k / (4 * n)); th = np.pi * (1 + 5 ** 0.5) * k
    d = np.stack([np.cos(th) * np.sin(phi), -np.cos(phi), np.sin(th) * np.sin(phi)], -1)
    P = c + d * r * 1.6
    P = head.project(P, 0.0, iters=6)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    # scalp: above the hairline at the front, above the ears at the sides, to the nape behind
    front = z - c[2]
    hairline = np.where(front > 0.25, 0.04, np.where(front > -0.05, 0.27, 0.80))
    keep = (y < hairline) & (np.abs(s(P)) < 0.03)
    P = P[keep]
    P = P[rng.permutation(len(P))[:n]]
    N = head.normal(P)
    ds = length / steps
    pts = [P.copy()]
    # combed away from a centre parting: sideways and back, then gravity takes over
    comb = np.stack([np.sign(P[:, 0] - 0.5) * (0.25 + np.abs(P[:, 0] - 0.5)), np.zeros(len(P)), np.full(len(P), -0.45)], -1)
    v = N * 0.5 + comb
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    for i in range(steps):
        v = v + np.array([0, 1.0, 0]) * 0.22
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        P = P + v * ds
        P = head.collide(P, 0.012 + 0.002 * i / steps)
        v = (P - pts[-1]); v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
        pts.append(P.copy())
    return np.stack(pts, 1)                      # (n, steps+1, 3)


def render_strands(S, fr, yaw, colour, width=0.7, opacity=0.85, zocc=None):
    Sv = canon.rotate_yaw(S.reshape(-1, 3), yaw).reshape(S.shape)
    px, py = fr.to_px(Sv[..., 0], Sv[..., 1])
    n, m = S.shape[:2]
    C = colour.shape[-1]
    V = np.zeros((n, m, 5 + C), np.float32)
    V[..., 0] = px; V[..., 1] = py; V[..., 2] = Sv[..., 2]
    V[..., 3] = width; V[..., 4] = opacity * np.linspace(1, 0.3, m)[None]
    V[..., 5:] = colour[:, None, :]
    seg = np.stack([V[:, :-1], V[:, 1:]], 2).reshape(-1, 2, 5 + C)
    order = np.argsort(seg[:, :, 2].mean(1), kind='stable')
    return raster(seg[order], fr.W, fr.H, zocc=zocc)


def raster_test(out, yaws=(-30, 0, 30)):
    fr = test_frame(160)
    S = synthetic_hair()
    az = head.azimuth(S[:, 0])
    hue = (az / (2 * np.pi)) % 1
    col = np.stack([0.5 + 0.5 * np.cos(2 * np.pi * (hue + k / 3)) for k in range(3)], -1) * 0.8 + 0.1
    ims = []
    for yaw in yaws:
        img, _, _ = shaded_body(fr, yaw)
        zocc, _ = head.occluder(fr, yaw, neck_pad=head.NECK_PAD)
        t = time.time()
        o = render_strands(S, fr, yaw, col, zocc=zocc)
        dt = time.time() - t
        comp = img * (1 - o[..., :1]) + o[..., 1:4]
        ims.append(_label(Image.fromarray(_u8(comp)), f'yaw {yaw:+d}  {S.shape[0]} strands  {dt:.2f}s'))
    # 4x zoom of the strand edge at the temple, to check the anti-aliasing of thin and wide strands
    fz = head.Frame(-0.25, -0.30, 320, 320, 640)
    img, _, _ = shaded_body(fz, 0)
    zocc, _ = head.occluder(fz, 0, neck_pad=head.NECK_PAD)
    o1 = render_strands(S[::6], fz, 0, col[::6], width=0.8, zocc=zocc)
    o2 = render_strands(S[::6], fz, 0, col[::6], width=3.5, zocc=zocc)
    z1 = Image.fromarray(_u8(img * (1 - o1[..., :1]) + o1[..., 1:4]))
    z2 = Image.fromarray(_u8(img * (1 - o2[..., :1]) + o2[..., 1:4]))
    zz = Image.new('RGB', (fr.W, fr.H), (30, 30, 30))
    k = fr.H // 2
    zz.paste(z1.resize((k, k), Image.LANCZOS), (0, 0))
    zz.paste(z2.resize((k, k), Image.LANCZOS), (0, k))
    ims.append(_label(zz, 'zoom: 0.8px / 3.5px strands'))
    Sh = _sheet(ims, 4)
    Sh.save(os.path.join(out, 'raster.png'))
    return Sh


# --------------------------------------------------------------------------------- portraits
PORTRAIT_DIRS = [os.path.join(BUILD, 'portraits')]
SCOUT = '/tmp/claude-0/-home-user-roja/e4193bd5-85d5-5100-b764-5ae1f62ae762/scratchpad/ultra/scout/test_portraits/crop512'


IMAGE_DIRS = [SCOUT, os.path.join(canon.REPO, 'tools')]


def _find_image(name):
    for d in IMAGE_DIRS:
        for ext in ('.png', '.jpg'):
            p = os.path.join(d, name + ext)
            if os.path.exists(p):
                return p
    return None


def portraits(out, det_dir=None, public_only=False):
    det_dir = det_dir or PORTRAIT_DIRS[0]
    fr = test_frame(200)
    X, Y = fr.grid()
    ims = []
    for js in sorted(glob.glob(os.path.join(det_dir, '*.json'))):
        name = os.path.basename(js)[:-5]
        if public_only and name.startswith('unk_'):
            continue
        det = canon.load_detection(js)
        src = _find_image(name)
        if det is None or src is None:
            continue
        a = np.array(Image.open(src).convert('RGB'))
        yaw = det['yaw']
        A = canon.head_fit(det['L'], yaw)
        z, part = head.occluder(fr, yaw, neck_pad=0.0)
        for mask, col in (((part == 0) | (part == head.FACE_ID), (255, 220, 0)), ((part >= 1) & (part <= 3), (0, 220, 255))):
            cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            for c in cs:
                c = c[:, 0].astype(np.float64)
                hx = fr.x0 + (c[:, 0] + 0.5) / fr.res; hy = fr.y0 + (c[:, 1] + 0.5) / fr.res
                ix, iy = canon.apply_fit(A, hx, hy)
                cv2.polylines(a, [np.round(np.c_[ix, iy] * 4).astype(np.int32)], True, col, 1, cv2.LINE_AA, shift=2)
        # the skull silhouette through the matrix (perspective), for comparison
        if det['M'] is not None:
            m = head.body_mesh()
            hv = m['V'][(m['region'] == 0)]
            pts, _ = canon.project(det['M'], hv, det['w'], det['h'])
            hull = cv2.convexHull(np.round(pts * 4).astype(np.int32))
            hp = hull[:, 0]
            for k in range(0, len(hp), 2):
                cv2.line(a, tuple(hp[k]), tuple(hp[(k + 1) % len(hp)]), (255, 0, 255), 1, cv2.LINE_AA, shift=2)
        for (x, y), l in zip(canon.anchors_xy(yaw), det['L'][canon.ANCHORS]):
            ix, iy = canon.apply_fit(A, x, y)
            cv2.circle(a, (int(round(l[0])), int(round(l[1]))), 2, (255, 40, 40), -1, cv2.LINE_AA)
            cv2.circle(a, (int(round(ix)), int(round(iy))), 3, (40, 255, 40), 1, cv2.LINE_AA)
        im = Image.fromarray(a).resize((384, 384), Image.LANCZOS)
        ims.append(_label(im, f'{name[:30]} yaw {yaw:+.0f}'))
    if not ims:
        return None
    S = _sheet(ims, 4)
    S.save(os.path.join(out, 'portraits_public.png' if public_only else 'portraits.png'))
    return S


# --------------------------------------------------------------------------------- checks
def checks(det_dir=None):
    """numeric regression checks of the core; returns the list of failures."""
    fails = []

    def ok(cond, what):
        print(('PASS ' if cond else 'FAIL ') + what)
        if not cond:
            fails.append(what)
    # frame
    H, _ = canon.face_mesh()
    ok(abs(H[10, 1] - 0.0283) < 1e-3 and abs(H[152, 1] - 1.1044) < 1e-3 and abs(H[1, 0] - 0.5) < 1e-6,
       'canonical frame: landmark 10 at y .028, 152 at y 1.104, nose on x = .5')
    ok(H[33, 0] < 0.5 < H[263, 0], "subject's right eye (33) on the image left: the frame is not mirrored")
    P = np.array([[0.2, 0.1, 0.3]])
    ok(np.allclose(canon.model_to_head(canon.head_to_model(P)), P), 'model <-> head units round trip')
    ok(np.allclose(canon.rotate_yaw(canon.rotate_yaw(H, 30), -30), H), 'yaw rotation inverts')
    Hv = canon.rotate_yaw(H, 30)
    ok(Hv[1, 0] > H[1, 0] + 0.1, '+yaw turns the nose toward +x (image right)')
    # raster
    W = Hh = 32
    seg = np.array([[[4, 16.5, 0, 1, 1, 1], [28, 16.5, 0, 1, 1, 1]]], np.float32)
    o = raster(seg, W, Hh)
    a = o[16, 8:24, 0]
    ok(0.55 < a.mean() < 0.75 and o[10, 16, 0] == 0, f'raster: a 1 px opaque strand deposits alpha ~.63 ({a.mean():.2f}) and nothing far off')
    ok(abs(o[16:18, 8:24, 1].sum() / o[16:18, 8:24, 0].sum() - 1) < 1e-4, 'raster: channels are premultiplied')
    zo = np.full((Hh, W), 1.0, np.float32)
    ok(raster(seg, W, Hh, zocc=zo)[..., 0].max() == 0, 'raster: a strand behind the occluder is hidden')
    o2 = raster(seg, W, Hh, zocc=None, zsoft=np.full((Hh, W), 1.0, np.float32), asoft=np.full((Hh, W), 0.5, np.float32))
    ok(abs(o2[16, 8:24, 0].mean() / (1 - (1 - a.mean()) ** 0.5) - 1) < 0.25 and o2[16, 8:24, 0].mean() < a.mean(),
       'raster: the soft occluder scales coverage')
    wide = raster(np.array([[[4, 16, 0, 6, 1, 1], [28, 16, 0, 6, 1, 1]]], np.float32), W, Hh)[:, 16, 0]
    ok(wide[13:19].min() > 0.6 and wide[11] == 0 and wide[20] == 0, 'raster: a 6 px strand covers 6 rows, edge to edge')
    # tri_zbuf
    from .native import tri_zbuf
    T = np.array([[[0, 0, 0.0], [32, 0, 0], [0, 32, 0]], [[0, 0, 1.0], [32, 0, 1], [0, 32, 1]]], np.float32)
    z, at = tri_zbuf(T, 32, 32, np.array([[[1], [1], [1]], [[2], [2], [2]]], np.float32))
    ok(z[2, 2] == 1 and at[2, 2, 0] == 2 and z[30, 30] < -1e8, 'tri_zbuf: the nearer triangle wins, empty stays empty')
    # body and SDF
    m = head.body_mesh()
    ok(m['rms'] < 0.035, f'MakeHuman landmark fit rms {m["rms"]:.4f} < .035')
    ok(np.median(m['gap']) < 0.004 and np.percentile(m['gap'], 99) < 0.03,
       f'warped MakeHuman face within {np.median(m["gap"]):.4f} (median) of the canonical face')
    top = m['V'][np.unique(m['T']), 1].min()
    ok(abs(top - head.SKULL_TOP) < 0.01, f'skull top at {top:.3f}')
    sdf = head.body_sdf()
    c, _ = head.skull()
    q = np.array([c, [0.5, -1.2, 0.0], [0.5, 0.2, 0.6], [0.5, 0.6, -0.5], [0.5, 1.6, -0.3], [0.0, 1.0, -0.3]])
    d = sdf(q)
    ok(d[0] < -0.2 and d[1] > 0.3 and d[2] > 0.1 and d[3] < 0 and d[4] < 0 and d[5] > 0,
       'SDF signs: skull centre, above, in front of the face, inside the head, torso inside, beside the neck outside')
    ok(abs(sdf(H[[10, 1, 152, 234]])).max() < 0.012, 'SDF ~0 on the canonical face (forehead, nose, chin, cheek)')
    p = canon.rotate_yaw(np.array([[0.5, -0.2, 0.0]]), 0)
    pc = head.collide(p, 0.02)
    ok(abs(sdf(pc)[0] - 0.02) < 0.006, 'collide pushes a point inside the skull out to the requested distance')
    pr = head.project(np.array([[0.5, -0.9, -0.3]]), 0.0)
    ok(abs(sdf(pr)[0]) < 0.006, 'project lands on the surface')
    # occlusion: hair rooted on the back of the head must never show over the face or the
    # neck (silhouettes eroded 4 px = .01: hair resting on the back of the neck may
    # overlap its edge by its own thickness), in any of the three views (on the scalp it may: the
    # back of the skull is in sight at +-30 degrees; so may hair lying on the shoulder top in
    # front of the neck's base, below y 1.25 where the neck flares into the trapezius)
    Sh = synthetic_hair(1500)
    back = np.abs(head.azimuth(Sh[:, 0])) > 2.2
    fr = head.Frame(-0.4, -0.6, 720, 880, 400)
    leaks = []
    for yaw in (-30, 0, 30):
        zocc, part = head.occluder(fr, yaw)
        o = render_strands(Sh[back], fr, yaw, np.ones((back.sum(), 1), np.float32), zocc=zocc)
        from scipy import ndimage
        inner = ndimage.binary_erosion((part == 1) | (part == head.FACE_ID), iterations=4)
        inner &= fr.grid()[1] < 1.25
        leaks.append(float(o[..., 0][inner].max()) if inner.any() else 0.0)
    ok(max(leaks) < 0.08, f'no back hair over the face or the neck (max alpha {max(leaks):.3f})')
    # photos
    det_dir = det_dir or PORTRAIT_DIRS[0]
    js = sorted(glob.glob(os.path.join(det_dir, '*.json')))
    errs, signs, names = [], [], []
    for j in js:
        det = canon.load_detection(j)
        if det is None:
            continue
        L = det['L']
        for sgn in (1, -1):
            A = canon.head_fit(L, sgn * det['yaw'])
            x, y = canon.apply_fit(A, *canon.anchors_xy(sgn * det['yaw']).T)
            e = np.hypot(x - L[canon.ANCHORS, 0], y - L[canon.ANCHORS, 1]).mean() / np.hypot(*(L[33, :2] - L[263, :2]))
            (errs if sgn == 1 else signs).append(e)
        names.append(os.path.basename(j)[:-5])
    if js:
        errs = np.array(errs); signs = np.array(signs)
        ok(np.all(errs <= signs + 1e-3), 'matrix yaw (measure.js pose) has the sign of the view yaw on every portrait')
        ok(errs.max() < 0.10, f'anchor fit residual <= {errs.max():.3f} eye-distances ({names[int(errs.argmax())]}), '
           f'median {np.median(errs):.3f}, on {len(errs)} portraits')
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(BUILD, 'selftest'))
    ap.add_argument('--only', default='checks,views,sdf,raster,portraits')
    ap.add_argument('--portraits', default=None)
    ap.add_argument('--public-only', action='store_true')
    ap.add_argument('--images', default=None, help='extra directory holding the portrait images (name.png/.jpg)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.images:
        IMAGE_DIRS.insert(0, a.images)
    m = head.body_mesh()
    print(f'body: {len(m["V"])} vertices, {len(m["T"])} triangles, landmark fit rms {m["rms"]:.4f} head units')
    for k in a.only.split(','):
        t = time.time()
        if k == 'checks':
            f = checks(a.portraits)
            if f:
                print(f'{len(f)} check(s) failed')
        elif k == 'views': views(a.out)
        elif k == 'sdf': sdf(a.out)
        elif k == 'raster': raster_test(a.out)
        elif k == 'portraits': portraits(a.out, a.portraits, a.public_only)
        print(f'{k}: {time.time() - t:.1f}s -> {a.out}', flush=True)


if __name__ == '__main__':
    main()
