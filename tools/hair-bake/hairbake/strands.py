"""Operations on strand arrays.

A set of strands is an array S (n, m, 3) float: n strands of m vertices each, vertex 0 at
the root, in head units.  Functions here never need the strands to be evenly spaced; the
ones that care work in arclength.  `t` below always means the normalised position along a
strand (0 root .. 1 tip), `s` the arclength from the root in head units.

  arclen, resample, cut_at_y, cut            lengths and cutting
  frames                                     parallel-transport frames along strands
  interpolate                                dense strands from guides (proto-a: k nearest
                                             guides of the same group, jittered weights)
  children                                   clumped children around each guide (proto-b:
                                             root offset carried by parallel transport,
                                             clump profile, fan, layer)
  clump                                      pull strands toward clump centre strands
  smooth_noise, frizz                        smooth per-strand noise
  wave                                       S-waves (radial + lateral, coherent per clump)
  helix                                      coils around a centre line (curls, ringlets,
                                             twisted ropes)
  bend_ends                                  ends curving under / flicking out
  ragged_lengths                             broken, irregular cut lines (no bowl line,
                                             no comb teeth)
  flyaways, strays                           strands leaving the surface, broken short hairs
  collide_strands                            final collision against the body
"""
import numpy as np
from scipy.spatial import cKDTree
from . import head, canon
from .head import smoothstep
from .scalp import unit, tangent


CHUNK = 16384          # strands per block in the per-strand functions (bounds peak memory)


def _rows(n, chunk=CHUNK):
    for a in range(0, n, chunk):
        yield slice(a, min(n, a + chunk))


def _per(x, n, sl):
    """slice a per-strand argument (scalar or (n,) / (n, ...)) to the block sl."""
    x = np.asarray(x)
    return x[sl] if (x.ndim >= 1 and x.shape[0] == n) else x


# ------------------------------------------------------------------------------- length
def arclen(S):
    """cumulative arclength (n, m) along each strand (0 at the root)."""
    S = np.asarray(S, np.float64)
    seg = np.linalg.norm(np.diff(S, axis=1), axis=-1)
    return np.concatenate([np.zeros((len(S), 1)), np.cumsum(seg, 1)], 1)


def lengths(S):
    return arclen(S)[:, -1]


def _locate(cs, u):
    """rows of increasing cs (n, m); targets u (n, k) -> segment index j (n, k) and
    fraction f inside it."""
    n, m = cs.shape
    big = float(cs[:, -1].max()) + 1.0
    off = (np.arange(n) * big)[:, None]
    flat = (cs + off).ravel()
    j = np.searchsorted(flat, (u + off).ravel(), side='right').reshape(u.shape) - 1
    j = np.clip(j - (np.arange(n) * m)[:, None], 0, m - 2)
    c0 = np.take_along_axis(cs, j, 1); c1 = np.take_along_axis(cs, j + 1, 1)
    f = np.clip((u - c0) / np.maximum(c1 - c0, 1e-12), 0, 1)
    return j, f


def sample_at(S, s):
    """points of the strands at arclengths s (n, k) -> (n, k, 3)."""
    S = np.asarray(S, np.float64)
    j, f = _locate(arclen(S), np.asarray(s, np.float64))
    a = np.take_along_axis(S, j[..., None], 1); b = np.take_along_axis(S, (j + 1)[..., None], 1)
    return a * (1 - f[..., None]) + b * f[..., None]


