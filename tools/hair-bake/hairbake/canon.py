"""The canonical head frame ("head units") shared by the bake, the packed files and the runtime.

Head units are the frame of facemesh.js: the front-on view of MediaPipe's canonical face
mesh, x across (image right), y DOWN, z toward the viewer, scaled so the face mesh plus a
3 % margin spans exactly 0..1 in x.  In head units a landmark i sits at

    x = CANON[2i],   y = CANON[2i+1] * CANON_ASPECT,   z = Z_i / UNIT_CM

and MediaPipe's canonical face model (centimetres, Y up, Z toward the camera: the space the
facial transformation matrix maps from) converts as

    x = (X - X0) / UNIT_CM,   y = (Y0 - Y) / UNIT_CM,   z = Z / UNIT_CM

with X0 = -8.2077, Y0 = 8.7264, UNIT_CM = 16.4154 (frame_constants()).  Forehead landmark 10
is at (.5, .028, .273), the chin (152) at (.5, 1.104, .260), the nose tip (1) at
(.5, .600, .455), the face's mid-line at x = .5.  The subject's right eye (33) is on the
image LEFT (x = .229): head units are not mirrored; a mirrored display flips the image, not
this frame.

Placing the frame on a photo (what the runtime does every frame, as the old hair.js did):
an affine least-squares fit of the ANCHORS (20 landmarks that hold still through a smile, a
blink or an open mouth) from head units to image pixels, head_fit().  For a view baked at
yaw v the anchors are first rotated by v (anchors_xy(v)), so each view is placed by the
landmarks as they appear in that view.

Yaw: rotation about the vertical axis through PIVOT; positive yaw turns the face toward +x
(image right).  It is the same sign and value as measure.js pose().yaw, i.e.
asin(-R[2][0]) of the facial transformation matrix (verified on 16 portraits by fitting
rotated canonical faces to detected landmarks; see selftest.py).
"""
import os, re, json, struct, zipfile, functools
import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))

# Landmarks that hold still through a smile, a blink or an open mouth (the old hair.js set).
ANCHORS = [10, 109, 338, 67, 297, 54, 284, 234, 454, 127, 356, 162, 389, 168, 6, 33, 263, 133, 362, 1]
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
             176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]

# Yaw pivot: the vertical axis x = .5, z = PIVOT[2] (roughly through the ear canals, a little
# behind them).  Any consistent pivot gives the same placement because the anchor fit absorbs
# translation; it only decides where a turned view sits inside its sprite frame.
PIVOT = np.array([0.5, 0.0, -0.36])

# MediaPipe's geometry pipeline renders through a perspective camera with this vertical field
# of view; the facial transformation matrix is defined against it.
FOV_DEG = 63.0


@functools.lru_cache(None)
def facemesh_js():
    src = open(os.path.join(REPO, 'facemesh.js')).read()
    A = float(re.search(r'CANON_ASPECT=([\d.]+)', src).group(1))
    c = np.array([float(v) for v in re.search(r'CANON=new Float32Array\(\[([^\]]+)\]', src).group(1).split(',')]).reshape(-1, 2)
    return A, c


def _fields(b):
    o = 0
    def varint():
        nonlocal o
        r = s = 0
        while True:
            c = b[o]; o += 1
            r |= (c & 0x7f) << s; s += 7
            if not c & 0x80:
                return r
    while o < len(b):
        key = varint(); f, t = key >> 3, key & 7
        if t == 0: v = varint()
        elif t == 2:
            n = varint(); v = b[o:o + n]; o += n
        elif t == 5: v = struct.unpack_from('<f', b, o)[0]; o += 4
        elif t == 1: v = struct.unpack_from('<d', b, o)[0]; o += 8
        else: raise ValueError('wire type %d' % t)
        yield f, t, v


