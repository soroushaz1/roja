"""High-level grooming primitives: the building blocks a style module assembles.

  growth_direction(roots)             natural growth flow (from the crown whorl)
  part_comb(roots, scalp)             combed away from the parting on top, radial behind
  long_hair(...)                      long / medium draping hair (proto-a L5 pipeline):
                                      guides grown with gravity (or proto-b's two-phase
                                      comb-then-fall), volume shells, crown lift, side
                                      asymmetry, face framing, ear clearing, front/back
                                      shoulder decision, straight drape; dense strands from
                                      guides; layered cut; waves; ends; two-level clumping;
                                      frizz and strays.
  layered_cut(...)                    the default cut line for long_hair
  short_hair(...)                     short hair lying on the head (crops, fades, buzz,
                                      slick-back, pixie): pieces with their own yaw,
                                      length and lift; clumping into pointed pieces
  fade_length, skin_fade, top_section helpers for short sides / tops
  bang_section, curtain_bangs         curtain bangs parted in the middle (proto-a L5 /
                                      proto-b Bezier arcs)
  fringe_section, fringe              a fringe from the front hairline onto the forehead:
                                      blunt, brow-skimming, side-swept or piecey, with a
                                      broken irregular edge
  baby_hairs                          very short fine hairs right at the hairline
  curly_locks, curl_centre_length     ringlets / curls: helix coils around guides, children
                                      bundled around each coil
  ponytail, bun, wrap                 hair gathered to a point, the tail / the coiled bun,
                                      a band of hair wrapped around the base

Every function returns plain arrays or Strands (hair.py); nothing here draws.
Units: head units (scalp.CM = one centimetre).
"""
import numpy as np
from scipy.spatial import cKDTree
from . import head
from .head import smoothstep
from .scalp import unit, tangent, rotate_about, crown, surface_z, CM, hash01
from .grow import (grow, grow_two_phase, surface_walk, gather_walk, catmull, bezier, on_surface, combine,
                   shoulder_field, drape_field, face_frame_field, ear_clear_field, decide_front)
from . import strands as st
from .hair import Strands


def _log(log, *a):
    if log:
        log(*a)


# ------------------------------------------------------------------------------- directions
def growth_direction(roots, forward=1.0):
    """the natural direction hair grows out of the scalp: radiating from the crown whorl
    (forward over the front, down over the sides and the nape).  (n, 3) unit tangents."""
    c, _ = crown()
    v = roots.p - c
    v = v + np.array([0, 0, 0.25 * forward])
    return tangent(v, roots.n)


def part_comb(roots, scalp, down=0.30, fwd=0.10, crown_pt=None, back_from=-0.45, back_to=-0.75):
    """L5's comb: on the top and front, sideways away from the parting (or the mid-line)
    and a little down/forward; behind the crown (z back_from .. back_to), radial from the
    crown whorl.  (n, 3) unit tangents."""
    c = crown()[0] if crown_pt is None else np.asarray(crown_pt)
    side = roots.side
    back = smoothstep(back_from, back_to, roots.z)
    radial = tangent(roots.p - c, roots.n)
    cp = tangent(np.stack([side, np.full(len(side), down), np.full(len(side), fwd)], -1), roots.n)
    d = cp * (1 - back[:, None]) + radial * back[:, None]
    return tangent(d, roots.n)


# ------------------------------------------------------------------------------- long hair
def layered_cut(roots, rng, lock_noise, length_y=2.12, back_extra=0.10, centre_shorter=0.22,
                frame=True, frame_y=(1.05, 1.80), frame_depth=0.16, frame_width=0.25, jitter=(0.06, 0.04)):
    """L5's layered cut, as the front-view height y_end (n,) where each strand is cut:
    the length reaches y = length_y (2.12: well past the shoulders) at the sides, a little
    longer behind (back_extra) and shorter in the middle of the back (centre_shorter);
    face-framing layers from the front hairline start at the chin (frame_y[0]) and grow to
    frame_y[1] over frame_depth behind the hairline.  lock_noise (n,) is per-lock (guide)
    noise so neighbouring strands are cut together; jitter = (lock, strand) sd."""
    su = np.clip(np.abs(roots.x - 0.5) / 0.5, 0, 1)
    back = smoothstep(-0.45, -0.75, roots.z)
    front = smoothstep(1.25, 0.85, np.abs(roots.phi)) * (1 - back)
    y_end = (length_y + back_extra * back - centre_shorter * (1 - su) ** 2 * (1 - back)
             + jitter[0] * lock_noise + jitter[1] * rng.normal(size=len(roots)))
    if frame:
        ff = front * smoothstep(frame_depth, 0.0, roots.dist)
        y_ff = frame_y[0] + (frame_y[1] - frame_y[0]) * smoothstep(0.0, frame_depth, roots.dist) + frame_width * su + 0.05 * lock_noise
        y_end = np.where(ff > 0.05, y_end * (1 - ff) + y_ff * ff, y_end)
    return y_end


