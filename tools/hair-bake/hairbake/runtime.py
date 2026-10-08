"""The REFERENCE RUNTIME: what the site's live hairstyle renderer does with a packed style
(hairstyles/<id>/), simulated in numpy.  qa.py composites styles on portraits with it and
FORMAT.md specifies the same steps for the WebGL implementation, so a difference between
this file and the site is a bug in one of them.

Per camera frame (inputs: the frame, the 478 landmarks in pixels, the 4x4 facial
transformation matrix, optionally the hair segmenter's confidence mask):

 1. yaw      head_yaw(): measure.js pose(M).yaw = asin(-R20) of the matrix (degrees, + = the
             face turned toward image right).  Without a matrix: yaw_from_landmarks() (a 3D
             similarity fit of the canonical face to the landmarks, landmark z x .7; 0.4
             degrees rms from the matrix yaw on the test portraits).
 2. weights  view_weights(): linear between the two nearest baked view yaws (style.json
             views[].yaw, -30 / 0 / +30), the outermost view alone beyond them.  At most two
             views are drawn.
 3. place    A = canon.head_fit(L, yaw): the 20 anchors as they appear at the CURRENT yaw
             (canon.anchors_xy(yaw)) fitted by least squares to the landmarks: a 2x3 affine
             from head units to frame pixels.
 4. mesh     each drawn view is a grid mesh over its sprite frame (one vertex every GRID = 8
             full-resolution texels).  Vertex (x, y) of view v takes its depth z from the
             view's Z channel (decoded on the CPU when the style loads), is turned by
             (yaw - v.yaw) about canon.PIVOT (parallax: the view's hair re-posed to the
             current yaw), and lands at A @ [x', y', 1].  Depth test on z' (nearer wins)
             where the mesh folds.  The face occludes: the canonical face mesh
             (canon.face_mesh, 468 vertices / 898 triangles) at the user's landmark positions,
             with its depths turned to the current yaw, plus a skirt under the jaw and an
             elliptic cylinder for the neck (face_depth, neck_mesh) are drawn into the depth
             buffer first, and hair more than FACE_EPS = .05 units behind them is hidden -
             without it a turned view slides the hair behind the jaw, cheek and neck across
             them as dark wedges (the bake smooths Z, so the grid cells at that edge
             stretch).  parallax=False
             instead places each view flat with head_fit(L, v.yaw) (ghosts during the
             cross-fade; kept for comparison).
 5. sample   the 4 textures of the view at the mesh's texture coordinates with bilinear +
             mipmap filtering of the ENCODED 8-bit values (what WebGL does with the RGB
             textures; mip levels are 2x2 box averages, LOD = log2(texels per frame pixel)
             from the placement's scale), then decoded (pack.LAYOUT): A; D, S1 premultiplied
             (square-root encoded: decode AFTER filtering); M, T, S2 straight; Z; shadow,
             scalp, head; face, body.
 6. colour   colour.recolour() of each view (linear light, premultiplied, with A for the
             straight-brightness terms), times the scene light (scene_light(): the
             hair-colour product's face-probe light factor, linearised: light^2.2).
             Cross-fade (render_layers): coverage-like layers (A, scalp, head, face, body) as
             a weighted UNION 1 - prod (1 - X_i)^min(1, 2 w_i); the hair colour as the
             coverage-weighted mean sum w_i P_i / sum w_i A_i; shadow and Z as weighted sums.
             Then colour.shoulder() on the straight colour (soft highlight roll-off above .72).
 7. under    the frame under the hair: (optional) own-hair hiding (hide_own_hair, proto-a's
             runtime2 with the judges' safeguards); the scalp: the user's own skin carried up
             from the face (skin_field) x (0.95 - 0.6 shadow), painted under the scalp mask
             only where the segmenter sees own hair, and (scalp_policy 'own') not where the
             new style is thin over a broad area (own short hair stays rather than a pale
             painted band); then the cast shadow, base x (1 - 0.32 blur(shadow, .02 units)).
 8. comp     out = hair + under * (1 - A), with a touch of the photo's softness (0.25 px blur
             over the hair) and grain (0.8 x the photo's noise, sRGB) over the new hair.

All images are float32; colours in linear light unless named *_srgb.
"""
import functools, json, os
import numpy as np
import cv2
from PIL import Image
from . import canon, colour
from .head import Frame
from .native import tri_zbuf

LUMA601 = np.array([0.299, 0.587, 0.114])      # stage.js luma(): sRGB values, Rec.601 weights
GRID = 8                                        # mesh vertex spacing (full-resolution texels)
FACE_OCCLUDE = True                             # the face mesh hides hair behind it (draw_view)
FACE_EPS = 0.05                                 # ... hair less than this behind the face surface stays
PROBES = (50, 280, 151, 199)                   # app.js probes(): both cheeks, forehead, chin
SKIN_PATCHES = ([108, 151, 337, 9], [117, 118, 101, 36, 205, 187, 123], [346, 347, 330, 266, 425, 411, 352])
DEFAULTS = dict(
    parallax=True,          # re-pose each view to the current yaw by its Z channel (step 4)
    union=True,             # cross-fade coverage as a weighted union (render_layers)
    shadow_k=0.32,          # cast shadow strength on skin / clothes
    shadow_blur=0.02,       # ... blurred by this many head units
    scalp=True,             # paint the scalp layer
    scalp_policy='own',     # 'paint': always; 'own': where the segmenter sees the user's own hair
                            # under the style's scalp and the style is thin there, recolour that
                            # hair instead of painting skin (no pale temple band on short styles)
    light='face',           # 'face': the hair-colour product's light factor; 'none': 1
    soften=0.25,            # px of blur over the new hair (camera optics)
    grain=0.8,              # x the photo's noise level, added over the new hair (sRGB)
    hide=False,             # own-hair hiding (hide_own_hair)
    hint=None,              # ... its tie-back decision: None = decide on this frame, 'tie-back' / ''
                            # = a decision kept from a frame that showed the whole head
    seed=1,
)


