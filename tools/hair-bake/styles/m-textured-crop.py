"""m-textured-crop: a modern men's textured crop - a mid skin fade on the sides and back, a
4-6 cm point-cut top pushed forward with matte texture, and a choppy, piecey fringe that
stops on the upper forehead (about 2 cm above the brows).

Recipe (continues proto-a's C12; the walker and the fringe cut live in this module):
  * scalp: men's hairline with temple recession (.35), jitter and a soft falloff.
  * one root set, split by `top_section` into
      - the top (inside the parietal ridges): 4.3-5.5 cm, longest at the front-middle,
        shorter toward the crown and at the side rim so it sits over the fade instead of
        draping over the temples.  It is pushed forward (a slight sweep to image left),
        stands 1.4-2.2 cm off the scalp (highest at the mid-top, lower at the crown, rim
        and front), in ~650 pieces with their own yaw, length, bend and tip lift (messy
        texture, a ragged silhouette), clumped hard to pointed tips (matte and piecey, not
        fur).  Behind the crown the top turns down the back of the head.
      - sides and back: a mid fade, ~1 mm low on the head to ~1.1 cm under the top, combed
        flat down and back; hardly clumped (a clumped fade reads as spots), thinner and
        sparser low down so the skin shows (skin_fade), low highlight and brightness
        variation (no speckle).
    The two sections share one length / height field and meet in a hash01 dither (no seam).
  * the walk (own `_walk`, a surface_walk with a position-dependent direction and height):
    once a front strand crosses the hairline its direction turns down the forehead and its
    height drops to 2-5 mm, so the fringe rolls over the hairline and lies on the skin.
  * the fringe line: strands are cut where they reach a front-view height y_end(x): centre
    ~y .06-.07 (2.5 cm above the brows), shorter toward the temples, with a slow wave,
    per-piece lengths (sd 1.3 cm), per-lock lengths and point cutting - choppy pieces with
    forehead showing between their tips, no bowl line and no comb teeth.
  * a few flyaways on top, baby hairs at the temples and the nape.
  * look: modest root darkening, almost no lighter ends (blonde tips go white), lock
    lowlights; the fade strands get flatter brightness and weaker highlights.
"""
import numpy as np
from hairbake import groom as g

STYLE = dict(id='m-textured-crop', name='کراپ تکسچر', group='men')
RENDER = dict(taper=(0.55, 1.0), fine_ao_r=0.008, fine_ao_d=0.010, fine_ao_min=0.36, res=320, max_hair_px=140000,
              spec=0.85)

SS = g.smoothstep


def _forehead(p):
    """0..1: how far a point is out over the forehead (in front of and below the front
    hairline), where the fringe lies close to the skin and falls down."""
    return SS(-0.085, 0.015, p[:, 1]) * SS(0.10, 0.20, p[:, 2])


def _walk(p0, dir_top, dir_fringe, L, H, h_fore, h_end, nv, yaw_noise=None, follow=0.32):
    """surface_walk with a position-dependent styling direction and height: on the head a
    strand heads along dir_top at height H (reached over the first 35 % of its length);
    out over the forehead (_forehead) it turns to dir_fringe and comes down to h_fore.
    h_end lifts (+) the tips over the last 35 %.  Returns (n, nv, 3) float32."""
    sdf = g.body_sdf()
    p = np.asarray(p0, np.float64).copy()
    n = len(p)
    P = np.zeros((n, nv, 3), np.float32)
    P[:, 0] = p
    nrm = sdf.grad(p)

    def target(q, nn):
        w = _forehead(q)[:, None]
        return g.tangent(dir_top * (1 - w) + dir_fringe * w, nn)

    d = target(p, nrm)
    ds = L / (nv - 1)
    for k in range(1, nv):
        u = k / (nv - 1)
        w = _forehead(p)
        h = (H * SS(0.0, 0.35, u)) * (1 - w) + h_fore * w + h_end * SS(0.65, 1.0, u)
        q = p + d * ds[:, None]
        q = g.project(q, h, sdf=sdf)
        nn = sdf.grad(q)
        v = g.unit(q - p)
        q = p + v * ds[:, None]
        t = target(q, nn)
        if yaw_noise is not None:
            t = t + yaw_noise[:, k]
        d = g.tangent((1 - follow) * v + follow * t, nn)
        p = q
        P[:, k] = p
    return P