def long_hair(scalp, rng, q=1.0, n=100000, n_guides=3200, nv=110, length=3.0, nv_out=90, accept=None,
              method='gravity', cut=None, volume=(0.055, 0.07), crown_lift=0.02, asym=0.12, flat_front=0.75,
              root_h=(0.004, 0.012), gravity=(0.16, 0.45), stiff=(0.86, 0.6), stick=0.8,
              face_frame=True, face_gap=-0.025, ears=True, front_frac=0.45, shoulders=True, drape=True,
              extra_field=None, comb=None, two_phase=None,
              waves=None, ends=dict(amount=0.05, under=0.6, start=0.78), clumps=((700, 0.15, 0.55, 1.0), (4000, 0.30, 0.55, 0.8)),
              frizz=(0.0015, 0.0025), stray=(0.05, 0.003, 0.014), groups='part', collide=0.004,
              dense='interpolate', children_kw=None, log=print):
    """Long or medium hair that drapes (most women's styles; men's flow / curtains).

    scalp, rng, q      the Scalp, the Generator, the quality factor (n and n_guides x q).
    n, n_guides, nv    strands, guides, guide vertices; length = guide length (head units,
                       >= the longest strand: 3.0 reaches the mid back); nv_out vertices
                       per strand after cutting.
    accept(P, N)       roots allowed for this hair (e.g. not in the bang section).
    method             'gravity' (proto-a grow: falls from the roots under gravity with
                       volume shells) or 'two_phase' (proto-b: combed flat over the scalp,
                       then released to fall; sleeker tops; two_phase = dict of its args).
    cut(roots, rng, lock_noise) -> y_end (n,)   the cut line (default layered_cut).
    volume = (stack, vol)  shell height rising along the strand: stack over the first .5
                       (hair from the part lies on top), vol from .35 to 1.1 (body);
                       crown_lift adds height over the crown (no flat tops); asym
                       makes one side of the part fuller (+ = the image-right side).
    flat_front         0..1: the front sections lie flatter (under bangs).
    gravity (g0, g1)   per step, ramping from g0 to g0 + g1 over arclength .05 .. .6.
    stiff (s0, s1)     direction keeping above / below arclength 1.0.
    face_frame, ears, shoulders, drape   the L5 fields (cheeks, ears, front/back at the
                       shoulders with front_frac of the side hair in front, straight drape);
                       face_frame may be a dict of grow.face_frame_field arguments (gap,
                       hug, spread, depth, y_range, k); face_gap = its gap.
    waves              None or dict(amp=.026, wavelength=(.42, .56), start=.7, ramp=1.0,
                       lateral=.5, amp_jitter=(.6, 1.4), scale=.30, lock_jitter=.6):
                       phase, wavelength and amplitude come from smooth random fields over
                       the scalp (varying over `scale` head units) so whole sections wave
                       together like real waves, plus lock_jitter (radians) per guide;
                       scale=None gives every guide its own phase (crimped texture).
    ends               dict(amount, under (fraction curling under; the rest flicks out), start).
    clumps             ((count, root strength, tip strength, power), ...) applied in order.
    frizz              (root, tip) amplitude; stray = (fraction, root amp, tip amp).
    groups             'part' (interpolation never crosses the parting) or None.
    collide            final collision distance from the body (every vertex but the root).
    dense              'interpolate' (proto-a: every strand blends its 4 nearest guides of
                       its group - smooth, even flow) or 'children' (proto-b: each guide is
                       the centre of a lock of n / n_guides children carried along it -
                       chunkier, more separated locks; children_kw = dict(radius=.016,
                       clump=.7, clump_start=.35, clump_pow=1.2, fan=.25)).
    Returns dict(strands=Strands, roots=Roots, guides, guide_roots, near (guide per
    strand), clump (lock id), y_end, front (bool per strand))."""
    n = max(200, int(n * q)); n_guides = max(60, int(n_guides * min(1.0, 0.4 + 0.6 * q)))
    seglen = length / nv
    _log(log, f'  long_hair: {n_guides} guides, {n} strands')
    g = scalp.roots(n_guides, rng, accept=accept, blue=True)
    side = g.side
    back = smoothstep(-0.45, -0.75, g.z)
    front = smoothstep(1.25, 0.85, np.abs(g.phi))
    frontish = front * (1 - back)
    d0 = comb(g) if comb is not None else part_comb(g, scalp)
    d0 = tangent(d0, g.n) + 0.05 * g.n
    h_root = root_h[0] + rng.uniform(0, root_h[1] - root_h[0], len(g))
    vol = (volume[1] + 0.05 * rng.random(len(g))) * (1 + asym * _side_weight(g, scalp))
    stack = volume[0] + 0.03 * rng.random(len(g))
    cw = smoothstep(0.75, 1.25, g.elev) * smoothstep(-0.05, -0.45, g.z)          # the crown
    flat = 1 - flat_front * frontish
    layer = rng.random(len(g))
    goes_front = decide_front(g, rng, front_frac, face_frame=frontish)
    fields = []
    if face_frame:
        ffk = dict(gap=face_gap)
        if isinstance(face_frame, dict):
            ffk.update(face_frame)
        fields.append(face_frame_field(frontish, side, layer, **ffk))
    if ears:
        fields.append(ear_clear_field(1 - frontish, side))
    if shoulders:
        fields.append(shoulder_field(goes_front, layer=layer))
    if drape:
        fields.append(drape_field())
    if extra_field is not None:
        fields.append(extra_field)
    field = combine(*fields) if fields else None
    if method == 'gravity':
        def shell(k, s):
            return h_root + (stack * smoothstep(0.0, 0.5, s) + vol * smoothstep(0.35, 1.1, s)) * flat \
                + crown_lift * cw * smoothstep(0.0, 0.3, s)
        G = grow(g.p, d0, nv, seglen, shell=shell, field=field,
                 gravity=lambda k, s: gravity[0] + gravity[1] * smoothstep(0.05, 0.6, s),
                 stiff=lambda k, s: stiff[0] if s < 1.0 else stiff[1], stick=stick)
    else:
        tp = dict(ds=seglen, h0=0.006, h_rate=0.06, h_max=(stack + vol * 0.5) * flat + crown_lift * cw, lift=0.12, turn=0.35)
        tp.update(two_phase or {})
        cfn = tp.pop('comb', None) or part_comb_field(scalp)
        G, _ = grow_two_phase(g.p, g.n, cfn, nv, field=field, **tp)
    ggroup = part_groups(g, scalp) if groups == 'part' else np.zeros(len(g), int)
    if dense == 'children':
        _log(log, '  long_hair: children')
        ck = dict(radius=0.016, clump=0.7, clump_start=0.35, clump_pow=1.2, fan=0.25)
        ck.update(children_kw or {})
        ok = (lambda p: (scalp.density(p) > 0) & (accept(p, None) if accept is not None else True))
        S, near, rp = st.children(G, g.n, max(1, int(round(n / len(g)))), ck.pop('radius'), rng, keep=ok, **ck)
        from .scalp import Roots
        r = Roots(rp, head.normal(rp), scalp)
        sgroup = ggroup[near]
    else:
        _log(log, '  long_hair: interpolating')
        r = scalp.roots(n, rng, accept=accept)
        sgroup = part_groups(r, scalp) if groups == 'part' else np.zeros(len(r), int)
        S, near = st.interpolate(G, g.p, r.p, ggroup, sgroup, k=4, rng=rng)
    lock = rng.normal(size=len(g))[near]
    y_end = cut(r, rng, lock) if cut is not None else layered_cut(r, rng, lock)
    L = st.cut_at_y(S, y_end)
    if waves:
        w = dict(amp=0.026, wavelength=(0.42, 0.56), start=0.7, ramp=1.0, lateral=0.5, amp_jitter=(0.6, 1.4),
                 scale=0.30, lock_jitter=0.6)
        w.update(waves)
        if w['scale']:
            f1, f2, f3 = (st.smooth_field(g.p, rng, w['scale']) for _ in range(3))
            ph = (np.pi * 2.2 * f1 + rng.normal(0, w['lock_jitter'], len(g)))[near] + rng.normal(0, 0.15, len(r))
            lam = (w['wavelength'][0] + (w['wavelength'][1] - w['wavelength'][0]) * (0.5 + 0.5 * f2))[near]
            amp = w['amp'] * (w['amp_jitter'][0] + (w['amp_jitter'][1] - w['amp_jitter'][0]) * (0.5 + 0.5 * f3))[near]
        else:
            ph = rng.uniform(0, 2 * np.pi, len(g))[near] + rng.normal(0, 0.25, len(r))
            lam = rng.uniform(w['wavelength'][0], w['wavelength'][1], len(g))[near]
            amp = w['amp'] * rng.uniform(w['amp_jitter'][0], w['amp_jitter'][1], len(g))[near]
        S = st.wave(S, amp, lam, ph, start=w['start'], ramp=w['ramp'], lateral=w['lateral'])
        L = np.minimum(L * 1.0, st.lengths(S))
    S = st.resample(S, nv_out, L)
    t = np.linspace(0, 1, nv_out)[None, :]
    if ends and ends.get('amount'):
        flip = np.where(rng.random(len(g))[near] < ends.get('under', 0.6), 1.0, -0.8)
        S = st.bend_ends(S, ends['amount'] * flip * (L > 0.9), start=ends.get('start', 0.78))
    cid = np.arange(len(S))
    for (cnt, a, b, pw) in clumps:
        S, cid = st.clump(S, r.p, sgroup, max(1, int(cnt * min(1.0, 0.3 + 0.7 * q))),
                          lambda tt, a=a, b=b, pw=pw: a + b * smoothstep(0.05, 1.0, tt) ** pw, rng)
    if frizz:
        S = st.frizz(S, rng, frizz[0], frizz[0] + frizz[1], freq=6)
    if stray and stray[0] > 0:
        sel = rng.random(len(S)) < stray[0]
        S[sel] += st.smooth_noise(rng, sel.sum(), nv_out, 3, 2) * ((stray[1] + stray[2] * t[..., None] ** 1.2) * smoothstep(0, 0.03, t)[..., None])
    _log(log, '  long_hair: collision')
    S = st.collide_strands(S, collide)
    return dict(strands=Strands(S, 'main', clump=cid), roots=r, guides=G, guide_roots=g, near=near, clump=cid,
                y_end=y_end, front=goes_front[near])