def resample(S, m_out, length=None, start=None):
    """resample each strand to m_out vertices evenly by arclength, keeping its first
    `length` (n,) (default: all of it; longer than the strand clamps at its end), from
    arclength `start` (n,) (default 0)."""
    n = len(S)
    if n > CHUNK:
        out = np.empty((n, m_out, 3), np.float32)
        for sl in _rows(n):
            out[sl] = resample(S[sl], m_out, None if length is None else _per(length, n, sl),
                               None if start is None else _per(start, n, sl))
        return out
    S = np.asarray(S, np.float64)
    cs = arclen(S)
    L = cs[:, -1] if length is None else np.minimum(np.asarray(length, np.float64) + (0 if start is None else start), cs[:, -1])
    s0 = np.zeros(len(S)) if start is None else np.asarray(start, np.float64)
    u = s0[:, None] + np.linspace(0, 1, m_out)[None, :] * (L - s0)[:, None]
    j, f = _locate(cs, u)
    a = np.take_along_axis(S, j[..., None], 1); b = np.take_along_axis(S, (j + 1)[..., None], 1)
    return (a * (1 - f[..., None]) + b * f[..., None]).astype(np.float32)


def resample_attr(X, m_out):
    """per-vertex attribute (n, m) or (1, m) resampled by index to m_out vertices."""
    X = np.asarray(X, np.float32)
    m = X.shape[1]
    if m == m_out:
        return X
    t = np.linspace(0, m - 1, m_out)
    i0 = np.clip(np.floor(t).astype(int), 0, m - 2); f = (t - i0)[None, :]
    return X[:, i0] * (1 - f) + X[:, i0 + 1] * f


def cut_at_y(S, y_end):
    """arclength (n,) at which each strand first reaches y >= y_end (n,) (a front-view cut
    line: hair hanging down is cut where it crosses that height); strands that never reach
    it keep their whole length."""
    n = len(S)
    if n > CHUNK:
        return np.concatenate([cut_at_y(S[sl], _per(y_end, n, sl)) for sl in _rows(n)])
    S = np.asarray(S, np.float64)
    cs = arclen(S)
    y = S[..., 1]
    ye = np.asarray(y_end, np.float64)[:, None]
    hit = y >= ye
    first = np.where(hit.any(1), hit.argmax(1), S.shape[1] - 1)
    i1 = np.clip(first, 1, S.shape[1] - 1); i0 = i1 - 1
    r = np.arange(len(S))
    y0, y1 = y[r, i0], y[r, i1]
    f = np.clip((ye[:, 0] - y0) / np.where(np.abs(y1 - y0) > 1e-9, y1 - y0, 1e-9), 0, 1)
    L = cs[r, i0] + f * (cs[r, i1] - cs[r, i0])
    return np.where(hit.any(1) & (first > 0), L, np.where(first == 0, cs[:, 1], cs[:, -1]))


def cut(S, length, m_out=None):
    """the first `length` (n,) of each strand, resampled to m_out (default: same m)."""
    return resample(S, m_out or S.shape[1], length)


# ------------------------------------------------------------------------------- frames
def tangents(S):
    T = np.gradient(np.asarray(S, np.float64), axis=1)
    return unit(T)


def frames(S, ref=None):
    """parallel-transport frames along strands: T (tangent), U, V (n, m, 3) each; U starts
    as `ref` (n, 3) (e.g. the scalp normal at the root) made perpendicular to the first
    tangent, and is carried along without twisting."""
    S = np.asarray(S, np.float64)
    n, m, _ = S.shape
    T = tangents(S)
    if ref is None:
        ref = np.where(np.abs(T[:, 0, 1:2]) < 0.9, np.array([0, 1.0, 0]), np.array([1.0, 0, 0]))
    U = np.zeros_like(S); u = tangent(ref, T[:, 0])
    bad = np.linalg.norm(np.cross(ref, T[:, 0]), axis=-1) < 1e-6
    if bad.any():
        u[bad] = tangent(np.array([1.0, 0, 0]) + 0 * T[bad, 0], T[bad, 0])
    U[:, 0] = u
    for i in range(1, m):
        u = u - (u * T[:, i]).sum(-1, keepdims=True) * T[:, i]
        u = unit(u)
        U[:, i] = u
    V = np.cross(T, U)
    return T, U, V


