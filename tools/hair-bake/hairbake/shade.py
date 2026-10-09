"""Hair shading for the bake: per strand vertex, in neutral (colourless) channels.

Ported from proto-a shade.py onto the MakeHuman body (head.body_sdf) and made multi-view.

Channels (per vertex, then rasterised by render.py):
  D   diffuse / multiple-scatter light: a key light (wrapped Kajiya-Kay diffuse, self-shadowed
      through the hair volume with a deep opacity map, soft-shadowed by the head and body)
      plus a studio ambient term with ambient occlusion from the hair and the body.
                                                              runtime: x the dye colour
  S1  R lobe (primary highlight: reflection off the fibre surface, white).
                                                              runtime: x the light colour
  S2  TRT lobe (secondary highlight: through the fibre and back, shifted toward the tips,
      coloured by the fibre).                                 runtime: x dye^0.8
  M   how deep inside the hair the light arrived (0 at the surface .. 1 deep): light that
      crossed more fibres is darker and more saturated, so the runtime raises the dye to the
      power 1 + k*M.

Longitudinal lobes follow Marschner et al. 2003 (theta_h = (theta_i + theta_r) / 2 measured
from the fibre's normal plane; R shifted by alpha_R toward the root, TRT by -1.5 alpha_R);
azimuthal terms are simple cosine fits.  Per-strand jitter (attrs spec1_j, spec2_j, shift_j,
albedo) breaks the highlight into strands and locks.

Views: the light and the camera are fixed in VIEW space (the room light does not turn with
the head).  A view baked at yaw v sees the groom rotated by v (canon.rotate_yaw); instead of
rotating 100k strands for every query we shade in the canonical frame with the light and
the view direction rotated by -v.  Everything that does not depend on the view (tangents,
the volume normal, the hair and body ambient occlusion per direction) is computed once in
Shader.__init__; Shader.view(v) adds what does (key-light shadow, the lobes).

Typical cost at q = 1 (100k strands x 90 vertices, 28 shading samples per strand): ~40 s
once + ~15 s per view, ~1.5 GB peak.
"""
import time
import numpy as np
from scipy import ndimage
from . import canon, head
from .volume import basis, fib_dirs, strand_mass, hair_od
from .native import splat3d

# Studio light, in VIEW space (x image right, y DOWN, z toward the camera).  key: direction
# TOWARD the light (upper left of the image, in front).
LIGHT = dict(
    key=(-0.28, -0.40, 0.87),
    kd=0.95, ka=0.42, wrap=0.35,          # key diffuse, ambient, diffuse wrap
    kappa=0.20,                           # extinction of the key light per unit fibre cross-section/area
    kappa_ao=0.16,                        # ... of the ambient light
    kappa_m=0.10,                         # ... for the M (depth into hair) measure
    alpha_r=-5.0, beta_r=9.0,             # R lobe shift / width (degrees)
    beta_trt=15.0,                        # TRT lobe width (degrees)
    ambient_floor=0.12,                   # ambient left in the deepest occlusion
    env_base=0.22,                        # room light from behind / below (env_weight)
    bounce=0.0,                           # light reflected onto the hair by the neck and shoulders
    bounce_m=0.0,                         # ... and how much it lowers M there (body_proximity):
                                          #     long hair falling around the neck stays readable
                                          #     (dark, not black) when its inside shows at 3/4
    bounce_reach=0.08,                    # ... falloff distance from the skin / clothes (head units)
    ao_dirs=16,                           # hair ambient-occlusion directions
    body_ao_dirs=16,                      # body ambient-occlusion directions
)

# Where the "outward" normal of the hair volume points from: a vertical axis through the
# middle of the head (x = .5, z = -.26) below the skull centre, the skull centre above it.
VOLUME_AXIS = (0.5, 0.32, -0.26)


def env_weight(dirs_view, base=0.22):
    """studio environment brightness from view-space directions (n, 3): mostly from the
    front and above, `base` from the walls behind and below (LIGHT['env_base'])."""
    d = np.asarray(dirs_view)
    front = np.clip(d[:, 2], 0, 1)
    up = np.clip(-d[:, 1], 0, 1)
    return base + 0.85 * front + 0.35 * up


def volume_normal(P):
    """approximate outward normal of the hair volume at P (..., 3)."""
    ax, ay, az = VOLUME_AXIS
    c = np.empty_like(P)
    c[..., 0] = ax; c[..., 2] = az
    c[..., 1] = np.clip(P[..., 1], ay, 3.0)
    n = P - c
    return n / (np.linalg.norm(n, axis=-1, keepdims=True) + 1e-9)


