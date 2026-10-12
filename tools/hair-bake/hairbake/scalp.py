"""Where hair grows: the scalp surface, hairlines, partings, root sampling.

Everything is in head units (canon.py: x across, y DOWN, z toward the viewer).  The scalp
is the head region of the fitted MakeHuman mesh (head.body_mesh(); the face is cut out and
replaced by the canonical face mesh, which never grows hair).  A Scalp combines

  * a Hairline: the front/side/nape boundary as y(azimuth) (azimuth = head.azimuth: 0 at
    the front, +-pi/2 at the sides, pi at the back), with natural irregularity (jitter),
    optional temple recession and widow's peak;
  * a soft density falloff over the last few millimetres inside the hairline (`soft`,
    `edge`): roots thin out toward the line instead of stopping at a hard edge;
  * an optional Parting: a narrow (about 1.5 mm), slightly zig-zag bare line on top of the
    head; roots are excluded on it and hair on either side is combed away from it;
  * the ears, which never grow hair.

Scalp.roots() samples root points uniformly by area weighted by that density and returns a
Roots record (positions, normals, azimuth, elevation, distance inside the hairline, side of
the parting...).  Scalp.density() / Scalp.part_mask() are also what the renderer uses for
the scalp layer (skin under the hair, a dim part line), so roots and scalp always agree.

Useful landmarks on this head (head units): skull top y = -.35; front hairline (women)
y ~ -.045 at x = .5; ears x < .02 / > .98, y .32 .. .56, z -.38 .. -.19; back of the head
z ~ -.85; nape hairline y ~ .97; shoulders y ~ 1.4.  1 cm = .061 head units.
"""
import functools
import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.spatial import cKDTree
from . import head, canon
from .head import smoothstep

CM = 1.0 / 16.4154          # one centimetre in head units
MM = CM / 10


# ------------------------------------------------------------------------------- vectors
def unit(v):
    v = np.asarray(v, np.float64)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


def tangent(v, n):
    """v projected into the plane normal to n, normalised (both (..., 3))."""
    v = np.asarray(v, np.float64)
    v = v - (v * n).sum(-1, keepdims=True) * n
    return unit(v)


def rotate_about(v, axis, ang):
    """rotate vectors v (n,3) about unit axes (n,3) by angles (n,) (Rodrigues)."""
    c = np.cos(ang)[:, None]; s = np.sin(ang)[:, None]
    return v * c + np.cross(axis, v) * s + axis * (axis * v).sum(-1, keepdims=True) * (1 - c)


def hash01(P, seed=0):
    """a deterministic pseudo-random number in [0, 1) per point (..., 3): the same point
    always gets the same value, so complementary section tests (a fringe's roots vs the
    rest of the hair) stay exact complements even with a dithered boundary."""
    P = np.asarray(P, np.float64)
    v = np.sin(P[..., 0] * 12.9898e3 + P[..., 1] * 78.233e3 + P[..., 2] * 37.719e3 + seed * 4.1414) * 43758.5453
    return v - np.floor(v)


# ------------------------------------------------------------------------------- skull frame
def azimuth(P):
    """0 at the front, +-pi/2 at the sides (+ toward image right, x > .5), pi at the back."""
    return head.azimuth(np.asarray(P))


def elevation(P):
    """angle above the skull centre's horizontal plane on the normalised skull ellipsoid
    (radians): ~0 at eye level, pi/2 at the top of the head."""
    c, r = head.skull()
    q = (np.asarray(P) - c) / r
    return np.arcsin(np.clip(-q[..., 1] / (np.linalg.norm(q, axis=-1) + 1e-12), -1, 1))


@functools.lru_cache(None)
def crown(elev_deg=58.0):
    """the crown whorl: on the scalp at the back of the top of the head (where hair
    radiates from).  Returns (point, outward normal)."""
    c, r = head.skull()
    e = np.radians(elev_deg)
    q = c + np.array([0.0, -np.sin(e) * r[1], -np.cos(e) * r[2]])
    p = head.project(q[None], 0.0)[0]
    return p, head.normal(p[None])[0]


def surface_point(x, y, side='front'):
    """the body surface point seen at front-view (x, y) (side='front') - e.g. a point on
    the forehead or cheek - with its outward normal."""
    z = surface_z(x, y)
    p = np.stack(np.broadcast_arrays(np.asarray(x, float), np.asarray(y, float), z), -1)
    return p, head.normal(p)


@functools.lru_cache(None)
def _front_depth(res=256):
    fr = head.Frame(-1.0, -0.6, int(3.0 * res), int(3.4 * res), res)
    z, part = head.occluder(fr, 0.0, neck_pad=0.0)
    return fr, z.astype(np.float32), part