# ------------------------------------------------------------------------------- guides
def interpolate(guides, groots, roots, ggroup=None, sgroup=None, k=4, rng=None, jitter=0.3):
    """dense strands from guides: each strand follows the inverse-distance blend of its k
    nearest guides OF THE SAME GROUP (so hair never blends across a parting or between
    front and back sections), offset to its own root.  jitter (0..1) randomises the
    weights a little so the flow is not mechanically uniform.
    guides (G, m, 3), groots (G, 3), roots (n, 3); groups are int labels (G,), (n,).
    Returns strands (n, m, 3) float32 and the index of the nearest guide (n,)."""
    guides = np.asarray(guides, np.float32)
    groots = np.asarray(groots); roots = np.asarray(roots)
    ns, nv = len(roots), guides.shape[1]
    ggroup = np.zeros(len(guides), int) if ggroup is None else np.asarray(ggroup)
    sgroup = np.zeros(ns, int) if sgroup is None else np.asarray(sgroup)
    out = np.zeros((ns, nv, 3), np.float32)
    near = np.zeros(ns, int)
    for gid in np.unique(sgroup):
        gi = np.where(ggroup == gid)[0]; si = np.where(sgroup == gid)[0]
        if len(si) == 0:
            continue
        if len(gi) == 0:
            raise ValueError(f'group {gid} has strands but no guides')
        kk = min(k, len(gi))
        dd, ii = cKDTree(groots[gi]).query(roots[si], kk)
        if kk == 1:
            dd = dd[:, None]; ii = ii[:, None]
        w = 1.0 / (dd + 0.004) ** 2
        if rng is not None and jitter:
            w *= rng.uniform(1 - jitter, 1 + jitter, w.shape)
        w /= w.sum(1, keepdims=True)
        G = guides[gi]
        for c in range(0, len(si), 4000):
            sl = slice(c, c + 4000)
            path = np.einsum('nk,nkvd->nvd', w[sl].astype(np.float32), G[ii[sl]])
            off = (roots[si[sl]] - path[:, 0]).astype(np.float32)
            out[si[sl]] = path + off[:, None, :]
        near[si] = gi[ii[:, 0]]
    return out, near


def children(guides, groot_n, per, radius, rng, clump=0.7, clump_start=0.3, clump_pow=1.2, fan=0.2,
             layer=(-0.35, 0.65), layer_scale=None, keep=None):
    """`per` children around each guide (proto-b): a child's root sits at a random offset
    (gaussian, `radius` head units) in the scalp's tangent plane plus a small offset along
    the normal (layer: uniform range x layer_scale, default = radius); that offset is
    carried along the guide by parallel transport and scaled by the clump profile
        1 - clump * smoothstep(clump_start, 1, t) ** clump_pow,   times (1 + fan * t)
    so children converge into a lock toward the tips (clump ~ .7 smooth hair, ~ .9 piecey
    texture, ~ .4 soft and full).  guides (G, m, 3) start on the scalp; groot_n (G, 3) are
    their root normals.  keep(p) -> bool can veto child roots (e.g. outside the hairline).
    Returns strands (G*per, m, 3) float32, the guide index of each child, its root."""
    guides = np.asarray(guides, np.float64)
    G, m, _ = guides.shape
    T, U, V = frames(guides, groot_n)
    gi = np.repeat(np.arange(G), per)
    a = rng.normal(0, radius, len(gi)); b = rng.normal(0, radius, len(gi))
    ls = radius if layer_scale is None else layer_scale
    lay = rng.uniform(layer[0], layer[1], len(gi)) * ls
    # root offset in the tangent plane of the scalp
    n0 = np.asarray(groot_n, np.float64)[gi]
    e1 = tangent(U[gi, 0] - (U[gi, 0] * n0).sum(-1, keepdims=True) * n0 + 1e-9, n0)
    e2 = np.cross(n0, e1)
    r0 = guides[gi, 0] + e1 * a[:, None] + e2 * b[:, None]
    r0 = head.project(r0, 0.0)
    off0 = r0 - guides[gi, 0]
    # express the offset in the guide's transported frame at the root, then carry it
    ca = (off0 * U[gi, 0]).sum(-1); cb = (off0 * V[gi, 0]).sum(-1)
    t = np.linspace(0, 1, m)[None, :]
    prof = (1 - clump * smoothstep(clump_start, 1, t) ** clump_pow) * (1 + fan * t)
    lift = lay[:, None] * smoothstep(0.0, 0.08, t)
    C = guides[gi] + (U[gi] * (ca[:, None] * prof)[..., None] + V[gi] * (cb[:, None] * prof)[..., None])
    # the layer offset pushes along the guide's U (which starts as the scalp normal)
    C = C + U[gi] * lift[..., None]
    C[:, 0] = r0
    sel = np.ones(len(gi), bool) if keep is None else keep(r0)
    return C[sel].astype(np.float32), gi[sel], r0[sel]


