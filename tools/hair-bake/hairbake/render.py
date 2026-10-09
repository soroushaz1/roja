"""Rasterise a shaded groom into one view's sprite layers, plus the body layers under it.

For a view baked at yaw v the groom is turned by v about the head's vertical axis
(canon.rotate_yaw, pivot canon.PIVOT) and drawn orthographically in the SAME head-unit frame
as the other views (x across, y down; the frame does not move with the yaw).  The turned
MakeHuman head and body (head.occluder) hide the hair behind them:
  * the head, face, neck and torso with a hard depth test;
  * the arms only for the back curtain: hair hanging over the chest or beside the
    shoulders (canonical z in front of FRONT_Z) is never cut by the proxy's A-pose arms,
    which slope out (and turn toward the camera in the side views) but hang at the user's
    sides in real life (raster's alternative occluder; head.body_sdf has no arms either, so
    the groom lets such hair fall straight past the shoulder tips);
  * hair well behind the neck, torso and arms (SOFT_GAP) also fades out softly over soft_r
    just OUTSIDE their outline, so where the user's real neck is a little wider or narrower
    than the proxy there is no hard line of hair along it.

render_hair() -> float layers at the sprite resolution, PREMULTIPLIED by coverage A:
    A    coverage 0..1
    Dp, S1p, S2p     shade.py's channels x A
    Mp   depth-into-hair x A
    Tp   tone x A (0 = the darker dye tone / lowlights .. 1 = the lighter tone; darker roots and
         lighter ends come from the groom's tone_t)
    Zp   view-space depth of the hair x A (head units, + toward the camera)
body_layers() -> half-resolution layers on the turned body:
    shadow   darkening the hair casts on skin and clothes (0..1)
    scalp    where the style's scalp is (inside its hairline, part line included, ears never):
             the runtime paints tinted, shadowed skin there under the hair so nothing of the
             user's own hair shows through partings and thin ends
    head     the head's silhouette (skull, ears and face) in this view
    face     the canonical face mesh's silhouette (forehead to chin, cheek to cheek)
    body     the neck, torso and arms
    zbody    view depth of the body (-1e9 where none)
finish_view() combines them into the shipped channels (pack.LAYOUT).
"""
import time
import numpy as np
import cv2
from scipy import ndimage
from . import canon, head
from .head import Frame, smoothstep, FACE_ID, REGION
from .native import raster, zmax
from .scalp import ear_mask

# Renderer defaults; a style's RENDER dict overrides any of them.
RENDER = dict(
    res=256,              # sprite pixels per head unit (the runtime texture resolution) ...
    max_hair_px=130000,   # ... lowered so the largest view's visible hair covers at most this
                          #     many texels (keeps big styles inside the file-size budget)
    ss=2,                 # supersampling of the strand raster
    taper=(0.7, 1.0),     # strand width tapers to 30 % between these fractions of its length
    tip_fade=0.45,        # opacity lost over the last 10 % of a strand
    fine_ao=True,         # clump-gap occlusion from the hair's front envelope (view space)
    fine_ao_r=0.010, fine_ao_d=0.014, fine_ao_min=0.32,
    soft_r=0.03,          # soft neck/torso occluder: depth dilation radius (head units)
    zbias=0.004,          # hard occluder depth bias (head units)
    step=0.33,            # raster sub-step along a segment (px)
    margin=0.05,          # frame margin around the hair (head units)
    max_side=1024,        # largest texture side (px)
    spec=1.0,             # runtime highlight strength hint for this style (style.json look.spec)
    bits=None,            # per-channel precision overrides for the packer (pack.BITS)
)


def render_kw(style_render=None, **over):
    kw = dict(RENDER)
    kw.update(style_render or {})
    kw.update({k: v for k, v in over.items() if v is not None})
    return kw


def pot(n):
    return 1 << int(np.ceil(np.log2(max(int(np.ceil(n)), 1))))


# the cranium in every view: the frame always covers it so the scalp / head masks are whole
CRANIUM_BOX = (-0.10, -0.42, 1.10, 0.62)