def _side_weight(r, scalp, width=0.25):
    """-1 .. 1 across the head: which side of the parting (or mid-line) and how far,
    continuous (no step at the part behind the crown)."""
    x0 = scalp.parting.x_at(r.z) if scalp.parting is not None else 0.5
    return np.clip((r.x - x0) / width, -1, 1)


def part_groups(r, scalp, behind=None):
    """interpolation groups: 0 / 1 = left / right of the parting where there is one (hair
    must not blend across a parting), 2 = behind the part's end (one group, so the back
    has no seam).  Without a parting everything is group 2."""
    par = scalp.parting
    if par is None:
        return np.full(len(r), 2, int)
    zb = par.z_back - 0.05 if behind is None else behind
    grp = (r.side > 0).astype(int)
    return np.where(r.z < zb, 2, grp)


def part_comb_field(scalp, down=0.45, back_from=-0.40, back_to=-0.70):
    """a comb(p, s) direction field for grow_two_phase: sideways away from the parting
    (or the mid-line) and down on the top and sides, radial from the crown behind."""
    par = scalp.parting
    c = crown()[0]

    def comb(p, s):
        nrm = head.normal(p)
        side = par.side(p) if par is not None else np.where(p[:, 0] >= 0.5, 1.0, -1.0)
        back = smoothstep(back_from, back_to, p[:, 2])
        lat = np.stack([side, np.full(len(p), down), np.full(len(p), -0.10)], -1)
        return tangent(lat * (1 - back[:, None]) + (p - c) * back[:, None] + np.array([0, 0.6, 0]), nrm)
    return comb


# ------------------------------------------------------------------------------- short hair
def top_section(roots, half_width=(0.44, 0.30), front=(0.14, -0.10)):
    """0..1: the long top of a short cut (inside the parietal ridges, above the temples)."""
    dx = np.abs(roots.x - 0.5)
    return smoothstep(half_width[0], half_width[1], dx) * smoothstep(front[0], front[1], roots.y)