# ------------------------------------------------------------------------------- clumps
def clump(S, roots, groups, nclumps, strength, rng, root_ramp=0.03, centres=None):
    """pull strands toward clump-centre strands (the nearest centre by root, within the
    same group).  strength(t) -> (m,) profile along the strand (e.g. .1 at the root
    rising to .8 at the tip makes pointed locks).  nclumps is the total number of clumps
    (shared among groups by their size).  Each strand gets its own random .6..1 factor so
    locks are not perfectly tight.  The root itself never moves (root_ramp).
    Returns strands and the clump id (index of the centre strand) per strand."""
    S = np.asarray(S, np.float32)
    ns, nv, _ = S.shape
    roots = np.asarray(roots)
    groups = np.zeros(ns, int) if groups is None else np.asarray(groups)
    out = S.copy()
    cid = np.zeros(ns, int)
    t = np.linspace(0, 1, nv)
    prof = (np.asarray(strength(t), np.float32) * smoothstep(0, root_ramp, t)).astype(np.float32) if root_ramp else np.asarray(strength(t), np.float32)
    for gid in np.unique(groups):
        si = np.where(groups == gid)[0]
        nc = max(1, min(len(si), int(round(nclumps * len(si) / ns))))
        cs_ = rng.choice(si, nc, replace=False) if centres is None else np.intersect1d(centres, si)
        _, ii = cKDTree(roots[cs_]).query(roots[si], 1)
        cc = cs_[ii]
        cid[si] = cc
        c = prof[None, :, None] * rng.uniform(0.6, 1.0, (len(si), 1, 1)).astype(np.float32)
        for a in range(0, len(si), 20000):
            sl = slice(a, a + 20000)
            out[si[sl]] = S[si[sl]] * (1 - c[sl]) + S[cc[sl]] * c[sl]
    return out, cid


# ------------------------------------------------------------------------------- noise
def smooth_noise(rng, n, nv, freq, octaves=2):
    """smooth per-strand noise along the strand, (n, nv, 3), amplitude ~1; freq = cycles
    over the strand's length."""
    t = np.linspace(0, 1, nv)
    out = np.zeros((n, nv, 3), np.float32)
    amp = 1.0
    for o in range(octaves):
        f = freq * 2 ** o
        for d in range(3):
            ph = rng.uniform(0, 2 * np.pi, (n, 1)); fr = f * rng.uniform(0.7, 1.3, (n, 1))
            out[..., d] += (amp * np.sin(2 * np.pi * fr * t[None, :] + ph)).astype(np.float32)
        amp *= 0.5
    return out


def frizz(S, rng, root=0.0015, tip=0.004, freq=6, octaves=2, power=1.5, root_ramp=0.03):
    """add smooth noise growing from `root` to `tip` amplitude (head units) along strands;
    the root vertex itself never moves (it fades in over root_ramp of the strand)."""
    n, m, _ = S.shape
    t = np.linspace(0, 1, m)[None, :, None]
    amp = (root + (tip - root) * t ** power) * smoothstep(0.0, root_ramp, t)
    return (S + smooth_noise(rng, n, m, freq, octaves) * amp).astype(np.float32)


