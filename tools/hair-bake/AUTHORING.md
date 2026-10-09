# Authoring a hairstyle

This is the guide for writing a new style module, `tools/hair-bake/styles/<id>.py`, for Roja's
live hairstyle try-on: how to groom it, bake it into `hairstyles/<id>/`, check it, and know
when it is good enough. `FORMAT.md` describes the files the bake writes and how the site draws
them. `hairbake/__init__.py` maps the library.

Several people author styles in parallel. **Do not edit the shared library** (`hairbake/*.py`,
`raster.c`).

* The groom and view caches of every style hash the library sources, so an edit there
  invalidates every author's caches and can change styles that were already approved.
* Everything a style needs is a parameter, a callable or your own numpy in the style module.
* If something is truly missing, ask the library owner (the lead) and say what you need.

Contents
1. Quick start
2. The pipeline and what you control
3. Coordinates and units
4. The style module contract
5. The library: primitives and the parameters that matter
6. Recipes by family
7. Renderer and light settings (`RENDER`, `LIGHT`)
8. Baking, QA and looking at the results
9. Gotchas
10. Quality checklist

---------------------------------------------------------------------------------------------

## 1. Quick start

All commands run from `tools/hair-bake/`.

```
cd tools/hair-bake
cp <this file's template, section 4> styles/w-my-style.py       # or start from a shipped style

python3 -m hairbake.preview w-my-style --q .25                  # shape, ~15 s: build/preview/w-my-style_brown.png
python3 -m hairbake.preview w-my-style --q .25 --scalp --views=0,top    # hairline and part line
python3 -m hairbake.bake w-my-style --q .5 --out build/drafts   # draft bake, ~1 min, ~1 GB
python3 qa.py w-my-style --styles-dir build/drafts --only pexels_piacquadio_f_long,pd_obama2_m_short --turntable
python3 -m hairbake.bake w-my-style                             # final: q 1 -> ../../hairstyles/w-my-style/
python3 qa.py w-my-style --set all --shades dark-brown,light-blonde --palette --turntable
python3 qa.py w-my-style --selfcheck
```

Then look at every image the bake and QA wrote (section 8) and go through the checklist in
section 10.

The two shipped styles are the worked examples. `styles/w-long-layers.py` is long layers with
curtain bangs. `styles/m-textured-crop.py` is a men's textured crop with a taper. The demos in
`hairbake/demos.py` (long, sleek, locks, waves, bob, crop, sidepart, buzz, curls, pony, bun)
show every primitive family in a few lines each:

* `python3 -m hairbake.preview demo:bob` previews one demo.
* `python3 -m hairbake.groomtest --no-sheet` checks all of them. All 11 pass.

---------------------------------------------------------------------------------------------

## 2. The pipeline and what you control

```
styles/<id>.py  build(rng, q)  ->  Hair (strands + per-strand look)      YOU: the groom and the look
     |  bake.py
     v
groom check (Hair.check) -> sprite frame -> shading (shade.py)            YOU: RENDER / LIGHT hints
  -> 3 views at yaw -30 / 0 / +30 (render.py) -> exposure -> pack (pack.py)
     v
hairstyles/<id>/ style.json + 12 lossless WebP (~300-700 KB)
     |  runtime (runtime.py = the site's reference)
     v
placed by landmarks, views cross-faded by head yaw, recoloured to any of the 16 HAIR shades
```

* **You write the groom**: 3D strands in head units (about 100 000 at `q = 1`) and their
  per-strand look (lock-correlated brightness, tone, highlight jitter).
* **You do not pick a colour.** The bake stores neutral light; the shade is applied at
  runtime. Your groom must look right in black, dark brown and light blonde.
* Exposure is normalised: the front view's median diffuse over the solid hair becomes 0.6.
  Making all strands darker or lighter changes nothing. Relative variation (darker roots,
  lighter ends, lowlights) is what shows.