def fade_length(roots, short=0.010, long=0.075, y_low=0.50, y_high=-0.08, power=1.0):
    """short sides: length grading from `short` low on the head (y_low: around the ears and
    the nape) to `long` up at y_high.  (n,)"""
    u = smoothstep(y_low, y_high, roots.y) ** power
    return short + (long - short) * u


def skin_fade(roots, y0=0.02, y1=0.36, strength=0.78, top=None):
    """a skin fade: hair thins out low on the sides and nape so the scalp shows (the scalp
    is drawn underneath in the user's skin).  Returns (opacity factor, width factor) (n,)."""
    f = smoothstep(y0, y1, roots.y)
    if top is not None:
        f = f * (1 - top)
    return 1 - strength * f, 1 - 0.35 * f


def short_hair(roots, rng, length, direction, H, nv=40, h_end=None, pieces=900, piece_yaw=0.42, piece_len=0.15,
               strand_yaw=0.07, bend=0.40, texture=None, follow=0.3,
               clumps=((1100, 0.05, 0.88, 0.6), (7000, 0.10, 0.40, 1.0)), frizz=(0.0005, 0.0022), collide=0.003,
               kind='main', log=print):
    """Short hair lying on (or standing off) the head: crops, fades, buzz cuts, pixies,
    slick-backs (proto-a C12).

    roots      Roots of these strands; length (n,) head units (fade_length for sides).
    direction  (n, 3) styling direction (tangent; e.g. growth_direction, forward, back).
    H (n,)     height above the scalp the hair rises to (volume; ~.10-.15 on a textured
               top, ~.01-.02 on short sides, ~.004 slicked).
    h_end (n,) extra height at the tips (+ flick up, - come down to the skin).
    pieces     number of pieces (~1 cm locks) with their own yaw (piece_yaw radians sd),
               length (piece_len relative sd) and bend wander (bend): messy, not combed.
               texture (n,) 0..1 scales that per-piece randomness (1 = full; e.g. the top
               section of a crop) - default 1 everywhere.
    clumps     ((count, root, tip, power), ...): pieces converge to points (matte texture).
    Returns (Strands, piece id per strand)."""
    n = len(roots)
    tex = np.ones(n) if texture is None else np.asarray(texture, np.float64)
    pieces = max(1, min(n, pieces))
    centres = rng.choice(n, pieces, replace=False)
    _, cid = cKDTree(roots.p[centres]).query(roots.p, 1)
    yaw = rng.normal(0, piece_yaw, pieces)[cid] * tex + rng.normal(0, strand_yaw, n)
    sd = rotate_about(tangent(direction, roots.n), roots.n, yaw)
    L = np.asarray(length, np.float64) * (1 + piece_len * rng.normal(size=pieces)[cid] * tex) * (1 + 0.07 * rng.normal(size=n))
    L = np.clip(L, 0.004, None)
    bn = (st.smooth_noise(rng, pieces, nv, 1.2, 2)[cid] * bend + st.smooth_noise(rng, n, nv, 2.0, 1) * 0.09) * tex[:, None, None]
    S = surface_walk(roots.p, sd, L, H, nv, h_end=h_end, yaw_noise=bn, follow=follow)
    cl = np.zeros(n, int)
    for (cnt, a, b, pw) in clumps:
        S, cl = st.clump(S, roots.p, None, min(n, cnt), lambda tt, a=a, b=b, pw=pw: a + b * smoothstep(0.1, 1.0, tt) ** pw, rng)
    if frizz:
        S = st.frizz(S, rng, frizz[0], frizz[0] + frizz[1], freq=3, power=1.3, root_ramp=0.1)
    if collide:
        S = st.collide_strands(S, collide)
    return Strands(S, kind, clump=cl), cid


# ------------------------------------------------------------------------------- bangs
CURTAIN_INNER = [(0.045, 0.0), (0.09, 0.08), (0.15, 0.16), (0.22, 0.245), (0.29, 0.325), (0.345, 0.41)]
CURTAIN_OUTER = [(0.24, -0.03), (0.31, 0.03), (0.37, 0.12), (0.42, 0.23), (0.445, 0.35), (0.455, 0.47)]


def bang_section(scalp, width=0.20, depth=0.13, rag=0.010, phi_max=0.7, x0=0.5, soft=0.03):
    """accept(P, N) for the bang section: a band behind the front hairline, `width` either
    side of x0 and `depth` deep (shallower at its sides), with a ragged back edge that is
    interleaved with the surrounding hair over `soft` (deterministic per point, so
    `~accept` is the exact complement for the rest of the hair)."""
    def accept(P, N):
        dx = np.abs(P[:, 0] - x0)
        j = soft * (hash01(P, 11) - 0.5)
        d = depth * (1 - 0.45 * (dx / width) ** 2) + rag * np.sin(P[:, 0] * 57.0) + j
        return (dx < width + 0.5 * j) & (scalp.hairline.dist(P) < d) & (np.abs(scalp_phi(P)) < phi_max)
    return accept


def scalp_phi(P):
    return head.azimuth(P)