# ------------------------------------------------------------------------------- waves / curls
def radial_dir(P):
    """horizontal outward direction from the head's vertical axis (x = .5, z = PIVOT z)."""
    P = np.asarray(P, np.float64)
    v = np.stack([P[..., 0] - 0.5, np.zeros(P.shape[:-1]), P[..., 2] - canon.PIVOT[2]], -1)
    return unit(v)


def smooth_field(P, rng, scale=0.25, octaves=3, k=6):
    """a smooth random scalar field over points P (..., 3), about -1..1, varying over
    `scale` head units (random Fourier features).  Use it to make neighbouring locks share
    wave phases, lengths or tones, with gradual change across the head."""
    P = np.asarray(P, np.float64)
    out = np.zeros(P.shape[:-1])
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        for _ in range(k):
            w = unit(rng.normal(size=3)) * (2 * np.pi / scale) * 2 ** o * rng.uniform(0.7, 1.3)
            out += amp * np.sin(P @ w + rng.uniform(0, 2 * np.pi))
        tot += amp * np.sqrt(k / 2)
        amp *= 0.5
    return out / tot


def wave(S, amp, wavelength, phase, start=0.3, ramp=0.4, lateral=0.6, end_amp=1.0):
    """S-waves: displacement amp * sin(2 pi s / wavelength + phase) along the outward
    (radial) direction - which makes the silhouette wave at the sides - plus `lateral` x amp
    x cos(...) across the hair sheet, which makes the alternating highlight bands of wavy
    hair.  The wave fades in from arclength `start` over `ramp` (roots stay smooth) and is
    scaled toward the tip by end_amp.  amp, wavelength, phase: scalars or (n,) (give the
    strands of a lock the same phase and wavelength so locks wave together)."""
    n = len(S)
    if n > CHUNK:
        out = np.empty(np.shape(S), np.float32)
        for sl in _rows(n):
            out[sl] = wave(S[sl], _per(amp, n, sl), _per(wavelength, n, sl), _per(phase, n, sl),
                           start, ramp, lateral, end_amp)
        return out
    S = np.asarray(S, np.float64)
    n, m, _ = S.shape
    al = arclen(S)
    T = tangents(S)
    R = radial_dir(S)
    R = unit(R - (R * T).sum(-1, keepdims=True) * T)
    Lt = unit(np.cross(T, R))
    A = np.broadcast_to(np.asarray(amp, np.float64), (n,))[:, None]
    lam = np.broadcast_to(np.asarray(wavelength, np.float64), (n,))[:, None]
    ph = np.broadcast_to(np.asarray(phase, np.float64), (n,))[:, None]
    tt = al / np.maximum(al[:, -1:], 1e-9)
    env = smoothstep(start, start + ramp, al) * (1 + (end_amp - 1) * tt)
    th = 2 * np.pi * al / lam + ph
    d = A * env
    out = S + R * (d * np.sin(th))[..., None] + Lt * (lateral * d * np.cos(th))[..., None]
    return out.astype(np.float32)


