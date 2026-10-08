"""Growing strands from roots: integrators and the force fields that steer them.

Integrators (all vectorised over strands, all collide against the body SDF of head.py:
head, canonical face, ears, neck, torso, upper arms):

  grow            proto-a: each step keeps the direction (stiffness), bends toward
                  gravity, adds a style field, then collides with the body at a shell
                  height h(s) that rises along the strand (hair from higher up lies on top
                  of the hair below it: volume).  For guides of long or medium hair.
  grow_two_phase  proto-b: (A) combed over the scalp at a layer height that grows with the
                  distance travelled, along a comb direction field, until the strand passes
                  the widest part of the head (or a release test); (B) falls under gravity
                  with stiffness, collides with the body, hugs the head, does not flare
                  out (drag), and decides front or back at the shoulders.
  surface_walk    proto-a: short hair that follows the skull at height h(s) toward a
                  styling direction (crops, fades, slick-backs, pulled-back hair).
  curve_from_root proto-a: a strand that leaves the scalp at an angle to the normal and
                  turns toward a styling direction (spiky / textured short tops).
  gather_walk     strands combed over the scalp toward a target point (ponytail, bun).
  bezier, catmull explicit paths through control points (fringes, curtain bangs).

Field functions plug into grow / grow_two_phase:  field(p, d, st) -> (n, 3) extra pull
added to the direction each step (before normalising), where st is a Step record with
k (step index), s (arclength), s_fall (arclength since release, = s in grow), and idx
(the strand indices, so fields can keep per-strand state).  Factories here:

  gravity_field, shoulder_field (front/back decision at the shoulders), drape_field (no
  sideways fanning over the shoulders), face_frame_field (face-framing sections fall
  close along the cheeks), ear_clear_field (side hair clears the ears), toward_field,
  and combine(*fields).

Units: head units (1 cm = .061).  Lengths: shoulder-length hair ~ 1.4-1.6 from the crown,
mid-back ~ 2.6.  Gravity / stiffness are per step: what matters is gravity * step_len.
"""
import numpy as np
from collections import namedtuple
from . import head
from .head import smoothstep
from .scalp import unit, tangent, face_halfwidth, surface_z

Step = namedtuple('Step', 'k s s_fall idx')
DOWN = np.array([0.0, 1.0, 0.0])          # y is down in head units


def _ev(x, *args, n=None):
    v = x(*args) if callable(x) else x
    v = np.asarray(v, np.float64)
    return np.broadcast_to(v, (n,)) if (n is not None and v.ndim <= 1) else v


# ------------------------------------------------------------------------------- grow (proto-a)
def grow(p0, d0, nseg, seglen, shell=0.01, field=None, gravity=0.25, stiff=0.85, iters=2,
         stick=0.0, stick_ymax=0.80, sdf=None):
    """grow strands from roots p0 (n, 3) with initial directions d0 (n, 3).

    Per step k (arclength s = k * seglen):
        d <- normalise(stiff * d + gravity * DOWN + field(p, d, Step))
        p <- p + d * seglen, collided with the body to the shell height h
    shell, gravity, stiff: constants, (n,) arrays or callables (k, s) -> value / (n,).
    stick (0..1): pulls hair back down to its shell height on the upper half of the head
    (hair lies on the head instead of standing off it); only above y = stick_ymax.
    Returns (n, nseg + 1, 3) float32."""
    sdf = sdf or head.body_sdf()
    p0 = np.asarray(p0, np.float64)
    n = len(p0)
    P = np.zeros((n, nseg + 1, 3)); P[:, 0] = p0
    d = unit(d0)
    idx = np.arange(n)
    for k in range(1, nseg + 1):
        s = k * seglen
        gw = _ev(gravity, k, s, n=n)
        st = _ev(stiff, k, s, n=n)
        nd = d * st[:, None] + DOWN * gw[:, None]
        if field is not None:
            nd = nd + field(P[:, k - 1], d, Step(k, s, s, idx))
        nd = unit(nd)
        p = P[:, k - 1] + nd * seglen
        h = _ev(shell, k, s, n=n)
        if stick:
            de, ge = sdf.eval(p)
            w = stick * smoothstep(0.3, -0.15, ge[:, 1]) * (de > h) * (de < h + 0.25) * (p[:, 1] < stick_ymax)
            p = p - ge * ((de - h) * w)[:, None]
        for _ in range(iters):
            p = head.collide(p, h, sdf=sdf, iters=1)
            v = unit(p - P[:, k - 1])
            p = P[:, k - 1] + v * seglen
        d = (p - P[:, k - 1]) / seglen
        P[:, k] = p
    return P.astype(np.float32)