def body_proximity(Q, parts=('neck', 'torso'), reach=0.08, chunk=500000):
    """0..1 per point (k, 3): how close it is to the given body parts (the neck and the
    shoulders by default, not the scalp): 1 on their surface, exp(-distance / reach) away
    from it.  The part label is blended over the 8 nearest body-mesh vertices, so there is
    no step where the neck meets the head."""
    from scipy.spatial import cKDTree
    m = head.body_mesh()
    lab = np.isin(m['region'], [head.REGION[p] for p in parts]).astype(np.float32)
    tree = cKDTree(m['V'])
    sdf = head.body_sdf()
    out = np.empty(len(Q), np.float32)
    for a in range(0, len(Q), chunk):
        q = np.asarray(Q[a:a + chunk], np.float64)
        d, i = tree.query(q, k=8)
        w = 1.0 / (d + 1e-3)
        lb = (lab[i] * w).sum(1) / w.sum(1)
        dist = np.asarray(sdf(q), np.float64)
        out[a:a + chunk] = lb * np.exp(-np.clip(dist - 0.005, 0, None) / reach)
    return out


def body_vis(Q, d, k=6.0, steps=14, tmin=0.008, tmax=2.0, chunk=400000, sdf=None):
    """soft visibility (0 blocked .. 1 free) of direction d from points Q past the body
    (sphere-traced through the SDF, penumbra factor k).  Canonical frame."""
    sdf = sdf or head.body_sdf()
    Q = np.asarray(Q)
    d = np.asarray(d, np.float64); d = d / np.linalg.norm(d)
    ts = tmin * (tmax / tmin) ** (np.arange(steps) / max(steps - 1, 1))
    out = np.empty(len(Q), np.float32)
    for a in range(0, len(Q), chunk):
        q = Q[a:a + chunk].astype(np.float64)
        res = np.ones(len(q))
        for t in ts:
            res = np.minimum(res, np.clip(k * sdf(q + d * t) / t, 0, 1))
        out[a:a + chunk] = res * res * (3 - 2 * res)
    return out


# Body ambient visibility per canonical direction does not depend on the groom: it is
# computed once on a grid over the whole sprite volume and cached in build/ (keyed by the
# body geometry and the directions), then sampled a little outside the body surface.
BODY_AO_BOX = (np.array([-0.95, -0.85, -1.60]), np.array([1.95, 3.00, 0.80]), 0.03)


def body_ao_field(dirs, log=print):
    """(len(dirs), NX, NY, NZ) float16 soft body visibility per direction on BODY_AO_BOX."""
    import os, hashlib
    from .native import BUILD
    lo, hi, vox = BODY_AO_BOX
    key = hashlib.sha1(head._key('bodyao', np.round(dirs, 6).tolist(), lo.tolist(), hi.tolist(), vox).encode()).hexdigest()[:12]
    path = os.path.join(BUILD, f'bodyao-{key}.npy')
    if os.path.exists(path):
        return np.load(path)
    t0 = time.time()
    shape = tuple(np.ceil((hi - lo) / vox).astype(int) + 1)
    g = np.stack(np.meshgrid(*[lo[i] + np.arange(shape[i]) * vox for i in range(3)], indexing='ij'), -1).reshape(-1, 3)
    sdf = head.body_sdf()
    F = np.empty((len(dirs),) + shape, np.float16)
    for i, d in enumerate(dirs):
        F[i] = body_vis(g, d, k=3.0, steps=7, tmax=0.8, sdf=sdf).reshape(shape)
    os.makedirs(BUILD, exist_ok=True)
    tmp = path + f'.{os.getpid()}.tmp.npy'
    np.save(tmp, F); os.replace(tmp, path)
    for old in os.listdir(BUILD):
        if old.startswith('bodyao-') and old != os.path.basename(path) and '.tmp' not in old:
            try:
                os.remove(os.path.join(BUILD, old))
            except OSError:
                pass
    log(f'  shade: body AO field built in {time.time() - t0:.1f}s -> {path}')
    return F


def sample_body_ao(F, Q, offset=0.008, chunk=1000000):
    """the field F (ndirs, NX, NY, NZ) at points Q (k, 3), each moved `offset` outward
    along the body SDF gradient first (the grid's voxels inside the body must not darken
    points right on the surface).  Returns (ndirs, k) float16."""
    lo, hi, vox = BODY_AO_BOX
    sdf = head.body_sdf()
    out = np.empty((F.shape[0], len(Q)), np.float16)
    for a in range(0, len(Q), chunk):
        q = np.asarray(Q[a:a + chunk], np.float64)
        q = q + sdf.grad(q) * offset
        c = ((q - lo) / vox).T
        for i in range(F.shape[0]):
            out[i, a:a + chunk] = ndimage.map_coordinates(F[i].astype(np.float32), c, order=1, mode='nearest')
    return out