def helix(C, radius, pitch, phase=0.0, hand=1.0, start=0.0, ramp=0.05, ref=None, vpt=12, m_out=None,
          radius_end=None, pitch_end=None):
    """coils around centre lines C (n, m, 3): the curl of a ringlet, a twisted rope, a
    spiral.  A point at centre-line arclength s goes around at
        radius r(s) (radius -> radius_end toward the tip), angle 2 pi s / pitch(s) + phase,
    hand = +1 / -1 for the winding direction; the coil fades in from s = start over ramp.
    The centre lines are resampled so each turn has ~vpt vertices (m_out overrides).
    The hair is longer than its centre line by 1/cos(helix angle).
    radius, pitch, phase, hand: scalars or (n,); ref (n, 3) or None.  Returns
    (n, m_out, 3) float32."""
    n = len(C)
    if m_out is None:
        Lc = lengths(C)
        pp = np.broadcast_to(np.asarray(pitch, np.float64), (n,))
        pe = pp if pitch_end is None else np.minimum(pp, np.broadcast_to(np.asarray(pitch_end, np.float64), (n,)))
        m_out = int(np.clip(np.ceil((Lc / np.minimum(pp, pe)).max() * vpt), 8, 400))
    if n > CHUNK:
        out = np.empty((n, m_out, 3), np.float32)
        for sl in _rows(n):
            out[sl] = helix(C[sl], _per(radius, n, sl), _per(pitch, n, sl), _per(phase, n, sl), _per(hand, n, sl),
                            start, ramp, None if ref is None else _per(ref, n, sl), vpt, m_out,
                            None if radius_end is None else _per(radius_end, n, sl),
                            None if pitch_end is None else _per(pitch_end, n, sl))
        return out
    C = np.asarray(C, np.float64)
    rr = np.broadcast_to(np.asarray(radius, np.float64), (n,))
    pp = np.broadcast_to(np.asarray(pitch, np.float64), (n,))
    C = resample(C, m_out).astype(np.float64)
    al = arclen(C)
    T, U, V = frames(C, ref)
    tt = al / np.maximum(al[:, -1:], 1e-9)
    r = rr[:, None] * np.ones_like(al)
    if radius_end is not None:
        r = r + (np.broadcast_to(np.asarray(radius_end, np.float64), (n,))[:, None] - rr[:, None]) * smoothstep(0.2, 1.0, tt)
    pi = pp[:, None] * np.ones_like(al)
    if pitch_end is not None:
        pi = pi + (np.broadcast_to(np.asarray(pitch_end, np.float64), (n,))[:, None] - pp[:, None]) * smoothstep(0.2, 1.0, tt)
    # angle: integrate 2 pi ds / pitch(s)
    ds = np.diff(al, axis=1)
    th = np.concatenate([np.zeros((n, 1)), np.cumsum(2 * np.pi * ds / (0.5 * (pi[:, 1:] + pi[:, :-1])), 1)], 1)
    th = th * np.broadcast_to(np.asarray(hand, np.float64), (n,))[:, None] + np.broadcast_to(np.asarray(phase, np.float64), (n,))[:, None]
    env = smoothstep(start, start + ramp, al) if ramp > 0 else (al >= start).astype(float)
    r = r * env
    P = C + U * (r * np.cos(th))[..., None] + V * (r * np.sin(th))[..., None]
    return P.astype(np.float32)


def bend_ends(S, amount, start=0.78, toward=None):
    """curve the last part of strands: amount (n,) head units, + curls under (toward the
    body axis and the front), - flicks out.  toward (n, m, 3) overrides the direction."""
    S = np.asarray(S, np.float32)
    n, m, _ = S.shape
    t = np.linspace(0, 1, m)[None, :]
    w = smoothstep(start, 1.0, t) ** 1.5
    if toward is None:
        toward = np.stack([0.5 - S[..., 0], np.zeros_like(S[..., 0]), 0.5 * np.ones_like(S[..., 0])], -1)
        toward = unit(toward)
    a = np.broadcast_to(np.asarray(amount, np.float32), (n,))[:, None]
    return (S + (w * a)[..., None] * toward).astype(np.float32)


# ------------------------------------------------------------------------------- cutting
def ragged_lengths(L, rng, lock=None, piece=0.06, strand=0.03, point=0.25, point_depth=0.30, floor=0.15):
    """an irregular, broken cut line from target lengths L (n,): every lock (lock = clump id
    per strand) gets its own length (piece, relative sd), every strand a little more
    (strand), and a fraction `point` of strands is point-cut shorter by up to point_depth
    (relative), which tapers the tips of each lock instead of leaving a blunt row.  This
    is what avoids bowl lines and comb teeth on fringes and cut ends."""
    L = np.asarray(L, np.float64)
    n = len(L)
    if lock is None:
        lock = np.arange(n)
    u, inv = np.unique(lock, return_inverse=True)
    f = 1 + piece * rng.normal(size=len(u))[inv] + strand * rng.normal(size=n)
    pc = rng.random(n) < point
    f = f - pc * point_depth * rng.random(n) ** 0.7
    return np.maximum(L * f, L * floor)