@functools.lru_cache(None)
def canonical_model():
    """MediaPipe's canonical face model from vendor/face_landmarker.task: (468, 3) cm (Y up,
    Z toward the camera) and the triangles (as tools/facemesh.cjs reads it)."""
    z = zipfile.ZipFile(os.path.join(REPO, 'vendor', 'face_landmarker.task'))
    meta = z.read('geometry_pipeline_metadata_landmarks.binarypb')
    mesh = next(v for f, t, v in _fields(meta) if f == 1)
    verts, tris = [], []
    for f, t, v in _fields(mesh):
        if f == 3:
            if t == 5: verts.append(v)
            else: verts += list(struct.unpack('<%df' % (len(v) // 4), v))
        if f == 4:
            if t == 0: tris.append(v)
            else:
                o = 0
                while o < len(v):
                    r = s = 0
                    while True:
                        c = v[o]; o += 1; r |= (c & 0x7f) << s; s += 7
                        if not c & 0x80: break
                    tris.append(r)
    V = np.array(verts, np.float64).reshape(-1, 5)[:, :3]
    T = np.array(tris, np.int64).reshape(-1, 3)
    assert len(V) == 468
    return V, T


@functools.lru_cache(None)
def frame_constants():
    """X0, Y0, UNIT_CM: head units = ((X - X0)/U, (Y0 - Y)/U, Z/U)."""
    V, _ = canonical_model()
    X, Yd = V[:, 0], -V[:, 1]
    x0, x1, y0 = X.min(), X.max(), Yd.min()
    margin = .03 * (x1 - x0); w = x1 - x0 + 2 * margin
    return float(x0 - margin), float(-(y0 - margin)), float(w)


def model_to_head(P):
    X0, Y0, U = frame_constants()
    P = np.asarray(P, np.float64)
    return np.stack([(P[..., 0] - X0) / U, (Y0 - P[..., 1]) / U, P[..., 2] / U], -1)


def head_to_model(P):
    X0, Y0, U = frame_constants()
    P = np.asarray(P, np.float64)
    return np.stack([P[..., 0] * U + X0, Y0 - P[..., 1] * U, P[..., 2] * U], -1)


@functools.lru_cache(None)
def face_mesh():
    """the canonical face mesh in head units: (468, 3), triangles (898, 3)."""
    V, T = canonical_model()
    H = model_to_head(V)
    A, c = facemesh_js()
    err = np.abs(H[:, :2] - np.c_[c[:, 0], c[:, 1] * A]).max()
    assert err < 2e-4, f'facemesh.js and the .task disagree ({err})'
    return H, T


def canon2d():
    """CANON of facemesh.js as (468, 2) head units."""
    A, c = facemesh_js()
    return np.c_[c[:, 0], c[:, 1] * A]


ASPECT = facemesh_js()[0]


# ------------------------------------------------------------------------------- yaw
def yaw_matrix(deg):
    """rotation about the vertical (y) axis; +deg moves the front (+z) toward +x."""
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rotate_yaw(P, deg, pivot=PIVOT):
    """points (..., 3) in head units turned by deg about the vertical axis through pivot."""
    P = np.asarray(P)
    if deg == 0:
        return P
    R = yaw_matrix(deg)
    dt = P.dtype if P.dtype.kind == 'f' else np.float64
    return ((P - pivot) @ R.T + pivot).astype(dt)


def anchors_xy(yaw=0.0):
    """(20, 2) head-unit x, y of the ANCHORS in the view baked at this yaw."""
    H, _ = face_mesh()
    return rotate_yaw(H[ANCHORS], yaw)[:, :2]


# ------------------------------------------------------------------------------- photos
def matrix4(data):
    """MediaPipe's facialTransformationMatrixes[0].data (16 numbers, column-major as the
    tasks API packs it; detected like measure.js does) -> 4x4 row-major M with
    camera = M @ [X, Y, Z, 1] for canonical-model cm."""
    m = np.asarray(data, np.float64).ravel()
    col_major = abs(m[12]) + abs(m[13]) + abs(m[14]) >= abs(m[3]) + abs(m[7]) + abs(m[11])
    return m.reshape(4, 4).T if col_major else m.reshape(4, 4)


def pose(M):
    """(yaw, pitch, roll) degrees exactly as measure.js pose(): yaw = asin(-R20),
    pitch = atan2(R21, R22), roll = atan2(R10, R00).  yaw is the view yaw of this frame."""
    yaw = np.degrees(np.arcsin(np.clip(-M[2, 0], -1, 1)))
    pitch = np.degrees(np.arctan2(M[2, 1], M[2, 2]))
    roll = np.degrees(np.arctan2(M[1, 0], M[0, 0]))
    return float(yaw), float(pitch), float(roll)


def load_detection(path):
    """a detect.cjs result -> dict(L=(478, 3) landmarks in pixels (z scaled by width as
    MediaPipe does), M=4x4 or None, w, h, yaw/pitch/roll, hair=path of the hair mask)."""
    d = json.load(open(path))
    if not d.get('landmarks'):
        return None
    w, h = d['w'], d['h']
    L = np.array([[p['x'] * w, p['y'] * h, p['z'] * w] for p in d['landmarks']])
    M = matrix4(d['matrix']) if d.get('matrix') else None
    out = dict(L=L, M=M, w=w, h=h, hair=path[:-5] + '.hair.png', mw=d.get('mw'), mh=d.get('mh'))
    out['yaw'], out['pitch'], out['roll'] = pose(M) if M is not None else (0.0, 0.0, 0.0)
    return out


def head_fit(L, yaw=0.0):
    """least-squares affine from head units of the view at `yaw` to image pixels, by the
    ANCHORS (as hair.js headFit for yaw 0).  Returns A (2, 3): px = A @ [x, y, 1]."""
    q = anchors_xy(yaw)
    p = np.asarray(L)[ANCHORS, :2]
    X = np.c_[q, np.ones(len(q))]
    sol, *_ = np.linalg.lstsq(X, p, rcond=None)
    return sol.T


def apply_fit(A, x, y):
    return A[0, 0] * x + A[0, 1] * y + A[0, 2], A[1, 0] * x + A[1, 1] * y + A[1, 2]


def project(M, P, w, h, fov=FOV_DEG):
    """head-unit points (..., 3) through the facial transformation matrix and MediaPipe's
    perspective camera to image pixels (..., 2) and camera depth (...)."""
    Q = head_to_model(P)
    sh = Q.shape[:-1]
    Q = Q.reshape(-1, 3)
    C = (M @ np.c_[Q, np.ones(len(Q))].T).T[:, :3]
    f = 1 / np.tan(np.radians(fov) / 2)
    xn = f * C[:, 0] / -C[:, 2] * (h / w); yn = f * C[:, 1] / -C[:, 2]
    px = np.stack([(xn + 1) / 2 * w, (1 - yn) / 2 * h], -1)
    return px.reshape(sh + (2,)), -C[:, 2].reshape(sh)