# ------------------------------------------------------------------------------- the sprite
def _mips(img, min_side=4):
    """mip chain of an (H, W, C) float image: 2x2 box averages (GL generateMipmap)."""
    out = [img]
    while min(out[-1].shape[:2]) >= 2 * min_side:
        a = out[-1]
        H, W = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
        a = a[:H, :W]
        out.append(0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]))
    return out


class Sprite:
    """a packed style as the runtime holds it: per view the four textures as ENCODED values
    v/255 (float32 RGB) with their mip chains, plus the view's depth decoded on the CPU for
    the mesh."""

    def __init__(self, style_dir):
        self.dir = style_dir
        self.meta = m = json.load(open(os.path.join(style_dir, 'style.json'), encoding='utf-8'))
        f = m['frame']
        self.frame = Frame(f['x0'], f['y0'], f['width'], f['height'], f['res'])
        self.scale = m['scale']
        self.z = (m['z']['min'], m['z']['max'])
        self.spec = m.get('look', {}).get('spec', 1.0)
        self.views = []
        for vm in m['views']:
            v = dict(yaw=float(vm['yaw']), tex={})
            for name in m['textures']:
                a = np.asarray(Image.open(os.path.join(style_dir, vm[name])).convert('RGB'), np.float32) / 255
                v['tex'][name] = _mips(a)
            v['Z'] = self.z[0] + (self.z[1] - self.z[0]) * v['tex']['depth'][0][..., 0]
            self.views.append(v)
        self.yaws = np.array([v['yaw'] for v in self.views])

    @property
    def id(self):
        return self.meta['id']


@functools.lru_cache(8)
def load_sprite(style_dir):
    return Sprite(os.path.abspath(style_dir))


def sample(mips, u, v, lod):
    """trilinear sample of a mip chain at level-0 texel coordinates (u, v) (texel i covers
    [i, i+1)), constant LOD, clamp-to-edge; returns (h, w, C)."""
    lod = max(0.0, float(lod))
    l0 = min(int(np.floor(lod)), len(mips) - 1)
    l1 = min(l0 + 1, len(mips) - 1)
    t = lod - np.floor(lod) if l1 != l0 else 0.0

    def at(l):
        k = 2.0 ** l
        return cv2.remap(mips[l], (u / k - 0.5).astype(np.float32), (v / k - 0.5).astype(np.float32),
                         cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    a = at(l0)
    if a.ndim == 2:
        a = a[..., None]
    if t > 1e-3:
        b = at(l1)
        a = a * (1 - t) + (b if b.ndim == 3 else b[..., None]) * t
    return a


# ------------------------------------------------------------------------------- pose
def head_yaw(det, source='matrix'):
    """the yaw that drives the cross-fade and the parallax: measure.js pose(M).yaw, or
    yaw_from_landmarks when source='landmarks' or there is no matrix."""
    if source == 'matrix' and det.get('M') is not None:
        return float(canon.pose(det['M'])[0])
    return yaw_from_landmarks(det['L'])


STABLE = sorted(set(canon.ANCHORS + canon.FACE_OVAL + [4, 5, 195, 197, 2, 98, 327, 168, 6]))


LANDMARK_Z = 0.7     # MediaPipe's landmark z is ~1/0.7 deeper than x/y scale implies (fitted)


def yaw_from_landmarks(L, ids=STABLE, kz=LANDMARK_Z):
    """yaw (degrees, measure.js sign) from the landmarks alone: least-squares similarity
    (Kabsch with scale) of the canonical face in head units onto the landmarks as 3D points
    (x, y, -kz * z) in pixels (MediaPipe's z is depth in about x's scale, negative toward the
    camera; kz = .7 matches the matrix yaw on the 16 test portraits to 0.4 degrees rms,
    kz = 1 overestimates turns by ~11 %).  yaw = asin(-R20) as pose() reads the matrix."""
    H, _ = canon.face_mesh()
    S = H[ids]
    D = np.c_[L[ids, 0], L[ids, 1], -kz * L[ids, 2]]
    mu_s, mu_d = S.mean(0), D.mean(0)
    C = (D - mu_d).T @ (S - mu_s)
    U, _, Vt = np.linalg.svd(C)
    R = U @ np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
    return float(np.degrees(np.arcsin(np.clip(-R[2, 0], -1, 1))))


def view_weights(yaws, yaw):
    """cross-fade weights of the baked views: linear between the two nearest view yaws,
    the outermost view alone beyond them."""
    yaws = np.asarray(yaws, np.float64)
    w = np.zeros(len(yaws))
    order = np.argsort(yaws)
    ys = yaws[order]
    if yaw <= ys[0]:
        w[order[0]] = 1
    elif yaw >= ys[-1]:
        w[order[-1]] = 1
    else:
        i = int(np.searchsorted(ys, yaw) - 1)
        t = (yaw - ys[i]) / (ys[i + 1] - ys[i])
        w[order[i]] = 1 - t
        w[order[i + 1]] = t
    return w


# ------------------------------------------------------------------------------- light
def lowres(img_srgb, k=8):
    """stage.js low2: the frame box-filtered to 1/8 size."""
    h, w = img_srgb.shape[:2]
    return cv2.resize(img_srgb.astype(np.float32), (max(1, round(w / k)), max(1, round(h / k))), interpolation=cv2.INTER_AREA)


def sample_uv(img, x, y):
    """bilinear sample of an (h, w, C) image at normalised coordinates (0..1)."""
    h, w = img.shape[:2]
    return cv2.remap(img, np.float32([[x * w - 0.5]]), np.float32([[y * h - 0.5]]), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REPLICATE)[0, 0]


def face_light(img_srgb, L):
    """the hair-colour product's light factor (shaders.js LAYER_FRAG): the mean luma of the
    low-res frame at the four face probes, light = clamp(mix(1, face / .58, .5), .72, 1.12)."""
    lo = lowres(img_srgb)
    h, w = img_srgb.shape[:2]
    face = np.mean([float(sample_uv(lo, np.clip(L[i, 0] / w, .01, .99), np.clip(L[i, 1] / h, .01, .99)) @ LUMA601)
                    for i in PROBES])
    return float(np.clip(1 + (face / 0.58 - 1) * 0.5, 0.72, 1.12)), face


def scene_light(img_srgb, L, mode='face'):
    """linear multiplier for the new hair: the product's sRGB light factor, linearised."""
    if mode == 'none':
        return 1.0
    lf, _ = face_light(img_srgb, L)
    return lf ** 2.2


def skin_reference(img_lin, L):
    """the user's skin tone (linear): median of forehead and cheek patches."""
    h, w = img_lin.shape[:2]
    m = np.zeros((h, w), np.uint8)
    for ids in SKIN_PATCHES:
        cv2.fillConvexPoly(m, cv2.convexHull(L[ids, :2].astype(np.int32)), 1)
    return np.median(img_lin[m > 0], axis=0) if m.any() else np.array([0.45, 0.3, 0.24])


def photo_noise(img_srgb):
    """the photo's noise level (sRGB, robust sigma of the high-pass luma)."""
    g = (img_srgb @ LUMA601).astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), 1.2)
    return float(np.median(np.abs(hp)) * 1.4826)


