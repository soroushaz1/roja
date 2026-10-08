"""Quick previews of a groom: strands drawn with a simple fibre shading over the shaded
MakeHuman body, from any yaw / pitch, with the scalp (hairline density, part line) shown
on the head.  This is for checking a groom's SHAPE quickly (seconds at q = .25); the real
bake shading (deep-opacity shadows, two specular lobes, recolour) is the renderer's job.

    cd tools/hair-bake
    python3 -m hairbake.preview <style>          # a style id (styles/<id>.py), a path to a
                                                 # style module, or demo:<name> (hairbake/demos.py)
            [--q .25] [--views -30,0,30,90,180,top] [--res 150] [--shade brown|blonde|kind]
            [--scalp] [--out build/preview/<name>.png] [--seed 1]

Views: a number is a yaw in degrees (+ turns the face toward image right, as the bake's
views); 'top' looks down from above (pitch 70), 'back' is yaw 180; 'yaw/pitch' gives both.
--scalp draws the scalp density (hairline falloff) in red and the part line in cyan and
leaves the hair out (to check hairlines and partings).
"""
import argparse, os, time
import numpy as np
import cv2
from PIL import Image, ImageDraw
from scipy import ndimage
from . import canon, head
from .native import raster, tri_zbuf, zmax, BUILD

LIGHT = np.array([-0.30, -0.55, 0.78]); LIGHT /= np.linalg.norm(LIGHT)
SHADES = {'brown': np.array([0.105, 0.066, 0.045]), 'blonde': np.array([0.62, 0.48, 0.30]),
          'black': np.array([0.035, 0.03, 0.028])}
KIND_RGB = {0: (0.85, 0.75, 0.55), 1: (0.95, 0.35, 0.35), 2: (0.35, 0.95, 0.35), 3: (0.35, 0.65, 1.0),
            4: (1.0, 0.95, 0.2), 5: (0.75, 0.45, 0.95), 6: (0.2, 0.95, 0.95)}
SKIN = np.array([0.80, 0.62, 0.52]); CLOTH = np.array([0.42, 0.47, 0.56])


def view_rotation(yaw=0.0, pitch=0.0):
    """rotation applied to canonical points about canon.PIVOT: first yaw (as the bake's
    views), then pitch (+ tips the top of the head toward the viewer, to look down on it)."""
    Ry = canon.yaw_matrix(yaw)
    a = np.radians(pitch); c, s = np.cos(a), np.sin(a)
    Rx = np.array([[1, 0, 0], [0, c, s], [0, -s, c]])
    return Rx @ Ry


def apply(R, P):
    P = np.asarray(P, np.float64)
    return ((P.reshape(-1, 3) - canon.PIVOT) @ R.T + canon.PIVOT).reshape(P.shape)


def parse_view(v):
    v = str(v).strip()
    if v == 'top':
        return 0.0, 70.0
    if v == 'back':
        return 180.0, 0.0
    if '/' in v:
        a, b = v.split('/'); return float(a), float(b)
    return float(v), 0.0


def preview_frame(res=150, pitch=0.0):
    if pitch > 30:
        return head.Frame(-0.55, -1.05, int(2.1 * res), int(2.2 * res), res)
    return head.Frame(-0.80, -0.75, int(2.6 * res), int(3.1 * res), res)