def surface_z(x, y, h=0.0):
    """z of the front-most body surface (head, face, neck, torso) at front-view (x, y),
    plus h; nan where nothing is there."""
    from scipy import ndimage
    fr, z, _ = _front_depth()
    x = np.asarray(x, np.float64); y = np.asarray(y, np.float64)
    px, py = fr.to_px(x, y)
    zz = np.where(z > -1e8, z, np.nan)
    out = ndimage.map_coordinates(np.nan_to_num(zz, nan=-50.0), [py.ravel() - 0.5, px.ravel() - 0.5], order=1, mode='nearest')
    out = np.where(out < -10, np.nan, out).reshape(x.shape)
    return out + h


@functools.lru_cache(None)
def _face_widths():
    H, _ = canon.face_mesh()
    poly = H[canon.FACE_OVAL, :2]
    ys = np.linspace(poly[:, 1].min(), poly[:, 1].max(), 200)
    w = np.zeros_like(ys)
    for i, y in enumerate(ys):
        xs = []
        for a, b in zip(poly, np.roll(poly, -1, 0)):
            if (a[1] - y) * (b[1] - y) <= 0 and a[1] != b[1]:
                t = (y - a[1]) / (b[1] - a[1]); xs.append(a[0] + t * (b[0] - a[0]))
        w[i] = max(abs(v - 0.5) for v in xs) if xs else 0
    return ys, w


def face_halfwidth(y):
    """half-width of the canonical face outline (FACE_OVAL, front view) at height y; 0
    above the forehead landmark / below the chin."""
    ys, w = _face_widths()
    return np.interp(y, ys, w, left=w[0], right=0.0)


# ------------------------------------------------------------------------------- hairline
# y of the hairline against |azimuth| (radians) on this head.  Front: just above landmark
# 10 (y .028); temples; the sideburn in front of the ear (down to the tragus); over the
# top of the ear; behind the ear down to the nape.
HAIRLINES = {
    'women': [(0.00, -0.045), (0.30, -0.040), (0.55, -0.010), (0.72, 0.050), (0.90, 0.120),
              (1.06, 0.250), (1.20, 0.420), (1.30, 0.440), (1.40, 0.330), (1.50, 0.285),
              (1.70, 0.270), (1.90, 0.300), (2.05, 0.420), (2.30, 0.680), (2.60, 0.900), (np.pi, 0.970)],
    'men':   [(0.00, -0.050), (0.25, -0.048), (0.45, -0.040), (0.62, -0.010), (0.76, 0.040),
              (0.92, 0.110), (1.06, 0.250), (1.20, 0.430), (1.30, 0.450), (1.40, 0.330), (1.50, 0.285),
              (1.70, 0.270), (1.90, 0.300), (2.05, 0.420), (2.30, 0.680), (2.60, 0.900), (np.pi, 0.960)],
}


class Hairline:
    """The hairline as y(azimuth).

    table      'women' / 'men' or a list of (|azimuth| radians, y) points (smooth PCHIP).
    jitter     amplitude (head units) of the natural irregularity (~.008 = 1.3 mm), not
               mirror-symmetric.
    recession  0..1: men's temple recession (the corners above the outer brows move up by
               up to ~.07 = 1.1 cm).
    widow      0..1: a widow's peak (the centre comes down by up to ~.03).
    lower      shift of the whole front hairline (+ = lower on the forehead).
    nape       shift of the nape (+ = lower on the neck)."""
    def __init__(self, table='women', jitter=0.008, recession=0.0, widow=0.0, lower=0.0, nape=0.0, seed=7):
        t = np.array(HAIRLINES[table] if isinstance(table, str) else table, np.float64)
        self.f = PchipInterpolator(t[:, 0], t[:, 1], extrapolate=True)
        self.jitter, self.recession, self.widow, self.lower, self.nape = jitter, recession, widow, lower, nape
        rng = np.random.default_rng(seed)
        self.ph = rng.uniform(0, 2 * np.pi, 6)

    def y(self, phi):
        phi = np.asarray(phi, np.float64)
        a = np.clip(np.abs(phi), 0, np.pi)
        y = self.f(a)
        y = y - self.recession * 0.07 * np.exp(-((a - 0.66) / 0.20) ** 2)
        y = y + self.widow * 0.03 * np.exp(-(a / 0.10) ** 2)
        front = smoothstep(1.35, 1.0, a)
        y = y + self.lower * front + self.nape * smoothstep(2.2, 2.8, a)
        j = (0.55 * np.sin(7.0 * phi + self.ph[0]) + 0.30 * np.sin(17.0 * phi + self.ph[1])
             + 0.20 * np.sin(37.0 * phi + self.ph[2]) + 0.12 * np.sin(71.0 * phi + self.ph[3]))
        return y + self.jitter * j

    def dist(self, P):
        """how far inside the hair area a point is (hairline y - point y; > 0 inside)."""
        P = np.asarray(P)
        return self.y(azimuth(P)) - P[..., 1]


