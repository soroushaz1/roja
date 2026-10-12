"""w-long-layers: long layered hair past the shoulders, curtain bangs parted in the centre.

Recipe (v2, work in progress)
"""
import numpy as np
from scipy.special import ndtr
from hairbake import groom as g
from hairbake.head import smoothstep

STYLE = dict(id='w-long-layers', name='لایه‌ای بلند با چتری پرده‌ای', group='women')
RENDER = dict(taper=(0.7, 1.0), res=300, max_hair_px=140000, spec=0.85, margin=0.08)
LIGHT = dict(ambient_floor=0.22, env_base=0.55, bounce=0.26, bounce_m=0.45)

# the curtain: front-view paths (dx from the part, y) of its inner edge (the arch over the
# forehead) and its outer edge (over the temple to the cheekbone), image-right side
INNER = [(0.030, 0.020), (0.080, 0.090), (0.140, 0.160), (0.205, 0.225), (0.265, 0.290), (0.320, 0.360),
         (0.370, 0.440), (0.410, 0.530)]
OUTER = [(0.320, 0.030), (0.380, 0.095), (0.425, 0.170), (0.450, 0.260), (0.460, 0.360), (0.462, 0.460),
         (0.460, 0.560), (0.455, 0.650)]
BANG_H = (0.050, 0.056, 0.052, 0.046, 0.041, 0.037, 0.034, 0.032)

PARAMS = dict(
    root_h=(0.004, 0.012), volume=(0.07, 0.095), crown_lift=0.05, asym=0.18, gravity=(0.16, 0.45),
    length_y=2.08, top_short=0.30, inner_frac=0.15, inner_keep=(0.70, 0.90),
    frame_y=(1.06, 2.0), frame_depth=0.55, frame_width=0.25,
    bang_w=0.30, bang_d=0.19, bang_n=8000, bang_len=(0.58, 0.42), flick=0.03,
    ears=True, flat_front=0.75,
)

ENV_C = np.array([0.5, 0.25, -0.30])          # centre of the spherical hair envelope


def unkink(S, h=0.004, thresh=22.0, iters=5, alpha=0.6, log=None):
    """smooth the strands that the per-vertex body collision zig-zagged (hair lying along the
    shoulder) and collide them again, a few times: kinks become smooth bends."""
    S = np.array(S, np.float32)
    d = np.diff(S.astype(np.float64), axis=1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True) + 1e-12
    ang = np.degrees(np.arccos(np.clip((d[:, 1:] * d[:, :-1]).sum(-1), -1, 1)))
    bad = np.where(ang[:, 2:].max(1) > thresh)[0]
    if log:
        log(f'  unkink: {len(bad)} of {len(S)} strands')
    if not len(bad):
        return S
    K = S[bad]
    m = K.shape[1]
    w = (alpha * smoothstep(0.08, 0.2, np.linspace(0, 1, m)))[None, 1:-1, None].astype(np.float32)
    for _ in range(iters):
        K[:, 1:-1] += w * (0.5 * (K[:, :-2] + K[:, 2:]) - K[:, 1:-1])
        K = g.collide_strands(K, h)
    S[bad] = K
    return S


def _sph(P, C=ENV_C, nb=(120, 240)):
    v = np.asarray(P, np.float64) - C
    r = np.linalg.norm(v, axis=-1) + 1e-12
    az = np.arctan2(v[..., 0], v[..., 2])
    el = np.arcsin(np.clip(-v[..., 1] / r, -1, 1))
    ie = np.clip(((el + np.pi / 2) / np.pi * nb[0]).astype(int), 0, nb[0] - 1)
    ia = ((az + np.pi) / (2 * np.pi) * nb[1]).astype(int) % nb[1]
    return r, ie, ia, v / r[..., None]


def envelope(S, pct=0.96, nb=(120, 240)):
    """the outer surface of a hair volume, as a radius per direction from ENV_C (a robust
    high percentile of the vertices in each direction bin, dilated and smoothed)."""
    from scipy import ndimage
    P = np.asarray(S[:, 1:], np.float64).reshape(-1, 3)
    r, ie, ia, _ = _sph(P, nb=nb)
    b = ie * nb[1] + ia
    o = np.lexsort((r, b))
    b, r = b[o], r[o]
    first = np.r_[0, np.flatnonzero(np.diff(b)) + 1]
    cnt = np.diff(np.r_[first, len(b)])
    k = first + np.minimum(cnt - 1, (pct * cnt).astype(int))
    E = np.zeros(nb[0] * nb[1])
    E[b[first]] = r[k]
    E = E.reshape(nb)
    E = ndimage.grey_dilation(E, size=(3, 3), mode='wrap')
    E = ndimage.gaussian_filter(E, 1.0, mode='wrap')
    return E


def layer_over(B, E, eps=0.004, t0=(0.04, 0.22), nb=(120, 240), max_push=0.03):
    """push strands B out to lie on top of the hair envelope E (radius per direction) by
    eps, from t0[0] to t0[1] along the strand on (the roots stay)."""
    B = np.array(B, np.float64)
    r, ie, ia, u = _sph(B, nb=nb)
    tgt = E[ie, ia] + eps
    w = smoothstep(t0[0], t0[1], np.linspace(0, 1, B.shape[1]))[None, :]
    rn = r + w * np.clip(tgt - r, 0, max_push)
    out = ENV_C + u * rn[..., None]
    for _ in range(2):                                   # smooth the pushed strands a little
        out[:, 1:-1] += 0.4 * (0.5 * (out[:, :-2] + out[:, 2:]) - out[:, 1:-1])
    return out.astype(np.float32)


