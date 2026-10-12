"""The head and body the hair is groomed on, rendered against and occluded by.

One body, used four ways:
  * collision: a signed distance field (SDF) of the MakeHuman CC0 base mesh (head, neck,
    torso; HAIR_PARTS: no arms, the arm holes capped) whose face is replaced by MediaPipe's
    canonical face mesh, so hair lies on the same forehead and cheeks the landmarks
    describe, and long hair drapes over a real neck, shoulders and back, falling straight
    past the shoulder tips as it does with the arms down (body_sdf, collide, project, normal);
  * scalp: roots are planted on that surface (head_vertices, skull/azimuth, view_surface
    give points, normals and a parametrisation; the groom library chooses where hair grows);
  * occluder: per view the body is z-buffered and hair behind it is hidden, so back hair
    never shows through the neck or the face (occluder; slits closed, a skirt behind the
    face outline); the neck and torso can be fattened (NECK_PAD) so a real neck a little
    wider than the proxy does not get hair painted over its edges; an occluder without the
    arms also leaves out the torso's lip around the arm holes (ARM_LIP);
  * masks: per view, the part id under each pixel (head / neck / torso / arm / face), from
    which the bake derives the head silhouette and the scalp under the hair (masks).

body_mesh() fits MakeHuman (decimetres, Y up) to the canonical face (head units, y down):
similarity + per-axis scale from the MediaPipe -> MakeHuman landmark correspondences (rms
~.028 head units, 4.6 mm), an RBF warp that lays its face onto the canonical face (median
gap .002), the cranium eased down to real-head height (SKULL_TOP = -.35, checked against
bald and short-haired portraits), and its own face (eye sockets, mouth cavity) cut out
inside the face oval.  The back of the head is at z ~ -.85, the ears at x ~ -.05 / 1.04,
the shoulders at y ~ 1.4.

Coordinates: head units (canon.py).  Yaw turns about the vertical axis through canon.PIVOT;
positive yaw turns the face toward +x (image right), the same sign as measure.js pose().yaw.
"""
import functools, hashlib, os
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from . import canon
from .canon import PIVOT, yaw_matrix, rotate_yaw          # re-exported: older code imports them from here
from .native import tri_zbuf, BUILD

ASSET = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'makehuman', 'upper_body.npz')
REGION = {'head': 0, 'neck': 1, 'torso': 2, 'arm': 3}
FACE_ID = 9                    # part id of the canonical face mesh in occluder / view_surface
NECK_PAD = 0.01               # occluder neck/torso fattening (head units): the MakeHuman neck is
                              # already a little wider than the women's necks in the test portraits
ALL_PARTS = ('head', 'neck', 'torso', 'arm')
# What hair lies on and collides with (body_sdf): no arms.  The MakeHuman arms are in an A
# pose, sloping out from the shoulders; long hair falling over a shoulder would slide out
# along them into a thin fan that never happens on a real person with the arms down.  The
# arm holes of the torso are capped, so the hair falls straight past the shoulder tips.  The
# arms stay in the occluder (render.py: they hide hair behind the shoulders only).
HAIR_PARTS = ('head', 'neck', 'torso')


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, np.float64) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------- fit
def _sim_fit(S, D):
    mu_s = S.mean(0); mu_d = D.mean(0)
    A = (D - mu_d).T @ (S - mu_s)
    U, s, Vt = np.linalg.svd(A)
    dm = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
    R = U @ dm @ Vt
    sc = (s * np.diag(dm)).sum() / ((S - mu_s) ** 2).sum()
    return sc, R, mu_s, mu_d


# The MakeHuman cranium is taller than real heads placed by the anchor fit: on bald and
# short-haired test portraits the skull top sits at y = -.25 .. -.35 head units (median
# -.31; anthropometric tables give -.36 .. -.40), MakeHuman's at -.45.  Everything above
# CRANIUM_FROM is eased down so the top lands at SKULL_TOP; the face, temples and the back
# of the head below that level do not move.
SKULL_TOP = -0.35
CRANIUM_FROM = 0.10            # y where the easing starts (just above the brows)
CRANIUM_EASE = 0.20            # over this distance the easing ramps in (no crease)
FACE_CUT_MARGIN = 0.035        # MakeHuman's own face is cut this far inside the face oval


