"""Containers for a groomed head of hair, the per-strand appearance attributes the shader
reads, and the style-module loader.

A style is a Python module styles/<id>.py with

    STYLE = dict(id='w-long-layers', name='<Persian name>', group='women')   # 'women' / 'men'
    def build(rng, q=1.0, log=print) -> Hair

build() grooms the hair from the shared library (hairbake.groom) with the numpy Generator
`rng` (the bake passes a fixed seed, so a bake is reproducible) and the quality factor q:
strand counts scale with q (1.0 for the bake, ~.25 for quick previews) and default strand
widths scale with 1/sqrt(q), so coverage looks the same at any q.

Hair holds Strands groups (each with its own vertex count) and the Scalp; merged() gives
the single (N, m, 3) array + attribute dict the renderer consumes.

Per-strand attributes (Strands.attrs; defaults filled by Hair.finish / merged):
  kind      KIND code (main, fringe, flyaway, stray, baby, short, wrap): the renderer may
            treat kinds differently (e.g. flyaways cast less shadow).
  width_u   fibre width in head units (default .00085 x kind factor / sqrt(q)).
  opacity   0..1 (default by kind: main .9, fringe .85, flyaway .65, stray .5, baby .45).
  albedo    brightness multiplier (lock-correlated log-normal variation: darker and lighter
            locks are what makes a head of hair look real).
  tone      0..1: which of the runtime's two dye tones a strand takes (lowlights /
            highlights); lock-correlated.
  spec1_j, spec2_j, shift_j   per-strand jitter of the two specular lobes and their shift.
  clump     lock id (for correlated variation).
Per-vertex attributes ((n, m) or (1, m)):
  tone_t    added to tone along the strand (default: darker roots, lighter ends on long
            hair - sun-lightened lengths).
  albedo_t  brightness along the strand.
  width_t, opac_t   multipliers along the strand (the renderer also tapers the tips).
"""
import importlib.util, os, sys, types
import numpy as np
from .head import smoothstep
from .strands import resample, resample_attr, lengths

KIND = dict(main=0, fringe=1, flyaway=2, stray=3, baby=4, short=5, wrap=6)
KIND_WIDTH = {0: 1.0, 1: 1.0, 2: 0.6, 3: 0.55, 4: 0.45, 5: 1.0, 6: 1.0}
KIND_OPACITY = {0: 0.9, 1: 0.85, 2: 0.65, 3: 0.5, 4: 0.45, 5: 0.9, 6: 0.95}
BASE_WIDTH = 0.00085            # head units at q = 1 (~100k main strands): ~.14 mm, wider than a real
                                # fibre (.07 mm) because there are fewer strands than real hairs
PER_STRAND = ('kind', 'width_u', 'opacity', 'albedo', 'tone', 'spec1_j', 'spec2_j', 'shift_j', 'clump')
PER_VERTEX = ('tone_t', 'albedo_t', 'width_t', 'opac_t')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # tools/hair-bake


class Strands:
    """a group of strands with the same vertex count: P (n, m, 3) and attributes.
    kind: a KIND name or code; clump: lock id per strand (for correlated colour/specular
    variation; default: every strand its own); any attribute of the module docstring
    may be given as a keyword (scalar, (n,), or per-vertex (n, m) / (1, m))."""
    def __init__(self, P, kind='main', clump=None, rooted=None, **attrs):
        self.P = np.ascontiguousarray(P, np.float32)
        assert self.P.ndim == 3 and self.P.shape[2] == 3, self.P.shape
        k = KIND[kind] if isinstance(kind, str) else int(kind)
        # rooted = False for strands that do not start on the scalp (a ponytail's tail, a bun's
        # coil, a wrap, broken strays lying on the hair): checks skip their roots
        self.rooted = (k not in (KIND['stray'], KIND['wrap'])) if rooted is None else bool(rooted)
        self.attrs = {}
        self.attrs['kind'] = np.full(self.n, k, np.int32)
        if clump is not None:
            self.attrs['clump'] = np.asarray(clump)
        self.set(**attrs)

    @property
    def n(self): return self.P.shape[0]

    @property
    def m(self): return self.P.shape[1]

    def set(self, **attrs):
        for k, v in attrs.items():
            if v is None:
                continue
            v = np.asarray(v)
            if k in PER_VERTEX:
                v = np.broadcast_to(v.astype(np.float32), (v.shape[0] if v.ndim == 2 else 1, self.m)) if v.ndim >= 1 else np.full((1, self.m), float(v), np.float32)
                if v.shape[0] not in (1, self.n):
                    raise ValueError(f'{k}: {v.shape} for {self.n} strands')
            else:
                v = np.broadcast_to(v, (self.n,)).copy()
            self.attrs[k] = v
        return self

    def take(self, sel):
        out = Strands.__new__(Strands)
        out.rooted = self.rooted
        out.P = self.P[sel]
        out.attrs = {k: (v[sel] if (k not in PER_VERTEX or v.shape[0] == self.n) else v) for k, v in self.attrs.items()}
        return out

    def resampled(self, m):
        if m == self.m:
            return self
        out = Strands.__new__(Strands)
        out.rooted = self.rooted
        out.P = resample(self.P, m)
        out.attrs = {k: (resample_attr(v, m) if k in PER_VERTEX else v) for k, v in self.attrs.items()}
        return out

    def __repr__(self):
        return f'Strands({self.n} x {self.m}, kind {np.unique(self.attrs["kind"]).tolist()})'