# ------------------------------------------------------------------------------- two-phase (proto-b)
def grow_two_phase(p0, n0, comb, nseg, ds=0.022, h0=0.006, h_rate=0.06, h_max=0.075, lift=0.12,
                   turn=0.35, release=None, max_comb=1.3, gravity=None, stiff=1.0, field=None,
                   hug=0.18, hug_above=0.28, drag=0.12, drag_below=0.62, fall_off=0.01, sdf=None):
    """proto-b's two-phase growth.

    Phase A (on the scalp): each step the direction turns toward comb(p, s) (n, 3) (made
    tangent to the head) by `turn`, the strand moves ds and is put back on the offset
    surface at height h, which starts at h0 and grows by h_rate per unit travelled up to
    h_max (h_max may be (n,)): hair from the parting ends up on top of the hair from lower
    down, which is what gives a head of hair its volume and its smooth top.  A strand
    leaves phase A when release(p, normal, d, s) is True (default: when the head's normal
    no longer points up - past the widest part of the head - or after max_comb).

    Phase B (falling), per step: the direction bends toward DOWN by gravity(s_fall, p)
    (default .04 rising to .16 over the first .3 of the fall), keeps `stiff`, adds
    field(p, d, Step), is held close to the head above y = hug_above (hug), cannot flare
    away from the head's vertical axis below y = drag_below (drag; above it the hair
    must stay free to clear the ears), and collides with the body at
    h + fall_off, sliding along it.  All per-step strengths assume ds ~ .022.
    Returns (n, nseg + 1, 3) float32 and the per-strand release step (n,)."""
    sdf = sdf or head.body_sdf()
    p0 = np.asarray(p0, np.float64); n = len(p0)
    hmax = np.broadcast_to(np.asarray(h_max, np.float64), (n,))
    h = np.full(n, float(h0))
    nn = np.asarray(n0, np.float64)
    p = head.project(p0 + nn * h0, h0, sdf=sdf)
    c0 = tangent(comb(p, np.zeros(n)), nn)
    d = unit(c0 + nn * _ev(lift, n=n)[:, None])
    P = np.zeros((n, nseg + 1, 3)); P[:, 0] = p0; P[:, 1] = p
    falling = np.zeros(n, bool)
    rel = np.full(n, nseg, int)
    s_fall = np.zeros(n)
    idx = np.arange(n)
    if gravity is None:
        gravity = lambda sf, pp: 0.04 + 0.12 * smoothstep(0.0, 0.30, sf)
    for k in range(2, nseg + 1):
        s = (k - 1) * ds
        A = ~falling
        if A.any():
            pa = p[A]
            g = sdf.grad(pa)
            c = tangent(comb(pa, np.full(A.sum(), s)), g)
            da = unit(tangent(unit(d[A] + c * turn), g))
            qa = pa + da * ds
            h[A] = np.minimum(hmax[A], h[A] + h_rate * ds)
            qa = head.project(qa, h[A], sdf=sdf)
            ga = sdf.grad(qa)
            da = unit(qa - pa)
            if release is None:
                done = (-ga[:, 1] < 0.18) | (s > max_comb)
            else:
                done = np.asarray(release(qa, ga, da, np.full(len(qa), s)), bool) | (s > max_comb)
            d[A] = da; p[A] = qa
            ai = np.where(A)[0]
            falling[ai[done]] = True; rel[ai[done]] = k
        B = falling & (rel < k)
        if B.any():
            pb, db = p[B], d[B]
            s_fall[B] += ds
            gw = _ev(gravity, s_fall[B], pb, n=B.sum())
            db = unit(db * stiff + DOWN * gw[:, None])
            if field is not None:
                db = unit(db + field(pb, db, Step(k, s, s_fall[B], idx[B])))
            if drag:
                rad = unit(np.stack([pb[:, 0] - 0.5, np.zeros(len(pb)), pb[:, 2] + 0.26], -1))
                out = (db * rad).sum(-1) * smoothstep(drag_below - 0.08, drag_below + 0.08, pb[:, 1])
                db = unit(db - rad * (np.maximum(out, 0) * drag)[:, None])
            hb = h[B] + fall_off
            if hug:
                dd, gg = sdf.eval(pb)
                ex = dd - hb - 0.012
                w = (ex > 0) * (pb[:, 1] < hug_above)
                db = unit(db - gg * (np.minimum(ex / 0.09, 1.0) * hug * w)[:, None])
            q = pb + db * ds
            dd, gg = sdf.eval(q)
            pen = hb - dd
            m = pen > 0
            q[m] += gg[m] * pen[m, None]
            dn = (db * gg).sum(-1)
            slide = m & (dn < 0)
            db[slide] = unit(db[slide] - gg[slide] * dn[slide, None])
            p[B] = q; d[B] = db
        P[:, k] = p
    return P.astype(np.float32), rel