def build(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('men', recession=0.35, jitter=0.007), soft=0.03, edge=0.20)
    hair = g.Hair(scalp, q, STYLE['id'])
    r = scalp.roots(int(125000 * q), rng)
    n = len(r)
    dx = np.abs(r.x - 0.5)
    top = g.top_section(r, half_width=(0.42, 0.29), front=(0.12, -0.10))
    rim = SS(0.24, 0.40, dx)                                   # toward the top's side edge
    front = SS(-0.05, 0.20, r.z) * top                         # the front of the top
    back = SS(-0.50, -0.72, r.z)                               # behind the crown
    mid = SS(-0.45, -0.15, r.z) * SS(0.30, 0.05, r.z)          # the mid-top (most height)

    # ---- lengths: a mid fade on the sides, the long top
    side_len = g.fade_length(r, 0.006, 0.068, 0.44, -0.06, power=1.35)
    side_len = side_len * (1 - 0.45 * SS(-0.2, 0.1, r.z) * SS(0.05, 0.25, r.y))     # temples, sideburns
    top_len = (0.265 + 0.07 * rng.random(n)) * (1 - 0.40 * back) * (1 - 0.30 * rim) * (1 + 0.10 * front)
    L = side_len * (1 - top) + top_len * top

    # ---- pieces (~1 cm locks of the top) with their own yaw, length, bend and tip lift
    is_top = (top + 0.25 * (g.hash01(r.p, 5) - 0.5)) > 0.5
    tex = top
    npieces = 650
    centres = rng.choice(n, npieces, replace=False)
    from scipy.spatial import cKDTree
    _, piece = cKDTree(r.p[centres]).query(r.p, 1)
    pyaw = rng.normal(0, 0.30, npieces)[piece] * tex + rng.normal(0, 0.04, n)
    plen = 1 + 0.16 * rng.normal(size=npieces)[piece] * tex + 0.06 * rng.normal(size=n)
    plift = rng.normal(0.004, 0.022, npieces)[piece]
    L = np.clip(L * plen, 0.004, None)

    # ---- directions: the top forward (slight sweep to image left; out and down at the rim),
    # behind the crown down the back of the head, the sides down and back
    sweep = -0.18
    fwd = np.stack([sweep + 0.55 * np.sign(r.x - 0.5) * rim, 0.10 + 0.25 * rim, np.ones(n)], -1)
    down_back = np.stack([0.10 * np.sign(r.x - 0.5), np.ones(n), -np.ones(n)], -1)
    wf = top * (1 - back)
    d0 = g.unit(fwd) * wf[:, None] + g.unit(down_back) * (1 - wf)[:, None]
    d0 = g.rotate_about(g.tangent(d0, r.n), r.n, pyaw)
    # over the forehead: down, with each piece's own sideways drift (pieces converge and part)
    psx = rng.normal(0, 0.22, npieces)[piece]
    dir_fringe = np.stack([sweep * 1.3 + psx + 0.25 * (r.x - 0.5), np.ones(n), 0.15 * np.ones(n)], -1)

    # ---- heights: the top stands 1.4-2.2 cm off the scalp; lies close on the forehead
    H = (0.085 + 0.035 * rng.random(n)) * (1 + 0.25 * mid) * (1 - 0.45 * back) * (1 - 0.55 * rim) \
        * (0.55 + 0.45 * SS(0.0, 0.08, r.dist))
    H = H * top + (0.008 + 0.008 * SS(0.45, 0.0, r.y)) * (1 - top)
    h_fore = 0.012 + 0.010 * rng.random(n) + 0.022 * np.clip(r.dist / 0.20, 0, 1)
    h_end = plift * top * (1 - front) - 0.010 * front

    bend = (g.smooth_noise(rng, npieces, 40, 1.2, 2)[piece] * 0.20 + g.smooth_noise(rng, n, 40, 2.0, 1) * 0.06) \
        * tex[:, None, None]
    nv = 40
    log('crop: walking %d strands' % n)
    S = _walk(r.p, d0, dir_fringe, L, H, h_fore, h_end, nv, yaw_noise=bend.astype(np.float64))

    # ---- clumping: the top into pointed pieces (matte), the sides hardly at all
    groups = []
    for sel, clumps, frz in ((~is_top, ((4000, 0.0, 0.15, 1.0),), (0.0002, 0.0005)),
                             (is_top, ((int(npieces * 1.1), 0.05, 0.70, 0.8), (5500, 0.08, 0.32, 1.0)),
                              (0.0003, 0.0010))):
        idx = np.where(sel)[0]
        Ss = S[idx]
        cl = np.zeros(len(idx), int)
        for (cnt, a, b, pw) in clumps:
            Ss, cl = g.clump(Ss, r.p[idx], None, min(len(idx), cnt),
                             lambda tt, a=a, b=b, pw=pw: a + b * SS(0.1, 1.0, tt) ** pw, rng)
        Ss = g.frizz(Ss, rng, frz[0], frz[0] + frz[1], freq=3, power=1.3, root_ramp=0.1)
        groups.append((idx, Ss, cl))

    # ---- the fringe line: cut where the strands reach y_end(x) on the forehead
    idx, St, clt = groups[1]
    rt = r.take(idx)
    xe = St[:, -1, 0]
    ph = rng.uniform(0, 2 * np.pi, 2)
    nl = 140
    _, lock = cKDTree(rt.p[rng.choice(len(idx), nl, replace=False)]).query(rt.p, 1)
    ye = (0.064 - 0.050 * ((xe - 0.5) / 0.26) ** 2
          + 0.012 * (0.7 * np.sin(xe * 13.0 + ph[0]) + 0.3 * np.sin(xe * 29.0 + ph[1]))
          + 0.013 * rng.normal(size=npieces)[piece[idx]]
          + 0.006 * rng.normal(size=nl)[lock] + 0.003 * rng.normal(size=len(idx))
          - (rng.random(len(idx)) < 0.40) * 0.030 * rng.random(len(idx)) ** 0.7)
    reach = rt.y < ye - 0.02
    Lt = g.lengths(St)
    Lc = np.where(reach, np.minimum(Lt, g.cut_at_y(St, ye)), Lt)
    Lc = np.maximum(Lc, 0.25 * Lt)
    St = g.cut(St, Lc)
    groups[1] = (idx, St, clt)

    op, wd = g.skin_fade(r, y0=0.08, y1=0.46, strength=0.70, top=top)
    width = 0.0010 / np.sqrt(q) * wd * rng.uniform(0.75, 1.25, n)
    out = []
    for (idx, Ss, cl) in groups:
        Ss = g.collide_strands(Ss, 0.003)
        s = g.Strands(Ss, 'main', clump=cl)
        s.set(opacity=0.92 * op[idx], width_u=width[idx])
        hair.add(s)
        out.append(s)
    sides, tp = out

    # ---- details: flyaways on top, baby hairs at the temples and the nape
    sel = rng.choice(tp.n, max(4, int(0.004 * tp.n)), replace=False)
    hair.add(g.flyaways(tp.P, rng, sel=sel, start=(0.3, 0.6), amp=(0.012, 0.010)), kind='flyaway')
    hair.add(g.baby_hairs(scalp, rng, max(8, int(0.0025 * n)), length=(0.012, 0.035), phi_range=(0.55, 1.25),
                          mid_gap=0.20))
    hair.add(g.baby_hairs(scalp, rng, max(8, int(0.0015 * n)), length=(0.010, 0.025), phi_range=(2.4, 3.14),
                          mid_gap=0.0))
    hair.finish(rng, look=dict(albedo_lock=0.20, albedo_strand=0.13, tone_lock=0.13, tone_strand=0.11,
                               tone_end=0.03, end_len=0.3, tone_root=-0.13))
    # the fade: flatter brightness and weaker highlights, so 1-3 mm hairs read as a smooth
    # shadow on the skin instead of bright specks
    a = sides.attrs
    fade = 1 - SS(0.012, 0.05, g.lengths(sides.P))
    a['albedo'] = (a['albedo'] ** (1 - 0.6 * fade)).astype(np.float32)
    a['spec1_j'] = (a['spec1_j'] * (1 - 0.55 * fade)).astype(np.float32)
    a['spec2_j'] = (a['spec2_j'] * (1 - 0.45 * fade)).astype(np.float32)
    return hair