# ------------------------------------------------------------------------------- parting
class Parting:
    """A parting: the line on top of the head where the hair divides.

    x          x of the part at the front hairline (.5 = centre; ~.36 / .64 = a side part on
               the viewer's left / right).
    drift      x change from the front to the back end (a part that bends a little).
    z_back     z where the part ends behind (toward the crown); it fades out over `fade`.
    width      half-width of the bare line (head units; .0045 = .7 mm, so ~1.5 mm of scalp
               shows between the two sides).
    zigzag     amplitude of its irregularity (a hand-made part is never ruler-straight).
    z_front    z where the part starts at the front: .30 = at the hairline (default); a
               full fringe covers the front of the part, so start it behind the fringe
               section (~.15 - .20).
    For x / z points above the side of the head the distance is measured across x."""
    def __init__(self, x=0.5, drift=0.0, z_back=-0.45, width=0.0045, zigzag=0.0035, fade=0.10, z_front=0.30, seed=3):
        self.x, self.drift, self.z_back, self.width, self.zigzag, self.fade = x, drift, z_back, width, zigzag, fade
        rng = np.random.default_rng(seed)
        self.ph = rng.uniform(0, 2 * np.pi, 4)
        self.z_front = z_front

    def x_at(self, z):
        z = np.asarray(z, np.float64)
        u = np.clip((0.30 - z) / max(0.30 - self.z_back, 1e-6), 0, 1)
        zz = self.zigzag * (0.6 * np.sin(z * 61.0 + self.ph[0]) + 0.4 * np.sin(z * 149.0 + self.ph[1]))
        return self.x + self.drift * u + zz

    def along(self, P):
        """0..1: 1 along the part (from the front hairline to z_back), 0 beyond its end
        and below the top of the head."""
        P = np.asarray(P)
        a = smoothstep(self.z_back - self.fade, self.z_back + 0.02, P[..., 2]) * smoothstep(0.20, 0.02, P[..., 1])
        if self.z_front < 0.29:
            a = a * smoothstep(self.z_front + 0.03, self.z_front - 0.02, P[..., 2])
        return a

    def dist(self, P):
        P = np.asarray(P)
        return np.abs(P[..., 0] - self.x_at(P[..., 2]))

    def side(self, P):
        """-1 / +1: which side of the part a point is on (by x for points away from it)."""
        P = np.asarray(P)
        return np.where(P[..., 0] >= self.x_at(P[..., 2]), 1.0, -1.0)

    def mask(self, P):
        """0..1 bare scalp along the part (what the renderer shows - dimmed - as the line)."""
        d = self.dist(P)
        return (1 - smoothstep(0.5 * self.width, 1.6 * self.width, d)) * self.along(P)

    def comb(self, P, N, down=0.25, back=0.0):
        """unit tangent directions combing away from the part: sideways, a little down."""
        s = self.side(P)
        v = np.stack([s, np.full(s.shape, down), np.full(s.shape, -back)], -1)
        return tangent(v, N)


# ------------------------------------------------------------------------------- scalp
def ear_mask(P):
    """True on the ears (no hair grows there)."""
    P = np.asarray(P)
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    return (np.abs(x - 0.5) > 0.472) & (y > 0.25) & (y < 0.64) & (z > -0.48) & (z < -0.08)


@functools.lru_cache(None)
def _pool():
    """head-region triangles of the body mesh (scalp candidates) with area weights."""
    m = head.body_mesh()
    V, T, N, reg = m['V'], m['T'], m['N'], m['region']
    cen = V[T].mean(1)
    # the head region, plus the back of the neck: MakeHuman labels the nape as neck from
    # y ~ .76, but the hairline at the back sits near y ~ .97
    keep = (reg[T] == head.REGION['head']).all(1) | (
        (reg[T] <= head.REGION['neck']).all(1) & (cen[:, 1] < 1.08) & (cen[:, 2] < -0.30))
    T = T[keep & (cen[:, 1] < 1.10) & ~ear_mask(cen)]
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    return V, T, N, np.cumsum(area) / area.sum(), float(area.sum())


def sample_surface(m, rng):
    """m points uniformly by area on the scalp-candidate part of the head, with normals."""
    V, T, N, cdf, _ = _pool()
    tri = np.minimum(np.searchsorted(cdf, rng.random(m)), len(T) - 1)
    u = rng.random(m); v = rng.random(m)
    f = u + v > 1; u[f] = 1 - u[f]; v[f] = 1 - v[f]
    w = 1 - u - v
    t = T[tri]
    P = V[t[:, 0]] * w[:, None] + V[t[:, 1]] * u[:, None] + V[t[:, 2]] * v[:, None]
    Nn = N[t[:, 0]] * w[:, None] + N[t[:, 1]] * u[:, None] + N[t[:, 2]] * v[:, None]
    return P, unit(Nn)