# ------------------------------------------------------------------------------- surface walk
def surface_walk(p0, direction, length, H, nv, h_end=None, yaw_noise=None, h_ramp=0.35, follow=0.3, sdf=None):
    """short hair lying on the head (proto-a): each strand steps along the head's tangent
    plane toward direction(p, n) -> (n, 3) (or a fixed (n, 3) array, re-projected to the
    tangent plane every step), at height H (n,) above the scalp (reached over the first
    h_ramp of the strand; + h_end (n,) over the last 35 %, e.g. tips lifting off or
    coming down to the skin).  follow (0..1): how fast the strand turns toward the styling
    direction (low = keeps its initial angle longer).  yaw_noise (n, nv, 3) adds per-step
    wander (texture).  length (n,) head units.  Returns (n, nv, 3) float32."""
    sdf = sdf or head.body_sdf()
    p = np.asarray(p0, np.float64).copy(); n = len(p)
    L = np.broadcast_to(np.asarray(length, np.float64), (n,))
    Hh = np.broadcast_to(np.asarray(H, np.float64), (n,))
    he = None if h_end is None else np.broadcast_to(np.asarray(h_end, np.float64), (n,))
    P = np.zeros((n, nv, 3), np.float32); P[:, 0] = p
    n0 = sdf.grad(p)
    dirf = direction if callable(direction) else (lambda pp, nrm: np.asarray(direction, np.float64))
    d = tangent(dirf(p, n0), n0)
    ds = L / (nv - 1)
    for k in range(1, nv):
        u = k / (nv - 1)
        h = Hh * smoothstep(0.0, h_ramp, u)
        if he is not None:
            h = h + he * smoothstep(0.65, 1.0, u)
        q = p + d * ds[:, None]
        q = head.project(q, h, sdf=sdf)
        nn = sdf.grad(q)
        v = unit(q - p)
        q = p + v * ds[:, None]
        target = tangent(dirf(q, nn), nn)
        if yaw_noise is not None:
            target = target + yaw_noise[:, k]
        d = tangent((1 - follow) * v + follow * target, nn)
        p = q
        P[:, k] = p
    return P