def _rbf(P, R, sig, lam):
    K = np.exp(-((P[:, None] - P[None]) ** 2).sum(-1) / (2 * sig * sig))
    W = np.linalg.solve(K + lam * np.eye(len(P)), R)
    def f(Q):
        out = np.zeros(Q.shape)
        for i in range(0, len(Q), 4096):
            q = Q[i:i + 4096]
            out[i:i + 4096] = np.exp(-((q[:, None] - P[None]) ** 2).sum(-1) / (2 * sig * sig)) @ W
        return out
    return f


def _ease(t, t0):
    """0 for t <= 0, t^2/(2 t0) up to t0, then t - t0/2: a ramp with no kink."""
    t = np.maximum(t, 0)
    return np.where(t < t0, t * t / (2 * t0), t - t0 / 2)


def _inside_polygon(x, y, poly):
    """even-odd test of points (x, y) against a closed polygon (k, 2)."""
    inside = np.zeros(np.shape(x), bool)
    px, py = poly[:, 0], poly[:, 1]
    j = len(poly) - 1
    for i in range(len(poly)):
        c = ((py[i] > y) != (py[j] > y)) & (x < (px[j] - px[i]) * (y - py[i]) / (py[j] - py[i] + 1e-12) + px[i])
        inside ^= c
        j = i
    return inside