def sprite_frame(bounds, res=256, margin=0.05, max_side=1024, shrink=0.12):
    """the sprite frame (head.Frame) for hair bounds (x0, y0, x1, y1) in head units: the
    bounds plus the cranium plus margin, at `res` px per unit, grown to power-of-two
    texture sides.  When a side needs at most `shrink` more pixels than a power of two the
    resolution drops a little to fit the smaller texture; a side above max_side lowers it too.
    The frame is centred on the content."""
    x0, y0, x1, y1 = bounds
    cx0, cy0, cx1, cy1 = CRANIUM_BOX
    x0, y0, x1, y1 = min(x0, cx0) - margin, min(y0, cy0) - margin, max(x1, cx1) + margin, max(y1, cy1) + margin
    w, h = x1 - x0, y1 - y0
    sides = []
    for need in (w * res, h * res):
        P = min(pot(need), max_side)
        if P > 64 and need <= (P // 2) * (1 + shrink):
            P //= 2                      # just over a power of two: lower the resolution a little
        sides.append(P)
    W, H = sides
    r = min(float(res), W / w, H / h)
    cx, cy = 0.5 * (x0 + x1), 0.5 * (y0 + y1)
    return Frame(cx - W / r / 2, cy - H / r / 2, W, H, r)


def _resize_area(img, W, H):
    """INTER_AREA resize of an (h, w, c) float image with any number of channels."""
    if img.ndim == 2:
        return cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
    out = [cv2.resize(np.ascontiguousarray(img[..., i:i + 3]), (W, H), interpolation=cv2.INTER_AREA).reshape(H, W, -1)
           for i in range(0, img.shape[-1], 3)]
    return np.concatenate(out, -1)


# Hair whose canonical z is in front of the back curtain is never hidden by the proxy's arms:
# with the arms down (real photos) it hangs over the chest or beside the upper arm, not behind
# an A-pose arm.  The long-hair grooms leave a natural gap in depth between the back curtain
# (z ~ -1.0) and the side / front hair (z > -0.75) around z ~ -0.82, so few strands are half
# way (a strand half way is drawn with partial coverage where an arm covers it).
FRONT_Z = (-0.88, -0.78)
SOFT_GAP = 0.05          # the soft neck / shoulder fade applies this far behind the body (head units)


def occluders(rfr, yaw, soft_r=0.03):
    """occluders for the strand raster at frame rfr (module docstring):
    zhard  depth of the whole body (head, face, neck, torso, arms): hair behind it is hidden;
    zalt   the same without the arms (for front hair, raster's alternative occluder);
    zsoft, asoft   the soft fade just outside the neck / torso / arm silhouette."""
    z, part = head.occluder(rfr, yaw, neck_pad=0.0)     # unpadded: hair resting on the chest stays in front
    body = part >= 0
    soft = (part == REGION['neck']) | (part == REGION['torso']) | (part == REGION['arm'])
    zhard = np.where(body, z, -1e9).astype(np.float32)
    za, pa = head.occluder(rfr, yaw, parts=('head', 'neck', 'torso'), neck_pad=0.0)
    zalt = np.where(pa >= 0, za, -1e9).astype(np.float32)
    zs = np.where(soft, z, -1e9).astype(np.float32)
    r = max(1, soft_r * rfr.res)
    ri = int(np.ceil(r))
    # only hair well BEHIND the nearby body fades (soft_gap): hair lying on a shoulder or
    # draped over the chest is in front of it and must not be faded by the dilated depth
    zsoft = ndimage.maximum_filter(zs, size=2 * ri + 1) - SOFT_GAP
    dist = cv2.distanceTransform((~soft).astype(np.uint8), cv2.DIST_L2, 5)
    asoft = np.clip(1 - dist / r, 0, 1)
    asoft = asoft * asoft * (3 - 2 * asoft)
    asoft = np.where(soft, 0.0, asoft).astype(np.float32)     # inside the outline the hard test rules
    return zhard, zalt, zsoft.astype(np.float32), asoft


def render_hair(S, attrs, shading, fr, yaw, kw=None, log=print, chunk=1500000, fade=None):
    """S (n, m, 3) canonical strands, attrs (Hair.merged), shading = (D, S1, S2, M) per
    vertex from Shader.view(yaw), fade: optional per-vertex opacity factor (n, m).
    Returns the premultiplied layers (module docstring) at fr's resolution."""
    kw = render_kw(kw)
    t0 = time.time()
    D, S1, S2, M = shading
    n, m, _ = S.shape
    ss = int(kw['ss'])
    rfr = fr.scaled(ss)
    # turned strands (chunked: S can be ~100 MB)
    px = np.empty((n, m), np.float32); py = np.empty((n, m), np.float32); z = np.empty((n, m), np.float32)
    for a in range(0, n, 20000):
        Sv = canon.rotate_yaw(S[a:a + 20000].astype(np.float64), yaw)
        x_, y_ = rfr.to_px(Sv[..., 0], Sv[..., 1])
        px[a:a + 20000], py[a:a + 20000], z[a:a + 20000] = x_, y_, Sv[..., 2]
    del Sv
    D = D.copy(); S1 = S1.copy(); S2 = S2.copy(); M = M.copy()
    kind = np.asarray(attrs.get('kind', np.zeros(n, int)))
    if kw['fine_ao']:
        # clump gaps: how far a vertex sits below the local front envelope of the hair body
        body = np.isin(kind, (0, 1, 5, 6))
        zb = zmax(px[body], py[body], z[body], rfr.W, rfr.H)
        zb = ndimage.grey_dilation(zb, size=(3, 3))
        sig = kw['fine_ao_r'] * rfr.res
        valid = (zb > -8).astype(np.float32)
        envb = cv2.GaussianBlur(np.where(zb > -8, zb, 0).astype(np.float32), (0, 0), sig)
        wb = cv2.GaussianBlur(valid, (0, 0), sig)
        env = np.where(wb > 1e-3, envb / np.maximum(wb, 1e-3), -9).astype(np.float32)
        env = np.maximum(env, cv2.GaussianBlur(np.where(zb > -8, zb, -9).astype(np.float32), (0, 0), 1.0))
        # only inside the hair body's silhouette: a stray or flyaway seen beyond it (above the
        # crown, past the ends) is lit by the room, not buried in the clump it sits behind
        inside = smoothstep(0.25, 0.75, cv2.GaussianBlur(valid, (0, 0), 1.5)).astype(np.float32)
        ze = ndimage.map_coordinates(env, [py.ravel() - 0.5, px.ravel() - 0.5], order=1, mode='nearest').reshape(n, m)
        gate = ndimage.map_coordinates(inside, [py.ravel() - 0.5, px.ravel() - 0.5], order=1, mode='constant').reshape(n, m)
        dz = np.clip(ze - z, 0, None) * gate
        del gate, inside
        fao = (kw['fine_ao_min'] + (1 - kw['fine_ao_min']) * np.exp(-dz / kw['fine_ao_d'])).astype(np.float32)
        del ze, dz, env, envb, wb, zb
        D *= fao; S1 *= fao * fao; S2 *= fao * fao
        M = np.clip(M + 0.5 * (1 - fao), 0, 1)
        log(f'  view {yaw:+g}: fine AO mean {fao.mean():.2f}')
        del fao
    t = np.linspace(0, 1, m, dtype=np.float32)[None, :]
    width = attrs['width_u'][:, None].astype(np.float32) * rfr.res * (1 - 0.7 * smoothstep(kw['taper'][0], kw['taper'][1], t)).astype(np.float32)
    if 'width_t' in attrs:
        width = width * attrs['width_t']
    opac = attrs['opacity'][:, None].astype(np.float32) * (1 - kw['tip_fade'] * smoothstep(0.9, 1.0, t)).astype(np.float32)
    if 'opac_t' in attrs:
        opac = opac * attrs['opac_t']
    if fade is not None:
        opac = opac * fade
    tone = np.clip(attrs['tone'][:, None] + (attrs['tone_t'] if 'tone_t' in attrs else 0.0), 0, 1)
    front = np.empty((n, m), np.float32)                 # 1 = hair in front of the shoulders
    for a in range(0, n, 20000):
        front[a:a + 20000] = smoothstep(FRONT_Z[0], FRONT_Z[1], S[a:a + 20000, :, 2])
    NV = 12
    V = np.empty((n, m, NV), np.float32)
    for i, X in enumerate((px, py, z, np.broadcast_to(width, (n, m)), np.broadcast_to(opac, (n, m)), D, S1, S2, M,
                           np.broadcast_to(tone, (n, m)), z, front)):
        V[..., i] = X
    del px, py, width, opac, tone, D, S1, S2, M, front
    zmid = (0.5 * (z[:, :-1] + z[:, 1:])).ravel()
    del z
    order = np.argsort(zmid, kind='stable')
    del zmid
    zhard, zalt, zsoft, asoft = occluders(rfr, yaw, kw['soft_r'])
    acc = np.zeros((rfr.H, rfr.W, NV - 4), np.float32)
    V = V.reshape(n * m, NV)
    t1 = time.time()
    for a in range(0, len(order), chunk):
        o = order[a:a + chunk]
        s, j = np.divmod(o, m - 1)
        i0 = s * m + j
        seg = np.stack([V[i0], V[i0 + 1]], 1)
        raster(seg, rfr.W, rfr.H, zhard, zbias=kw['zbias'], step=kw['step'], zsoft=zsoft, asoft=asoft, out=acc,
               zalt=zalt, alt_ch=NV - 6)
    log(f'  view {yaw:+g}: raster {len(order) / 1e6:.1f}M segments {time.time() - t1:.1f}s')
    del V, order
    acc = _resize_area(acc, fr.W, fr.H) if ss > 1 else acc
    A = np.clip(acc[..., 0], 0, 1)
    out = dict(A=A)
    for i, k in enumerate(('Dp', 'S1p', 'S2p', 'Mp', 'Tp', 'Zp')):
        out[k] = acc[..., 1 + i].astype(np.float32)
    log(f'  view {yaw:+g}: hair layers {time.time() - t0:.1f}s, coverage {(A > 0.5).mean():.1%} of the frame')
    return out


def push_pull(X, w, scales=(1, 2, 4, 8, 16, 32, 64, 128)):
    """fill X (h, w) or (h, w, c) where weight w is ~0 from the weighted values around it
    (multi-scale normalised convolution); keeps X where w > 0 (blending where 0 < w < 1)."""
    X = np.asarray(X, np.float32); w = np.clip(np.asarray(w, np.float32), 0, 1)
    if X.ndim == 2:
        return push_pull(X[..., None], w, scales)[..., 0]
    est = np.zeros_like(X); have = np.zeros(w.shape, np.float32)
    for s in scales:
        num = cv2.GaussianBlur(X * w[..., None], (0, 0), s)
        den = cv2.GaussianBlur(w, (0, 0), s)
        if num.ndim == 2:
            num = num[..., None]
        e = num / np.maximum(den[..., None], 1e-6)
        take = np.clip(den / 0.15, 0, 1) * (1 - have)
        est += e * take[..., None]; have += take
        if have.min() > 0.999:
            break
    est = est / np.maximum(have[..., None], 1e-6)
    return X * w[..., None] + est * (1 - w[..., None])


def body_layers(fr_half, yaw, scalp, shader=None, shadow_res=64.0, skin_offset=0.012, log=print):
    """per-view layers on the body at half resolution (see the module docstring).
    scalp: the groom's Scalp (hairline -> where the scalp layer goes); shader: the Shader,
    for the cast shadow (None: no shadow)."""
    t0 = time.time()
    z, part, nrm = head.occluder(fr_half, yaw, normals=True)
    body = part >= 0
    X, Y = fr_half.grid()
    Pv = np.stack([X, Y, np.where(body, z, 0)], -1)
    P = canon.rotate_yaw(Pv.reshape(-1, 3), -yaw).reshape(Pv.shape)
    headm = (part == REGION['head']) | (part == FACE_ID)
    out = dict(zbody=np.where(body, z, -1e9).astype(np.float32))
    out['head'] = cv2.GaussianBlur(headm.astype(np.float32), (0, 0), 0.7)
    out['face'] = cv2.GaussianBlur((part == FACE_ID).astype(np.float32), (0, 0), 0.7)
    out['body'] = cv2.GaussianBlur((body & ~headm).astype(np.float32), (0, 0), 0.7)
    # the scalp: inside the hairline (+ a 0.5 mm soft edge outside it), never the ears or
    # the face below the hairline
    dist = scalp.hairline.dist(P)
    sc = (headm | (part == REGION['neck'])) * smoothstep(-0.005, 0.03, dist) * ~ear_mask(P)
    out['scalp'] = cv2.GaussianBlur(sc.astype(np.float32), (0, 0), 0.6)
    if shader is not None:
        k = shadow_res / fr_half.res
        fs = fr_half.scaled(k)
        zs, ps, ns = head.occluder(fs, yaw, normals=True)
        on = ps >= 0
        Xs, Ys = fs.grid()
        Qv = np.stack([Xs[on], Ys[on], zs[on]], -1) + ns[on] * skin_offset
        Qc = canon.rotate_yaw(Qv, -yaw)
        sh = np.zeros(zs.shape, np.float32)
        sh[on] = shader.skin_shadow(Qc, yaw)
        # spread a little past the silhouette so the bilinear upsampling keeps the edge
        sh = push_pull(sh, on.astype(np.float32), scales=(1, 2))
        sh = cv2.resize(sh, (fr_half.W, fr_half.H), interpolation=cv2.INTER_LINEAR)
        out['shadow'] = (np.clip(sh, 0, 1) * cv2.GaussianBlur(body.astype(np.float32), (0, 0), 0.7)).astype(np.float32)
    else:
        out['shadow'] = np.zeros(z.shape, np.float32)
    log(f'  view {yaw:+g}: body layers {time.time() - t0:.1f}s')
    return out


def finish_view(hair, body, fr, z_range=(-1.0, 0.6), fill_px=8, z_blur=0.025, gap_r=0.006, gap_k=0.9):
    """combine a view's hair layers (full res, premultiplied) and body layers (half res)
    into the shipped channels, all float:
      full res:  A, Dp, S1p (premultiplied by A)
      half res:  M, T, S2 (straight: per unit of coverage, filled outward past the hair so
                 filtering never pulls in junk; the runtime multiplies S2 by the full-res A),
                 Z (head units: hair depth over the hair, body depth elsewhere, filled and
                 smoothed (z_blur head units) for the parallax grid), shadow (on the scalp at
                 least gap_k x the hair coverage within ~gap_r), scalp, head, face, body (0..1)."""
    Wh, Hh = fr.W // 2, fr.H // 2
    A = hair['A']
    out = dict(A=A, Dp=hair['Dp'], S1p=hair['S1p'])
    half = _resize_area(np.stack([A, hair['Mp'], hair['Tp'], hair['S2p'], hair['Zp'], hair['Zp']], -1), Wh, Hh)
    Ah = half[..., 0]
    inv = 1 / np.maximum(Ah, 1e-6)
    wgt = np.clip(Ah / 0.05, 0, 1)
    M = np.clip(half[..., 1] * inv, 0, 1); T = np.clip(half[..., 2] * inv, 0, 1)
    S2 = np.clip(half[..., 3] * inv, 0, None); Zh = half[..., 4] * inv
    MT = push_pull(np.stack([M, T, S2], -1), wgt)
    # far from the hair the filled values are never sampled: settle them to constants
    # (smaller files) beyond fill_px half-resolution texels (mip levels stay valid near it)
    far = cv2.distanceTransform((Ah < 0.01).astype(np.uint8), cv2.DIST_L2, 5)
    keep = (1 - smoothstep(fill_px, 2 * fill_px, far)).astype(np.float32)[..., None]
    MT = MT * keep + np.array([0.5, 0.5, 0.0], np.float32) * (1 - keep)
    out['M'] = np.clip(MT[..., 0], 0, 1); out['T'] = np.clip(MT[..., 1], 0, 1); out['S2'] = np.clip(MT[..., 2], 0, None)
    zb = body['zbody']
    onb = zb > -1e8
    wh = smoothstep(0.02, 0.5, Ah).astype(np.float32)
    Zc = np.where(onb, wh * Zh + (1 - wh) * zb, Zh)
    known = np.where(onb | (Ah > 0.02), 1.0, 0.0).astype(np.float32)
    Zc = push_pull(np.where(known > 0, Zc, 0).astype(np.float32), known)
    Zc = cv2.GaussianBlur(Zc, (0, 0), max(1.0, z_blur * fr.res / 2))
    out['Z'] = np.clip(Zc, z_range[0], z_range[1]).astype(np.float32)
    for k in ('shadow', 'scalp', 'head', 'face', 'body'):
        out[k] = np.clip(body[k], 0, 1).astype(np.float32)
    # on the scalp the cast shadow alone is too coarse (64 px per unit) to darken what shows
    # through a parting or between pieces: the hair right around such a gap occludes it, so
    # the scalp there takes the local coverage (~gap_r) as shadow too - partings and gaps read
    # dim instead of as bright skin lines
    near = cv2.GaussianBlur(A, (0, 0), max(0.6, gap_r * fr.res))
    near = _resize_area(near, Wh, Hh)
    out['shadow'] = np.maximum(out['shadow'], out['scalp'] * gap_k * np.clip(near, 0, 1) ** 0.7).astype(np.float32)
    return out