def curve_from_root(root, n, sd, L, th0, th1, power, nv, bend_noise=None):
    """a strand leaving `root` at angle th0 (radians) from the normal n toward the styling
    direction sd (unit, tangent), turning to th1 by the end with profile s ** power
    (proto-a).  All per strand (n,) except bend_noise (n, nv, 3).  No collision."""
    s = np.linspace(0, 1, nv)
    th = th0[:, None] + (th1 - th0)[:, None] * s[None, :] ** power[:, None]
    dirs = n[:, None, :] * np.cos(th)[..., None] + sd[:, None, :] * np.sin(th)[..., None]
    if bend_noise is not None:
        dirs = dirs + bend_noise
    dirs = unit(dirs)
    dsl = (L / (nv - 1))[:, None, None]
    P = np.concatenate([root[:, None, :], root[:, None, :] + np.cumsum(dirs[:, :-1] * dsl, 1)], 1)
    return P.astype(np.float32)


def gather_walk(p0, target, nv=40, h=0.004, h_end=None, stop=0.03, ds=0.02, max_len=2.5, sdf=None):
    """strands combed over the head toward a target point (ponytail / bun base): each step
    moves along the tangent plane toward the target at height h (sleek: ~.003-.006).  The
    path stops `stop` short of the target.  h_end (n,) adds height near the target (the
    hair bunching up).  Returns (n, nv, 3) float32 (resampled by arclength) and the path
    lengths (n,)."""
    from .strands import resample
    sdf = sdf or head.body_sdf()
    p = np.asarray(p0, np.float64).copy(); n = len(p)
    tgt = np.broadcast_to(np.asarray(target, np.float64), (n, 3))
    steps = int(max_len / ds) + 2
    path = np.zeros((n, steps, 3)); path[:, 0] = p
    alive = np.ones(n, bool)
    L = np.zeros(n)
    d0 = np.linalg.norm(tgt - p, axis=1)
    for k in range(1, steps):
        nn = sdf.grad(p)
        dist = np.linalg.norm(tgt - p, axis=1)
        alive &= dist > stop
        dirn = tangent(tgt - p, nn)
        frac = np.clip(1 - dist / np.maximum(d0, 1e-6), 0, 1)
        hh = h + (0 if h_end is None else np.asarray(h_end) * smoothstep(0.6, 1.0, frac))
        q = head.project(p + dirn * ds, hh, sdf=sdf)
        q = np.where(alive[:, None], q, p)
        L += alive * np.linalg.norm(q - p, axis=1)
        p = q
        path[:, k] = p
        if not alive.any():
            path = path[:, :k + 1]
            break
    return resample(path, nv, L), L


# ------------------------------------------------------------------------------- explicit paths
def bezier(ctrl, nv):
    """Bezier curves through control points ctrl (n, k, 3) (any degree), nv samples each,
    evenly spaced by arclength.  Returns (n, nv, 3) float32."""
    from .strands import resample
    ctrl = np.asarray(ctrl, np.float64)
    t = np.linspace(0, 1, max(4 * nv, 64))[None, :, None]
    pts = [ctrl[:, i][:, None, :] * np.ones_like(t) for i in range(ctrl.shape[1])]
    while len(pts) > 1:
        pts = [a * (1 - t) + b * t for a, b in zip(pts[:-1], pts[1:])]
    return resample(pts[0], nv)


def catmull(P, nv, per=24):
    """Catmull-Rom splines through control points P (n, k, 3), nv samples evenly by
    arclength (proto-a curtain bangs).  Returns (n, nv, 3) float32."""
    from .strands import resample
    P = np.asarray(P, np.float64)
    k = P.shape[1]
    Pe = np.concatenate([2 * P[:, :1] - P[:, 1:2], P, 2 * P[:, -1:] - P[:, -2:-1]], 1)
    out = []
    t = np.linspace(0, 1, per, endpoint=False)[None, :, None]
    for i in range(k - 1):
        p0, p1, p2, p3 = Pe[:, i], Pe[:, i + 1], Pe[:, i + 2], Pe[:, i + 3]
        a = 2 * p1[:, None]; b = (p2 - p0)[:, None]; c = (2 * p0 - 5 * p1 + 4 * p2 - p3)[:, None]; d = (-p0 + 3 * p1 - 3 * p2 + p3)[:, None]
        out.append(0.5 * (a + b * t + c * t * t + d * t ** 3))
    out.append(P[:, -1:])
    return resample(np.concatenate(out, 1), nv)