def _poly_dist(x, y, poly):
    """distance of points to the polygon's edges."""
    d = np.full(np.shape(x), np.inf)
    for i in range(len(poly)):
        a, b = poly[i - 1], poly[i]
        ab = b - a
        t = np.clip(((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / (ab @ ab), 0, 1)
        d = np.minimum(d, np.hypot(x - a[0] - t * ab[0], y - a[1] - t * ab[1]))
    return d


@functools.lru_cache(None)
def body_mesh():
    """MakeHuman upper body in head units, made to agree with the canonical face:

      1. a robust similarity + small per-axis scale from the 462 MediaPipe -> MakeHuman
         landmark correspondences (rms ~.028);
      2. a two-scale RBF warp of the residuals, then three closest-point passes, so MakeHuman's
         face surface passes through the canonical face mesh (median gap ~.002);
      3. the cranium eased down to SKULL_TOP;
      4. MakeHuman's own face (with its eye sockets, nostrils and mouth cavity) cut out
         FACE_CUT_MARGIN inside the face oval: the canonical face mesh takes its place
         (the occluder and the SDF add it back).

    Returns dict(V (n,3), T (m,3) outward-wound and without the cut face, region (n,),
    N (n,3) vertex normals, rms of step 1, gap: canonical vertex -> surface distances)."""
    z = np.load(ASSET)
    V = z['V'].astype(np.float64) * np.array([1, -1, 1.0])       # y down
    lm = z['landmarks'].astype(np.float64) * np.array([1, -1, 1.0])
    H, TF = canon.face_mesh()
    ok = np.isfinite(lm[:, 0])
    S, D = lm[ok], H[ok]
    keep = np.ones(len(S), bool)
    for _ in range(6):
        sc, R, mu_s, mu_d = _sim_fit(S[keep], D[keep])
        Y = sc * (S - mu_s) @ R.T + mu_d
        err = np.linalg.norm(Y - D, axis=1)
        keep = err < max(2.5 * np.median(err), 0.03)
    Yk = Y[keep] - Y[keep].mean(0); Dk = D[keep] - D[keep].mean(0)
    ax = np.clip((Yk * Dk).sum(0) / (Yk * Yk).sum(0), 0.85, 1.15)
    c0 = Y[keep].mean(0)

    def tf(P):
        Q = sc * (P - mu_s) @ R.T + mu_d
        return (Q - c0) * ax + c0
    rms = float(np.sqrt((np.linalg.norm(tf(S[keep]) - D[keep], axis=1) ** 2).mean()))
    V = tf(V); P = tf(S)
    T = _orient(V, z['T'].astype(np.int64))
    reg = z['region']
    # 2. warp the face onto the canonical face
    good = np.linalg.norm(D - P, axis=1) < 0.1
    for sig, lam in ((0.12, 0.05), (0.04, 0.01)):
        f = _rbf(P[good], (D - P)[good], sig, lam)
        V = V + f(V); P = P + f(P)
    headtri = T[(reg[T] == REGION['head']).all(1)]
    for it in range(3):                # closest-point passes: pull the surface onto every canonical vertex
        pts, _ = _surface_samples(V, headtri, np.zeros_like(V), 0.005)
        d, j = cKDTree(pts).query(H)
        sel = d < 0.06
        f = _rbf(pts[j[sel]], H[sel] - pts[j[sel]], 0.03, 0.005)
        V = V + f(V)
    # 3. the cranium
    top = V[reg == REGION['head'], 1].min()
    span = _ease(CRANIUM_FROM - top, CRANIUM_EASE)
    k = (SKULL_TOP - top) / span
    V = V.copy()
    V[:, 1] += k * _ease(CRANIUM_FROM - V[:, 1], CRANIUM_EASE)
    pts, _ = _surface_samples(V, T[(reg[T] == REGION['head']).all(1)], np.zeros_like(V), 0.006)
    gap, _ = cKDTree(pts).query(H)
    # 4. cut MakeHuman's face inside the oval
    oval = H[canon.FACE_OVAL, :2]
    cen = V[T].mean(1)
    inside = _inside_polygon(cen[:, 0], cen[:, 1], oval) & (_poly_dist(cen[:, 0], cen[:, 1], oval) > FACE_CUT_MARGIN)
    cut = inside & (cen[:, 2] > -0.30) & (reg[T] == REGION['head']).all(1)
    T = T[~cut]
    return dict(V=V, T=T, region=reg, N=vertex_normals(V, T), rms=rms, gap=gap)


def vertex_normals(V, T):
    fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, T[:, k], fn)
    return vn / (np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12)


def _orient(V, T):
    """outward normals: flip the winding if the enclosed signed volume is negative."""
    vol = np.einsum('ij,ij->i', V[T[:, 0]], np.cross(V[T[:, 1]], V[T[:, 2]])).sum()
    return T if vol > 0 else T[:, ::-1]


def head_vertices():
    """points and outward normals of the head region (scalp, ears; the face is cut out)."""
    m = body_mesh()
    used = np.zeros(len(m['V']), bool); used[m['T'].ravel()] = True
    s = (m['region'] == REGION['head']) & used
    return m['V'][s], m['N'][s]


def _surface_samples(V, T, N, spacing):
    """points + interpolated normals spread over the triangles every ~spacing."""
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    n = np.maximum(1, np.ceil(area / (spacing * spacing) * 2)).astype(int)
    tri = np.repeat(np.arange(len(T)), n)
    rng = np.random.default_rng(0)
    u = rng.random(len(tri)); v = rng.random(len(tri))
    f = u + v > 1; u[f] = 1 - u[f]; v[f] = 1 - v[f]
    w = 1 - u - v
    P = a[tri] * w[:, None] + b[tri] * u[:, None] + c[tri] * v[:, None]
    Nn = N[T[tri, 0]] * w[:, None] + N[T[tri, 1]] * u[:, None] + N[T[tri, 2]] * v[:, None]
    Nn /= np.linalg.norm(Nn, axis=1, keepdims=True) + 1e-12
    # the vertices of these triangles too (no gaps on tiny triangles)
    u = np.unique(T)
    return np.concatenate([P, V[u]]), np.concatenate([Nn, N[u]])


# ------------------------------------------------------------------------------- SDF
class SDF:
    """signed distance on a regular grid (negative inside), trilinear lookups.
    Grid layout d[ix, iy, iz] at lo + i * vox."""
    def __init__(self, data, lo, vox):
        self.d = data.astype(np.float32)
        self.lo = np.asarray(lo, np.float64); self.vox = float(vox)
        g = np.gradient(self.d, self.vox)
        self.g = [x.astype(np.float32) for x in g]

    def _coords(self, p):
        c = (np.asarray(p, np.float64).reshape(-1, 3) - self.lo) / self.vox
        return [c[:, 0], c[:, 1], c[:, 2]]

    def __call__(self, p):
        sh = np.shape(p)[:-1]
        return ndimage.map_coordinates(self.d, self._coords(p), order=1, mode='nearest').reshape(sh)

    def grad(self, p):
        """unit gradient (the outward direction) at p (..., 3)."""
        sh = np.shape(p)[:-1]
        c = self._coords(p)
        g = np.stack([ndimage.map_coordinates(x, c, order=1, mode='nearest') for x in self.g], -1)
        g /= np.linalg.norm(g, axis=-1, keepdims=True) + 1e-12
        return g.reshape(sh + (3,))

    def eval(self, p):
        return self(p), self.grad(p)


GRID_LO = np.array([-1.05, -0.95, -1.75])
GRID_HI = np.array([2.05, 3.05, 0.85])
GRID_VOX = 0.02
SDF_VERSION = 4       # bump when the SDF construction changes (the cache key also hashes the inputs)


def _build_sdf(parts, key, band=0.12):
    """narrow band: exact distance to dense surface samples, signed by the sample normal;
    far field: sign by connected component (majority of the bordering band voxels),
    distance from a Euclidean distance transform of the band."""
    path = os.path.join(BUILD, f'sdf-{key}.npy')
    shape = tuple(np.ceil((GRID_HI - GRID_LO) / GRID_VOX).astype(int) + 1)
    if os.path.exists(path):
        return SDF(np.load(path), GRID_LO, GRID_VOX)
    Ps, Ns = [], []
    for V, T, N in parts:
        p, n = _surface_samples(V, T, N, GRID_VOX * 0.35)
        Ps.append(p); Ns.append(n)
    P = np.concatenate(Ps); Nn = np.concatenate(Ns)
    tree = cKDTree(P)
    axes = [GRID_LO[i] + np.arange(shape[i]) * GRID_VOX for i in range(3)]
    out = np.full(shape, np.inf, np.float32)
    for i, x in enumerate(axes[0]):
        Yg, Zg = np.meshgrid(axes[1], axes[2], indexing='ij')
        Q = np.stack([np.full(Yg.size, x), Yg.ravel(), Zg.ravel()], -1)
        d, j = tree.query(Q, distance_upper_bound=band, workers=4)
        ok = np.isfinite(d)
        s = np.ones(len(Q))
        s[ok] = np.sign(((Q[ok] - P[j[ok]]) * Nn[j[ok]]).sum(1)); s[s == 0] = 1
        out[i] = np.where(ok, d * s, np.inf).reshape(Yg.shape)
    far = ~np.isfinite(out)
    lab, n = ndimage.label(far)
    inside_band = np.isfinite(out) & (out < 0)
    outside_band = np.isfinite(out) & (out >= 0)
    sign = np.ones(n + 1)
    for k, sl in enumerate(ndimage.find_objects(lab), 1):
        sl2 = tuple(slice(max(0, a.start - 1), a.stop + 1) for a in sl)
        comp = lab[sl2] == k
        ring = ndimage.binary_dilation(comp) & ~comp
        ni = inside_band[sl2][ring].sum(); no = outside_band[sl2][ring].sum()
        sign[k] = -1 if ni > no else 1
    dist = ndimage.distance_transform_edt(far) * GRID_VOX + band
    out = np.where(far, sign[lab] * dist, out).astype(np.float32)
    os.makedirs(BUILD, exist_ok=True)
    tmp = path + f'.{os.getpid()}.tmp.npy'
    np.save(tmp, out); os.replace(tmp, path)
    for old in os.listdir(BUILD):             # stale caches of older geometry (16 MB each)
        if old.startswith('sdf-') and old.endswith('.npy') and old != os.path.basename(path) and '.tmp' not in old:
            try:
                os.remove(os.path.join(BUILD, old))
            except OSError:
                pass
    return SDF(out, GRID_LO, GRID_VOX)


def _face_part():
    H, T = canon.face_mesh()
    N = vertex_normals(H, T)
    if np.median(N[:, 2]) < 0:
        T = T[:, ::-1]; N = -N
    return H, T, N


def _body_part(regions):
    m = body_mesh()
    keep = np.isin(m['region'][m['T']], [REGION[r] for r in regions]).all(1)
    return m['V'], m['T'][keep], m['N']


def _boundary_loops(T):
    """closed loops of directed boundary edges (each a list of vertex ids) of a mesh with
    consistently wound triangles."""
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    nv = int(T.max()) + 1
    key = E[:, 0] * nv + E[:, 1]
    bd = E[~np.isin(key, E[:, 1] * nv + E[:, 0])]
    nxt = {}
    for a, b in bd:
        nxt.setdefault(int(a), []).append(int(b))
    seen, loops = set(), []
    for a0 in sorted(nxt):
        if a0 in seen:
            continue
        loop, a = [a0], a0
        seen.add(a0)
        while True:
            b = next((b for b in nxt.get(a, []) if b not in seen), None)
            if b is None:
                break
            loop.append(b); seen.add(b); a = b
        loops.append(loop)
    return loops


def _capped_torso_part(regions=HAIR_PARTS):
    """the body without the arms, the arm holes of the torso closed with a fan around each
    hole's centroid (wound like the mesh, so the cap's normals point out of the body)."""
    V, T, N = _body_part(regions)
    region = body_mesh()['region']
    V = [V]; N = [N]; T = [T]; nv = len(V[0])
    for loop in _boundary_loops(T[0]):
        P = V[0][loop]
        c = P.mean(0)
        if not ((region[loop] != REGION['head']).all() and 1.2 < c[1] < GRID_HI[1] and abs(c[0] - 0.5) > 0.4):
            continue                                   # only the two arm holes
        a = np.array(loop); b = np.roll(a, -1)
        cap = np.stack([b, a, np.full(len(a), nv)], 1)       # edge a->b of the mesh is b->a here
        fn = np.cross(V[0][cap[:, 1]] - V[0][cap[:, 0]], c - V[0][cap[:, 0]]).sum(0)
        T.append(cap); V.append(c[None]); N.append((fn / (np.linalg.norm(fn) + 1e-12))[None])
        V[0] = np.concatenate([V[0], c[None]]); nv += 1
    Vc = V[0]
    Nc = np.concatenate([N[0]] + N[1:]) if len(N) > 1 else N[0]
    return Vc, np.concatenate(T), Nc


def _key(*xs):
    """cache key: the exact body and face geometry plus the grid, so any change to the fit,
    the warp, the cut or the asset rebuilds the SDF."""
    m = body_mesh()
    H, TF = canon.face_mesh()
    h = hashlib.sha1()
    for a in (np.round(m['V'], 6), m['T'], np.round(H, 6), TF):
        h.update(np.ascontiguousarray(a).tobytes())
    h.update(repr((SDF_VERSION, GRID_LO.tolist(), GRID_HI.tolist(), GRID_VOX)).encode())
    for x in xs:
        h.update(repr(x).encode())
    return h.hexdigest()[:12]


@functools.lru_cache(None)
def body_sdf():
    """head + neck + torso (arm holes capped, no arms: HAIR_PARTS), with the canonical face:
    what hair lies and drapes on.  Built once (~15 s) and cached in build/sdf-<key>.npy
    (16 MB)."""
    return _build_sdf([_capped_torso_part(HAIR_PARTS), _face_part()], _key('body', HAIR_PARTS, 'capped'))


def collide(p, h, sdf=None, iters=2):
    """push points (..., 3) out of the body to at least distance h (scalar or per point)."""
    sdf = sdf or body_sdf()
    sh = np.shape(p)
    q = np.asarray(p, np.float64).reshape(-1, 3).copy()
    hh = np.broadcast_to(np.asarray(h, np.float64), sh[:-1]).reshape(-1)
    for _ in range(iters):
        d, g = sdf.eval(q)
        pen = hh - d
        m = pen > 0
        if not m.any():
            break
        q[m] += g[m] * pen[m, None]
    return q.reshape(sh)


def project(p, h=0.0, sdf=None, iters=3):
    """move points onto the offset surface sdf = h (both directions)."""
    sdf = sdf or body_sdf()
    q = np.asarray(p, np.float64).reshape(-1, 3).copy()
    hh = np.broadcast_to(np.asarray(h, np.float64), np.shape(p)[:-1]).reshape(-1)
    for _ in range(iters):
        d, g = sdf.eval(q)
        q -= g * (d - hh)[:, None]
    return q.reshape(np.shape(p))


def normal(p, sdf=None):
    return (sdf or body_sdf()).grad(p)


# ------------------------------------------------------------------------------- skull frame
@functools.lru_cache(None)
def skull():
    """centre and radii of an ellipsoid around the cranium (for azimuth / elevation
    parametrisations of the scalp).  The centre sits at y = .40, inside the skull."""
    m = body_mesh()
    V = m['V'][m['region'] == REGION['head']]
    top = V[V[:, 1] < 0.45]
    c = np.array([0.5, 0.40, 0.5 * (top[:, 2].min() + top[:, 2].max())])
    r = np.array([0.5 * (top[:, 0].max() - top[:, 0].min()), c[1] - top[:, 1].min(), 0.5 * (top[:, 2].max() - top[:, 2].min())])
    return c, r


def azimuth(p):
    """0 at the front, +-pi/2 at the sides (+ toward +x), pi at the back."""
    c, _ = skull()
    return np.arctan2(p[..., 0] - c[0], p[..., 2] - c[2])


# ------------------------------------------------------------------------------- per view
@functools.lru_cache(None)
def face_skirt(depth=0.06):
    """a strip of triangles from the canonical face's outline inward into the head: in
    the occluder it closes the hair-thin slit that can open between the face mesh and the
    surrounding MakeHuman surface in a turned view (so hair behind the head never shows
    through along the jaw).  Not part of the SDF (it lies inside the body).
    Returns triangles (k, 3, 3) and their corner normals (k, 3, 3)."""
    H, _ = canon.face_mesh()
    loop = np.array(canon.FACE_OVAL)
    B = H[loop]
    c = np.array([0.5, 0.45, -0.35])
    I = B + (c - B) / np.linalg.norm(c - B, axis=1, keepdims=True) * depth
    n = len(loop)
    tris, nrm = [], []
    for i in range(n):
        j = (i + 1) % n
        for t in ((B[i], B[j], I[i]), (B[j], I[j], I[i])):
            tris.append(t)
            e = np.cross(t[1] - t[0], t[2] - t[0]); e /= np.linalg.norm(e) + 1e-12
            nrm.append((e, e, e))
    return np.array(tris), np.array(nrm)


@functools.lru_cache(8)
def _view_tris(yaw, neck_pad, parts):
    m = body_mesh()
    V, T, N, reg = m['V'], m['T'], m['N'], m['region']
    # fatten the neck and torso along their normals; the pad fades in below the jaw line so
    # the head/neck seam does not step (and the face, ears and skull are never padded)
    pad = neck_pad * smoothstep(0.80, 1.10, V[:, 1]) * (reg != REGION['head'])
    Vp = V + N * pad[:, None]
    keep = np.isin(reg[T], [REGION[r] for r in parts]).all(1)
    if 'arm' not in parts and 'torso' in parts:
        keep &= ~_near_arm_holes(T)
    Tk = T[keep]
    tri_reg = reg[Tk].max(1)
    H, TF = canon.face_mesh()
    NF = vertex_normals(H, TF) * np.sign(np.median(vertex_normals(H, TF)[:, 2]))
    SK, SKN = face_skirt()
    P = np.concatenate([Vp[Tk], H[TF], SK])
    Nt = np.concatenate([N[Tk], NF[TF], SKN])
    pid = np.concatenate([tri_reg, np.full(len(TF), FACE_ID), np.full(len(SK), REGION['head'])])
    P = rotate_yaw(P.reshape(-1, 3), yaw).reshape(-1, 3, 3)
    Nt = (Nt.reshape(-1, 3) @ yaw_matrix(yaw).T).reshape(-1, 3, 3)
    return P, Nt, pid


ARM_LIP = 0.08     # occluders without the arms also drop the torso this close to the arm holes


@functools.lru_cache(None)
def _arm_hole_rims():
    """vertices of the two arm-hole loops of the torso (where the arms attach)."""
    V, T, _ = _body_part(HAIR_PARTS)
    region = body_mesh()['region']
    rims = []
    for loop in _boundary_loops(T):
        c = V[loop].mean(0)
        if (region[loop] != REGION['head']).all() and 1.2 < c[1] < GRID_HI[1] and abs(c[0] - 0.5) > 0.4:
            rims.append(V[loop])
    return np.concatenate(rims)


def _near_arm_holes(T, r=ARM_LIP):
    """(len(T),) bool: triangles with a vertex within r of an arm-hole rim.  An occluder that
    leaves the arms out (render.py: what may hide the hair hanging in front of the shoulders)
    also leaves out this lip of the torso: hair falling past a shoulder tip hangs where a real
    arm would be, and the jagged rim of the hole must not cut holes into it."""
    V = body_mesh()['V']
    d, _ = cKDTree(_arm_hole_rims()).query(V, distance_upper_bound=r)
    return np.isfinite(d)[T].any(1)


def view_mesh(yaw, neck_pad=NECK_PAD, parts=ALL_PARTS):
    """triangles (m,3,3) of the occluder in the yawed view (head units), their vertex
    normals (m,3,3) and a part id per triangle (REGION values, FACE_ID for the face)."""
    return _view_tris(float(yaw), float(neck_pad), tuple(parts))


class Frame:
    """a sprite frame in head units: x0..x1, y0..y1 at res px per unit (square pixels)."""
    def __init__(self, x0, y0, W, H, res):
        self.x0, self.y0, self.W, self.H, self.res = float(x0), float(y0), int(W), int(H), float(res)
        self.x1 = self.x0 + self.W / self.res; self.y1 = self.y0 + self.H / self.res

    def scaled(self, k):
        return Frame(self.x0, self.y0, int(round(self.W * k)), int(round(self.H * k)), self.res * k)

    def to_px(self, x, y):
        return (x - self.x0) * self.res, (y - self.y0) * self.res

    def grid(self):
        xs = self.x0 + (np.arange(self.W) + 0.5) / self.res
        ys = self.y0 + (np.arange(self.H) + 0.5) / self.res
        return np.meshgrid(xs, ys)

    def as_list(self):
        return [self.x0, self.y0, self.x1, self.y1, self.res]

    def __repr__(self):
        return f'Frame(x {self.x0:.3f}..{self.x1:.3f}, y {self.y0:.3f}..{self.y1:.3f}, {self.W}x{self.H} @ {self.res:g}/unit)'


def _close_slits(z, part, gap=0.02):
    """grey closing of the depth (3x3): fills slits up to ~2 px wide where a farther
    surface shows between two nearer ones (the seam between the face mesh and MakeHuman in
    turned views, ear creases), so hair behind the head can never leak through as a line.
    Silhouettes against empty space and real depth steps wider than that are unchanged.
    Filled pixels take the part id of their nearest neighbour."""
    zc = ndimage.grey_closing(z, size=(3, 3))
    fill = zc > z + gap
    if not fill.any():
        return z, part
    z = z.copy(); part = part.copy()
    ys, xs = np.nonzero(fill)
    best = np.full(len(ys), -1e30); bp = np.full(len(ys), -1, np.int16)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            yy = np.clip(ys + dy, 0, z.shape[0] - 1); xx = np.clip(xs + dx, 0, z.shape[1] - 1)
            zz = z[yy, xx]
            better = zz > best
            best = np.where(better, zz, best); bp = np.where(better, part[yy, xx], bp)
    z[fill] = zc[fill]
    part[fill] = bp
    return z, part


def occluder(fr, yaw, parts=ALL_PARTS, neck_pad=NECK_PAD, normals=False):
    """front depth (H, W) of the body in this view (-1e9 where empty), the part id image
    (-1 where empty) and, if normals, the view-space unit normal image (H, W, 3)."""
    P, Nt, pid = view_mesh(yaw, neck_pad, parts)
    Q = P.copy()
    Q[..., 0], Q[..., 1] = fr.to_px(P[..., 0], P[..., 1])
    A = np.concatenate([np.repeat(pid[:, None, None].astype(np.float32), 3, 1), Nt], -1) if normals else \
        np.repeat(pid[:, None, None].astype(np.float32), 3, 1)
    z, a = tri_zbuf(Q, fr.W, fr.H, A)
    part = np.where(z > -1e8, np.round(a[..., 0]), -1).astype(np.int16)
    z, part = _close_slits(z, part)
    if not normals:
        return z, part
    n = a[..., 1:4]
    n = n / (np.linalg.norm(n, axis=-1, keepdims=True) + 1e-12)
    return z, part, n


def view_surface(fr, yaw, neck_pad=0.0):
    """per pixel: the front-most body point (rotated back into the canonical pose), its
    part id and depth.  Returns P (H,W,3) canonical, z (H,W) view depth, pid."""
    z, pid = occluder(fr, yaw, neck_pad=neck_pad)
    X, Y = fr.grid()
    on = z > -1e8
    Pv = np.stack([X, Y, np.where(on, z, 0)], -1)
    P = rotate_yaw(Pv.reshape(-1, 3), -yaw).reshape(Pv.shape)
    return P, z, pid


def masks(fr, yaw, neck_pad=NECK_PAD):
    """boolean part masks of the body in this view, plus its depth:
    head (skull, ears and face), face (the canonical face mesh only), scalp_side (head
    minus face), neck, torso, arm, body (any), and z (H, W)."""
    z, part = occluder(fr, yaw, neck_pad=neck_pad)
    face = part == FACE_ID
    headm = (part == REGION['head']) | face
    return dict(z=z, part=part, head=headm, face=face, scalp_side=headm & ~face,
                neck=part == REGION['neck'], torso=part == REGION['torso'], arm=part == REGION['arm'], body=part >= 0)