* The bake renders against a proxy head-and-shoulders (the CC0 MakeHuman base mesh warped to
  MediaPipe's canonical face). Hair behind the head, neck or torso is removed per view.

---------------------------------------------------------------------------------------------

## 3. Coordinates and units

**Head units**: the `facemesh.js` CANON frame (FORMAT.md section 2).

* x runs across the face toward image right; the face mid-line is `x = .5`.
* y runs **down**; the top of the forehead (landmark 10) is at y .028 and the chin (152) at
  y 1.104.
* z points **toward the camera**; the nose tip is at z .455 and the back of the head at about
  -.85.
* `g.CM = 0.0609` (1 cm) and `g.MM`. One head unit is 16.4 cm.

The image is not mirrored: the subject's right eye is at image left.

| place on the proxy | head units |
|---|---|
| skull top | y -0.35 |
| women's front hairline (centre) | y ~ -.045 |
| brows | y ~ .22; eyes y ~ .37 |
| ears | \|x - .5\| > .47, y .25 .. .64, z -.48 .. -.08 (never grow hair: `ear_mask`) |
| chin / jaw line | y ~ 1.10 |
| nape hairline | y ~ .97 |
| shoulders | y ~ 1.4 |
| `layered_cut` default length (past the shoulders) | y 2.12 |
| crown whorl | `g.crown()` (back of the top, elevation 58 deg) |

On the scalp, `azimuth` is 0 at the front, ±pi/2 at the sides (+ toward image right) and pi at
the back. `elevation` is about 0 at eye level and pi/2 at the top. A `Roots` record carries
these per root as `phi` and `elev`, plus `dist` (how far inside the hairline), `side` (which
side of the part, -1 or +1) and `pd` (distance to the part line).

Lengths: shoulder-length hair is about 1.4-1.6 from the crown, and mid-back about 2.6.

Yaw follows the site's `measure.js pose().yaw`. +30 is the face turned toward image right.

---------------------------------------------------------------------------------------------

## 4. The style module contract

```python
"""w-example-bob: a chin-length bob with a soft, brow-skimming fringe (the AUTHORING.md template).

Recipe: (write down what each section does and why: the next author reads it)
"""
import numpy as np
from hairbake import groom as g

STYLE = dict(id='w-example-bob', name='باب با چتری', group='women')   # id = file name; name in Persian
RENDER = dict(res=300, max_hair_px=140000, spec=0.85)                 # optional (section 7)
# LIGHT = dict(...)                                                   # optional (section 7)


def build(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women', jitter=0.008),
                    g.Parting(0.5, width=0.0035, z_front=0.16),      # the part starts behind the fringe
                    soft=0.035, edge=0.22)
    sec = g.fringe_section(scalp, half_width=0.30, depth=0.16)
    hair = g.Hair(scalp, q, STYLE['id'])
    out = g.long_hair(scalp, rng, q, n=80000, n_guides=2400, length=1.6, nv=70, nv_out=50,
                      accept=lambda P, N: ~sec(P, N), volume=(0.05, 0.06), crown_lift=0.03, asym=0.12,
                      shoulders=False, drape=False,
                      cut=lambda r, rng, lock: g.layered_cut(r, rng, lock, length_y=1.08, back_extra=-0.12,
                                                             centre_shorter=0.0, frame=False, jitter=(0.025, 0.012)),
                      ends=dict(amount=0.035, under=0.95, start=0.7), log=log)
    S = out['strands']
    hair.add(S)
    # a broken, point-cut edge: pieces of their own length, tapered locks (no bowl line)
    fr, _ = g.fringe(scalp, rng, int(9000 * q), sec, end_y=0.20, arch=0.06, locks=(28, 110),
                     edge=dict(wave=0.018, piece=0.024, lock=0.012, strand=0.006, point=0.45, point_depth=0.10))
    hair.add(fr)
    hair.add(g.flyaways(S.P, rng, 0.006), kind='flyaway')
    hair.add(g.baby_hairs(scalp, rng, max(8, int(0.004 * S.n))))
    return hair.finish(rng, look=dict(tone_root=-0.15))
```

This template was run through preview, a `q = .35` bake and QA while this guide was written. It
is a **starting point, not a finished style**: its fringe still reads fairly blunt.

Rules:

* `STYLE = dict(id, name, group)`.
  * `id` equals the file name and the output directory. Start it with `w-` for women or `m-`
    for men.
  * `name` is the Persian display name.
  * `group` is `'women'` or `'men'`; QA uses it to pick portraits.
* `build(rng, q=1.0, log=print)` returns a `Hair`, normally `hair.finish(rng, look=...)`.
* **Only use `rng`** (a `numpy.random.Generator` the bake seeds). Never use `np.random.*`
  globals, time or hashing of object ids. Bakes are deterministic: the same seed gives
  byte-identical files.
* **Scale counts with `q`**: `int(n * q)`, `max(8, int(...))`. The primitives that take `q`
  scale themselves. Default strand widths scale with `1/sqrt(q)`, so coverage looks the same
  at any q. If you set `width_u` yourself, divide by `sqrt(q)` as the crop does.
* Keep the `Scalp` picklable. The bake caches the groom with the pickled scalp, so a lambda or
  closure in `Scalp(exclude=...)` disables the cache (the bake logs `groom: not cached`). Use
  a module-level function instead; this was verified to pickle. Lambdas passed to `accept=`,
  `cut=` and so on are fine, because they are not stored.
* Write a docstring recipe: what each section is and the numbers that matter.

---------------------------------------------------------------------------------------------

## 5. The library: primitives and the parameters that matter

Everything is in one namespace: `from hairbake import groom as g`. Each module's docstring
and each function's docstring has the details; this section is the map. Defaults are given in
brackets.

### 5.1 Where hair grows (`scalp.py`)

* `g.Hairline(table='women'|'men'|[(abs azimuth, y), ...], jitter=.008, recession=0, widow=0, lower=0, nape=0, seed=7)`
  is the hairline as y(azimuth).
  * `jitter` is natural irregularity (about 1.3 mm), not mirror-symmetric.
  * `recession` (0..1) is the men's temple corners, up to 1.1 cm.
  * `widow` is a widow's peak.
  * `lower` (+ lower on the forehead) and `nape` shift the line.
* `g.Parting(x=.5, drift=0, z_back=-.45, width=.0045, zigzag=.0035, fade=.10, z_front=.30, seed=3)`.
  * `x` is the part at the front hairline: .5 is centre, about .36 / .64 a side part.
  * `width` is the half-width of bare scalp. Use .0035-.0045, never wider: a wide part reads
    as a pink line.
  * `z_front` is where the part starts. Use .30 at the hairline; behind a full fringe start it
    at about .15-.20.
  * `zigzag` and `drift` keep it from being ruler-straight.
* `g.Scalp(hairline, parting=None, soft=.035, edge=.22, exclude=None)`.
  * `soft` and `edge` are the density falloff inside the hairline. Roots thin out over the last
    `soft` head units (6 mm) from `edge` density at the line: a soft hairline, never a hard cut.
  * `exclude(P) -> bool` removes regions (an undercut, a shaved line).
  * The ears never grow hair.
* `scalp.roots(n, rng, accept=None, blue=False, density=None)` returns a `Roots` record.
  * Sampling is uniform by area times density.
  * `accept(P, N) -> bool` restricts the region.
  * `blue=True` gives Poisson-disc spacing (for guides).
  * `scalp.section(accept, n, rng)` is the same with an accept region.
* `Roots` fields: `p, n, phi, elev, dist, side, pd`, plus `.x/.y/.z`, `.take(sel)` and
  `Roots.concat`.
* `g.hash01(P, seed)` is a deterministic 0..1 per point. Use it to dither a section boundary so
  that complementary sections (`accept` and `~accept`) interleave instead of meeting at a line.
* Helpers: `g.unit`, `g.tangent(v, n)`, `g.rotate_about`, `g.azimuth`, `g.elevation`,
  `g.crown()`, `g.surface_z(x, y)`, `g.surface_point`, `g.face_halfwidth(y)`, `g.ear_mask`.

### 5.2 Directions

* `g.growth_direction(roots)` is the natural flow from the crown whorl (buzz cuts).
* `g.part_comb(roots, scalp, down=.30, fwd=.10)` combs away from the part on top and runs
  radially from the crown behind. It is the long-hair comb.
* `g.part_comb_field(scalp)` is the same as a field for `grow_two_phase`.

### 5.3 Long and medium draping hair

`g.long_hair(scalp, rng, q, ...)` is the full L5 pipeline. It returns
`dict(strands, roots, guides, guide_roots, near, clump, y_end, front)`. Guides grow under
gravity with volume shells, then dense strands are made from the guides, cut, waved, end-bent,
clumped, frizzed and collided.

| parameter | default | what it does / typical |
|---|---|---|
| `n`, `n_guides` | 100000, 3200 | strands and guides at q = 1 (guides scale with `0.4 + 0.6 q`) |
| `length`, `nv`, `nv_out` | 3.0, 110, 90 | guide length (>= the longest strand), guide vertices, strand vertices. Short styles: `length=1.6, nv=70, nv_out=50` |
| `accept` | None | roots allowed (e.g. `lambda P, N: ~bang(P, N)` to leave the fringe section out) |
| `method` | `'gravity'` | or `'two_phase'`: proto-b comb-then-fall, sleeker tops (`two_phase=dict(...)`) |
| `volume` | (.055, .07) | (stack, body) shell heights: hair from higher up lies on top. More = fuller |
| `crown_lift` | .02 | extra height over the crown. **No flat tops**: .03-.04 |
| `asym` | .12 | one side of the part fuller (+ = image right). .12-.25 |
| `flat_front` | .75 | front sections lie flatter (under bangs) |
| `cut(roots, rng, lock_noise) -> y_end` | `layered_cut` | the front-view height where each strand is cut |
| `face_frame` | True | face-framing sections fall along the cheeks. Dict: `gap, hug (0 = straight down past the cheekbones, 1 = follow the jaw), spread, k` |
| `face_clear` | `{}` (on) | no strand of this hair in front of the face below the upper forehead. `None` only for styles meant to cover an eye or cheek |
| `ears` | True | side hair clears and covers the ears |
| `shoulders`, `front_frac` | True, .45 | front/back decision at the shoulders; fraction of the side hair in front |
| `drape` | True | below the shoulders hair hangs straight instead of fanning out |
| `waves` | None | `dict(amp=.026, wavelength=(.42, .56), start=.7, ramp=1.0, lateral=.5, scale=.30, lock_jitter=.6)`: whole sections wave together (`scale`); `scale=None` gives every guide its own phase (crimp) |
| `ends` | `dict(amount=.05, under=.6, start=.78)` | ends bend under (`under` fraction) or flick out |
| `clumps` | ((700, .15, .55, 1), (4000, .30, .55, .8)) | (count, root strength, tip strength, power) applied in order: locks |
| `frizz`, `stray` | (.0015, .0025), (.05, .003, .014) | fine noise; a fraction of strands with extra wander |
| `dense` | `'interpolate'` | or `'children'` (proto-b guide + children: chunkier, separated locks; `children_kw`) |
| `groups` | `'part'` | interpolation never crosses the part |

`g.layered_cut(roots, rng, lock, length_y=2.12, back_extra=.10, centre_shorter=.22, frame=True, frame_y=(1.05, 1.80), frame_depth=.16, frame_width=.25, jitter=(.06, .04))`
is the default cut:

* sides reach `length_y`, the back a little more, and the middle of the back is shorter;
* face-framing layers start at the chin (`frame_y[0]`) and grow longer behind the hairline;
* `jitter` is (per lock, per strand), so neighbouring strands are cut together;
* a level bob is `length_y=1.08, centre_shorter=0, frame=False`.

### 5.4 Fringes and curtain bangs

* `g.bang_section(scalp, width=.20, depth=.13)` and
  `g.curtain_bangs(scalp, rng, n, width=.20, depth=.13, h=..., length=(.70, .30), clumps=(70, 260), tip_clump=.62, ends=None, x0=.5)`
  make curtain bangs parted at `x0`.
  * Strands follow Catmull-Rom paths between `CURTAIN_INNER` (at the part) and `CURTAIN_OUTER`
    (to the cheekbone), lifted onto the forehead by `h`.
  * They gather into pieces and locks, and every piece gets its own length (`ends`:
    `ragged_lengths` arguments).
  * About 4500 x q strands with `opacity=.85` (as `w-long-layers` uses) is solid enough; fewer
    gives a translucent veil.
* `g.fringe_section(scalp, half_width=.30, depth=.14)` and
  `g.fringe(scalp, rng, n, section, end_y=.19, arch=.06, sweep=0, spread=1, lift=.035, h=.010, h_back=.020, edge=..., locks=(40, 140))`
  make a full fringe.
  * `end_y` is the cut height at the centre: brow top ~.22, brow-skimming ~.19, a short
    French-crop fringe ~.06.
  * `arch` makes the sides longer (+) or shorter (-).
  * `sweep` gives a side-swept fringe (+ toward image right; .15-.30).
  * `edge` breaks the cut line: `wave` (a slow wander), `piece`, `lock` and `strand` (length sd
    per level), and `point` / `point_depth` (point-cut tips).
  * Use about 9000 x q strands.
  * Raise `piece` and `point` until no straight bowl line or regular comb teeth remain.
* Both are separate Bezier strands of kind `fringe`. `face_clear` does not apply to them.

### 5.5 Short hair, crops, fades

* `g.short_hair(roots, rng, length, direction, H, nv=40, h_end=None, pieces=900, piece_yaw=.42, piece_len=.15, strand_yaw=.07, bend=.40, texture=None, follow=.3, clumps=(...), frizz=(...), collide=.003)`
  makes strands that walk over the skull (`surface_walk`). It returns
  `(Strands, piece id per strand)`.
  * `length` (n,) is in head units: 1 cm = .061.
  * `direction` (n, 3) is the styling direction; it is made tangent to the scalp.
  * `H` (n,) is the height the hair rises to: ~.10-.15 on a textured top, .01-.02 on short
    sides, ~.004 slicked.
  * `h_end` (n,) lifts the tips (+) or brings them down to the skin (-).
  * Pieces (~1 cm locks) get their own yaw, length and bend wander. `texture` (n,) 0..1 scales
    that randomness: 1 on a textured top, low on sides.
  * `clumps` makes the pieces pointed. A clumped fade reads as spots: keep the sides nearly
    unclumped (see `m-textured-crop`).
* `g.top_section(roots, half_width=(.44, .30), front=(.14, -.10))` is 0..1: the long top inside
  the parietal ridges.
* `g.fade_length(roots, short=.010, long=.075, y_low=.50, y_high=-.08, power=1)` grades the
  length from low on the head to up top.
* `g.skin_fade(roots, y0=.02, y1=.36, strength=.78, top=None)` returns
  `(opacity factor, width factor)` that thin the hair low on the sides so the skin shows.
  Apply them with `strands.set(opacity=..., width_u=...)`.
* Two sections that share one length, height and direction field, split with a `hash01`
  dither, blend without a seam (`m-textured-crop`).

### 5.6 Curls, waves, coils

* `g.curly_locks(guides, groot_n, rng, per=12, radius=(.025, .045), pitch=(.09, .14), tube=.010, radius_end=None, pitch_end=None, hand=None, clump=.55, fan=.35, scalp=None)`
  coils each guide centre line into a helix and bundles `per` children around it.
  * Grow the guides first (`g.grow` with a shell and a field), then cut them to
    `g.curl_centre_length(hair_length, radius, pitch)`: a coil is shorter than its hair.
  * See `demos.curls`.
* `g.wave(S, amp, wavelength, phase, start=.3, ramp=.4, lateral=.6)` gives S-waves. Give the
  strands of a lock the same phase.
* `g.helix(C, radius, pitch, ...)` makes coils around any centre lines (ropes, twists).

### 5.7 Updos

* `g.gather_point(x, y, z)` gives a base on the scalp: high pony (.5, -.15, -.78), low pony at
  the nape (.5, .62, -.74), top knot (.5, -.33, -.35).
* `g.ponytail(scalp, rng, q, gather=..., tie_r=.085, h=.004, sleek=.3, tail_len=1.6, tail_dir=(0, .15, -1), waves=None, ...)`
  returns `dict(scalp, tail, wrap, gather, tail_guides)`. Add all three Strands groups.
* `g.bun(scalp, rng, q, gather=..., radius=.17, height=.13, rope_r=.05, turns=2.3, twist=.16, messy=0, ...)`
  returns `dict(scalp, bun, gather, rope)`.
* `g.wrap(centre, axis, radius, width, n, rng)` is a band of hair or an elastic.
* `g.gather_walk(p0, target, ...)` combs strands over the head toward a point.

### 5.8 Hairline and silhouette details

* `g.baby_hairs(scalp, rng, n, length=(.02, .07), phi_range=(0, 1.25), mid_gap=.05, flow=None, curl=.004)`
  makes very short, fine hairs at the hairline. Use `phi_range=(2.3, 3.14)` for the nape. About
  0.4-0.6 % of the main strand count is enough.
* `g.flyaways(S, rng, frac=.012, start=(.15, .75), amp=(.06, .07), sel=None)` copies a few
  strands so they leave the surface. Add them with `kind='flyaway'`.
* `g.strays(roots, rng, n, length=(.04, .16), lift=.04)` makes short broken hairs standing off
  the top. Add them with `kind='stray'`, and keep them few: dark crown strays read as dirt.

### 5.9 Low level (when no feature fits)

* **Integrators** (`grow.py`, all colliding with the body SDF):
  * `g.grow(p0, d0, nseg, seglen, shell, field, gravity, stiff, stick)`;
  * `g.grow_two_phase(p0, n0, comb, nseg, ...)`;
  * `g.surface_walk(p0, direction, length, H, nv, ...)`;
  * `g.curve_from_root(root, n, sd, L, th0, th1, power, nv)` (no collision);
  * `g.gather_walk`, `g.bezier(ctrl, nv)`, `g.catmull(P, nv)`;
  * `g.on_surface(x, y, h)` lifts front-view points onto the face or forehead.
* **Fields** for `grow`: `field(p, d, st) -> (n, 3)`. Available: `g.combine(*fields)`,
  `g.shoulder_field(front, ...)`, `g.decide_front(roots, rng, front_frac)`, `g.drape_field()`,
  `g.face_frame_field(weight, side, ...)`, `g.face_clear_field(side, ...)`,
  `g.ear_clear_field(weight, side)` and `g.toward_field(target, k)`.
* **Strand arrays** (`strands.py`, S is (n, m, 3), root at vertex 0):
  * `g.interpolate(guides, groots, roots, ggroup, sgroup)`, `g.children(...)`,
    `g.clump(S, roots, groups, n, strength(t), rng)`;
  * `g.frizz`, `g.smooth_noise`, `g.smooth_field(P, rng, scale)` (smooth random fields over
    the scalp), `g.bend_ends`;
  * `g.ragged_lengths(L, rng, lock, piece, strand, point, point_depth)` gives broken cut
    lines;
  * `g.cut_at_y`, `g.cut`, `g.resample`, `g.lengths`, `g.arclen`, `g.frames`;
  * `g.collide_strands(S, h)` (the final push out of the body).
* **The body**: `g.collide`, `g.project`, `g.normal`, `g.body_sdf()` (negative inside),
  `g.skull()`.

### 5.10 Strands, kinds and the look

* `g.Strands(P, kind='main', clump=None, rooted=None, **attrs)` and
  `hair.add(strands_or_array, kind=..., **attrs)`. `strands.set(opacity=..., width_u=...)`
  sets attributes.
* **Kinds** and their defaults:

  | kind | code | width x | opacity | treatment in the renderer |
  |---|---|---|---|---|
  | main | 0 | 1.0 | .90 | hair body: casts full shadow, defines the clump-gap AO envelope |
  | fringe | 1 | 1.0 | .85 | as main |
  | flyaway | 2 | .6 | .65 | casts .3 of the shadow; not in the AO envelope (stays lit) |
  | stray | 3 | .55 | .50 | as flyaway; not root-checked |
  | baby | 4 | .45 | .45 | as flyaway |
  | short | 5 | 1.0 | .90 | as main |
  | wrap | 6 | 1.0 | .95 | as main; not root-checked |

  Give bulk hair kind main, fringe, short or wrap. As a flyaway kind it would look flat and
  lit through.
* The base width is `.00085 / sqrt(q)` head units (about .14 mm, wider than a real fibre
  because there are fewer strands than hairs).
* `rooted=False` for strands that do not start on the scalp (a tail, a bun coil, a wrap): the
  check skips their roots.
* `hair.finish(rng, look=dict(...))` fills the per-strand look. Override any of:

  | key | default | meaning |
  |---|---|---|
  | `albedo_lock`, `albedo_strand` | .27, .22 | log-normal brightness variation per lock and per strand: real hair has darker and lighter locks |
  | `tone_lock`, `tone_strand` | .16, .14 | lowlights / highlights (the T channel) per lock and per strand |
  | `tone_root` | -.10 | darker roots (over the first quarter of strands longer than ~.15). The shipped styles use -.12 to -.18 |
  | `tone_end` | .16 | lighter ends, ramped in by length up to `end_len` (.6). **Keep it at .05 or below on short hair**: the recolour amplifies tone for light shades, and .12 gave the crop white frosted tips in blonde |
  | `spec_lock` | (.65, 1.35) | highlight strength range per lock |
  | `shift_lock` | .03 | highlight shift per lock |

  Per-vertex attributes (`tone_t`, `albedo_t`, `width_t`, `opac_t`) can be set directly for
  special effects (balayage).

---------------------------------------------------------------------------------------------

## 6. Recipes by family

Each recipe names its tested reference. The "trial" recipes were checked only as preview shapes
at q .3 while this guide was written; bake and QA them before you rely on them.

* **Long layers, waves, sleek** (women's long; men's long flow): `long_hair` with
  `layered_cut`, optional `waves`, `ends`, `face_frame=dict(hug=0)`, plus `curtain_bangs` or
  `fringe`, baby hairs, a few flyaways and strays.
  * Tested: `styles/w-long-layers.py`, `demo:long`, `demo:waves`, `demo:sleek`
    (`method='two_phase'`, low volume, little clumping, small `albedo_lock`) and `demo:locks`
    (`dense='children'`).
* **Bob / lob**: `long_hair(length=1.6, nv=70, nv_out=50, shoulders=False, drape=False)` with
  `cut = layered_cut(length_y=1.08 (jaw) .. ~1.35 (lob), centre_shorter=0, frame=False)` and
  `ends=dict(under=.95)`. Add a fringe if wanted.
  * Tested: the template in section 4, and `demo:bob`.
* **Textured crop, taper, fade**: one `scalp.roots()` set, with `top_section`, `fade_length`
  for the sides, a top length (4-5 cm = .27-.32) and `H`. Then `short_hair` in two
  dither-split sections (sides: no texture, little clumping; top: pieces, clumps, bend), with
  `skin_fade` on opacity and width.
  * Tested: `styles/m-textured-crop.py`, `demo:crop`.
* **Side part (men)**: `Parting(.33)`; the top is combed over away from the part
  (`direction = ±x` by `r.side`, weighted by `scalp.parting.along(r.p)`), down and back behind;
  `H` rises away from the part.
  * Tested: `demo:sidepart`.
* **Buzz**: `short_hair` with `g.growth_direction(r)`, `L` ~.035, `H` .008, `nv=8`, no
  clumps; `Hairline('men', recession=.35)`, `soft=.025, edge=.15`.
  * Tested: `demo:buzz`.
* **Slick back** (trial):
  * top roots `top_section(r, half_width=(.40, .30))`, combed back
    (`direction = (.15 (x - .5), -.25, -1)`), long (`L` .75-.85), lying close (`H` .03-.045,
    `pieces=500, piece_yaw=.06, piece_len=.05, bend=.05`), with light clumping;
  * sides: `fade_length(r, .006, .03, .45, .10)` combed down and back, `H` .004;
  * `skin_fade(y0=.10, y1=.40, strength=.75, top=top)`;
  * look: `albedo_lock=.12, tone_lock=.08, spec_lock=(.8, 1.2)` for an even, glossy finish.
* **Quiff / pompadour** (trial):
  * top roots combed up and back (`direction = (.1 (x - .5), -1, -.6)`), `L` .30-.44;
  * height rising toward the front: `H = (.06 + .16 front) top`, with
    `front = smoothstep(-.25, .15, r.z) * top`;
  * `h_end = -.4 H top (1 - front)`, so the back of the top lies down.
* **Undercut**: `Scalp(exclude=undercut)`, where `undercut(P)` is a **module-level** function
  (for example `(P[..., 1] > .16) & (abs(P[..., 0] - .5) > .30)`), so the scalp still pickles.
  A fade on the remaining short hair keeps the edge soft. Remember that the scalp layer covers
  the whole hairline, including excluded regions (section 9).
* **Curls / ringlets / afro**: grow guides with `g.grow` (shell rising .03 to .15, gravity
  .05-.25), cut them to `curl_centre_length`, then `curly_locks(per=60 q, radius .028-.042,
  pitch .09-.13, tube .012, scalp=scalp)`.
  * Tested: `demo:curls`. Its front curls cover the eyes: raise the front cut, shorten the
    front guides or keep their roots out of the face-frame zone.
* **Ponytail / bun / man bun**: `ponytail` (`demo:pony`) and `bun` (`demo:bun`; it is still
  slightly spiral, so use `messy` .2-.4 and a `swell`able rope). Add `baby_hairs` at the
  hairline and nape: a scraped-back hairline without them looks like a wig.

---------------------------------------------------------------------------------------------

## 7. Renderer and light settings

`RENDER = dict(...)` in the style module overrides `render.RENDER`:

| key | default | notes |
|---|---|---|
| `res` | 256 | texels per head unit. The shipped styles use 300-320 |
| `max_hair_px` | 130000 | caps the visible hair of the largest view at this many texels, lowering `res` for big styles: the file-size budget. Use 140000 |
| `taper` | (.7, 1.0) | strand width tapers to 30 % between these fractions of the length. Short hair: (.55, 1.0) |
| `tip_fade` | .45 | opacity lost over the last 10 % of a strand |
| `fine_ao_r`, `fine_ao_d`, `fine_ao_min` | .010, .014, .32 | clump-gap occlusion (how dark the gaps between pieces get). The crop uses .008, .010, .40 |
| `spec` | 1.0 | highlight strength written to `style.json` `look.spec`. 0.85 on both shipped styles. Lower it if dark shades come out light (section 9) |
| `margin` | .05 | frame margin around the hair |
| `soft_r`, `zbias`, `step`, `ss`, `max_side`, `fine_ao` | | internals; leave them |
| `bits` | None | per-channel precision overrides (pack.BITS). Leave them |

`bits` and `spec` are pack-only: changing them repacks without re-rendering.

`LIGHT = dict(...)` overrides `shade.LIGHT`:

* **Do not change `key`.** The key-light direction is shared by every style and view, and the
  runtime does not relight.
* The useful knobs are `ambient_floor` (.12), `env_base` (.22), `bounce` (0), `bounce_m` (0)
  and `bounce_reach` (.08). `w-long-layers` uses `ambient_floor=.20, env_base=.55, bounce=.18,
  bounce_m=.35`, so hair beside and behind the neck is dark but not black.
* `LIGHT` is not written to `style.json`; `bake.source_sha1` identifies the recipe.

---------------------------------------------------------------------------------------------

## 8. Baking, QA and looking at the results

### Commands (run from `tools/hair-bake`)

| what | command | time / peak memory |
|---|---|---|
| shape preview | `python3 -m hairbake.preview <id|path|demo:x> [--q .25] [--views=-30,0,30,90,back] [--shade brown|blonde|black|kind] [--scalp] [--res 150] [--out F]` | 10-20 s, 0.4-0.8 GB |
| draft bake | `python3 -m hairbake.bake <id|path> --q .5 --out build/drafts` | about 1 min, about 1 GB (q .35 bob: 47 s, 0.86 GB) |
| final bake | `python3 -m hairbake.bake <id>` (q 1, seed 1, views -30,0,30, into `../../hairstyles/<id>/`) | 1.5-3.5 min, 1.7-2.1 GB |
| QA sheets | `python3 qa.py <id> [--styles-dir build/drafts] [--set public|internal|all] [--shades dark-brown,light-blonde|all] [--only a,b] [--hide off|on|both] [--turntable] [--palette]` | 0.3 s per composite (0.6 s hidden); one style with `--set all --palette --turntable` about 8 min, about 0.3 GB |
| runtime self-check | `python3 qa.py <id> --selfcheck` | seconds |
| library checks | `python3 -m hairbake.groomtest --no-sheet` (11 PASS) and `python3 -m hairbake.selftest --only checks` (21 PASS) | 30 s, seconds |
| portrait list / shade names | `python3 qa.py --list` | |

Notes on the commands:

* Write `--views=...` with `=` when the list starts with a minus sign. Without it, argparse
  takes `-30,...` for an option.
* The bake caches in `build/bake/<id>/`:
  * the groom is keyed by the style source, the groom library sources, q and seed;
  * each finished view is keyed additionally by the frame, `RENDER`, `LIGHT` and the renderer
    sources.

  So a killed bake resumes, and a `RENDER` change re-renders without re-grooming. `--no-cache`
  forces everything.
* The bake log prints `check OK`, or the failures of `Hair.check`. **A failing check does not
  stop the bake: read it.** It also prints the frame and resolution, the exposure gain, the
  size of each file, the round-trip error and a budget warning above 700 KB.
* **Never bake a draft into `hairstyles/`.** The default `--out` is the published directory.
  Use `--out build/drafts` and `qa.py --styles-dir build/drafts`.
* **Memory and parallel work** (4 cores, 15 GB, no swap): a q = 1 bake peaks at about
  2.1 GB. Run at most 3 bakes at once machine-wide, and at most one headless browser
  (`detect.cjs`). Every QA portrait's landmarks are already cached in `build/portraits/` and
  `build/qa/variants/`, so QA needs no browser.

### What to look at (with your own eyes, every time)

1. **The bake preview**, `build/bake/<id>/preview.png`: the packed files read back, 3 views x
   (neutral, dark brown, light blonde), over the shaded proxy.
2. **QA sheets**, `build/qa/<id>/sheet_public_N.jpg`: each public portrait shows the
   original, then per shade 1x, 1x with own hair hidden, and a 2x zoom of the head. Labels give
   the yaw, the view weights and the tie-back hint.
   * `INTERNAL_sheet_internal_N.jpg` holds the licence-unknown portraits, including the 3/4
     views at ±30 and ±39 deg. **Never** copy these, `tiles/unk_*` or `INTERNAL_*` into the
     repo or into anything shown to the owner.
3. **The turntable**, `turntable.jpg`: the style on the proxy from -40 to +40 deg in 5-degree
   steps through the runtime. Check for popping between views, smears behind the jaw and
   asymmetric glitches.
4. **Palette and colour**:
   * `palette_<portrait>.jpg`: all 16 shades, the existing hair-colour product versus the new
     style.
   * `shades_<portrait>.jpg`: all 16 shades on one face.
   * `colour.txt`: each shade's mean against its hex. The target is a few sRGB levels; the
     shipped styles are within about 11.
5. **Full-size tiles**, `tiles/<portrait>__<shade>__<1x|2x>[__hide].png`, for close
   inspection.
6. **The shape preview** (any yaw, the back, `top`), for the parts the views never show well.

The preview's shading is crude. Judge shape there, and judge the look on the bake preview and
QA. The preview's known artefacts are a dark band at shoulder height in some back views, a
dark ring at an ear bulge, and black holes at the jaw seam in 90-degree views. The bake does
not have them.

### Portraits

* **Public**: `tools/face-test.png` (NASA, public domain), `pd_*` (public domain),
  `pexels_piacquadio_f_long` (Pexels licence), and their mirrored and ±15-degree-rolled
  variants. Only these may be shown to the owner.
* The images are found in `$ROJA_PORTRAITS`, the scout directory named in `qa.py` (`SCOUT`) or
  `tools/`. `--images DIR` adds a directory.
* `qa.py` runs `detect.cjs` for new portraits or variants, which needs the preview server
  (`node tools/preview.cjs`, port 4173).

---------------------------------------------------------------------------------------------

## 9. Gotchas (learned the hard way)

**Groom**

* **Judge colour, depth and file size at q = 1** (or at least .7). At low q the hair volume is
  thinner, so M (depth) and self-shadowing drop and the hair looks glossier and lighter. A
  q = .35 bob draft had median M .35 against .52 at q = 1, and black came out 15 levels light
  in `colour.txt`.
* Short hair reads curly at low q: judge crops at q >= .5.
* **Dark shades come out light** when a style is very glossy (high S1 on solid hair).
  * The recolour is shared by all styles and is calibrated for the shipped styles' averages:
    M about .52, T about .5.
  * If `colour.txt` shows black or dark brown more than about 10 levels light at q = 1, lower
    `RENDER['spec']` (repack only) or reduce the sheen with more clumping or lower
    `spec_lock`.
  * Never change `colour.RECOLOUR` for one style.
* **Light shades and tone**: the recolour amplifies T contrast for light shades (darker roots,
  lowlights).
  * `tone_end` above about .05 on short hair gives blonde white tips.
  * `tone_root` -.12 to -.18 gives believable blonde roots.
* **Fringes and curtains**:
  * Too few strands, or opacity below about .85, gives a translucent veil.
  * The same length for every strand gives a bowl line.
  * Regular lock spacing with equal lengths gives comb teeth.
  * Use pieces with their own length, point cutting and a slow wave of the cut line
    (`fringe(edge=...)`, `curtain_bangs(ends=...)`).
* **Partings**:
  * Keep `width` at .0035-.0045.
  * Start the part behind a full fringe (`z_front` .15-.20), or a pink line runs through the
    fringe.
  * The bake already dims what shows through the part (the shadow channel); a wider part only
    makes it brighter.
* **Hairline**: always `jitter`, a soft falloff (`soft` .03-.035, `edge` .15-.22) and baby
  hairs. A hard hairline is the most obvious fake cue at 2x.
* **Volume**: `crown_lift` .03 or more and `asym` .12 or more. Flat tops and mirror-perfect
  symmetry read as a wig.
* **Hair over the face**:
  * `long_hair` keeps its strands off the face by default (`face_clear`).
  * Curls (`curly_locks`) and custom grows have no such field: check the front view and the
    ±30 views for strands across the eyes.
  * Face-framing locks should fall straight past the cheekbones (`face_frame=dict(hug=0)`),
    not wrap the jaw.
* **Strays**: a few broken hairs break the silhouette. Many dark ones above the crown read as
  dirt, so keep strays at about 0.15 % and flyaways at 0.6-1.2 % of the main count.
* **Kinked strands on the shoulders.** The final collision (`collide_strands`) pushes each
  vertex out of the body on its own, so strands lying along the shoulder or arm-hole cap can
  zigzag.
  * In `w-long-layers` about 4 % of the main strands have kinks in their last third, at y
    1.5-2.0. They read as a faint net beside the shoulder in light shades at ±30.
  * Check your style with the mean turning angle per strand. In the shipped long groom the
    median is 3.5 deg per segment, and kinked strands run 12-19 deg.
* **Collision with the proxy**: hair lies on a generic MakeHuman head (skull top -.35) and on a
  neck and shoulders without arms (arm holes capped). Real users vary; the runtime places by
  landmarks only.

**Frame and views**

* **The frame clips outliers.** It covers the visible strands' 0.01 to 99.99 percentile
  bounds plus `margin`, so the farthest flyaways can be cut by the frame edge. A cut strand
  ends in a straight line at runtime. Check the coverage on the 3-texel border after every
  final bake; it should be 0, or a few hundredths at most:

  ```
  python3 -c "
  import sys; from hairbake import pack
  st = pack.read_style(sys.argv[1])
  for v in st['views']:
      A = v['A']; b = max(A[:3].max(), A[-3:].max(), A[:, :3].max(), A[:, -3:].max())
      print('yaw %+3.0f  max coverage on the 3-px border %.3f' % (v['yaw'], b))
  " ../../hairstyles/<id>
  ```

  `m-textured-crop` gives 0.000. `w-long-layers` gives .22 at yaw -30 and .17 at +30, from
  the kinked strands above. Raise `RENDER['margin']` or tame the outliers.
* **Front hair and the proxy's arms**:
  * Long hair must decide front or back at the shoulders (`shoulders=True`).
  * The renderer hides only the back curtain behind the A-pose arms. Hair whose canonical z is
    in front of -0.78 (`render.FRONT_Z`) is never cut by them, and hair between -0.88 and
    -0.78 is half-way.
  * A curtain that hangs in that gap can show partial cuts.
* **Hidden hair is gone.** Each view keeps only what a camera at its yaw sees, and the runtime
  cross-fades and re-poses views by up to 15 deg. Hair that pops in or out between views shows
  in the turntable.
* **The scalp layer covers the whole area inside the hairline**, whatever `Scalp.density` or
  `exclude` says.
  * Under fades, undercuts and thin ends, the runtime paints the user's skin there, unless the
    user has own hair there and the style is thin (then it keeps and recolours the own hair:
    `scalp_policy='own'`).
  * Design fades to read well both ways.
* **Size budget**: 300-700 KB for the three views together. Big styles lower their resolution
  automatically (`max_hair_px`). Over budget, lower `max_hair_px` or `res`; do not touch
  `bits`.

**Process**

* Short styles over the user's long own hair trigger the runtime's tie-back hint (FORMAT.md
  section 11). That is expected, not a style bug. Judge short styles on the short-haired
  portraits with hiding on, and on the long-haired ones with hiding off.
* Do not edit the library, other authors' styles, `hairstyles/` of other ids, or anything else
  in the repo.
* Do not run `git` commit, push, reset, stash or checkout; the lead commits.
* Do not install packages, and do not run `playwright install`.

---------------------------------------------------------------------------------------------

## 10. Quality checklist

A style is ready when **every** box holds, judged by eye on the bake preview, the public QA
sheets (1x, hidden and 2x), the turntable and the palette, and by the numbers.

**Shape and silhouette**

- [ ] The silhouette and volume read as the named cut at a glance, from -30 to +30 and on the
      turntable from -40 to +40.
- [ ] There is lift at the crown, with no flat top and no helmet. Fullness is slightly
      asymmetric, and lengths are not uniform: they are layered, ragged and vary by lock.
- [ ] Locks and pieces are visible (clumping) without reading as noodles or spaghetti. Short
      hair is matte and piecey, not curly, unless the style is curly.
- [ ] A few flyaways break the silhouette. There are no floating dark specks above the crown.

**Hairline and parting**

- [ ] The parting is narrow and dim (darker skin between hair), never a bright pink or
      blocky line, and it drifts or zigzags slightly.
- [ ] The hairline is soft: density falls off, baby hairs are at the front and temples, and
      there is no hard cut line at 2x.
- [ ] No hair grows on the ears or the face below the hairline.

**Fringe and face**

- [ ] Fringe and curtain edges are broken and irregular: no bowl line, no comb teeth, no
      ruler-straight ends.
- [ ] The fringe is opaque enough to read as hair: no translucent veil.
- [ ] No strands cross the eyes or cheeks, unless the style is designed to (and then on
      purpose).

**Colour**

- [ ] Dark brown **and** light blonde both look like real hair on the public portraits: no
      grey or olive darks, no lemon, straw or white blondes, and roots slightly darker.
- [ ] All 16 shades read coherently on `shades_<portrait>.jpg`. `colour.txt` (at q = 1) is
      within about 10 sRGB levels of each hex.

**Views and runtime**

- [ ] The three views are consistent: no popping on the turntable, no seams, notches or steps
      where the hair meets the neck or shoulders, and no halos.
- [ ] Nothing touches the frame border (border coverage about 0).
- [ ] Behind the jaw, at ±15-30 deg, there are no smears (the runtime occluder handles the
      face; check anyway).
- [ ] Hair behind and beside the neck at ±30 is dark but not black. If needed, use
      `LIGHT=dict(bounce=...)`.

**Numbers**

- [ ] The bake log says `check OK`. `qa.py <id> --selfcheck` passes.
- [ ] The size is 300-700 KB, baked at q = 1 and seed 1 with the default views.
- [ ] The docstring recipe describes the style, and `STYLE` has the Persian name and the right
      group.