def _interp_back(X, idx, m):
    """values at the shading samples idx (n, ns) -> every vertex (n, m), linearly."""
    ns = len(idx)
    tq = np.arange(m)
    j = np.clip(np.searchsorted(idx, tq, side='right') - 1, 0, ns - 2)
    f = ((tq - idx[j]) / (idx[j + 1] - idx[j])).astype(np.float32)[None, :]
    return (X[:, j] * (1 - f) + X[:, j + 1] * f).astype(np.float32)


class Shader:
    """Shades one groom for any number of views.

        sh = Shader(S, attrs)            # S (n, m, 3) canonical strands, attrs as Hair.merged()
        D, S1, S2, M = sh.view(yaw)      # (n, m) float32 each

    n_sub   shading samples per strand (the rest is interpolated along the strand).
    vox     deep-opacity voxel size for the key light (head units)."""

    def __init__(self, S, attrs, light=None, n_sub=28, vox=0.02, log=print):
        t0 = time.time()
        self.light = dict(LIGHT, **(light or {}))
        self.log = log
        self.attrs = attrs
        self.vox = vox
        n, m, _ = S.shape
        self.n, self.m = n, m
        idx = np.unique(np.round(np.linspace(0, m - 1, min(n_sub, m))).astype(int))
        self.idx = idx
        ns = len(idx)
        Ss = S[:, idx].astype(np.float32)
        self.Q = Ss.reshape(-1, 3)
        T = np.empty((n, ns, 3), np.float32)
        for a in range(0, n, 20000):                       # tangents in chunks (memory)
            g = np.gradient(S[a:a + 20000].astype(np.float32), axis=1)[:, idx]
            T[a:a + 20000] = g / (np.linalg.norm(g, axis=-1, keepdims=True) + 1e-9)
        self.T = T
        N = volume_normal(Ss)
        N = N - (N * T).sum(-1, keepdims=True) * T
        self.N = (N / (np.linalg.norm(N, axis=-1, keepdims=True) + 1e-9)).astype(np.float32)
        del N
        mass = strand_mass(S, attrs)                       # (n, m)
        # occluding hair: every other vertex for the key light, every 4th for the ambient
        self.P2 = S[:, ::2].reshape(-1, 3).astype(np.float32); self.m2 = (mass[:, ::2] * 2).reshape(-1)
        self.P4 = S[:, ::4].reshape(-1, 3).astype(np.float32); self.m4 = (mass[:, ::4] * 4).reshape(-1)
        del mass
        L = self.light
        # hair ambient occlusion per canonical direction (reweighted per view)
        self.ao_dirs = fib_dirs(L['ao_dirs'])
        self.ao_hair = np.empty((len(self.ao_dirs), n, ns), np.float16)
        for i, d in enumerate(self.ao_dirs):
            od = hair_od(self.P4, self.m4, self.Q, d, vox=vox * 1.6, blur=0.9)
            self.ao_hair[i] = np.exp(-L['kappa_ao'] * od).reshape(n, ns)
        log(f'  shade: hair AO ({len(self.ao_dirs)} dirs) {time.time() - t0:.1f}s')
        # body ambient occlusion per canonical direction (cached field, sampled)
        t1 = time.time()
        self.body_dirs = fib_dirs(L['body_ao_dirs'])
        F = body_ao_field(self.body_dirs, log=log)
        self.ao_body = sample_body_ao(F, self.Q).reshape(len(self.body_dirs), n, ns)
        del F
        log(f'  shade: body AO ({len(self.body_dirs)} dirs) {time.time() - t1:.1f}s')
        # albedo and the root factor (roots are seen end-on: dimmer highlight)
        alb = attrs['albedo'][:, None].astype(np.float32)
        if 'albedo_t' in attrs:
            alb = alb * np.broadcast_to(attrs['albedo_t'], (n, m))[:, idx]
        self.alb = np.broadcast_to(alb, (n, ns)).astype(np.float32)
        self.root = (0.25 + 0.75 * np.clip(idx / max(m - 1, 1) / 0.12, 0, 1)).astype(np.float32)[None, :]
        self.prox = None
        if L.get('bounce') or L.get('bounce_m'):
            self.prox = body_proximity(self.Q, reach=L.get('bounce_reach', 0.08)).reshape(n, ns)
            log(f'  shade: body proximity (bounce) mean {self.prox.mean():.3f}')
        log(f'  shade: setup {time.time() - t0:.1f}s ({n} strands x {ns} samples)')

    def _ambient(self, R):
        """hair and body ambient visibility at every sample for the view rotation R."""
        w = env_weight(self.ao_dirs @ R.T, self.light['env_base'])
        aoh = np.zeros(self.ao_hair.shape[1:], np.float32)
        for wi, a in zip(w, self.ao_hair):
            aoh += wi * a
        aoh /= w.sum()
        wb = env_weight(self.body_dirs @ R.T, self.light['env_base'])
        aob = np.zeros(self.ao_body.shape[1:], np.float32)
        for wi, a in zip(wb, self.ao_body):
            aob += wi * a
        aob /= wb.sum()
        return aoh, aob

    def view(self, yaw):
        """D, S1, S2, M per vertex (n, m) for the view baked at this yaw."""
        t0 = time.time()
        L = self.light
        R = canon.yaw_matrix(yaw)                        # canonical -> view
        Lv = np.asarray(L['key'], np.float64); Lv /= np.linalg.norm(Lv)
        Lc = R.T @ Lv                                    # key light direction in the canonical frame
        Vc = R.T @ np.array([0, 0, 1.0])                 # toward the camera, canonical frame
        n, ns = self.alb.shape
        od_key = hair_od(self.P2, self.m2, self.Q, Lc, vox=self.vox).reshape(n, ns)
        vis = body_vis(self.Q, Lc).reshape(n, ns)
        K = np.exp(-L['kappa'] * od_key) * vis
        aoh, aob = self._ambient(R)
        ao = aoh * aob
        T, N = self.T, self.N
        sTL = T @ Lc; sTV = T @ Vc
        th_i = np.arcsin(np.clip(sTL, -1, 1)); th_r = np.arcsin(np.clip(sTV, -1, 1))
        th_h = 0.5 * (th_i + th_r); th_d = 0.5 * (th_r - th_i)
        Lp = Lc[None, None] - sTL[..., None] * T; Vp = Vc[None, None] - sTV[..., None] * T
        cphi = (Lp * Vp).sum(-1) / (np.linalg.norm(Lp, axis=-1) * np.linalg.norm(Vp, axis=-1) + 1e-9)
        del Lp, Vp
        a_r = np.radians(L['alpha_r']) + self.attrs['shift_j'][:, None]
        MR = np.exp(-0.5 * ((th_h - a_r) / np.radians(L['beta_r'])) ** 2)
        MT = np.exp(-0.5 * ((th_h + 1.5 * a_r) / np.radians(L['beta_trt'])) ** 2)
        NR = np.sqrt(np.clip(0.5 + 0.5 * cphi, 0, 1))
        NT = 0.55 + 0.45 * np.clip(cphi, 0, 1)
        norm = 1.0 / np.maximum(np.cos(th_d) ** 2, 0.3)
        facing = np.clip((N @ Vc) * 0.6 + 0.55, 0, 1)
        sinTL = np.sqrt(np.clip(1 - sTL * sTL, 0, 1))
        wrapd = np.clip(((N @ Lc) + L['wrap']) / (1 + L['wrap']), 0, 1)
        diff = sinTL * (0.45 + 0.55 * wrapd)
        amb = L['ambient_floor'] + (1 - L['ambient_floor']) * ao
        D = self.alb * (L['kd'] * diff * K + L['ka'] * amb)
        if self.prox is not None and L.get('bounce'):
            D = D + self.alb * (L['bounce'] * self.prox)
        S1 = self.attrs['spec1_j'][:, None] * MR * NR * norm * K * facing * self.root
        S2 = self.attrs['spec2_j'][:, None] * MT * NT * norm * K * facing * (0.4 + 0.6 * aoh) * self.root
        Mt = np.clip(1 - (0.6 * np.exp(-L['kappa_m'] * od_key) + 0.4 * aoh), 0, 1)
        if self.prox is not None and L.get('bounce_m'):
            Mt = Mt * (1 - L['bounce_m'] * self.prox)
        out = [_interp_back(X.astype(np.float32), self.idx, self.m) for X in (D, S1, S2, Mt)]
        self.log(f'  shade view {yaw:+g}: {time.time() - t0:.1f}s (key transmittance mean {K.mean():.2f}, AO {ao.mean():.2f})')
        return out

    def skin_shadow(self, Qc, yaw):
        """darkening (0..1) the hair casts on body points Qc (k, 3, canonical frame, already
        offset a little off the surface) in the view at this yaw: key-light shadow through
        the hair and ambient occlusion by the hair."""
        L = self.light
        R = canon.yaw_matrix(yaw)
        Lv = np.asarray(L['key'], np.float64); Lv /= np.linalg.norm(Lv)
        Lc = R.T @ Lv
        tk = np.exp(-L['kappa'] * hair_od(self.P2, self.m2, Qc, Lc, vox=self.vox, bias=0.5))
        dirs = self.ao_dirs
        w = env_weight(dirs @ R.T, L['env_base']) * ((dirs @ R.T)[:, 2] > -0.1)
        ao = np.zeros(len(Qc))
        for d, wi in zip(dirs, w):
            if wi > 0:
                ao += wi * np.exp(-L['kappa_ao'] * hair_od(self.P4, self.m4, Qc, d, vox=self.vox * 1.5, bias=0.5))
        ao /= w.sum()
        return np.clip(1 - (0.7 * tk + 0.3 * ao), 0, 1).astype(np.float32)