def curtain_bangs(scalp, rng, n, width=0.20, depth=0.13, inner=CURTAIN_INNER, outer=CURTAIN_OUTER,
                  h=(0.050, 0.065, 0.075, 0.085, 0.095, 0.105), length=(0.70, 0.30), clumps=260, nv=90,
                  jitter=0.007, x0=0.5, log=print):
    """Curtain bangs parted in the middle (L5): each strand follows a front-view path
    between the inner edge (at the part) and the outer edge (to the cheekbone) of its
    curtain, chosen by how far from the part its root is (a); the path is lifted onto the
    forehead at heights h (head units above the skin, one per control point; the bangs
    stand off the forehead a little at the root and lie down toward the ends).  Inner
    strands are cut shorter (around the brow), outer ones reach the cheekbone; the ends are
    ragged.  inner / outer: control points (dx from x0, y) for the image-right curtain,
    mirrored for the left.  Returns (Strands kind 'fringe', Roots)."""
    r = scalp.roots(n, rng, accept=bang_section(scalp, width, depth, x0=x0))
    nb = len(r)
    bs = np.where(r.x >= x0, 1.0, -1.0)
    v = np.clip(np.abs(r.x - x0) / width, 0, 1)
    w_ = np.clip(r.dist / depth, 0, 1)
    a = np.clip(0.8 * v + 0.2 * rng.random(nb) + 0.15 * w_, 0, 1)
    I = np.asarray(inner, np.float64); O = np.asarray(outer, np.float64)
    WP = I[None] * (1 - a[:, None, None]) + O[None] * a[:, None, None]
    dxr = np.abs(r.x - x0)
    WP[:, 0, 0] = np.maximum(WP[:, 0, 0], dxr + 0.02)
    WP[:, 1, 0] = np.maximum(WP[:, 1, 0], dxr + 0.05)
    WP[:, 0, 1] = np.maximum(WP[:, 0, 1], r.y + 0.03)
    WP = WP + rng.normal(0, jitter, WP.shape)
    k = WP.shape[1]
    W = np.zeros((nb, k + 1, 3))
    W[:, 0] = r.p
    hb = np.asarray(h, np.float64)[None, :k] * (1 + 0.4 * w_[:, None]) + 0.012 * rng.random((nb, 1))
    W[:, 1:] = on_surface(x0 + bs[:, None] * WP[:, :, 0], WP[:, :, 1], hb)
    B = catmull(W, nv)
    frac = np.clip(length[0] + length[1] * a + 0.09 * rng.normal(size=nb), 0.5, 1.0)
    B = st.resample(B, nv, st.lengths(B) * frac)
    B = st.collide_strands(B, 0.012)
    B, cid = st.clump(B, r.p, (bs > 0).astype(int), clumps, lambda tt: 0.15 + 0.55 * smoothstep(0.1, 1.0, tt), rng)
    B = st.frizz(B, rng, 0.0012, 0.0042, freq=4)
    return Strands(B, 'fringe', clump=cid), r


def fringe_section(scalp, half_width=0.30, depth=0.14, phi_max=1.0, x0=0.5, rag=0.008, soft=0.04):
    """accept(P, N) for a straight fringe: the front band of the scalp `depth` behind the
    hairline across |x - x0| < half_width; its back edge is interleaved with the hair
    behind over `soft` (no visible line where the fringe section starts)."""
    def accept(P, N):
        dx = np.abs(P[:, 0] - x0)
        j = soft * (hash01(P, 13) - 0.5)
        d = depth * (1 - 0.35 * (dx / half_width) ** 2) + rag * np.sin(P[:, 0] * 43.0 + 1.0) + j
        return (dx < half_width + 0.5 * j) & (scalp.hairline.dist(P) < d) & (np.abs(head.azimuth(P)) < phi_max)
    return accept


def fringe(scalp, rng, n, section, end_y=0.19, arch=0.06, sweep=0.0, spread=1.0, lift=0.035, h=0.010,
           h_back=0.020, nv=50, edge=None, locks=(40, 140), lock_strength=((0.05, 0.35), (0.10, 0.55)),
           frizz=(0.001, 0.004), log=print):
    """A fringe falling from the front hairline onto the forehead.

    section       accept(P, N) of its roots (fringe_section / bang_section).
    end_y         front-view height of the cut at the centre (brow top ~ .22, a
                  brow-skimming fringe ~ .19, a short French-crop fringe ~ .06);
                  arch: how much longer toward the sides (+) or shorter (-).
    sweep         sideways travel of the ends (head units; + toward image right): a
                  side-swept fringe ~ .15-.30; spread scales the ends' x away from the
                  centre (1: straight down; >1 fans out).
    lift, h       the fringe leaves the scalp lifted by `lift` and lies `h` off the
                  forehead (+ h_back for roots further behind the hairline: they lie on top).
    edge          dict: the broken, irregular cut line (head units, front-view y):
                  wave = a slow wander of the cut line across the forehead (default .014),
                  piece = sd of each big piece's length (.016), lock = sd per small lock
                  (.008), strand = per strand (.005), point / point_depth = the fraction of
                  strands point-cut shorter and by up to how much (.35 / .06: tapers each
                  lock).  Neighbouring pieces vary together (no regular comb teeth) and the
                  line is never ruler-straight (no bowl line).
    locks         (big pieces, small locks): ~(40, 140) for a full fringe;
                  lock_strength ((root, tip) for the pieces, (root, tip) for the locks).
    Returns (Strands kind 'fringe', Roots)."""
    r = scalp.roots(n, rng, accept=section)
    m = len(r)
    depth = np.clip(r.dist / 0.15, 0, 1)
    xe = 0.5 + (r.x - 0.5) * spread + sweep * (0.6 + 0.4 * rng.random(m))
    # piece / lock structure first, so whole pieces share their length
    nbig = max(1, min(m, locks[0])); nl = max(1, min(m, locks[1]))
    _, piece = cKDTree(r.p[rng.choice(m, nbig, replace=False)]).query(r.p, 1)
    centres = rng.choice(m, nl, replace=False)
    _, lock = cKDTree(r.p[centres]).query(r.p, 1)
    e = dict(wave=0.014, piece=0.016, lock=0.008, strand=0.005, point=0.35, point_depth=0.06)
    e.update(edge or {})
    ph = rng.uniform(0, 2 * np.pi, 2)
    ye = (end_y + arch * ((xe - 0.5) / 0.30) ** 2
          + e['wave'] * (0.7 * np.sin(xe * 11.0 + ph[0]) + 0.3 * np.sin(xe * 23.0 + ph[1]))
          + e['piece'] * rng.normal(size=nbig)[piece] + e['lock'] * rng.normal(size=nl)[lock]
          + e['strand'] * rng.normal(size=m)
          - (rng.random(m) < e['point']) * e['point_depth'] * rng.random(m) ** 0.7)
    # the end point lies on the forehead; the start leaves the scalp forward and up
    hh = h + h_back * depth
    E = on_surface(xe, ye, hh)
    fwd = tangent(np.array([0, 1.0, 0.25]) + 0 * r.p, r.n)
    C1 = r.p + r.n * lift * (0.8 + 0.4 * depth)[:, None] + fwd * 0.03
    mid_y = np.minimum(r.y + 0.06, 0.5 * (r.y + ye))
    C2 = on_surface(0.5 * (r.x + xe), mid_y, hh + lift * 0.6)
    B = bezier(np.stack([r.p, C1, C2, E], 1), nv)
    B = st.collide_strands(B, h * 0.6)
    (a0, b0), (a1, b1) = lock_strength
    B, _ = st.clump(B, r.p, None, nbig, lambda tt: a0 + b0 * smoothstep(0.15, 1.0, tt), rng)
    B, cid = st.clump(B, r.p, None, nl, lambda tt: a1 + b1 * smoothstep(0.15, 1.0, tt), rng)
    B = st.frizz(B, rng, frizz[0], frizz[1], freq=3)
    return Strands(B, 'fringe', clump=cid), r