# ------------------------------------------------------------------------------- strays
def flyaways(S, rng, frac=0.012, start=(0.15, 0.75), amp=(0.06, 0.07), centre=(0.5, 0.6, -0.3), sel=None):
    """copies of a fraction of the strands that leave the hair surface from a random point
    along them (frizz and flyaways break the silhouette).  amp = (random wander, outward
    push) in head units at the tip.  Returns new strands (k, m, 3)."""
    S = np.asarray(S, np.float32)
    n, m, _ = S.shape
    if sel is None:
        sel = rng.choice(n, max(1, int(frac * n)), replace=False)
    k = len(sel)
    t = np.linspace(0, 1, m)[None, :]
    s0 = rng.uniform(start[0], start[1], k)[:, None]
    dirf = rng.normal(size=(k, 1, 3)); dirf[..., 2] = np.abs(dirf[..., 2]) * 0.3
    out_dir = S[sel] - np.array(centre, np.float32); out_dir /= np.linalg.norm(out_dir, axis=-1, keepdims=True) + 1e-9
    dev = (np.clip(t - s0, 0, None) ** 1.4)[..., None] * (amp[0] * dirf + amp[1] * out_dir) * rng.uniform(0.5, 1.5, (k, 1, 1))
    return (S[sel] + dev).astype(np.float32)


def strays(roots, rng, n, length=(0.04, 0.16), droop=3.0, m=24, lift=0.04):
    """short broken hairs standing off the scalp surface near the top (roots: a Roots
    record to pick from).  Returns (n, m, 3)."""
    i = rng.choice(len(roots), n, replace=n > len(roots))
    p, nn = roots.p[i], roots.n[i]
    side = np.where(p[:, 0] >= 0.5, 1.0, -1.0)
    L = rng.uniform(length[0], length[1], n)
    d = tangent(np.stack([side, 0.4 * np.ones(n), np.zeros(n)], -1), nn) * 0.8 + nn * 0.5
    d = unit(d)
    th = np.linspace(0, 1, m)[None, :, None]
    base = p + nn * (lift + 0.05 * (1 - np.abs(p[:, 0] - 0.5)))[:, None]
    H = base[:, None, :] + d[:, None, :] * L[:, None, None] * th
    H[..., 1] += (th[..., 0] * L[:, None]) ** 2 * droop
    H += smooth_noise(rng, n, m, 1.0, 1) * 0.006 * th
    return H.astype(np.float32)


# ------------------------------------------------------------------------------- collision
def collide_strands(S, h=0.004, iters=2, chunk=400000, skip_root=True):
    """push every vertex out of the body (head, face, neck, torso, arms) to at least h
    (scalar, (n,) or (n, m)).  The root vertex stays put (skip_root)."""
    S = np.asarray(S, np.float32)
    n, m, _ = S.shape
    out = S.copy()
    hh = np.broadcast_to(np.asarray(h, np.float64), (n, m)) if np.ndim(h) != 1 else np.broadcast_to(np.asarray(h, np.float64)[:, None], (n, m))
    flat = out.reshape(-1, 3); hf = np.ascontiguousarray(hh).reshape(-1)
    for a in range(0, len(flat), chunk):
        flat[a:a + chunk] = head.collide(flat[a:a + chunk], hf[a:a + chunk], iters=iters)
    out = flat.reshape(n, m, 3)
    if skip_root:
        out[:, 0] = S[:, 0]
    return out.astype(np.float32)
