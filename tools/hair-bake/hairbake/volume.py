"""Volume queries for shading a groom (ported from proto-a hairlib.py / shade.py onto the
MakeHuman body SDF): how much hair, and whether the body, lies between a point and a
light direction.  The shader (deep-opacity self-shadowing, ambient occlusion, the "depth
into the hair" M channel) and the skin-shadow pass are built on these.

  basis(d)                 an orthonormal frame whose third axis is d
  fib_dirs(n)              n directions spread evenly over the sphere (+y is DOWN)
  strand_mass(S, attrs)    per-vertex fibre cross-section (width x opacity x segment length)
  hair_od(P, mass, Q, d)   optical depth of the hair from each query point toward d (a deep
                           opacity map: splat the hair into a grid aligned with d, cumulative
                           sum toward the light, sample at the queries)
  body_vis(Q, d)           soft visibility of direction d past the body (sphere-traced SDF
                           penumbra: 0 = blocked by the head / neck / shoulders, 1 = free)

All in head units, in the canonical (unrotated) frame; rotate light directions instead of
the groom when baking a turned view.
"""
import numpy as np
from scipy import ndimage
from . import head
from .native import splat3d
from .head import smoothstep


def basis(d):
    d = np.asarray(d, np.float64); d = d / np.linalg.norm(d)
    a = np.array([0, 1.0, 0]) if abs(d[1]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(a, d); u /= np.linalg.norm(u); v = np.cross(d, u)
    return np.stack([u, v, d])          # rows: u, v, d


def fib_dirs(n):
    """n unit directions on a Fibonacci spiral (even over the sphere); y = cos(phi), +y down."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n); th = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], -1)


def strand_mass(S, attrs, flyaway_factor=0.3):
    """per-vertex fibre cross-section (n, m): width_u x opacity x local segment length;
    flyaways / strays / baby hairs (kind 2-4) cast less."""
    seg = np.linalg.norm(np.gradient(np.asarray(S, np.float32), axis=1), axis=-1)
    mass = attrs['width_u'][:, None] * attrs['opacity'][:, None] * seg
    if 'kind' in attrs:
        k = np.asarray(attrs['kind'])
        mass = mass * np.where(((k >= 2) & (k <= 4))[:, None], flyaway_factor, 1.0)
    return mass.astype(np.float32)


def hair_od(P, mass, Q, d, vox=0.02, blur=0.7, bias=1.0):
    """optical depth (sum of fibre cross-section per area) of the hair between each query
    point Q (k, 3) and the light at direction d, from hair samples P (n, 3) with mass (n,).
    bias (voxels) shifts the lookup toward the light so a strand does not shadow itself."""
    R = basis(d)
    Pr = np.asarray(P, np.float64) @ R.T; Qr = np.asarray(Q, np.float64) @ R.T
    lo = np.minimum(Pr.min(0), Qr.min(0)) - 3 * vox; hi = np.maximum(Pr.max(0), Qr.max(0)) + 3 * vox
    shape = np.ceil((hi - lo) / vox).astype(int) + 1
    g = splat3d((Pr - lo) / vox, mass, shape) / (vox * vox)
    if blur:
        g = ndimage.gaussian_filter(g, blur)
    cs = np.cumsum(g[::-1], axis=0)[::-1] - 0.5 * g        # toward +d (the light)
    fz = (Qr[:, 2] - lo[2]) / vox + bias; fy = (Qr[:, 1] - lo[1]) / vox; fx = (Qr[:, 0] - lo[0]) / vox
    return ndimage.map_coordinates(cs, [fz, fy, fx], order=1, mode='nearest')


def body_vis(Q, d, k=6.0, steps=14, tmin=0.008, tmax=2.0, chunk=500000):
    """soft visibility of direction d from points Q (k, 3) past the body (head, face,
    neck, torso, arms): sphere-traced through the SDF with a penumbra factor k."""
    sdf = head.body_sdf()
    Q = np.asarray(Q, np.float64)
    d = np.asarray(d, np.float64); d = d / np.linalg.norm(d)
    out = np.ones(len(Q))
    ts = tmin * (tmax / tmin) ** (np.arange(steps) / (steps - 1))
    for a in range(0, len(Q), chunk):
        q = Q[a:a + chunk]
        res = np.ones(len(q))
        for t in ts:
            res = np.minimum(res, np.clip(k * sdf(q + d * t) / t, 0, 1))
        out[a:a + chunk] = res
    return out * out * (3 - 2 * out)