# ------------------------------------------------------------------------------- hairline
def baby_hairs(scalp, rng, n, length=(0.02, 0.07), phi_range=(0.0, 1.25), mid_gap=0.05, nv=24, flow=None,
               lie=0.004, curl=0.004):
    """very short, fine hairs right at the hairline (front and temples by default; use
    phi_range=(2.3, 3.14) for the nape): roots chosen nearest the hairline, growing down /
    outward along the skin.  flow (n, 3) overrides the direction.  Returns Strands 'baby'."""
    cand = scalp.roots(n * 3, rng, accept=lambda P, N: (np.abs(head.azimuth(P)) >= phi_range[0]) & (np.abs(head.azimuth(P)) <= phi_range[1])
                       & (np.abs(P[:, 0] - 0.5) > mid_gap))
    sel = np.argsort(cand.dist)[:n]
    r = cand.take(sel)
    side = np.where(r.x >= 0.5, 1.0, -1.0)
    L = rng.uniform(length[0], length[1], len(r))
    if flow is None:
        back = smoothstep(1.8, 2.4, np.abs(r.phi))
        flow = np.stack([side * 0.6 * (1 - back), np.ones(len(r)), 0.3 * (1 - back) - 0.3 * back], -1)
    d = tangent(flow + rng.normal(0, 0.4, (len(r), 3)), r.n)
    th = np.linspace(0, 1, nv)[None, :, None]
    P = r.p[:, None, :] + (d[:, None, :] * th) * L[:, None, None] + r.n[:, None, :] * lie * th
    P = P + st.smooth_noise(rng, len(r), nv, 1.2, 1) * curl * th
    return Strands(P.astype(np.float32), 'baby')


# ------------------------------------------------------------------------------- curls
def curl_centre_length(hair_length, radius, pitch):
    """centre-line length of a coil whose hair is hair_length long (curls shrink)."""
    return hair_length * pitch / np.sqrt(pitch ** 2 + (2 * np.pi * radius) ** 2)


def curly_locks(guides, groot_n, rng, per=12, radius=(0.025, 0.045), pitch=(0.09, 0.14), tube=0.010,
                radius_end=None, pitch_end=None, start=0.04, hand=None, clump=0.55, fan=0.35, frizz=(0.002, 0.006),
                vpt=12, collide=0.004, scalp=None):
    """Ringlets / curls: each guide centre line (G, m, 3) is coiled into a helix (radius and
    pitch drawn per guide from the ranges; radius_end / pitch_end = per-guide multipliers
    toward the tip, e.g. .8 = tighter ends), then `per` children are bundled around the
    coil within `tube` (children(), which carries the offset along the coil), so each lock
    is a coherent spiral of many hairs.  hand: per-guide +-1 (default random).  scalp:
    children whose roots would fall outside its hair area are dropped.
    Returns (Strands 'main', guide index per strand, coiled guides)."""
    G = len(guides)
    rad = rng.uniform(radius[0], radius[1], G)
    pit = rng.uniform(pitch[0], pitch[1], G)
    hd = rng.choice([-1.0, 1.0], G) if hand is None else hand
    ph = rng.uniform(0, 2 * np.pi, G)
    C = st.helix(guides, rad, pit, ph, hd, start=start, ramp=0.05, ref=groot_n, vpt=vpt,
                 radius_end=None if radius_end is None else rad * radius_end,
                 pitch_end=None if pitch_end is None else pit * pitch_end)
    keep = None if scalp is None else (lambda p: scalp.density(p) > 0)
    S, gi, _ = children(C, groot_n, per, tube, rng, clump=clump, fan=fan, keep=keep)
    if frizz:
        S = st.frizz(S, rng, frizz[0], frizz[1], freq=8)
    if collide:
        S = st.collide_strands(S, collide)
    return Strands(S, 'main', clump=gi), gi, C


def children(*a, **k):
    return st.children(*a, **k)


# ------------------------------------------------------------------------------- updos
def gather_point(x=0.5, y=-0.12, z=-0.80):
    """a point on the scalp near (x, y, z) and its outward normal (ponytail / bun base;
    high pony ~ (.5, -.15, -.78), low pony at the nape ~ (.5, .62, -.74), top knot
    ~ (.5, -.33, -.35))."""
    p = head.project(np.array([[x, y, z]], np.float64), 0.0)[0]
    return p, head.normal(p[None])[0]