def on_surface(x, y, h):
    """front-view points (x, y) lifted onto the front of the head / face / body + h
    (head units).  Arrays of any (same) shape -> (..., 3)."""
    x, y, h = np.broadcast_arrays(np.asarray(x, float), np.asarray(y, float), np.asarray(h, float))
    z = surface_z(x, y)
    z = np.where(np.isfinite(z), z, 0.0) + h
    return np.stack([x, y, z], -1)


# ------------------------------------------------------------------------------- fields
def combine(*fields):
    fields = [f for f in fields if f is not None]

    def f(p, d, st):
        out = np.zeros_like(p)
        for g in fields:
            out = out + g(p, d, st)
        return out
    return f


def shoulder_field(front=None, y0=0.85, y1=1.15, y2=1.90, z_front=0.26, z_back=-0.95, strength=0.9,
                   z_split=-0.22, layer=None):
    """the front / back decision at the shoulders.  Below the jaw (y0..y1 ramp, fading
    out by y2) each strand is pulled toward z_front (over the collarbone onto the chest)
    or z_back (down the back).  front: (n,) bool decided per strand in advance (e.g. by
    decide_front), or None to decide by where the strand is when it reaches the shoulder
    (proto-b: in front of z_split -> front).  layer (n,) 0..1 spreads the front strands in
    depth (z_front + .08 * layer) so the front curtain has thickness."""
    def f(p, d, st):
        y = p[:, 1]
        w = smoothstep(y0, y1, y) * smoothstep(y2, y2 - 0.3, y)
        if front is None:
            fr = p[:, 2] > z_split
        else:
            fr = np.asarray(front)[st.idx]
        zf = z_front + (0.08 * np.asarray(layer)[st.idx] if layer is not None else 0.0)
        out = np.zeros_like(p)
        out[:, 2] = w * strength * (np.where(fr, zf, z_back) - p[:, 2])
        return out
    return f


def decide_front(roots, rng, front_frac=0.45, face_frame=None):
    """which strands fall in front of the shoulders: the face-framing / front sections
    (face_frame (n,) 0..1, default: roots in front of the ears) always, the side sections
    with probability front_frac, the back never.  Returns (n,) bool."""
    aphi = np.abs(roots.phi)
    ff = smoothstep(1.25, 0.85, aphi) if face_frame is None else np.asarray(face_frame)
    back = smoothstep(1.7, 2.1, aphi)
    return (ff > 0.3) | ((back < 0.3) & (rng.random(len(roots)) < front_frac))


def drape_field(y_start=1.2, y_full=1.5, k=1.2):
    """below y_start hair hangs straight down instead of fanning out sideways over the
    shoulders: x is pulled back toward the x the strand had at y_start."""
    mem = {}

    def f(p, d, st):
        key = 'x'
        if key not in mem or len(mem[key]) < st.idx.max() + 1:
            mem[key] = np.full(st.idx.max() + 1 if len(st.idx) else 1, np.nan)
        xs = mem[key]
        y = p[:, 1]
        rec = np.isnan(xs[st.idx]) & (y > y_start)
        xs[st.idx[rec]] = p[rec, 0]
        x0 = xs[st.idx]
        w = smoothstep(y_start, y_full, y) * ~np.isnan(x0)
        out = np.zeros_like(p)
        out[:, 0] = -k * np.nan_to_num(p[:, 0] - x0) * w
        return out
    return f


def _face_envelope(y):
    """the face outline's half-width as hair falling past it sees it: the outline above
    the cheekbones, then the widest half-width (hair hangs straight down from the
    cheekbones; it does not follow the jaw inward)."""
    ys = np.linspace(0.0, 1.3, 131)
    env = np.maximum.accumulate(face_halfwidth(ys))
    return np.interp(y, ys, env)