def build(rng, q=1.0, log=print, P=None):
    p = dict(PARAMS, **(P or {}))
    scalp = g.Scalp(g.Hairline('women', jitter=0.009),
                    g.Parting(0.503, drift=-0.012, width=0.0035, zigzag=0.0045),
                    soft=0.035, edge=0.20)
    bw, bd = p['bang_w'], p['bang_d']
    bang = g.bang_section(scalp, width=bw, depth=bd)
    hair = g.Hair(scalp, q, STYLE['id'])

    def cut(r, rng_, lock):
        """front-view cut height per strand: the long perimeter (U-shaped behind), the top
        layers shorter than the hair underneath, graduated face-framing layers from the chin
        down beside the face, and a few shorter locks inside the lengths."""
        y = g.layered_cut(r, rng_, lock, length_y=p['length_y'], back_extra=0.10, centre_shorter=0.20, frame=False,
                          jitter=(0.06, 0.035))
        top = smoothstep(0.55, 1.35, r.elev)
        y = y - p['top_short'] * top
        aphi = np.abs(r.phi)
        back = smoothstep(-0.30, -0.60, r.z)
        ff = smoothstep(1.25, 0.85, aphi) * (1 - back)
        fd = np.clip((0.20 - r.z) / p['frame_depth'], 0, 1)
        y_ff = p['frame_y'][0] + (p['frame_y'][1] - p['frame_y'][0]) * fd ** 1.3 + p['frame_width'] * smoothstep(0.7, 1.2, aphi) \
            + 0.05 * lock + 0.02 * rng_.normal(size=len(r))
        y = np.where(ff > 0.02, np.minimum(y, y_ff * ff + y * (1 - ff)), y)
        u = ndtr(lock)                                   # uniform per lock
        fi = p['inner_frac']
        k0, k1 = p['inner_keep']
        f = k0 + (k1 - k0) * (u / max(fi, 1e-6))
        return np.where(u < fi, 0.9 + (y - 0.9) * f, y)

    out = g.long_hair(scalp, rng, q, n=100000, n_guides=3200, accept=lambda P_, N: ~bang(P_, N),
                      root_h=p['root_h'], volume=p['volume'], crown_lift=p['crown_lift'], asym=p['asym'],
                      gravity=p['gravity'], ears=p['ears'], flat_front=p['flat_front'],
                      comb=lambda r: g.part_comb(r, scalp, down=0.35, fwd=-0.25),
                      face_frame=dict(gap=0.0, hug=0.0, spread=0.08, k=(0.9, 0.45)),
                      cut=cut,
                      waves=dict(amp=0.032, wavelength=(0.85, 1.10), start=0.85, ramp=0.6, lateral=0.25,
                                 scale=0.35, lock_jitter=0.35),
                      ends=dict(amount=0.07, under=0.55, start=0.78), front_frac=0.6,
                      frizz=(0.0008, 0.0018), stray=(0.03, 0.002, 0.008), log=log)
    S = out['strands']
    S.P = unkink(S.P, log=log)
    hair.add(S)

    bangs, br = g.curtain_bangs(scalp, rng, int(p['bang_n'] * q), width=bw, depth=bd, inner=INNER, outer=OUTER,
                                h=BANG_H, h_back=0.45, length=p['bang_len'], clumps=(60, 220), tip_clump=0.55,
                                ends=dict(piece=0.10, strand=0.03, point=0.35, point_depth=0.22, floor=0.45), log=log)
    # the lower curtain curves out, away from the face (a smooth field: whole pieces move together)
    B = bangs.P
    side = np.where(B[:, :1, 0] >= 0.5, 1.0, -1.0)
    dxa = np.abs(B[..., 0] - 0.5)
    w = smoothstep(0.30, 0.65, B[..., 1]) * smoothstep(0.30, 0.42, dxa) * p['flick']
    B = B + np.stack([side * w, -0.3 * w, -0.25 * w], -1)
    bangs.P = layer_over(B, envelope(S.P[::3]))
    hair.add(bangs.set(opacity=0.9))
    hair.add(g.flyaways(bangs.P, rng, 0.012, start=(0.3, 0.7), amp=(0.02, 0.008)), kind='flyaway')
    hair.add(g.flyaways(S.P, rng, 0.006), kind='flyaway')
    r = out['roots']
    top = r.take((r.y < 0.1) & (np.abs(r.phi) < 2.4) & (np.abs(r.x - 0.5) > 0.03))
    hair.add(g.strays(top, rng, max(4, int(0.0015 * S.n)), length=(0.03, 0.09), lift=0.02), kind='stray')
    hair.add(g.baby_hairs(scalp, rng, max(8, int(0.006 * S.n))))
    return hair.finish(rng, look=dict(tone_root=-0.18, tone_lock=0.15))