def wrap(centre, axis, radius, width, n, rng, turns=(1.0, 1.6), nv=48, kind='wrap'):
    """a band of hair (or an elastic) wrapped around a point: n strands winding `turns`
    times around `axis` at `radius`, spread over `width` along the axis.  Strands 'wrap'."""
    axis = unit(np.asarray(axis, np.float64))
    e1 = unit(np.cross(axis, [0, 1.0, 0] if abs(axis[1]) < 0.9 else [1.0, 0, 0])); e2 = np.cross(axis, e1)
    th0 = rng.uniform(0, 2 * np.pi, n); tr = rng.uniform(turns[0], turns[1], n)
    off = rng.uniform(-0.5, 0.5, n) * width
    rr = radius * rng.uniform(0.97, 1.06, n)
    u = np.linspace(0, 1, nv)[None, :]
    th = th0[:, None] + 2 * np.pi * tr[:, None] * u
    a = off[:, None] + 0.15 * width * np.sin(3 * th)
    P = centre + axis * a[..., None] + rr[:, None, None] * (np.cos(th)[..., None] * e1 + np.sin(th)[..., None] * e2)
    return Strands(P.astype(np.float32), kind, rooted=False)


def ponytail(scalp, rng, q=1.0, gather=(0.5, -0.15, -0.78), n_scalp=60000, n_tail=30000, n_guides=500,
             tie_r=0.085, h=0.004, sleek=0.3, tail_len=1.6, tail_dir=(0.0, 0.15, -1.0), lift=0.5,
             gravity=(0.10, 0.40), stiff=(0.95, 0.80), cut_jitter=(0.10, 0.05, 0.35, 0.25), waves=None,
             tail_clumps=((300, 0.15, 0.60, 1.0), (2000, 0.25, 0.55, 0.8)), accept=None, nv_scalp=40, nv_tail=80,
             wrap_width=0.035, log=print):
    """A ponytail: all the hair combed tight over the head to the gather point (sleek: a
    little clumping makes the brushed grooves), a tail falling from there, and a band of
    hair wrapped around the base.

    gather          (x, y, z) near the scalp (see gather_point).
    tie_r           radius of the gathered bunch at the tie (.085 ~ 1.4 cm: a full head of
                    hair is ~3 cm across at the elastic).
    h, sleek        height of the combed hair over the scalp; sleek 0..1 (1 = glass smooth).
    tail_len        length of the tail (head units; 1.6 ~ to the shoulder blades).
    tail_dir        the tail's initial direction (it leaves the head outward and back,
                    then falls); lift: how much it first points away from the head.
    cut_jitter      (lock, strand, point fraction, point depth) for a tapered, natural end.
    Returns dict(scalp=Strands, tail=Strands, wrap=Strands, gather=(point, normal))."""
    G0, nG = gather_point(*gather)
    rs = scalp.roots(max(200, int(n_scalp * q)), rng, accept=accept)
    _log(log, f'  ponytail: {len(rs)} scalp strands, gather at {np.round(G0, 3)}')
    stop = tie_r * np.sqrt(rng.uniform(0.15, 1.0, len(rs)))
    # each strand aims at its own spot of the bunch, so they arrive spread over the tie
    e1 = unit(np.cross(nG, [0, 1.0, 0])); e2 = np.cross(nG, e1)
    ang = np.arctan2(((rs.p - G0) * e2).sum(1), ((rs.p - G0) * e1).sum(1))
    tgt = G0 + nG * 0.01 + (np.cos(ang)[:, None] * e1 + np.sin(ang)[:, None] * e2) * (stop * 0.6)[:, None]
    hh = h + (1 - sleek) * 0.01 * rng.random(len(rs))
    P, L = gather_walk(rs.p, tgt, nv=nv_scalp, h=hh, stop=0.004)
    P, c1 = st.clump(P, rs.p, None, max(50, int(1500 * q)), lambda tt: (1 - sleek) * 0.4 * smoothstep(0.0, 0.5, tt) + 0.15, rng)
    P = st.frizz(P, rng, 0.0003, 0.0003 + 0.002 * (1 - sleek), freq=5)
    P = st.collide_strands(P, 0.002)
    scalp_s = Strands(P, 'main', clump=c1)
    # the tail
    ng = max(40, int(n_guides * min(1.0, 0.4 + 0.6 * q)))
    td = unit(np.asarray(tail_dir, np.float64))
    d0 = unit(nG * lift + td)
    ra = np.sqrt(rng.random(ng)) * tie_r; aa = rng.uniform(0, 2 * np.pi, ng)
    groots = G0 + nG * 0.012 + ra[:, None] * (np.cos(aa)[:, None] * e1 + np.sin(aa)[:, None] * e2)
    spread = unit(d0 + 0.35 * (groots - G0 - nG * 0.012) / tie_r)
    nv = 90
    seg = tail_len * 1.15 / nv
    Gd = grow(groots, spread, nv, seg, shell=0.012,
              gravity=lambda k, s: gravity[0] + gravity[1] * smoothstep(0.0, 0.5, s),
              stiff=lambda k, s: stiff[0] if s < 0.25 else stiff[1])
    nt = max(200, int(n_tail * q))
    rt = np.sqrt(rng.random(nt)) * tie_r; at = rng.uniform(0, 2 * np.pi, nt)
    troots = G0 + nG * 0.012 + rt[:, None] * (np.cos(at)[:, None] * e1 + np.sin(at)[:, None] * e2)
    T, near = st.interpolate(Gd, groots, troots, k=4, rng=rng)
    lock = rng.normal(size=ng)[near]
    Lt = tail_len * (1 + cut_jitter[0] * lock + cut_jitter[1] * rng.normal(size=nt))
    Lt = Lt * (1 - (rng.random(nt) < cut_jitter[2]) * cut_jitter[3] * rng.random(nt))
    if waves:
        w = dict(amp=0.02, wavelength=(0.35, 0.5), start=0.3, ramp=0.6, lateral=0.6)
        w.update(waves)
        T = st.wave(T, w['amp'] * rng.uniform(0.6, 1.4, ng)[near], rng.uniform(*w['wavelength'], ng)[near],
                    rng.uniform(0, 2 * np.pi, ng)[near], start=w['start'], ramp=w['ramp'], lateral=w['lateral'])
    T = st.resample(T, nv_tail, Lt)
    for (cnt, a, b, pw) in tail_clumps:
        T, ct = st.clump(T, troots, None, max(1, int(cnt * min(1.0, 0.3 + 0.7 * q))), lambda tt, a=a, b=b, pw=pw: a + b * smoothstep(0.05, 1.0, tt) ** pw, rng)
    T = st.frizz(T, rng, 0.001, 0.004, freq=6)
    T = st.collide_strands(T, 0.006)
    tail = Strands(T, 'main', clump=ct, rooted=False)
    wr = wrap(G0 + nG * 0.012 + d0 * 0.012, d0, tie_r * 1.05, wrap_width, max(30, int(400 * q)), rng)
    return dict(scalp=scalp_s, tail=tail, wrap=wr, gather=(G0, nG), tail_guides=Gd)