class Hair:
    """a groomed head of hair: the scalp it grows from, the strand groups, metadata.
    q is the build quality (strand-count factor) used for default widths."""
    def __init__(self, scalp, q=1.0, name=''):
        self.scalp = scalp
        self.q = float(q)
        self.name = name
        self.groups = []
        self.meta = {}

    def add(self, strands, **attrs):
        if not isinstance(strands, Strands):
            strands = Strands(strands, **attrs)
        elif attrs:
            strands.set(**attrs)
        if strands.n:
            self.groups.append(strands)
        return strands

    @property
    def n(self):
        return sum(g.n for g in self.groups)

    def finish(self, rng, look=None):
        """fill unset attributes with defaults (see the module docstring); look (dict)
        overrides the default variation amounts:
            albedo_lock .27, albedo_strand .22, tone_lock .16, tone_strand .14,
            spec_lock (.65, 1.35), tone_root -.10, tone_end .16, end_len .6"""
        lk = dict(albedo_lock=0.27, albedo_strand=0.22, tone_lock=0.16, tone_strand=0.14, spec_lock=(0.65, 1.35),
                  tone_root=-0.10, tone_end=0.16, end_len=0.6, shift_lock=0.03)
        lk.update(look or {})
        NL = 16384
        lock_alb = np.exp(rng.normal(0, lk['albedo_lock'], NL))
        lock_spec = rng.uniform(lk['spec_lock'][0], lk['spec_lock'][1], NL)
        lock_shift = rng.normal(0, lk['shift_lock'], NL)
        lock_tone = rng.normal(0, lk['tone_lock'], NL)
        wq = BASE_WIDTH / np.sqrt(max(self.q, 1e-3))
        for g in self.groups:
            a = g.attrs
            n, m = g.n, g.m
            kind = a['kind']
            if 'clump' not in a:
                a['clump'] = rng.integers(0, 1 << 30, n)
            ci = (np.asarray(a['clump']).astype(np.int64) * 2654435761 % NL).astype(np.int64)
            if 'width_u' not in a:
                a['width_u'] = (wq * np.vectorize(KIND_WIDTH.get)(kind) * rng.uniform(0.7, 1.3, n)).astype(np.float32)
            if 'opacity' not in a:
                a['opacity'] = np.vectorize(KIND_OPACITY.get)(kind).astype(np.float32)
            if 'albedo' not in a:
                a['albedo'] = (np.exp(rng.normal(0, lk['albedo_strand'], n)) * lock_alb[ci]).astype(np.float32)
            if 'spec1_j' not in a:
                a['spec1_j'] = (np.exp(rng.normal(-0.08, 0.38, n)) * lock_spec[ci]).astype(np.float32)
            if 'spec2_j' not in a:
                a['spec2_j'] = (np.exp(rng.normal(-0.05, 0.25, n)) * lock_spec[ci]).astype(np.float32)
            if 'shift_j' not in a:
                a['shift_j'] = (rng.normal(0, 0.015, n) + lock_shift[ci]).astype(np.float32)
            if 'tone' not in a:
                a['tone'] = np.clip(0.45 + lock_tone[ci] + rng.normal(0, lk['tone_strand'], n), 0, 1).astype(np.float32)
            t = np.linspace(0, 1, m)[None, :]
            L = lengths(g.P)[:, None]
            long_ = np.clip(L / lk['end_len'], 0, 1)
            if 'tone_t' not in a:
                a['tone_t'] = (lk['tone_root'] * smoothstep(0.25, 0.0, t) * np.clip(L / 0.15, 0, 1)
                               + lk['tone_end'] * smoothstep(0.45, 1.0, t) * long_).astype(np.float32)
            if 'albedo_t' not in a:
                a['albedo_t'] = (0.92 + 0.08 * smoothstep(0.0, 0.15, t) + 0.10 * smoothstep(0.5, 1.0, t) * long_).astype(np.float32)
        return self

    def merged(self, m=None, rng=None):
        """all groups resampled to m vertices (default: the largest m) and concatenated:
        S (N, m, 3) float32 and attrs {name: (N,) or (N, m)}."""
        if any(k not in g.attrs for g in self.groups for k in PER_STRAND):
            self.finish(rng or np.random.default_rng(12345))
        m = m or max(g.m for g in self.groups)
        gs = [g.resampled(m) for g in self.groups]
        S = np.concatenate([g.P for g in gs], 0)
        attrs = {}
        for k in PER_STRAND:
            attrs[k] = np.concatenate([g.attrs[k] for g in gs])
        for k in PER_VERTEX:
            if any(k in g.attrs for g in gs):
                attrs[k] = np.concatenate([np.broadcast_to(g.attrs.get(k, np.ones((1, m), np.float32) if k != 'tone_t' else np.zeros((1, m), np.float32)), (g.n, m)) for g in gs]).astype(np.float32)
        return S, attrs

    def bounds(self, yaws=(-30, 0, 30), margin=0.03):
        """front-view x0, y0, x1, y1 (head units) covering the hair in all these views."""
        from .canon import rotate_yaw
        lo = np.array([np.inf, np.inf]); hi = -lo
        for g in self.groups:
            P = g.P[:, ::max(1, g.m // 16)].reshape(-1, 3)
            for y in yaws:
                Q = rotate_yaw(P, y)[:, :2]
                lo = np.minimum(lo, Q.min(0)); hi = np.maximum(hi, Q.max(0))
        return (lo[0] - margin, lo[1] - margin, hi[0] + margin, hi[1] + margin)

    def check(self, tol=0.004):
        """numeric sanity of the groom: dict of measurements and a list of failures.
          - no NaN / inf; every strand longer than 0
          - rooted groups: roots on the body surface (|sdf| < .012) where the scalp grows
            hair (density > 0), never on the ears
          - vertices inside the body (sdf < -tol), excluding roots: < 0.5 %
          - the part line (if any) is clear: < 2 % of the roots that would sit on it"""
        from .head import body_sdf
        from .scalp import ear_mask
        sdf = body_sdf()
        fails, stats = [], {}
        allP = [g.P for g in self.groups]
        bad = sum(int((~np.isfinite(P)).sum()) for P in allP)
        stats['nonfinite'] = bad
        if bad:
            fails.append(f'{bad} non-finite coordinates')
        zero = sum(int((lengths(g.P) <= 1e-6).sum()) for g in self.groups)
        stats['zero_length'] = zero
        if zero:
            fails.append(f'{zero} zero-length strands')
        R = np.concatenate([g.P[:, 0] for g in self.groups if g.rooted]) if any(g.rooted for g in self.groups) else np.zeros((0, 3))
        if len(R):
            d = sdf(R.astype(np.float64))
            dens = self.scalp.density(R)
            # roots in the hairline's soft edge can be at density ~ .2; a root on bare skin has 0
            off = (np.abs(d) > 0.012).mean(); bare = (dens <= 0).mean(); ears = ear_mask(R).mean()
            stats.update(root_off_surface=float(off), root_on_bare_skin=float(bare), root_on_ears=float(ears))
            if off > 0.01: fails.append(f'{off:.1%} of roots off the scalp surface')
            if bare > 0.01: fails.append(f'{bare:.1%} of roots outside the hair area')
            if ears > 0: fails.append(f'{ears:.1%} of roots on the ears')
            if self.scalp.parting is not None:
                on_part = self.scalp.parting.mask(R) > 0.9
                stats['roots_on_part'] = float(on_part.mean())
        inside = 0; total = 0
        for g in self.groups:
            Q = g.P[:, 1:].reshape(-1, 3)
            if len(Q) > 400000:
                Q = Q[np.random.default_rng(0).choice(len(Q), 400000, replace=False)]
            inside += int((sdf(Q.astype(np.float64)) < -tol).sum()); total += len(Q)
        stats['inside_body'] = inside / max(total, 1)
        if stats['inside_body'] > 0.005:
            fails.append(f"{stats['inside_body']:.2%} of vertices inside the body")
        return stats, fails

    def summary(self):
        lines = [f'Hair {self.name!r}: {self.n} strands in {len(self.groups)} groups (q {self.q:g})']
        for g in self.groups:
            L = lengths(g.P)
            lines.append(f'  {g!r}  length {np.percentile(L, 5):.3f}..{np.percentile(L, 95):.3f}')
        return '\n'.join(lines)


# ------------------------------------------------------------------------------- styles
def load_style(name):
    """a style module by id (styles/<id>.py), by path, or 'demo:<name>' (hairbake/demos.py).
    The module must define STYLE (dict with id, name, group) and build(rng, q, log)."""
    if name.startswith('demo:'):
        from . import demos
        key = name[5:]
        if key not in demos.DEMOS:
            raise KeyError(f'no demo {key!r}; have {sorted(demos.DEMOS)}')
        return types.SimpleNamespace(STYLE=dict(id=name, name=key, group='demo'), build=demos.DEMOS[key])
    path = name if (os.path.sep in name or name.endswith('.py')) else os.path.join(ROOT, 'styles', name + '.py')
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    modname = 'hairstyle_' + os.path.basename(path)[:-3].replace('-', '_')
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[modname] = mod
    spec.loader.exec_module(mod)
    for k in ('STYLE', 'build'):
        if not hasattr(mod, k):
            raise AttributeError(f'{path} has no {k}')
    return mod