def body_image(fr, R, scalp=None, show_scalp=False):
    """shaded body (+ canonical face) in view R; returns rgb (H,W,3), z, canonical points."""
    m = head.body_mesh()
    V, T, N, reg = m['V'], m['T'], m['N'], m['region']
    H, TF = canon.face_mesh()
    NF = head.vertex_normals(H, TF); NF *= np.sign(np.median(NF[:, 2]))
    SK, SKN = head.face_skirt()
    P = np.concatenate([V[T], H[TF], SK])
    Nt = np.concatenate([N[T], NF[TF], SKN])
    pid = np.concatenate([reg[T].max(1), np.full(len(TF), head.FACE_ID), np.full(len(SK), head.FACE_ID)]).astype(np.float32)
    canon_pts = P.copy()
    Pv = apply(R, P.reshape(-1, 3)).reshape(P.shape)
    Nv = (Nt.reshape(-1, 3) @ R.T).reshape(Nt.shape)
    Q = Pv.copy()
    Q[..., 0], Q[..., 1] = fr.to_px(Pv[..., 0], Pv[..., 1])
    A = np.concatenate([np.repeat(pid[:, None, None], 3, 1), Nv, canon_pts], -1)
    z, a = tri_zbuf(Q, fr.W, fr.H, A)
    on = z > -1e8
    part = np.where(on, np.round(a[..., 0]), -1)
    n = a[..., 1:4]; n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-12
    Pc = a[..., 4:7]
    lam = np.clip((n * LIGHT).sum(-1), 0, 1)
    base = np.where(((part >= 2) & (part <= 3))[..., None], CLOTH, SKIN)
    img = base * (0.30 + 0.70 * lam[..., None])
    if scalp is not None:
        dens = np.where(on & ((part == 0) | (part == 1)), scalp.density(Pc), 0)
        part_m = np.where(on & (part == 0), scalp.part_mask(Pc), 0)
        if show_scalp:
            img = img * (1 - 0.6 * dens[..., None]) + 0.6 * dens[..., None] * np.array([0.85, 0.15, 0.12]) * (0.4 + 0.6 * lam[..., None])
            img = img * (1 - part_m[..., None]) + part_m[..., None] * np.array([0.1, 0.9, 1.0])
        else:
            # the scalp under the hair: skin darkened by the hair's shadow
            img = img * (1 - 0.45 * dens[..., None])
    img[~on] = (0.13, 0.13, 0.14)
    return img, np.where(on, z, -1e9).astype(np.float32), Pc


def shade_strands(S, Sv, attrs, mode='brown'):
    """per-vertex colour (n, m, 3) of view-space strands Sv: Kajiya-Kay diffuse and two
    specular lobes, a volume occlusion from the depth below the hair's front envelope."""
    n, m, _ = Sv.shape
    T = np.gradient(Sv, axis=1); T /= np.linalg.norm(T, axis=-1, keepdims=True) + 1e-9
    tl = (T * LIGHT).sum(-1)
    Hh = LIGHT + np.array([0, 0, 1.0]); Hh /= np.linalg.norm(Hh)
    th = (T * Hh).sum(-1)
    diff = np.sqrt(np.clip(1 - tl * tl, 0, 1))
    s1 = np.sqrt(np.clip(1 - (th - 0.08) ** 2, 0, 1)) ** 120
    s2 = np.sqrt(np.clip(1 - (th + 0.12) ** 2, 0, 1)) ** 40
    if mode == 'kind':
        kind = attrs.get('kind', np.zeros(n, int))
        alb = np.array([KIND_RGB.get(int(k), (1, 1, 1)) for k in range(8)])[np.clip(kind, 0, 7)][:, None, :] * 0.6
        spec_tint = np.ones(3)
    else:
        base = SHADES.get(mode, SHADES['brown'])
        a = attrs.get('albedo', np.ones(n))[:, None] * attrs.get('albedo_t', np.ones((1, m)))
        tone = np.clip(attrs.get('tone', np.full(n, 0.5))[:, None] + attrs.get('tone_t', np.zeros((1, m))), 0, 1)
        alb = base[None, None, :] * a[..., None] * (0.75 + 0.5 * tone[..., None])
        spec_tint = base / base.max()
    return alb, diff, s1, s2, spec_tint