def bun(scalp, rng, q=1.0, gather=(0.5, -0.20, -0.74), n_scalp=60000, n_bun=25000, radius=0.17, height=0.13,
        rope_r=0.05, turns=2.3, twist=0.16, h=0.004, sleek=0.4, messy=0.0, accept=None, nv_scalp=40, nv_bun=120,
        log=print):
    """A bun: hair combed to the gather point, then coiled into a bun - a twisted rope
    spiralling outward around the base's normal (radius, height: the bun's size; rope_r
    the rope's thickness; turns of the coil; twist: pitch of the hairs twisting around the
    rope).  messy 0..1 loosens it (loops, wisps).  Returns dict(scalp, bun, gather)."""
    G0, nG = gather_point(*gather)
    rs = scalp.roots(max(200, int(n_scalp * q)), rng, accept=accept)
    _log(log, f'  bun: {len(rs)} scalp strands, gather at {np.round(G0, 3)}')
    e1 = unit(np.cross(nG, [0, 1.0, 0])); e2 = np.cross(nG, e1)
    ang = np.arctan2(((rs.p - G0) * e2).sum(1), ((rs.p - G0) * e1).sum(1))
    rad = radius * 0.55 * np.sqrt(rng.uniform(0.2, 1.0, len(rs)))
    tgt = G0 + nG * 0.01 + (np.cos(ang)[:, None] * e1 + np.sin(ang)[:, None] * e2) * rad[:, None]
    hh = h + (1 - sleek) * 0.01 * rng.random(len(rs))
    P, L = gather_walk(rs.p, tgt, nv=nv_scalp, h=hh, stop=0.004)
    P, c1 = st.clump(P, rs.p, None, max(50, int(1500 * q)), lambda tt: (1 - sleek) * 0.4 * smoothstep(0.0, 0.5, tt) + 0.15, rng)
    P = st.frizz(P, rng, 0.0003, 0.0005 + 0.003 * (1 - sleek), freq=5)
    P = st.collide_strands(P, 0.002)
    # the rope's centre line: a spiral from the middle outward and down around the axis
    nb = max(200, int(n_bun * q))
    K = 400
    u = np.linspace(0, 1, K)
    r_u = radius * (0.25 + 0.75 * u ** 0.8) - rope_r * 0.6
    th = 2 * np.pi * turns * u
    hgt = height * (1 - u ** 1.6) * 0.85 + rope_r
    rope = G0 + nG * hgt[:, None] + r_u[:, None] * (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2)
    u0 = rng.uniform(0, 0.55, nb); u1 = np.minimum(1, u0 + rng.uniform(0.35, 0.8, nb))
    uu = u0[:, None] + (u1 - u0)[:, None] * np.linspace(0, 1, 60)[None, :]
    C = np.stack([np.interp(uu, u, rope[:, i]) for i in range(3)], -1)
    # an uneven rope: its thickness swells and thins along the coil, and every hair has
    # its own twist pitch, so the bun reads as twisted hair, not a regular spiral
    swell = 1 + 0.35 * np.sin(2 * np.pi * (2.7 * uu + rng.uniform(0, 1))) * (0.5 + 0.5 * rng.random((nb, 1)))
    rr = rope_r * np.sqrt(rng.random(nb)) * (1 + messy * 0.6 * rng.random(nb))
    C = C + (st.smooth_noise(rng, nb, C.shape[1], 1.5, 2) * rope_r * (0.25 + 0.6 * messy)).astype(np.float64)
    Bn = st.helix(C, rr, twist * rng.uniform(0.7, 1.4, nb), rng.uniform(0, 2 * np.pi, nb), 1.0,
                  start=0.0, ramp=0.0, ref=np.repeat(nG[None], nb, 0), m_out=nv_bun)
    Bn = (Bn - G0) * st.resample_attr(swell, nv_bun)[..., None] ** 0.15 + G0
    Bn = st.frizz(Bn, rng, 0.0008 + 0.004 * messy, 0.002 + 0.02 * messy, freq=5)
    Bn = st.collide_strands(Bn, 0.004)
    return dict(scalp=Strands(P, 'main', clump=c1), bun=Strands(Bn, 'main', rooted=False), gather=(G0, nG), rope=rope)