def face_frame_field(weight, side, layer=None, gap=-0.025, depth=(0.01, 0.025, 0.05), y_range=(0.15, 0.45, 1.15, 1.45),
                     k=(0.55, 0.45), hug=0.0, spread=0.09):
    """face-framing sections (weight (n,) 0..1 per strand) fall close along the cheeks
    in front of the ears: x is pulled toward the face outline (+ gap + spread * layer) on
    the strand's side (side (n,) -1/+1), z toward the face surface + depth.  (proto-a L5.)
    hug 0..1: 0 = below the cheekbones the hair hangs straight down from the widest part of
    the face (natural; the jaw and cheeks stay visible), 1 = it follows the outline in
    along the jaw (hair pulled forward around the face: covers the cheeks)."""
    def f(p, d, st):
        w8 = np.asarray(weight)[st.idx]; sd = np.asarray(side)[st.idx]
        ly = np.asarray(layer)[st.idx] if layer is not None else 0.5
        y = p[:, 1]
        hw = face_halfwidth(y) * hug + _face_envelope(y) * (1 - hug)
        wt = hw + 0.04 * smoothstep(0.6, 0.35, y) + gap + spread * ly
        tx = 0.5 + sd * wt
        on = smoothstep(y_range[0], y_range[1], y) * smoothstep(y_range[3], y_range[2], y) * w8
        out = np.zeros_like(p)
        out[:, 0] = k[0] * (tx - p[:, 0]) * on
        tz = surface_z(tx, y, depth[0] + (depth[1] + depth[2] * ly) * smoothstep(0.35, 0.6, y))
        tz = np.where(np.isfinite(tz), tz, p[:, 2])
        out[:, 2] = k[1] * (tz - p[:, 2]) * on * smoothstep(0.2, 0.5, y)
        return out
    return f


def ear_clear_field(weight, side, k=0.8, k_side=0.45, clear=0.565):
    """hair clears the ears instead of parting around them: (1) hair from the top gets an
    outward push early (proto-a), (2) hair passing beside the ear (y .02 .. .6, z of the ear)
    is pushed out until it is `clear` (|x - .5|) outside the mid-line - past the ear's
    outer edge (~.55) - so it falls over the ear and covers it.  weight (n,) 0..1 per
    strand (e.g. 1 - face-framing weight), side (n,) -1 / +1."""
    def f(p, d, st):
        w8 = np.asarray(weight)[st.idx]; sd = np.asarray(side)[st.idx]
        y = p[:, 1]; z = p[:, 2]
        ax = np.abs(p[:, 0] - 0.5)
        over = smoothstep(0.52, 0.36, ax) * smoothstep(-0.10, 0.05, y) * smoothstep(1.2, 1.0, y) \
            * smoothstep(-0.45, -0.15, z) * w8
        ear = smoothstep(-0.08, 0.22, y) * smoothstep(0.66, 0.48, y) * smoothstep(-0.66, -0.48, z) \
            * smoothstep(0.0, -0.16, z) * smoothstep(0.30, 0.42, ax) * w8
        out = np.zeros_like(p)
        out[:, 0] = sd * (k * over + k_side * ear * np.clip((clear - ax) / 0.06, 0, 1))
        out[:, 2] = -0.10 * over
        return out
    return f


def toward_field(target, k=0.5, y_range=None):
    """a constant pull toward a point (n, 3) / (3,) (e.g. hair tucked behind the ear)."""
    def f(p, d, st):
        t = np.asarray(target, np.float64)
        t = t[st.idx] if t.ndim == 2 else t
        out = k * (t - p)
        if y_range is not None:
            out = out * (smoothstep(y_range[0], y_range[1], p[:, 1]) * smoothstep(y_range[3], y_range[2], p[:, 1]))[:, None]
        return out
    return f
