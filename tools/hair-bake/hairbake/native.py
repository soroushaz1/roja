"""ctypes bindings to raster.c, compiled on first use into tools/hair-bake/build/.

The shared library's name carries a hash of the source and the compiler flags, so an edited
raster.c is rebuilt automatically, and several bakes running in parallel never load a
half-written file (each compiles to a temporary name and renames it into place).  No
-march=native: the container may come back on another CPU after a restart.

Conventions shared by every function: float32 buffers, row-major, pixel centres at integer
+ 0.5, z grows toward the viewer (a larger z is in front).
"""
import ctypes, hashlib, os, subprocess, tempfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                     # tools/hair-bake
BUILD = os.path.join(ROOT, 'build')
SRC = os.path.join(HERE, 'raster.c')
CFLAGS = ['-O3', '-ffast-math', '-shared', '-fPIC']


def _lib():
    os.makedirs(BUILD, exist_ok=True)
    h = hashlib.sha1(open(SRC, 'rb').read() + ' '.join(CFLAGS).encode()).hexdigest()[:10]
    so = os.path.join(BUILD, f'libraster-{h}.so')
    if not os.path.exists(so):
        fd, tmp = tempfile.mkstemp(suffix='.so', dir=BUILD)
        os.close(fd)
        subprocess.check_call(['gcc', *CFLAGS, SRC, '-o', tmp, '-lm'])
        os.replace(tmp, so)
    return ctypes.CDLL(so)


_L = _lib()
_fp = ctypes.POINTER(ctypes.c_float)
_L.raster.argtypes = [ctypes.c_int, _fp, ctypes.c_int, ctypes.c_int, ctypes.c_int, _fp, _fp, ctypes.c_float, ctypes.c_float]
_L.set_soft.argtypes = [_fp, _fp]
_L.tri_zbuf.argtypes = [ctypes.c_int, _fp, _fp, ctypes.c_int, ctypes.c_int, ctypes.c_int, _fp, _fp]
_L.splat3d.argtypes = [ctypes.c_int, _fp, _fp, ctypes.c_int, ctypes.c_int, ctypes.c_int, _fp]
_L.zmax.argtypes = [ctypes.c_int, _fp, _fp, _fp, ctypes.c_int, ctypes.c_int, _fp]


def _p(a):
    return a.ctypes.data_as(_fp) if a is not None else None


def raster(seg, W, H, zocc=None, zbias=0.01, step=0.35, zsoft=None, asoft=None, out=None):
    """Strand segments -> premultiplied image.

    seg: (n, 2, 5+C) float32, per segment end: x px, y px, z (head units, larger = nearer),
         width px, opacity, then C <= 64 shading channels; sorted BACK TO FRONT.
    zocc: (H, W) occluder depth; a deposit with z < zocc - zbias is hidden.
    zsoft, asoft: optional soft occluder: behind zsoft a deposit is scaled by (1 - asoft).
    out: an existing (H, W, 1+C) float32 accumulator to composite OVER (to rasterise a long
         back-to-front list in several chunks, each chunk sorted and behind the next).
    Returns (H, W, 1+C): alpha, then the channels premultiplied by alpha."""
    seg = np.ascontiguousarray(seg, np.float32)
    C = seg.shape[2] - 5
    assert 0 <= C <= 64, 'at most 64 channels'
    if zsoft is not None:
        zsoft = np.ascontiguousarray(zsoft, np.float32); asoft = np.ascontiguousarray(asoft, np.float32)
        assert zsoft.shape == (H, W) and asoft.shape == (H, W)
        _L.set_soft(_p(zsoft), _p(asoft))
    else:
        _L.set_soft(None, None)
    if out is None:
        out = np.zeros((H, W, 1 + C), np.float32)
    else:
        assert out.shape == (H, W, 1 + C) and out.dtype == np.float32 and out.flags.c_contiguous
    if zocc is not None:
        zocc = np.ascontiguousarray(zocc, np.float32)
        assert zocc.shape == (H, W)
    try:
        _L.raster(seg.shape[0], _p(seg), C, W, H, _p(out), _p(zocc), zbias, step)
    finally:
        _L.set_soft(None, None)
    return out


def tri_zbuf(P, W, H, attrs=None, zbuf=None, attr_out=None):
    """P: (ntri, 3, 3) x px, y px, z.  attrs: (ntri, 3, na) per-corner attributes or None.
    Returns zbuf (H, W) (-1e9 where empty; the largest z wins) and the attribute image
    (H, W, na) of the front-most triangle (barycentric interpolation), or None."""
    P = np.ascontiguousarray(P, np.float32)
    if zbuf is None:
        zbuf = np.full((H, W), -1e9, np.float32)
    na = 0; A = None
    if attrs is not None:
        A = np.ascontiguousarray(attrs, np.float32); na = A.shape[2]
        if attr_out is None:
            attr_out = np.zeros((H, W, na), np.float32)
    _L.tri_zbuf(len(P), _p(P), _p(A), na, W, H, _p(zbuf), _p(attr_out) if attrs is not None else None)
    return zbuf, attr_out


def splat3d(pts, mass, shape):
    """trilinear splat of point masses at grid coordinates pts (n, 3) = (x, y, z) into a
    grid of shape (NX, NY, NZ); returns the array indexed [z][y][x]."""
    pts = np.ascontiguousarray(pts, np.float32); mass = np.ascontiguousarray(mass, np.float32)
    NX, NY, NZ = shape
    grid = np.zeros((NZ, NY, NX), np.float32)
    _L.splat3d(pts.shape[0], _p(pts), _p(mass), NX, NY, NZ, _p(grid))
    return grid


def zmax(px, py, pz, W, H):
    """front-most z per pixel of points (pixel = floor of px, py); -9 where empty."""
    px = np.ascontiguousarray(px, np.float32).ravel(); py = np.ascontiguousarray(py, np.float32).ravel()
    pz = np.ascontiguousarray(pz, np.float32).ravel()
    zb = np.full((H, W), -9.0, np.float32)
    _L.zmax(len(px), _p(px), _p(py), _p(pz), W, H, _p(zb))
    return zb