# ------------------------------------------------------------------------------- drawing
NECK = dict(cx=0.5, cz=-0.40, rx=0.27, rz=0.31, y0=0.75, y1=1.30)   # the neck occluder (head units)
JAW = [361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132]   # jaw line
JAW_DROP = 0.12                                                     # the skirt under it (head units)


@functools.lru_cache(None)
def neck_mesh(nseg=16, nring=6):
    """the neck and the jaw's underside of the occluder, head units at yaw 0:
    (m, 3, 3) triangles of the front half of an elliptic cylinder, x = cx + rx sin t,
    z = cz + rz cos t (t in -90..90 degrees), y0..y1 (NECK: fitted to the bake's MakeHuman
    neck: x .22-.78, z -.70..-.07 between the jaw and the shoulders), and the skirt's lower
    edge: (len(JAW), 3) points on that cylinder JAW_DROP below the jaw line, x drawn in to
    the neck.  face_depth joins JAW to it (the underside of the jaw: without it the hair
    behind slides into the gap between the jaw's outline and the narrower neck)."""
    H, T = canon.face_mesh()
    n = NECK
    t = np.radians(np.linspace(-90, 90, nseg + 1))
    ys = np.linspace(n['y0'], n['y1'], nring + 1)
    G = np.stack(np.meshgrid(t, ys), -1)                    # (ring, seg, 2)
    P = np.stack([n['cx'] + n['rx'] * np.sin(G[..., 0]), G[..., 1], n['cz'] + n['rz'] * np.cos(G[..., 0])], -1)
    a, b, c, d = P[:-1, :-1], P[:-1, 1:], P[1:, :-1], P[1:, 1:]
    neck = np.concatenate([np.stack([a, b, d], -2).reshape(-1, 3, 3), np.stack([a, d, c], -2).reshape(-1, 3, 3)])
    J = H[JAW]
    xn = n['cx'] + (J[:, 0] - n['cx']) * n['rx'] / np.abs(J[:, 0] - n['cx']).max()
    tn = np.arcsin(np.clip((xn - n['cx']) / n['rx'], -1, 1))
    low = np.stack([xn, J[:, 1] + JAW_DROP, n['cz'] + n['rz'] * np.cos(tn)], -1)
    return neck, low


def face_depth(A, yaw, shape, L=None):
    """the occluder of the hair behind the face, turned to the current yaw (about PIVOT) and
    drawn into a depth buffer of the frame (-1e9 off it): what hides the hair behind the
    face, jaw and neck that a turned view slides across them (draw_view).
      * the face: the canonical face mesh (canon.face_mesh: 468 vertices, 898 triangles) with
        its depths turned to the yaw, at the user's own landmark positions L (pixels) - so
        it has the user's outline - or, without L, placed with A;
      * the skirt under the jaw: the jaw line (JAW: face oval 361 .. 152 .. 132, as the face)
        joined to neck_mesh's lower edge;
      * the neck: neck_mesh's cylinder.
    Skirt and neck are turned and placed with A (head units -> pixels)."""
    H, T = canon.face_mesh()
    neck, low = neck_mesh()
    Hr = canon.rotate_yaw(H, yaw)

    def put(P):
        P = canon.rotate_yaw(P.reshape(-1, 3), yaw)
        return np.stack([A[0, 0] * P[:, 0] + A[0, 1] * P[:, 1] + A[0, 2],
                         A[1, 0] * P[:, 0] + A[1, 1] * P[:, 1] + A[1, 2], P[:, 2]], -1)
    if L is not None:
        F = np.c_[L[:468, :2], Hr[:, 2]]
    else:
        F = np.stack([A[0, 0] * Hr[:, 0] + A[0, 1] * Hr[:, 1] + A[0, 2],
                      A[1, 0] * Hr[:, 0] + A[1, 1] * Hr[:, 1] + A[1, 2], Hr[:, 2]], -1)
    J = F[JAW]
    N = put(low)
    skirt = np.concatenate([np.stack([J[:-1], J[1:], N[1:]], 1), np.stack([J[:-1], N[1:], N[:-1]], 1)])
    Q = np.concatenate([F[T], skirt, put(neck).reshape(-1, 3, 3)])
    zf, _ = tri_zbuf(Q, shape[1], shape[0])
    return zf