def render(S, attrs, fr, R, mode='brown', bg=None, zocc=None, ss=2):
    """S (n, m, 3) canonical strands -> premultiplied RGBA float image (H, W, 4)."""
    n, m, _ = S.shape
    Sv = apply(R, S)
    rfr = fr.scaled(ss)
    px, py = rfr.to_px(Sv[..., 0], Sv[..., 1])
    alb, diff, s1, s2, tint = shade_strands(S, Sv, attrs, mode)
    # volume occlusion: how far below the hair's front envelope a vertex is
    kind = attrs.get('kind', np.zeros(n, int))
    body = np.isin(kind, (0, 1, 5, 6))                 # the hair volume, without flyaways / strays / baby hairs
    zb = zmax(px[body], py[body], Sv[body][..., 2], rfr.W, rfr.H)
    zb = ndimage.grey_dilation(zb, size=(3, 3))
    valid = zb > -8
    sig = 0.02 * rfr.res
    envb = cv2.GaussianBlur(np.where(valid, zb, 0).astype(np.float32), (0, 0), sig)
    wb = cv2.GaussianBlur(valid.astype(np.float32), (0, 0), sig)
    env = np.where(wb > 1e-3, envb / np.maximum(wb, 1e-3), -9)
    env = np.maximum(env, zb)
    ze = ndimage.map_coordinates(env, [py.ravel() - 0.5, px.ravel() - 0.5], order=1, mode='nearest').reshape(n, m)
    dz = np.clip(ze - Sv[..., 2], 0, None)
    ao = 0.25 + 0.75 * np.exp(-dz / 0.035)
    t = np.linspace(0, 1, m)[None, :]
    root = 0.55 + 0.45 * np.clip(t / 0.08, 0, 1)
    col = alb * (0.30 + 0.85 * diff[..., None]) * (ao * root)[..., None] \
        + (0.22 * s1 + 0.10 * s2)[..., None] * tint * (ao ** 2 * root)[..., None]
    w = attrs.get('width_u', np.full(n, 0.0011))[:, None] * rfr.res * attrs.get('width_t', np.ones((1, m)))
    o = attrs.get('opacity', np.full(n, 0.9))[:, None] * attrs.get('opac_t', np.ones((1, m))) * (1 - 0.4 * np.clip((t - 0.9) / 0.1, 0, 1))
    w = np.broadcast_to(w, (n, m)); o = np.broadcast_to(o, (n, m))
    V = np.concatenate([np.stack([px, py, Sv[..., 2], w, o], -1), col], -1).astype(np.float32)
    seg = np.stack([V[:, :-1], V[:, 1:]], 2).reshape(-1, 2, V.shape[-1])
    seg = seg[np.argsort(seg[:, :, 2].mean(1), kind='stable')]
    if zocc is not None and ss > 1:
        zocc = cv2.resize(zocc, (rfr.W, rfr.H), interpolation=cv2.INTER_NEAREST)
    acc = raster(seg, rfr.W, rfr.H, zocc=zocc, zbias=0.006)
    acc = cv2.resize(acc, (fr.W, fr.H), interpolation=cv2.INTER_AREA)
    return acc


def preview(hair, views=('-30', '0', '30', '90', 'back'), res=150, mode='brown', show_scalp=False, label=''):
    S, attrs = hair.merged()
    ims = []
    for v in views:
        yaw, pitch = parse_view(v)
        R = view_rotation(yaw, pitch)
        fr = preview_frame(res, pitch)
        bg, z, _ = body_image(fr, R, hair.scalp, show_scalp)
        if show_scalp:
            img = bg
        else:
            t0 = time.time()
            acc = render(S, attrs, fr, R, mode, zocc=z)
            img = bg * (1 - acc[..., :1]) + acc[..., 1:4]
        im = Image.fromarray((np.clip(img, 0, 1) ** (1 / 1.15) * 255 + 0.5).astype(np.uint8))
        d = ImageDraw.Draw(im)
        txt = f'{label} {v}'.strip()
        d.rectangle([2, 2, 8 + 6 * len(txt), 15], fill=(0, 0, 0)); d.text((5, 3), txt, fill=(255, 255, 255))
        ims.append(im)
    return sheet(ims, len(ims))


def sheet(ims, cols, pad=3, bg=(25, 25, 25)):
    w = max(i.width for i in ims); h = max(i.height for i in ims)
    rows = (len(ims) + cols - 1) // cols
    S = Image.new('RGB', (cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad), bg)
    for k, im in enumerate(ims):
        S.paste(im, (pad + (k % cols) * (w + pad), pad + (k // cols) * (h + pad)))
    return S


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('style')
    ap.add_argument('--q', type=float, default=0.25)
    ap.add_argument('--views', default='-30,0,30,90,back')
    ap.add_argument('--res', type=int, default=150)
    ap.add_argument('--shade', default='brown')
    ap.add_argument('--scalp', action='store_true')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    from .hair import load_style
    t0 = time.time()
    mod = load_style(a.style)
    hair = mod.build(np.random.default_rng(a.seed), q=a.q, log=print)
    S, _ = hair.merged()
    print(f'groom {time.time() - t0:.1f}s: {S.shape[0]} strands x {S.shape[1]} vertices')
    name = mod.STYLE['id']
    out = a.out or os.path.join(BUILD, 'preview', f"{name.replace(':', '_')}{'_scalp' if a.scalp else ''}_{a.shade}.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    t0 = time.time()
    im = preview(hair, a.views.split(','), a.res, a.shade, a.scalp, label=name)
    im.save(out)
    print(f'preview {time.time() - t0:.1f}s -> {out}')


if __name__ == '__main__':
    main()