class Roots:
    """root points of a set of strands: p (n,3) on the scalp, n (n,3) outward normals,
    phi azimuth, elev elevation, dist (how far inside the hairline), side (-1/+1 of the
    parting, or of the mid-line x = .5 without one), pd (distance to the part line;
    inf without one)."""
    def __init__(self, p, n, scalp):
        self.p = np.asarray(p, np.float64); self.n = np.asarray(n, np.float64)
        self.phi = azimuth(self.p); self.elev = elevation(self.p)
        self.dist = scalp.hairline.dist(self.p)
        if scalp.parting is not None:
            self.side = scalp.parting.side(self.p); self.pd = scalp.parting.dist(self.p)
        else:
            self.side = np.where(self.p[:, 0] >= 0.5, 1.0, -1.0); self.pd = np.full(len(self.p), np.inf)

    def __len__(self):
        return len(self.p)

    @property
    def x(self): return self.p[:, 0]

    @property
    def y(self): return self.p[:, 1]

    @property
    def z(self): return self.p[:, 2]

    def take(self, sel):
        r = Roots.__new__(Roots)
        for k, v in self.__dict__.items():
            r.__dict__[k] = v[sel]
        return r

    @staticmethod
    def concat(rs):
        r = Roots.__new__(Roots)
        for k in rs[0].__dict__:
            r.__dict__[k] = np.concatenate([x.__dict__[k] for x in rs])
        return r


class Scalp:
    """Where hair grows and how densely: hairline (+ soft falloff), parting, ears, and
    any extra `exclude(P) -> bool` the style wants (e.g. a shaved undercut).

    soft   width (head units) of the density falloff inside the hairline (~.035 = 6 mm).
    edge   density right at the hairline (0..1); it ramps to 1 over `soft`."""
    def __init__(self, hairline=None, parting=None, soft=0.035, edge=0.22, exclude=None):
        self.hairline = hairline or Hairline()
        self.parting = parting
        self.soft, self.edge, self.exclude = soft, edge, exclude

    def density(self, P):
        P = np.asarray(P)
        d = self.hairline.dist(P)
        dens = (d > 0) * (self.edge + (1 - self.edge) * smoothstep(0.0, self.soft, d))
        dens = dens * ~ear_mask(P)
        if self.parting is not None:
            dens = dens * (1 - 0.97 * self.parting.mask(P))
        if self.exclude is not None:
            dens = dens * ~self.exclude(P)
        return dens

    def part_mask(self, P):
        return self.parting.mask(P) if self.parting is not None else np.zeros(np.shape(P)[:-1])

    def area(self):
        return _pool()[4]

    def roots(self, n, rng, accept=None, blue=False, density=None):
        """n roots, uniform by area x density (and an optional accept(p, roots-like) -> bool
        mask on candidate points).  blue=True spreads them as Poisson-disc (for guides).
        density(P) overrides the scalp's own density."""
        dens_fn = density or self.density
        out_p, out_n, have = [], [], 0
        tries = 0
        want = n * (4 if blue else 1)
        sampled = 0
        while have < want and tries < 60:
            tries += 1
            m = max(4096, int((want - have) * 3.5))
            P, Nn = sample_surface(m, rng)
            keep = rng.random(m) < dens_fn(P)
            if accept is not None:
                keep &= accept(P, Nn)
            out_p.append(P[keep]); out_n.append(Nn[keep]); have += keep.sum(); sampled += m
        P = np.concatenate(out_p); Nn = np.concatenate(out_n)
        if blue and len(P) > n:
            sel = _poisson(P, n, rng, self.area() * have / max(sampled, 1))
            P, Nn = P[sel], Nn[sel]
        P, Nn = P[:n], Nn[:n]
        if len(P) < n:
            raise ValueError(f'only {len(P)} of {n} roots: the accept region is too small')
        return Roots(P, Nn, self)

    def section(self, accept, n, rng, **kw):
        """roots(n) restricted to accept(P, N)."""
        return self.roots(n, rng, accept=accept, **kw)


def _poisson(P, n, rng, area):
    """greedy dart-throwing selection of ~n well-spread points among candidates P that
    cover about `area` (head units^2)."""
    r = 0.95 * np.sqrt(area / n)
    tree = cKDTree(P)
    for _ in range(12):
        alive = np.ones(len(P), bool)
        sel = []
        for i in rng.permutation(len(P)):
            if not alive[i]:
                continue
            sel.append(i)
            alive[tree.query_ball_point(P[i], r)] = False
        if len(sel) >= n:
            sel = np.array(sel)
            return sel[rng.permutation(len(sel))[:n]]
        r *= 0.92
    return np.array(sel)