def draw_view(sp, view, A, yaw, shape, parallax=True, grid=GRID, zface=None):
    """one view of the sprite drawn into a frame of `shape` (h, w): the decoded layers at
    frame pixels (zero where the mesh does not reach).  A: 2x3 head units (of the CURRENT
    yaw) -> px when parallax, else head units of this view -> px.

    zface (face_depth() of the current pose): hair whose re-posed depth is more than
    FACE_EPS behind the face surface is hidden there - the user's face occludes the hair
    behind the jaw, cheeks and neck that a turned view slides across them."""
    fr = sp.frame
    h, w = shape
    nx, ny = fr.W // grid + 1, fr.H // grid + 1
    gu = np.arange(nx) * grid * 1.0; gv = np.arange(ny) * grid * 1.0
    U, V = np.meshgrid(gu, gv)
    X = fr.x0 + U / fr.res; Y = fr.y0 + V / fr.res
    if parallax:
        Zh = view['Z']                                       # half-res, decoded
        Zv = cv2.remap(Zh.astype(np.float32), (U / 2 - 0.5).astype(np.float32), (V / 2 - 0.5).astype(np.float32),
                       cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        P = canon.rotate_yaw(np.stack([X, Y, Zv], -1).reshape(-1, 3), yaw - view['yaw']).reshape(ny, nx, 3)
    else:
        P = np.stack([X, Y, np.zeros_like(X)], -1)
    px = A[0, 0] * P[..., 0] + A[0, 1] * P[..., 1] + A[0, 2]
    py = A[1, 0] * P[..., 0] + A[1, 1] * P[..., 1] + A[1, 2]
    Q = np.stack([px, py, P[..., 2]], -1)
    att = np.stack([U, V], -1)
    a, b, c, d = Q[:-1, :-1], Q[:-1, 1:], Q[1:, :-1], Q[1:, 1:]
    ta, tb, tc, td = att[:-1, :-1], att[:-1, 1:], att[1:, :-1], att[1:, 1:]
    tris = np.concatenate([np.stack([a, b, d], -2).reshape(-1, 3, 3), np.stack([a, d, c], -2).reshape(-1, 3, 3)])
    tatt = np.concatenate([np.stack([ta, tb, td], -2).reshape(-1, 3, 2), np.stack([ta, td, tc], -2).reshape(-1, 3, 2)])
    zb, uv = tri_zbuf(tris, w, h, tatt)
    cov = zb > -1e8
    if zface is not None and parallax:
        cov &= ~(zb < zface - FACE_EPS)
    # level of detail from the on-screen scale (texels per frame pixel)
    s = np.sqrt(abs(np.linalg.det(A[:, :2])))                # frame px per head unit
    lod = np.log2(max(fr.res / s, 1e-6))
    u = np.where(cov, uv[..., 0], -10.0); v = np.where(cov, uv[..., 1], -10.0)
    hair = sample(view['tex']['hair'], u, v, lod)
    aux = sample(view['tex']['aux'], u / 2, v / 2, lod - 1)
    mask = sample(view['tex']['mask'], u / 2, v / 2, lod - 1)
    dep = sample(view['tex']['depth'], u / 2, v / 2, lod - 1)
    sc = sp.scale
    c = cov.astype(np.float32)
    A_ = hair[..., 2] * c
    out = dict(A=A_,
               S1p=sc['S1'] * hair[..., 0] ** 2 * c, Dp=sc['D'] * hair[..., 1] ** 2 * c,
               M=aux[..., 0], T=aux[..., 1], S2p=sc['S2'] * aux[..., 2] ** 2 * A_,
               shadow=mask[..., 0] * c, scalp=mask[..., 1] * c, head=mask[..., 2] * c,
               Z=sp.z[0] + (sp.z[1] - sp.z[0]) * dep[..., 0], face=dep[..., 1] * c, body=dep[..., 2] * c,
               cover=c)
    return out


def place(sp, det, yaw=None, yaw_source='matrix', parallax=True, shape=None):
    """the views to draw for this frame: (yaw, weights, [(weight, A, view)])."""
    L = det['L']
    if yaw is None:
        yaw = head_yaw(det, yaw_source)
    w = view_weights(sp.yaws, yaw)
    A_now = canon.head_fit(L, yaw)
    todo = []
    for wi, v in zip(w, sp.views):
        if wi <= 1e-6:
            continue
        todo.append((float(wi), A_now if parallax else canon.head_fit(L, v['yaw']), v))
    return yaw, w, A_now, todo


UNION = ('A', 'scalp', 'head', 'face', 'body')     # coverage-like layers: cross-faded as a union


def render_layers(sp, det, shape, dye, light=1.0, yaw=None, yaw_source='matrix', parallax=True, recolour_params=None,
                  union=True):
    """steps 1-6: the views drawn, recoloured and cross-faded into frame layers:
    hair (h, w, 3) linear premultiplied, A, shadow, scalp, head, face, body, Z, plus info.

    Cross-fade of the (at most two) drawn views with weights w_i:
      coverage-like layers X in UNION (A, scalp, head, face, body) as a weighted union
          X = 1 - prod_i (1 - X_i)^c_i,   c_i = min(1, 2 w_i)
      (= X_i alone at w_i = 1, the plain union at .5 / .5): hair that only one view shows -
      the side of the head turning into view, hair hidden behind the head in the other view -
      stays opaque instead of going half see-through over the user's own hair or skin;
      the hair colour as the coverage-weighted mean colour of the views,
          C = sum_i w_i P_i / sum_i w_i A_i   (P_i = A_i C_i premultiplied),   P = A C;
      the other layers (shadow, Z) as plain weighted sums.
    union=False: everything as plain weighted sums (the simplest runtime; see-through bands
    where the views disagree)."""
    yaw, wts, A_now, todo = place(sp, det, yaw, yaw_source, parallax, shape)
    zface = face_depth(A_now, yaw, shape, det['L']) if (parallax and FACE_OCCLUDE) else None
    acc = None
    for wi, A, v in todo:
        L = draw_view(sp, v, A, yaw, shape, parallax=parallax, zface=zface)
        hair = colour.recolour(L['Dp'], L['S1p'], L['S2p'], L['M'], L['T'], dye, spec=sp.spec,
                               params=recolour_params, A=L['A']) * light
        ci = min(1.0, 2 * wi) if union else wi
        lay = dict(hair=hair * wi, wA=L['A'] * wi, shadow=L['shadow'] * wi, Z=L['Z'] * wi, cover=L['cover'] * wi)
        for k in UNION:
            lay['T_' + k] = np.power(np.clip(1 - L[k], 1e-6, 1), ci) if union else L[k] * wi
        if acc is None:
            acc = lay
        else:
            for k in acc:
                acc[k] = acc[k] * lay[k] if (k.startswith('T_') and union) else acc[k] + lay[k]
    for k in UNION:
        T = acc.pop('T_' + k)
        acc[k] = np.clip(1 - T if union else T, 0, 1).astype(np.float32)
    A_out = acc['A']
    C = acc['hair'] / np.maximum(acc.pop('wA'), 1e-4)[..., None]          # straight colour
    # the camera's highlight shoulder on the straight colour (no flat white in bright photos)
    acc['hair'] = (colour.shoulder(C) * A_out[..., None]).astype(np.float32)
    info = dict(yaw=yaw, weights=wts.tolist(), A=A_now, px_per_unit=float(np.sqrt(abs(np.linalg.det(A_now[:, :2])))))
    return acc, info


def composite(img_srgb, det, sp, dye, opts=None, hair_mask=None, yaw=None, yaw_source='matrix', recolour_params=None,
              return_parts=False):
    """the whole frame: img_srgb (h, w, 3) float 0..1, det: dict(L, M) (canon.load_detection),
    sp: Sprite, dye: '#hex' or sRGB triple, hair_mask: the segmenter's confidence (h, w) 0..1
    or None.  Returns the sRGB result (h, w, 3) float, and the parts with return_parts."""
    o = dict(DEFAULTS, **(opts or {}))
    h, w = img_srgb.shape[:2]
    img_lin = colour.srgb_to_lin(img_srgb).astype(np.float32)
    L = det['L']
    light = scene_light(img_srgb, L, o['light'])
    lay, info = render_layers(sp, det, (h, w), dye, light=light, yaw=yaw, yaw_source=yaw_source,
                              parallax=o['parallax'], recolour_params=recolour_params, union=o['union'])
    A = lay['A']
    hu = info['px_per_unit']
    skin = skin_reference(img_lin, L)
    base = img_lin.copy()
    report = dict(light=light, skin=skin.tolist())
    own = None
    if hair_mask is not None:
        own = np.clip(hair_mask, 0, 1).astype(np.float32)
    if o['hide'] and own is not None:
        base, rep = hide_own_hair(img_lin, img_srgb, L, own, lay, info['A'], hu, dye, light, seed=o['seed'],
                                  force_hint=o.get('hint'))
        report.update(rep)
    # the scalp under the hair: the user's own skin carried up from the face (a skin field,
    # so a parting or the forehead between curtain bangs continues the forehead's tone), shaded
    if o['scalp']:
        sa = np.clip(lay['scalp'], 0, 1)
        if own is not None:
            # only where the user has hair of their own (painted skin over bare skin would only
            # replace its texture with a flat field), softly
            sa = sa * np.clip(cv2.GaussianBlur(own, (0, 0), max(0.8, 0.006 * hu)) / 0.5, 0, 1)
        if o['scalp_policy'] == 'own' and own is not None:
            sa = sa * (1 - scalp_keep(own, A, hu))
        sh = np.clip(lay['shadow'], 0, 1)
        field = skin_field(img_lin, L, own, sa > 0.01, skin)
        scalp_rgb = field * (0.95 - 0.6 * sh)[..., None]
        base = base * (1 - sa[..., None]) + scalp_rgb * sa[..., None]
    # the cast shadow
    if o['shadow_k'] > 0:
        shb = cv2.GaussianBlur(np.clip(lay['shadow'], 0, 1), (0, 0), max(0.5, o['shadow_blur'] * hu))
        base = base * (1 - o['shadow_k'] * shb)[..., None]
    out = lay['hair'] + base * (1 - A[..., None])
    if o['soften'] > 0:
        soft = cv2.GaussianBlur(out, (0, 0), o['soften'])
        out = out * (1 - A[..., None]) + soft * A[..., None]
    srgb = colour.lin_to_srgb(out)
    if o['grain'] > 0:
        rng = np.random.default_rng(o['seed'])
        srgb = srgb + rng.normal(0, photo_noise(img_srgb) * o['grain'], (h, w, 1)) * A[..., None]
    srgb = np.clip(srgb, 0, 1).astype(np.float32)
    info.update(report)
    if return_parts:
        return srgb, dict(layers=lay, info=info, base=base)
    return srgb, info


def skin_field(img_lin, L, own, where, skin):
    """the user's skin colour continued from the face into `where` (linear, (h, w, 3)): the
    face oval's skin pixels (not hair, not eyes / brows / lips / deep shadow: luma within
    -35 / +40 % of the skin reference) spread by normalised convolution.  On a GPU: a mip
    chain of the masked frame and mask, sampled at a coarse level and divided."""
    h, w = img_lin.shape[:2]
    if not where.any():
        return np.broadcast_to(skin[None, None], (h, w, 3)).astype(np.float32)
    face = np.zeros((h, w), np.uint8)
    cv2.fillPoly(face, [L[FACE_OVAL, :2].astype(np.int32)], 1)
    Y = img_lin @ colour.LUMA
    Ys = float(skin @ colour.LUMA)
    src = (face > 0) & (Y > 0.65 * Ys) & (Y < 1.4 * Ys)
    if own is not None:
        src &= own < 0.2
    if src.sum() < 50:
        return np.broadcast_to(skin[None, None], (h, w, 3)).astype(np.float32)
    f, _ = fill_from(img_lin, where & ~src, src, scales=(3, 6, 12, 24, 48, 96, 192))
    return np.where(src[..., None], img_lin, f).astype(np.float32)


def scalp_keep(own, A, hu, thin=0.9):
    """scalp_policy 'own': where the user's own hair is under the style's scalp and the style
    is thin over a broad area (its coverage blurred over ~2.5 mm below `thin`: short sides,
    a fade, sparse temples), the scalp is not painted and the own hair stays (recoloured by
    the hiding when it is on), instead of a pale band of painted skin showing through the thin
    new hair.  Narrow gaps (a parting, between pieces) are surrounded by dense hair, so their
    blurred coverage stays high and they are still painted (0..1 = keep)."""
    Ab = cv2.GaussianBlur(A, (0, 0), max(0.6, 0.015 * hu))
    return np.clip(own, 0, 1) * (1 - np.clip(Ab / thin, 0, 1))


# ------------------------------------------------------------------------------- own hair
FACE_OVAL = canon.FACE_OVAL


def disk(r):
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def own_hair(hm, img_bgr8=None, strong=0.4, weak=0.06):
    """the user's hair (bool): weak-confidence regions connected to confident ones
    (hysteresis), and with the image only pixels whose colour is plausible for this hair."""
    st = hm > strong
    wk = hm > weak
    if img_bgr8 is not None and st.sum() > 50:
        lab = cv2.cvtColor(img_bgr8, cv2.COLOR_BGR2LAB).astype(np.float32)
        X = lab[hm > 0.6] if (hm > 0.6).sum() > 50 else lab[st]
        mu = X.mean(0); C = np.cov(X.T) + np.eye(3) * 4.0
        d = lab.reshape(-1, 3) - mu
        md = np.sqrt(np.einsum('ij,jk,ik->i', d, np.linalg.inv(C), d)).reshape(hm.shape)
        wk &= (md < 3.5) | (hm > 0.5)
    n, lab = cv2.connectedComponents(wk.astype(np.uint8))
    ids = np.unique(lab[st]); ids = ids[ids > 0]
    return np.isin(lab, ids)


def blur(x, s):
    """Gaussian blur of sigma s px; large sigmas on a reduced copy (same result to the eye,
    a fraction of the time)."""
    if s <= 4:
        return cv2.GaussianBlur(x, (0, 0), s)
    k = 2 ** int(np.log2(s / 2))
    h, w = x.shape[:2]
    sm = cv2.resize(x, (max(1, w // k), max(1, h // k)), interpolation=cv2.INTER_AREA)
    sm = cv2.GaussianBlur(sm, (0, 0), s / k)
    return cv2.resize(sm, (w, h), interpolation=cv2.INTER_LINEAR)


def fill_from(img_lin, remove, known, scales=(1.5, 3, 6, 12, 24, 48, 96, 192)):
    """fill `remove` from `known` pixels: multi-scale normalised convolution, the scales
    blended softly by how much known support each has (no terraces between rings).
    Returns (image, filled mask)."""
    wts = known.astype(np.float32)
    X = img_lin * wts[..., None]
    est = np.zeros_like(img_lin); have = np.zeros(remove.shape, np.float32)
    for k, s in enumerate(scales):
        num = blur(X, s)
        den = blur(wts, s)
        e = num / np.maximum(den[..., None], 1e-6)
        thr = 0.15 if k < len(scales) - 1 else 1e-3
        take = np.clip(den / thr, 0, 1) * (1 - have)
        est += e * take[..., None]; have += take
        if have[remove].min(initial=1.0) > 0.999:
            break
    est = est / np.maximum(have[..., None], 1e-6)
    out = img_lin.copy(); out[remove] = est[remove]
    return out, (have > 0.5) | ~remove


def radial_fill(img_lin, remove, known, centre, ang_sigma=2.0, inward=False, max_gap=None):
    """fill `remove` by carrying the nearest known pixel further OUT along the ray from the
    head centre inward (inward=True: the nearest pixel closer to the centre outward), in
    polar coordinates, smoothed across angle (proto-a): walls and curtains continue toward
    the head instead of blurring into a halo.  max_gap (px): rays whose known pixel is
    farther than this along the ray are not filled (no long streaks).  Returns (fill, ok)."""
    from scipy import ndimage
    h, w = remove.shape
    cx, cy = float(centre[0]), float(centre[1])
    R = float(np.sqrt(max(cx, w - cx) ** 2 + max(cy, h - cy) ** 2)) + 2
    nr, na = int(R), 1440
    fl = cv2.WARP_POLAR_LINEAR
    P = np.nan_to_num(cv2.warpPolar(img_lin.astype(np.float32), (nr, na), (cx, cy), R, fl | cv2.INTER_LINEAR))
    K = cv2.warpPolar(known.astype(np.uint8) * 255, (nr, na), (cx, cy), R, fl | cv2.INTER_NEAREST) > 127
    ang = np.arange(na)[:, None] * (2 * np.pi / na); rad = (np.arange(nr)[None, :] + 0.5) * (R / nr)
    xx = cx + rad * np.cos(ang); yy = cy + rad * np.sin(ang)
    K &= (xx >= 1) & (xx < w - 1) & (yy >= 1) & (yy < h - 1)     # nothing from beyond the frame
    num = cv2.blur(P * K[..., None], (5, 1)); den = cv2.blur(K.astype(np.float32), (5, 1))
    Pm = num / np.maximum(den[..., None], 1e-6)
    BIG = nr + 10
    if inward:
        idx = np.where(K, np.arange(nr)[None, :], -1)
        nxt = np.maximum.accumulate(idx, axis=1); ok = nxt >= 0
        gap = np.arange(nr)[None, :] - nxt
    else:
        idx = np.where(K, np.arange(nr)[None, :], BIG)
        nxt = np.minimum.accumulate(idx[:, ::-1], axis=1)[:, ::-1]; ok = nxt < BIG
        gap = nxt - np.arange(nr)[None, :]
    if max_gap is not None:
        ok &= gap <= max_gap * nr / R
    F = np.take_along_axis(Pm, np.clip(nxt, 0, nr - 1)[..., None], 1)
    Wt = ok.astype(np.float32)
    pad = int(4 * ang_sigma) + 1
    Fp = np.concatenate([F[-pad:], F, F[:pad]], 0) * np.concatenate([Wt[-pad:], Wt, Wt[:pad]], 0)[..., None]
    Wp = np.concatenate([Wt[-pad:], Wt, Wt[:pad]], 0)
    Fs = ndimage.gaussian_filter1d(Fp, ang_sigma, axis=0)[pad:-pad]
    Ws = ndimage.gaussian_filter1d(Wp, ang_sigma, axis=0)[pad:-pad]
    F = Fs / np.maximum(Ws[..., None], 1e-6)
    back = cv2.warpPolar(F.astype(np.float32), (w, h), (cx, cy), R, fl | cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR)
    okb = cv2.warpPolar((Ws > 0.05).astype(np.float32), (w, h), (cx, cy), R, fl | cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR) > 0.5
    back = np.nan_to_num(back)
    okb &= np.isfinite(back).all(-1) & (back.max(-1) < 4.0)
    return np.clip(back, 0, 4.0), okb


def hide_own_hair(img_lin, img_srgb, L, hm, lay, A, hu, dye, light, seed=1, big_hair=0.35, big_fringe=0.065,
                  force_hint=None):
    """proto-a runtime2's own-hair removal on the cross-faded layers, with the judges'
    safeguards.  Returns (new base (linear), report).

      * the user's hair: segmenter hysteresis + this person's hair colour (own_hair); never
        straight under the chin (dark collars fool the segmenter);
      * short, skull-hugging own hair right next to the new style is KEPT and recoloured
        toward the new hair (it reads as the cut's short sides / under-layer);
      * the rest of the uncovered own hair is filled: outside the head from the background
        only (never from the face, never from the clothes: the proxy body and the frame
        below the shoulders are not sources for pixels above them), carried along rays
        toward the head; inside the head silhouette from the face's skin (no ears are
        painted: the skin fill is flat);
      * the face (landmark oval) is never a fill target and never smeared;
      * when much big own hair would have to be invented away (more than `big_hair` x the
        face area outside the new style and head), or an own fringe over the brows is left
        bare by the new style (more than `big_fringe` x the face area in the protected zone),
        the report says hint='tie-back' and nothing is hidden: the app shows "tie / pin your
        hair back" instead of shipping smears and seams.  A close camera sees only part of
        big hair, so the app decides on a frame that shows the whole head and passes that
        decision on (force_hint: 'tie-back' or ''; None decides on this frame)."""
    h, w = hm.shape
    img8 = (np.clip(img_srgb, 0, 1)[..., ::-1] * 255 + 0.5).astype(np.uint8)
    alpha = lay['A']
    headm = lay['head'] > 0.5
    own0 = own_hair(hm, img8)
    Ai = np.linalg.inv(np.r_[A, [[0, 0, 1]]])
    gx, gy = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    cx_ = Ai[0, 0] * gx + Ai[0, 1] * gy + Ai[0, 2]; cy_ = Ai[1, 0] * gx + Ai[1, 1] * gy + Ai[1, 2]
    neck_col = (np.abs(cx_ - 0.5) < 0.36) & (cy_ > 0.98)
    own0 &= ~neck_col
    face = np.zeros((h, w), np.uint8)
    cv2.fillPoly(face, [L[FACE_OVAL, :2].astype(np.int32)], 1)
    face = face.astype(bool)
    face_area = max(face.sum(), 1)
    # the face below the brows (eyes, brows, nose, mouth) is never a fill target; the forehead
    # above them may be (a real fringe the new style does not cover becomes forehead skin)
    b0, b1 = L[105, :2], L[334, :2]
    up = 0.06 * np.linalg.norm(L[10, :2] - L[152, :2])
    nrm = np.array([-(b1 - b0)[1], (b1 - b0)[0]]); nrm /= max(np.linalg.norm(nrm), 1e-6)
    if nrm @ (L[152, :2] - b0) < 0:
        nrm = -nrm
    features = face & (((gx - b0[0]) * nrm[0] + (gy - b0[1]) * nrm[1]) > -up)
    own = cv2.dilate(own0.astype(np.uint8), disk(0.03 * hu)).astype(bool)
    near = cv2.dilate(own0.astype(np.uint8), disk(0.06 * hu)).astype(bool) | (hm > 0.02)
    cover = alpha > 0.999
    # how far the own hair reaches out from the head: short (hugging) or big
    dist = cv2.distanceTransform((~headm).astype(np.uint8), cv2.DIST_L2, 5) / hu
    out_d = dist[own0 & ~headm]
    thick = float(np.percentile(out_d, 95)) if out_d.size > 20 else 0.0
    # big own hair outside the new style: the tie-back hint (then nothing is hidden, kept or
    # recoloured: the app asks the user to tie it back)
    style_zone = cv2.dilate(((alpha > 0.3) | headm).astype(np.uint8), disk(0.04 * hu)).astype(bool)
    big_frac = float((own0 & ~style_zone).sum()) / face_area
    # a close camera shows only part of big hair (the 2x tiles: shaggy hair .5 -> .02), so the
    # app decides on frames that show the whole head and keeps the decision (force_hint)
    # ... or an own fringe over the brows that the new style leaves bare: the features zone is
    # never filled, so it would stay as a strip of hair under a filled forehead (a seam)
    fringe = float((own0 & features & (alpha < 0.5)).sum()) / face_area
    hint = ('tie-back' if (big_frac > big_hair or fringe > big_fringe) else '') if force_hint is None else force_hint
    keep_r = 0.18 if (thick < 0.20 and not hint) else 0.0
    zone = cv2.dilate((alpha > 0.4).astype(np.uint8), disk(max(keep_r, 0.01) * hu)).astype(bool) & \
        cv2.dilate(headm.astype(np.uint8), disk(1.5 * max(keep_r, 0.01) * hu)).astype(bool) & \
        ~(face | (headm & (lay['scalp'] < 0.5)))
    keep = own0 & zone & ~cover if keep_r > 0 else np.zeros_like(own0)
    if keep.any():
        keep_ring = cv2.dilate(keep.astype(np.uint8), disk(0.05 * hu)).astype(bool) & ~face
        remove = own & ~cover & ~keep_ring
    else:
        remove = own & ~cover
    remove &= ~features                                     # eyes, brows, nose, mouth: never touched
    if hint:
        # nothing is hidden: patching big hair inside the head alone leaves flat skin blocks
        # with own hair all around them (QA: shaggy hair at 2x); the app shows the new style
        # over the user's hair with the "tie your hair back" message instead
        return img_lin.astype(np.float32), dict(hint=hint, big_hair=round(big_frac, 3), fringe=round(fringe, 3), unfilled=0.0, removed=0,
                                                kept=0, own_thickness=round(thick, 3))
    outside = remove & ~headm
    # sources for the outside fill: background only, not the face, head, own hair or the body
    body = cv2.dilate((lay['body'] > 0.3).astype(np.uint8), disk(0.04 * hu)).astype(bool)
    shoulder_y = A @ np.array([0.5, 1.30, 1.0])
    below = gy > shoulder_y[1]
    known_bg = ~near & ~face & ~headm & ~own & ~body & ~below
    filled, ok1 = fill_from(img_lin, outside & ~below, known_bg)
    ctr = A @ np.array([0.5, 0.42, 1.0])
    rf, rok = radial_fill(img_lin, outside & ~below, known_bg, ctr, max_gap=0.5 * hu)
    filled = np.where((outside & ~below & rok)[..., None], rf, filled)
    # the clothes / body below the shoulders fill from the clothes
    known_body = ~near & ~face & ~headm & ~own & below
    fb, ok2 = fill_from(img_lin, outside & below, known_body)
    filled = np.where((outside & below)[..., None], fb, filled)
    inside, ok3 = fill_from(img_lin, remove & headm, face & ~remove & (hm < 0.08))
    unfilled = remove & ~(np.where(headm, ok3, np.where(below, ok2, ok1)))
    remove &= ~unfilled
    fill = np.where(headm[..., None], inside, filled)
    soft = cv2.GaussianBlur(remove.astype(np.float32), (0, 0), 1.2)
    # on the face (a removed fringe) a wider feather: the flat skin fill fades into the real
    # forehead instead of meeting it at a line
    soft = np.maximum(soft, 2 * cv2.GaussianBlur(remove.astype(np.float32), (0, 0), max(1.2, 0.012 * hu)) * face)
    soft = np.clip(np.maximum(soft, remove.astype(np.float32)), 0, 1)[..., None]
    rng0 = np.random.default_rng(seed + 2)
    g = rng0.normal(0, photo_noise(img_srgb) * 0.6, (h, w, 1))
    fill = np.clip(fill * (1 + 2 * g), 0, None)
    base = img_lin * (1 - soft) + fill * soft
    if keep.any():
        # the kept short own hair takes the new colour, keeping its own light and shade
        Y = (img_lin * colour.LUMA).sum(-1)
        ref = np.median(Y[keep])
        body_px = alpha > 0.6
        tgt = np.median(lay['hair'][body_px] / np.maximum(alpha[body_px, None], 1e-3), axis=0) if body_px.any() else \
            colour.srgb_to_lin(colour.hex_rgb(dye) if isinstance(dye, str) else np.asarray(dye)) * light
        rec = tgt[None, None] * (Y / max(ref, 1e-4))[..., None] * 0.9
        ks = cv2.GaussianBlur(keep.astype(np.float32), (0, 0), 0.8)[..., None] * np.clip(hm, 0, 1)[..., None] ** 0.5
        base = base * (1 - ks) + rec * ks
    unf = float(unfilled.sum()) / face_area
    if unf > 0.10 and not hint:
        hint = 'tie-back'                 # own hair left showing: nothing to fill it from
    rep = dict(hint=hint, big_hair=round(big_frac, 3), fringe=round(fringe, 3), unfilled=round(unf, 3), removed=int(remove.sum()),
               kept=int(keep.sum()), own_thickness=round(thick, 3))
    return base.astype(np.float32), rep


# ------------------------------------------------------------------------------- product
def hair_colour_product(img_srgb, L, hm, dye, intensity=100, fade=40):
    """the site's EXISTING hair-colour product on the user's real hair (shaders.js
    LAYER_FRAG pigment mode with app.js stageLayer('hair') settings), for calibrating the
    new hair's colour against it.  sRGB in, sRGB out."""
    col = colour.hex_rgb(dye) if isinstance(dye, str) else np.asarray(dye, np.float64)
    h, w = img_srgb.shape[:2]
    wd = .05 + .3 * fade / 100
    cover = np.clip((hm - (.55 - wd * .6)) / (wd * 1.2), 0, 1)
    cover = cover * cover * (3 - 2 * cover)
    lo = lowres(img_srgb)
    low = cv2.resize(lo, (w, h), interpolation=cv2.INTER_LINEAR)
    # stats: the mean colour under the mask over a 6x6 grid of the mask's box (low-res)
    ys, xs = np.nonzero(cover > 0.01)
    if len(xs) == 0:
        return img_srgb.copy()
    bx0, bx1, by0, by1 = xs.min() / w, (xs.max() + 1) / w, ys.min() / h, (ys.max() + 1) / h
    s = np.zeros(3); wsum = 0.0
    for j in range(6):
        for i in range(6):
            u = bx0 + (bx1 - bx0) * (i + .5) / 6; v = by0 + (by1 - by0) * (j + .5) / 6
            m = float(cover[min(h - 1, int(v * h)), min(w - 1, int(u * w))])
            s += sample_uv(lo, u, v) * m; wsum += m
    mean = s / wsum if wsum > .05 else sample_uv(lo, (bx0 + bx1) / 2, (by0 + by1) / 2)
    light, _ = face_light(img_srgb, L)
    Y = img_srgb @ LUMA601
    Yl = np.maximum(low @ LUMA601, .03)
    Yr = max(float(mean @ LUMA601), .03)
    shade = np.clip(Y / Yr, 0, 2.5)
    glint = np.maximum(Y - Yl, 0)
    amount = intensity / 100
    m = cover * amount
    paint = col[None, None] * light * shade[..., None]
    wash = img_srgb * (col / max(col @ LUMA601, .05))[None, None]
    outc = img_srgb * (1 - m[..., None]) + (paint * (1 - .12) + wash * .12) * m[..., None]
    gloss = .22 * amount
    sm = np.clip((glint - .012) / (.18 - .012), 0, 1); sm = sm * sm * (3 - 2 * sm)
    outc = outc + (gloss * cover * (sm * .55 * light + .045 * shade))[..., None]
    return np.clip(outc, 0, 1).astype(np.float32)
