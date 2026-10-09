# Roja hairstyle format (`roja-hairstyle`, version 1)

This is the specification of the baked hairstyles in `hairstyles/<id>/` and of how the live
mirror draws them. It is written for the engineer who implements the WebGL runtime: this file
plus the files of a style is all that is needed.

The numpy **reference implementation** is `tools/hair-bake/hairbake/runtime.py` (with
`colour.py` for the recolour and `canon.py` for the frame). `qa.py` composites styles onto test
portraits with it, and every QA image the owner and the critics judged came from it. When this
text and the reference disagree, the reference is right and this file has a bug; please report
it.

Contents
1. What is in a style
2. The coordinate frame (head units)
3. Placement on the camera frame (anchors, yaw)
4. The sprite frame and texel addressing
5. Views
6. Textures, channels and decoding
7. `style.json` field by field
8. The runtime, step by step
9. Recolour (exact)
10. Under the hair: scalp, cast shadow, composite
11. Own-hair hiding and the tie-back hint (optional)
12. WebGL 1 implementation notes
13. Checking an implementation
14. Versioning

---------------------------------------------------------------------------------------------

## 1. What is in a style

```
hairstyles/<id>/
  style.json            frame, views, channel layout, encoding scales, provenance
  yawm30.hair.webp      view at yaw -30 deg: S1 D A        full resolution
  yawm30.aux.webp                          M T S2       half resolution
  yawm30.mask.webp                         shadow scalp head   half resolution
  yawm30.depth.webp                        Z face body  half resolution
  yaw0.*.webp           view at yaw 0   (same four textures)
  yawp30.*.webp         view at yaw +30 (same four textures)
```

All twelve images are lossless WebP, RGB, 8 bits per channel and no alpha channel.

The two styles that exist now:

| id | group | frame (px) | px per head unit | bytes, all 3 views |
|---|---|---|---|---|
| `w-long-layers` | women | 512 x 1024 (half 256 x 512) | 224.08 | 599 910 (586 KB) |
| `m-textured-crop` | men | 512 x 512 (half 256 x 256) | 320 | 398 096 (389 KB) |

How the data was made (only background; nothing here is needed to draw a style):

1. About 100 000 strands are groomed in 3D on a head-and-shoulders proxy. The proxy is the
   CC0 MakeHuman base mesh, warped so its face is MediaPipe's canonical face.
2. The strands are shaded in neutral, colourless channels: diffuse light, two highlight lobes,
   depth into the hair and tone. Shading uses a fixed studio key light at the upper left front,
   deep-opacity self-shadowing, and ambient occlusion from the hair and the body.
3. For each view yaw `v`, the groom is turned by `v` about the head's vertical axis. It is
   rasterised orthographically in one fixed 2D frame, and the proxy body hides whatever is
   behind it.
4. The views are packed as above.

At runtime the sprite is placed on the face by landmarks. The two nearest views are re-posed to
the current head yaw by their depth and cross-faded. The result is recoloured to the chosen
shade, a scalp and a shadow are painted under it, and it is composited over the camera frame.

---------------------------------------------------------------------------------------------

## 2. The coordinate frame (head units)

All geometry is in **head units**. This is the frame of `facemesh.js` (`CANON`, `CANON_ASPECT`),
extended to 3D:

* **x** runs across the face toward image right. The face mesh plus a 3 % margin spans exactly
  `0..1`, and the face's mid-line is `x = 0.5`.
* **y** runs **down**. `y = CANON[2i+1] * CANON_ASPECT`, with `CANON_ASPECT = 1.13274`.
* **z** points **toward the camera** (toward the viewer of a front-on face). Larger z is nearer.

Landmark `i` in head units:

```
x_i = CANON[2i]
y_i = CANON[2i+1] * CANON_ASPECT
z_i = Z_i / UNIT_CM          (Z_i: MediaPipe canonical face model, cm, + toward the camera)
```

MediaPipe's canonical face model is in centimetres, with Y up and Z toward the camera. It is the
space the facial transformation matrix maps from, and it is stored in
`vendor/face_landmarker.task` (`geometry_pipeline_metadata_landmarks.binarypb`, which is what
`tools/facemesh.cjs` reads). It converts to head units as

```
x = (X - X0) / UNIT_CM      X0      = -8.207681
y = (Y0 - Y) / UNIT_CM      Y0      =  8.726364
z =  Z       / UNIT_CM      UNIT_CM = 16.415361   (1 head unit = 16.4154 cm)
```

`canon.py` derives these constants from the `.task` file and asserts that they agree with
`facemesh.js` to within 2e-4.

`facemesh.js` holds only x and y. The runtime's face occluder (section 8, step 5) also needs the
canonical z of the 468 landmarks and the closed mesh: 898 triangles, which are the 852
`facemesh.js` `TRIANGLES` plus the 46 that span the eye and mouth openings. Export them once
with:

```
cd tools/hair-bake && python3 -c "
import json; from hairbake import canon
H, T = canon.face_mesh()
print(json.dumps(dict(z=[round(float(z), 5) for z in H[:, 2]], triangles=T.ravel().tolist())))" > face.json
```

The output is 17 KB. You can also extend `tools/facemesh.cjs`, which already reads the model,
to emit the z array and the full triangle list.

Reference points in head units:

| what | x | y | z |
|---|---|---|---|
| landmark 10 (top of the forehead) | .500 | .028 | .273 |
| landmark 1 (nose tip) | .500 | .600 | .455 |
| landmark 152 (chin) | .500 | 1.104 | .260 |
| landmark 33 (the subject's right eye, outer corner) | .229 | .369 | .193 |
| landmark 263 (left eye, outer corner) | .771 | .369 | .193 |
| landmarks 234 / 454 (face outline at the ears) | .033 / .967 | .491 | -.148 |
| skull top (proxy head) | .5 | -.35 | |
| women's front hairline | .5 | ~ -.045 | |
| ears | < .02 / > .98 | .32 .. .56 | -.38 .. -.19 |
| back of the head | | | ~ -.85 |
| shoulders | | ~ 1.4 | |

**Not mirrored.** The subject's right eye (33) is at image left (x = .229), exactly as in the
unmirrored camera frame. The site mirrors the canvas in CSS. All runtime work happens in
unmirrored frame pixels, where the landmarks are.

---------------------------------------------------------------------------------------------

## 3. Placement on the camera frame

### Yaw and the pivot

The head turns about the vertical axis through **PIVOT = (0.5, 0, -0.36)** (`style.json`
`anchors.pivot`). Turning a head-unit point `P` by `deg` degrees gives

```
a = radians(deg);  c = cos a;  s = sin a
x' = px + c (x - px) + s (z - pz)
y' = y
z' = pz - s (x - px) + c (z - pz)          (px, pz) = (PIVOT.x, PIVOT.z)
```

Positive yaw turns the face toward **image right** (+x). This has the same sign and value as
`measure.js` `pose(matrix).yaw = asin(-R[2][0])` of MediaPipe's facial transformation matrix.
`pose()` reads the packed data as column-major when
`|d12| + |d13| + |d14| >= |d3| + |d7| + |d11|`. This was verified on 16 portraits.

The choice of pivot does not change where things land, because the anchor fit below absorbs
translation. It only decides where a turned view sits inside the fixed sprite frame.

### Anchors and the affine fit

The 20 **anchors** are landmarks that hold still through a smile, a blink or an open mouth. They
are the same as the old `hair.js` `headFit`:

```
ANCHORS = [10, 109, 338, 67, 297, 54, 284, 234, 454, 127, 356, 162, 389, 168, 6, 33, 263, 133, 362, 1]
```

`style.json` `anchors.canonical` holds their (x, y, z) in head units.

To place head units on the frame at head yaw `yaw`:

1. Turn the canonical anchors by `yaw` about PIVOT and keep (x', y'). This is
   `anchors_xy(yaw)`. `style.json` `views[].anchors` holds it precomputed for each view's yaw,
   but the runtime needs it at the **current** yaw.
2. Fit the 2x3 affine `A` from those anchor positions to the detected landmark pixel positions
   by least squares: `px = A @ [x, y, 1]`. The old `headFit()` code (normal equations, 3x3
   solve) works unchanged with the turned anchor coordinates in place of `canon(i)`.

```
qx_k, qy_k   = anchors_xy(yaw)[k]                       (head units)
lx_k, ly_k   = landmark[ANCHORS[k]].x * W, .y * H       (frame pixels)
A = argmin sum_k |A [qx_k, qy_k, 1] - [lx_k, ly_k]|^2
px_per_unit  = hu = sqrt(|det A[:, :2]|)                 (used for blurs and LOD below)
```

Turning the anchors before fitting matters. On a 512-px test portrait at yaw -29.8, the rms
anchor residual is 20.5 px with front-on anchors and 5.6 px with anchors turned by the yaw.

Roll is a rotation in the image plane, and the affine fit absorbs it. Pitch is not modelled:
the fit approximates it with a vertical squash. There are no pitch views.

### Which yaw drives everything

`yaw = pose(matrix).yaw`, from the matrix the face worker already forwards
(`face-core.js` -> `d.matrix`). If there is no matrix, the reference falls back to
`yaw_from_landmarks`, which is within 0.40 deg rms (max 1.38 deg) of the matrix on 16
portraits:

* It is a Kabsch similarity fit (with scale) of the canonical face in head units onto the
  landmarks taken as 3D points `(x*W, y*H, -0.7 * z*W)`.
* The points used are the anchors, the face oval and the nose (4, 5, 195, 197, 2, 98, 327,
  168, 6).
* The yaw is `asin(-R[2][0])` of the fitted rotation.

The tested range is yaw -40..+40 deg (QA turntable). The runtime does not change behaviour
beyond that.

---------------------------------------------------------------------------------------------

## 4. The sprite frame and texel addressing

`style.json` `frame = {x0, y0, x1, y1, res, width, height}`:

* `width x height` are the full-resolution texture sides. They are powers of two, at most 1024.
* `res` is texels per head unit (square texels), and `x1 = x0 + width / res`,
  `y1 = y0 + height / res`.
* Full-resolution texel `(i, j)` (column i, row j, row 0 at the **top**) covers head units
  `[x0 + i/res, x0 + (i+1)/res) x [y0 + j/res, y0 + (j+1)/res)`. Its centre is at +0.5.
* `half = {width/2, height/2}` (exactly half) is the size of the aux, mask and depth
  textures. They cover the **same rectangle** with texels twice as large, so texel centres line
  up the way GPU bilinear sampling expects.
* Normalised texture coordinates are the same for every texture of a style:
  `u = (x - x0) / (x1 - x0)`, `v = (y - y0) / (y1 - y0)`, with v growing downward. If you
  upload images row 0 first (`UNPACK_FLIP_Y_WEBGL = false`, the default), texture `t = v`.
* The frame is the **same for all views** of a style. It does not move with the view yaw.
* It always contains the cranium box x -0.10..1.10, y -0.42..0.62, plus every view's visible
  hair, plus a 0.05 margin. So the scalp and head masks are never cut by the frame edge.

---------------------------------------------------------------------------------------------

## 5. Views

`style.json` `views` is an array with one entry per baked yaw. Today it is -30, 0 and +30, in
that order, but read the yaws from the file and sort them yourself; one view or more than
three are valid.

A view baked at yaw `v` is the 3D groom turned by `v` about PIVOT, projected orthographically
along z into the fixed frame. That is what a camera at head yaw `v` sees, expressed in that
view's turned head units, and placed with `anchors_xy(v)`.

Each view contains **only the hair visible in that view**:

* Hair behind the head, face, neck and torso of the proxy is not in it.
* The proxy's arms hide only the back curtain behind the shoulders. Hair in front of the
  shoulders is never cut by the A-pose arms.
* Hair a little behind the neck or shoulders fades out softly just outside their outline.
  This means a real neck slightly wider or narrower than the proxy's shows no hard line.

The view tag in the file names is `yaw0`, `yawm<n>` for -n, or `yawp<n>` for +n, with n the
rounded degrees.

`views[i]`:

| field | meaning |
|---|---|
| `yaw` | degrees, the view's yaw (same convention as section 3) |
| `hair`, `aux`, `mask`, `depth` | file names of the four textures |
| `anchors` | `anchors_xy(yaw)`, 20 x 2 head units (informational: computable from `anchors.canonical`) |
| `head_outline` | the head silhouette (skull, ears, face) of this view as a closed polygon in head units, from the `head` mask (informational, for a runtime that prefers geometry to the mask) |

---------------------------------------------------------------------------------------------

## 6. Textures, channels and decoding

### Loading (this matters)

The values are data, not colours. Upload them exactly:

* Decode with `createImageBitmap(blob, {colorSpaceConversion: 'none', premultiplyAlpha: 'none'})`,
  or an `<img>` with `gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)`.
* Keep `UNPACK_PREMULTIPLY_ALPHA_WEBGL` false and `UNPACK_FLIP_Y_WEBGL` false.
* Use RGB or RGBA `UNSIGNED_BYTE` textures. The browser's alpha is always 255; ignore it.
* Use `CLAMP_TO_EDGE` and `LINEAR_MIPMAP_LINEAR` with `generateMipmap`. All sides are powers of
  two, so WebGL 1 can mipmap them. The mip chain is 2x2 box averages of the **encoded**
  values, which is what the reference does.

### Channels

`v` is the 8-bit code read back as a texture value in 0..1 (`code / 255`).

| texture | res | ch | name | decode | bits | meaning |
|---|---|---|---|---|---|---|
| hair | full | R | S1 | `S1p = scale.S1 * v^2` | 6 | primary highlight (R lobe), **premultiplied** by A |
| hair | full | G | D | `Dp = scale.D * v^2` | 6 | diffuse light, **premultiplied** by A |
| hair | full | B | A | `A = v` | 7 | coverage (opacity) of the hair |
| aux | half | R | M | `M = v` | 5 | depth into the hair, 0 surface .. 1 deep (straight) |
| aux | half | G | T | `T = v` | 5 | tone, 0 darker .. 1 lighter (straight) |
| aux | half | B | S2 | `S2 = scale.S2 * v^2`, then `S2p = S2 * A` | 5 | secondary highlight (TRT lobe), per unit coverage (straight) |
| mask | half | R | shadow | `v` | 6 | darkening the hair casts on skin and clothes |
| mask | half | G | scalp | `v` | 7 | where to paint scalp skin under the hair |
| mask | half | B | head | `v` | 6 | the proxy head's silhouette (skull, ears, face) in this view |
| depth | half | R | Z | `Z = z.min + (z.max - z.min) * v` | 7 | depth of the visible hair (head units, + toward the camera) |
| depth | half | G | face | `v` | 6 | the canonical face mesh's silhouette in this view |
| depth | half | B | body | `v` | 6 | the proxy's neck, torso and arms in this view |

* `scale` (`style.json` `scale.D`, `scale.S1`, `scale.S2`) is shared by all views of a style.
  It is the 99.9th percentile over covered texels, so values above it were clipped.
* `z = {min: -1.0, max: 0.6}`.
* **bits**: each channel uses only `2^bits` evenly spaced levels of its 8-bit code, with 0 and
  255 included. Fewer levels make the lossless files much smaller, and the hair's own strand
  noise hides the steps. The decoder ignores this: always read `code / 255`.
* **Decode after filtering.** Sample the encoded values with the GPU's bilinear and mipmap
  filtering, then decode (square, scale). The reference does this, and so did every QA image.
* `S1p` and `Dp` are already premultiplied, so where `A = 0` they are 0. `S2` is straight, so
  multiply it by the full-resolution `A` at the same point.
* Half-resolution straight channels (M, T, S2) are filled outward past the edge of the hair.
  Between 8 and 16 half-res texels away from it they settle to the constants M = .5, T = .5,
  S2 = 0. Filtering at the edge of the hair therefore never pulls in junk.
* `Z` is defined everywhere. Over the hair it is the coverage-weighted depth of the visible
  hair; over the proxy body it is the body's depth; elsewhere it is filled outward. It is
  smoothed with a Gaussian of sigma 0.025 head units. It is meant for the parallax mesh, not
  as a per-strand depth.

### What the channels mean

* **A**: coverage of the hair, 0..1. It includes anti-aliased strand edges, tapered tips and
  see-through thin ends.
* **D**: diffuse and multiple-scatter light in neutral grey: a key light with a deep-opacity
  self-shadow, a soft shadow from the head and body, and studio ambient light with hair and
  body occlusion. The exposure is normalised so that the **median straight D over the front
  view's solid hair is 0.6** (`D0`). Shading uses the same studio light in every view (light
  fixed in view space), so the views match when cross-faded.
* **S1**: the R lobe, the white surface highlight. The recolour tints it toward the dye for
  dark shades only.
* **S2**: the TRT lobe, a highlight that passes through the fibre. It is shifted toward the
  tips and coloured by the dye.
* **M**: how deep inside the hair volume the light arrived. Deep hair is darker and more
  saturated. The style average is about .52 (`M0`).
* **T**: tone. 0 is the darker tone of the dye (roots, lowlights), 1 the lighter (ends,
  highlights). It carries the per-lock variation. The average is about .5 (`T0`).
* **Z**: see above.
* **shadow**: how much the hair darkens the skin and clothes under it in this view. It is the
  key light's shadow through the hair volume onto the proxy body. On the scalp it is at least
  `0.9 * scalp * blur(A, 0.006 head units)^0.7`, so skin seen through a parting or between
  pieces reads dim, not bright.
* **scalp**: where the style's scalp is. That is inside its hairline (including the part line),
  never on the ears, and never on the face below the hairline. It is 0 at 0.005 head units
  (0.8 mm) outside the hairline and ramps to 1 at 0.03 (5 mm) inside it. The runtime paints
  shaded skin there under the hair, so the user's own hair does not show through partings and
  thin ends.
* **head**: the proxy head (skull, ears and face) silhouette in this view. The runtime uses it
  only for own-hair hiding.
* **face**: the canonical face mesh silhouette in this view. It is not used by the reference
  runtime and is provided for runtimes that want it.
* **body**: the proxy neck, torso and arms silhouette in this view. Own-hair hiding uses it so
  that fills never take clothing colours.

---------------------------------------------------------------------------------------------

## 7. `style.json` field by field

| field | type | used by the runtime | meaning |
|---|---|---|---|
| `format` | `"roja-hairstyle"` | check | format name |
| `version` | `1` | check | format version (section 14) |
| `id` | string | yes | style id = directory name, e.g. `w-long-layers` |
| `name` | string | UI | Persian display name |
| `group` | `"women"` / `"men"` | UI | which list the style belongs to |
| `frame` | object | yes | section 4 |
| `half` | `{width, height}` | yes | half-resolution texture size |
| `views` | array | yes | section 5 |
| `textures` | object | informational | the channel layout (`size`, `mode`, `channels`, `encoding`) per texture kind, as in section 6 |
| `bits` | object | informational | bits per channel (section 6) |
| `scale` | `{D, S1, S2}` | yes | decode scales |
| `z` | `{min, max}` | yes | Z decode range (head units) |
| `units` | string | informational | the head-unit definition |
| `anchors.landmarks` | 20 ints | yes | ANCHORS |
| `anchors.canonical` | 20 x [x, y, z] | yes | the anchors in head units (turn them for `anchors_xy(yaw)`) |
| `anchors.pivot` | [x, y, z] | yes | PIVOT (0.5, 0, -0.36) |
| `crossfade` | `{by, rule}` | informational | section 8, step 2 |
| `bytes` | int | informational | total size of the 12 textures |
| `look.spec` | number | yes | highlight strength for this style (`spec` in the recolour, e.g. 0.85) |
| `light.key` | [x, y, z] | informational | the bake's key-light direction (toward the light; view space x right, y down, z toward the camera). The runtime does not relight. |
| `bake` | object | informational | provenance: `q`, `seed`, `strands`, `vertices`, `res`, `exposure_gain`, `source` (the style module), `source_sha1` (12 hex digits of its SHA-1), `render` (renderer settings), `date`, `seconds`. A style module's `LIGHT` overrides are not written; `source_sha1` identifies the exact recipe. |

---------------------------------------------------------------------------------------------

## 8. The runtime, step by step

Inputs per camera frame:

* the frame itself (sRGB, unmirrored);
* the 478 landmarks (normalised x, y as `app.js` receives them; pixel position = `x*W, y*H`);
* the 4x4 facial transformation matrix;
* optionally the hair segmenter's confidence mask (`hairMask`, 192 px), bilinearly upsampled
  to the frame;
* the chosen style and HAIR shade (`catalog.js`, 16 shades).

Steps 1 to 7 produce the hair layers. Section 10 puts them on the frame.

**1. Yaw.** `yaw = pose(matrix).yaw` (section 3).

**2. View weights.** Sort the view yaws `y_1 < ... < y_n`.

* If `yaw <= y_1`, view 1 gets weight 1.
* If `yaw >= y_n`, view n gets weight 1.
* Otherwise, with `y_k <= yaw < y_k+1` and `t = (yaw - y_k) / (y_k+1 - y_k)`, view k gets
  `1 - t` and view k+1 gets `t`.

So at most two views are drawn; skip views with weight 0.

**3. Placement.** Compute `A = fit(anchors_xy(yaw) -> landmarks)` (section 3) once, at the
**current** yaw. It is used for every drawn view, because step 4 re-poses each view to the
current yaw first. Also compute `hu = sqrt|det A[:, :2]|` (pixels per head unit).

**4. The parallax mesh of a view.** For each drawn view `V` (yaw `v`):

* Lay a regular grid over the sprite frame with one vertex every 8 full-resolution texels:
  `(width/8 + 1) x (height/8 + 1)` vertices at texel coordinates `(8a, 8b)`. Each grid cell is
  two triangles, `(p00, p10, p11)` and `(p00, p11, p01)`.
* Vertex `(U, Vt)` (texel coordinates) sits at head units `x = x0 + U/res`, `y = y0 + Vt/res`.
  Its depth `z` is the decoded Z bilinearly sampled at the same point, i.e. at normalised
  `(U/width, Vt/height)`. This is fixed per style and view, so compute it on the CPU when the
  style loads. WebGL 1 does not guarantee texture reads in vertex shaders.
* Turn `(x, y, z)` by `yaw - v` about PIVOT (section 3) to get `(x', y', z')`.
* The vertex lands at frame pixel `A @ [x', y', 1]` with depth `z'`, and carries its texture
  coordinate `(U/width, Vt/height)`.
* Draw with a depth test where **larger z' is nearer**. Where the re-posed mesh folds over
  itself, the nearer surface wins.

Without parallax (each view placed flat with `fit(anchors_xy(v))`), the two views of a
cross-fade ghost against each other. The reference keeps that mode only for comparison.

**5. The face occluder.** Before the hair, draw into the same depth buffer an occluder made of
three parts:

* **Face**: the 468 face-mesh vertices at the user's **landmark pixel positions**
  `(x*W, y*H)`. Their depth is the z' of section 3 for the landmark's canonical point: x from
  `CANON`, z from the export in section 2, turned by `yaw` about PIVOT. Use the 898 triangles
  of the closed canonical mesh (section 2).
* **Jaw skirt**: the jaw line
  `JAW = [361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132]`
  (face vertices as above), joined to a lower edge. For each jaw landmark k with canonical
  head-unit position `(Jx, Jy)`, the lower edge point is:
  ```
  xn = 0.5 + (Jx - 0.5) * 0.27 / max_k |Jx - 0.5|
  tn = asin(clamp((xn - 0.5) / 0.27, -1, 1))
  low_k = (xn, Jy + 0.12, -0.40 + 0.31 cos tn)      (head units, at yaw 0)
  ```
  Turn `low_k` by `yaw` about PIVOT and place it with A, keeping z'. The triangles are
  `(J_k, J_k+1, low_k+1)` and `(J_k, low_k+1, low_k)` for k = 0..15.
* **Neck**: the front half of an elliptic cylinder, centre x 0.5, z -0.40, radii rx 0.27 and
  rz 0.31, from y 0.75 to y 1.30. It is a grid of `t` in -90..90 deg (16 segments) by y
  (6 rings), with vertex `(0.5 + 0.27 sin t, y, -0.40 + 0.31 cos t)`. Make two triangles per
  quad, turn the vertices by `yaw` about PIVOT and place them with A, keeping z'.

A hair fragment is **discarded where its z' < z_occluder - 0.05** (`FACE_EPS`). An easy way to
get this is to write the occluder's depth as `z_occluder - 0.05`, then draw the hair with the
normal depth test. Without the occluder, a turned view slides the hair that sat behind the
jaw, cheek and neck across them as dark wedges. The occluder removed these wedges on the QA
portraits that showed them (pd_obama2 and its mirror, Biden) and on the turntable at yaw -20
and +15. It does not cut the fringe or the face-framing locks, which are in front of the
face.

**6. Sampling and decoding.** Sample the four textures at the fragment's texture coordinate
with trilinear filtering of the encoded values (section 6).

* The reference uses one LOD per view: `lod = log2(res / hu)` for the full-resolution
  texture and `lod - 1` for the half-resolution ones.
* WebGL's automatic LOD selection gives the same thing. The half-resolution textures have half
  as many texels at the same normalised coordinates, so they get `lod - 1` automatically.
* Decode as in section 6. Fragments outside the mesh do not exist, so coverage-like values
  (A, shadow, scalp, head, face, body) are 0 there.

**7. Colour and cross-fade.**

For each drawn view i (weight `w_i`):

```
P_i = recolour(Dp, S1p, S2p, M, T, A, dye, spec = look.spec) * L      (linear, premultiplied; section 9)
```

`L` is the **scene light**, the existing hair-colour product's face-probe light factor:

* `face` = the mean Rec.601 luma (`.299, .587, .114` on sRGB values) of the frame
  box-filtered to 1/8 size (`stage.js` `low2`). It is sampled bilinearly at landmarks
  50, 280, 151 and 199, with their normalised coordinates clamped to .01..0.99 (`app.js`
  `probes()`).
* `light = clamp(1 + (face / 0.58 - 1) * 0.5, 0.72, 1.12)`, as in `shaders.js` `LAYER_FRAG`.
* `L = light ^ SCENE_GAMMA` with **SCENE_GAMMA = 1**, so `L = light`, applied in linear light.
  The full sRGB strength (`light^2.2`) made light shades near-white on fair skin and dark
  shades near-black on dark skin, because the probe reads skin tone as well as exposure.

Cross-fade the drawn views:

* **Coverage-like layers** `X` in {A, scalp, head, face, body} form a weighted union:
  `X = 1 - prod_i (1 - X_i)^c_i`, with `c_i = min(1, 2 w_i)`.
  * At `w = 1` this is that view alone; at .5/.5 it is the plain union.
  * Hair that only one view shows (the side of the head turning into view, or hair hidden
    behind the head in the other view) stays opaque instead of going see-through.
* **Hair colour** is the coverage-weighted mean, straight:
  `C = sum_i w_i P_i / max(sum_i w_i A_i, 1e-4)`.
* **shadow** (and Z, if you need it) is a plain weighted sum `sum_i w_i X_i`.
* **Highlight shoulder** on the straight colour, per channel:
  `shoulder(x) = x` for `x <= 0.72`, and `0.72 + 0.28 * tanh((x - 0.72) / 0.28)` above it.
  This is a camera-like roll-off, so light shades in bright photos keep their texture.
* The hair layer to composite is `H = shoulder(C) * A` (linear, premultiplied).

---------------------------------------------------------------------------------------------

## 9. Recolour (exact)

The bake stores neutral light. A shade from the `catalog.js` HAIR palette is applied here.
After `shoulder()`, the new hair **averages to the shade's hex**, the same as the existing
hair-colour product makes real hair average to it.

* On the front view's solid hair (light 1), the 16 shades come within about 11 sRGB levels per
  channel, most within 5 (`build/qa/<style>/colour.txt`).
* Light shades are deliberately a little less saturated than the hex: darker roots and
  lowlights, warm golden or beige shadows (never olive), and cream (not yellow) highlights.

All of it is in **linear light**:

```
srgb_to_lin(c) = c <= .04045 ? c / 12.92 : ((c + .055) / 1.055)^2.4
lin_to_srgb(c) = c <= .0031308 ? 12.92 c : 1.055 c^(1/2.4) - .055
luma(c) = .2126 r + .7152 g + .0722 b          (Rec.709, linear)
```

### Parameters (`colour.RECOLOUR`)

| name | value | name | value | name | value |
|---|---|---|---|---|---|
| kd | 1.38 | kd_light | 0.49 | D0 | 0.6 |
| k_m | 0.55 | k_ml | 0.6 | M0 | 0.52 |
| T0 | 0.50 | tone | 1.6 | tone_light | 1.2 |
| sat | 1.08 | sat_light | 0.22 | sat_m | 0.6 |
| sat_t | 0.8 | sat_max | 1.35 | contrast_light | 0.35 |
| desat_hi | 0.15 | warm | 0.6 | warm_rgb | (1.25, 1.0, 0.72) |
| k1 | 0.075 | k1_dark | 0.55 | tint1 | 0.55 |
| tint1_light | 0.18 | k2 | 0.45 | e2 | 0.75 |
| sat2 | 1.15 | | | | |

### Per shade (once, when the shade changes)

```
c      = srgb_to_lin(hex)                 (r, g, b)
Y      = max(luma(c), 1e-4)
ch     = c / Y                            chroma (per channel)
l      = Y^(1/2.2)                        lightness 0..1
kd'    = kd (1 + kd_light (l - 0.4))
gamma' = 1 - contrast_light l
tone'  = tone (1 + tone_light l)
sat'   = sat (1 - sat_light l)
k1'    = k1 (k1_dark + (1 - k1_dark) l)
tint1' = tint1 + (tint1_light - tint1) l
absorb = Y^k_m exp(-k_ml l)
wv     = warm_rgb / luma(warm_rgb)        (per channel)
```

### Per texel

The inputs are premultiplied `Dp`, `S1p`, `S2p` (`S2p = S2 * A`), straight `M` and `T`, and
the coverage `A`.

```
a     = max(A, 1e-3)
rel   = Dp / a / D0                                   brightness against the average lit hair
Dc    = a D0 max(rel, 0)^gamma'                       (premultiplied; softer for light shades)
lum   = kd' Y Dc exp(tone' (T - T0)) absorb^(M - M0)
s     = min(sat_max, sat' (1 + sat_m (M - M0) + sat_t (T0 - T)) (1 - desat_hi clamp(rel - 1, 0, 1)))
dark  = clamp(0.5 (1 - rel) + (M - M0) + 0.5 (T0 - T), 0, 1)
per channel k:
  warm_k = 1 + (wv_k - 1) warm l dark
  body_k = lum max(0, 1 + (ch_k - 1) s) warm_k
  hl1_k  = k1' S1p (1 + (ch_k - 1) tint1')
  hl2_k  = k2 Y^e2 S2p max(0, 1 + (ch_k - 1) sat2)
  P_k    = body_k + spec (hl1_k + hl2_k)              (premultiplied, linear)
```

`spec` is `style.json` `look.spec`. Multiply `P` by the scene light `L` (step 7) before the
cross-fade. GLSL ES 1.0 has no `tanh`; use `tanh(x) = (1 - e^-2x) / (1 + e^-2x)` for x >= 0.

The same in JavaScript. It was checked against `colour.recolour` (section 13):

```js
// FORMAT.md reference: recolour
const RECOLOUR = {kd: 1.38, kd_light: .49, k_m: .55, k_ml: .6, M0: .52, T0: .50, tone: 1.6, tone_light: 1.2,
  sat: 1.08, sat_light: .22, sat_m: .6, sat_t: .8, sat_max: 1.35, D0: .6, contrast_light: .35, desat_hi: .15,
  warm: .6, warm_rgb: [1.25, 1, .72], k1: .075, k1_dark: .55, tint1: .55, tint1_light: .18, k2: .45, e2: .75,
  sat2: 1.15};
const LUMA709 = [.2126, .7152, .0722];
const toLin = c => c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function dyeTerms(hex, p = RECOLOUR) {                 // once per shade
  const c = [1, 3, 5].map(i => toLin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const Y = Math.max(dot3(c, LUMA709), 1e-4), l = Math.pow(Y, 1 / 2.2), wl = dot3(p.warm_rgb, LUMA709);
  return {Y, l, ch: c.map(v => v / Y), wv: p.warm_rgb.map(v => v / wl),
    kd: p.kd * (1 + p.kd_light * (l - .4)), gamma: 1 - p.contrast_light * l, tone: p.tone * (1 + p.tone_light * l),
    sat: p.sat * (1 - p.sat_light * l), k1: p.k1 * (p.k1_dark + (1 - p.k1_dark) * l),
    tint1: p.tint1 + (p.tint1_light - p.tint1) * l,
    absorb: Math.pow(Y, p.k_m) * Math.exp(-p.k_ml * l), y2: p.k2 * Math.pow(Y, p.e2)};
}
// premultiplied Dp, S1p, S2p; straight M, T; coverage A -> premultiplied linear [r, g, b]
function recolour(Dp, S1p, S2p, M, T, A, t, spec, p = RECOLOUR) {
  const a = Math.max(A, 1e-3), rel = Dp / a / p.D0;
  const Dc = a * p.D0 * Math.pow(Math.max(rel, 0), t.gamma);
  const lum = t.kd * t.Y * Dc * Math.exp(t.tone * (T - p.T0)) * Math.pow(t.absorb, M - p.M0);
  const s = Math.min(p.sat_max, t.sat * (1 + p.sat_m * (M - p.M0) + p.sat_t * (p.T0 - T))
    * (1 - p.desat_hi * Math.min(Math.max(rel - 1, 0), 1)));
  const dark = Math.min(Math.max(.5 * (1 - rel) + (M - p.M0) + .5 * (p.T0 - T), 0), 1);
  return [0, 1, 2].map(k => {
    const warm = 1 + (t.wv[k] - 1) * (p.warm * t.l * dark);
    const body = lum * Math.max(0, 1 + (t.ch[k] - 1) * s) * warm;
    const hl1 = t.k1 * S1p * (1 + (t.ch[k] - 1) * t.tint1);
    const hl2 = t.y2 * S2p * Math.max(0, 1 + (t.ch[k] - 1) * p.sat2);
    return body + spec * (hl1 + hl2);
  });
}
const shoulder = (x, k = .72) => x > k ? k + (1 - k) * Math.tanh((x - k) / (1 - k)) : x;   // straight colour
```

### Test vectors

These use `spec = 0.85` and light 1. The texel values are typical: the median, a deep root and
a lit highlight of the long style's front view, and a half-covered texel. The last column is
`shoulder(P / A)`.

| shade | texel | Dp | S1p | S2p | M | T | A | P (linear, premultiplied) | shoulder(P / A) |
|---|---|---|---|---|---|---|---|---|---|
| black | median | 0.6 | 0.12 | 0.11 | 0.52 | 0.5 | 1.0 | 0.01505, 0.01221, 0.01289 | 0.01505, 0.01221, 0.01289 |
| black | deep root | 0.22 | 0.005 | 0.01 | 0.78 | 0.34 | 1.0 | 0.00164, 0.00122, 0.00130 | 0.00164, 0.00122, 0.00130 |
| black | lit | 1.1 | 0.47 | 0.31 | 0.39 | 0.64 | 1.0 | 0.05025, 0.04255, 0.04437 | 0.05025, 0.04255, 0.04437 |
| dark-brown | median | 0.6 | 0.12 | 0.11 | 0.52 | 0.5 | 1.0 | 0.03706, 0.01998, 0.01447 | 0.03706, 0.01998, 0.01447 |
| dark-brown | deep root | 0.22 | 0.005 | 0.01 | 0.78 | 0.34 | 1.0 | 0.00548, 0.00243, 0.00145 | 0.00548, 0.00243, 0.00145 |
| dark-brown | lit | 1.1 | 0.47 | 0.31 | 0.39 | 0.64 | 1.0 | 0.10899, 0.06709, 0.05357 | 0.10899, 0.06709, 0.05357 |
| dark-brown | half coverage | 0.3 | 0.06 | 0.055 | 0.52 | 0.5 | 0.5 | 0.01853, 0.00999, 0.00724 | 0.03706, 0.01998, 0.01447 |
| light-blonde | median | 0.6 | 0.12 | 0.11 | 0.52 | 0.5 | 1.0 | 0.59429, 0.44253, 0.26758 | 0.59429, 0.44253, 0.26758 |
| light-blonde | deep root | 0.22 | 0.005 | 0.01 | 0.78 | 0.34 | 1.0 | 0.14965, 0.09729, 0.04409 | 0.14965, 0.09729, 0.04409 |
| light-blonde | lit | 1.1 | 0.47 | 0.31 | 0.39 | 0.64 | 1.0 | 1.50255, 1.20548, 0.86304 | 0.99792, 0.98306, 0.85177 |
| light-blonde | half coverage | 0.3 | 0.06 | 0.055 | 0.52 | 0.5 | 0.5 | 0.29714, 0.22126, 0.13379 | 0.59429, 0.44253, 0.26758 |
| platinum | median | 0.6 | 0.12 | 0.11 | 0.52 | 0.5 | 1.0 | 0.73505, 0.68180, 0.59483 | 0.73504, 0.68180, 0.59483 |
| platinum | deep root | 0.22 | 0.005 | 0.01 | 0.78 | 0.34 | 1.0 | 0.18725, 0.15799, 0.12074 | 0.18725, 0.15799, 0.12074 |
| copper | median | 0.6 | 0.12 | 0.11 | 0.52 | 0.5 | 1.0 | 0.34251, 0.07510, 0.02312 | 0.34251, 0.07510, 0.02312 |
| copper | lit | 1.1 | 0.47 | 0.31 | 0.39 | 0.64 | 1.0 | 0.81192, 0.25373, 0.14521 | 0.80875, 0.25373, 0.14521 |

### The 16 shades and their per-shade terms

| # | shade | hex | Y | ch (R, G, B) | l | kd' | gamma' | tone' | sat' | k1' | tint1' |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | black | `#1C1819` | 0.00970 | 1.1967, 0.9413, 1.0018 | 0.1216 | 1.1918 | 0.9574 | 1.8335 | 1.0511 | 0.04535 | 0.5050 |
| 2 | dark-brown | `#35251E` | 0.02174 | 1.6378, 0.8511, 0.5973 | 0.1755 | 1.2282 | 0.9386 | 1.9369 | 1.0383 | 0.04717 | 0.4851 |
| 3 | chocolate | `#4E3326` | 0.04127 | 1.8459, 0.8021, 0.4696 | 0.2348 | 1.2683 | 0.9178 | 2.0509 | 1.0242 | 0.04918 | 0.4631 |
| 4 | chestnut | `#69412C` | 0.06966 | 2.0280, 0.7589, 0.3616 | 0.2979 | 1.3110 | 0.8957 | 2.1720 | 1.0092 | 0.05130 | 0.4398 |
| 5 | hazel | `#835636` | 0.11747 | 1.9321, 0.7922, 0.3140 | 0.3778 | 1.3650 | 0.8678 | 2.3253 | 0.9902 | 0.05400 | 0.4102 |
| 6 | caramel | `#9C6A40` | 0.17746 | 1.8734, 0.8122, 0.2889 | 0.4557 | 1.4177 | 0.8405 | 2.4750 | 0.9717 | 0.05663 | 0.3814 |
| 7 | honey | `#B78A52` | 0.28853 | 1.6412, 0.8808, 0.2924 | 0.5684 | 1.4939 | 0.8011 | 2.6913 | 0.9450 | 0.06043 | 0.3397 |
| 8 | dark-blonde | `#9A815F` | 0.23397 | 1.3811, 0.9383, 0.4891 | 0.5167 | 1.4589 | 0.8191 | 2.5921 | 0.9572 | 0.05869 | 0.3588 |
| 9 | ash-blonde | `#A49A88` | 0.32781 | 1.1325, 0.9858, 0.7510 | 0.6023 | 1.5168 | 0.7892 | 2.7565 | 0.9369 | 0.06158 | 0.3271 |
| 10 | light-blonde | `#CBB088` | 0.45525 | 1.3118, 0.9537, 0.5408 | 0.6993 | 1.5824 | 0.7552 | 2.9426 | 0.9138 | 0.06485 | 0.2913 |
| 11 | platinum | `#DAD2C4` | 0.64984 | 1.0789, 0.9917, 0.8495 | 0.8221 | 1.6654 | 0.7123 | 3.1784 | 0.8847 | 0.06900 | 0.2458 |
| 12 | copper | `#A44F28` | 0.13638 | 2.7221, 0.5733, 0.1556 | 0.4043 | 1.3829 | 0.8585 | 2.3762 | 0.9839 | 0.05490 | 0.4004 |
| 13 | mahogany | `#692B25` | 0.04865 | 2.9039, 0.4966, 0.3803 | 0.2530 | 1.2806 | 0.9114 | 2.0859 | 1.0199 | 0.04979 | 0.4564 |
| 14 | burgundy | `#5E1F2C` | 0.03542 | 3.1606, 0.3869, 0.7112 | 0.2190 | 1.2576 | 0.9233 | 2.0206 | 1.0280 | 0.04864 | 0.4690 |
| 15 | rose-gold | `#BF8A7F` | 0.30786 | 1.6923, 0.8256, 0.6894 | 0.5854 | 1.5053 | 0.7951 | 2.7239 | 0.9409 | 0.06101 | 0.3334 |
| 16 | silver | `#9C9A9E` | 0.32648 | 1.0183, 0.9898, 1.0473 | 0.6012 | 1.5161 | 0.7896 | 2.7543 | 0.9372 | 0.06154 | 0.3276 |

The recolour does not depend on the style. A change to `RECOLOUR` must be made in
`colour.py` and in the runtime together, and checked with `qa.py --palette`.

---------------------------------------------------------------------------------------------

## 10. Under the hair: scalp, cast shadow, composite

The reference composites in **linear light**. `img` is the frame converted with
`srgb_to_lin`. Blur sigmas are in frame pixels; `hu` is pixels per head unit from step 3.
`own` is the segmenter's hair confidence (0..1) at frame resolution, or absent.

**Base.** `base = img`, or the frame with the user's own hair hidden (section 11).

**Scalp.** It is painted only where the user has hair of their own (painted skin over bare
skin would only flatten its texture):

```
sa = scalp                                                   (union, step 7)
if own:     sa *= clamp(blur(own, max(0.8, 0.006 hu)) / 0.5, 0, 1)
            sa *= 1 - own * (1 - clamp(blur(A, max(0.6, 0.015 hu)) / 0.9, 0, 1))
base = base (1 - sa) + skin_field * (0.95 - 0.6 shadow) * sa
```

* The second `own` line keeps the user's short own hair rather than painting a pale band where
  the new style is thin over a broad area: short sides, fades, sparse temples. Narrow gaps such
  as a parting are surrounded by dense hair, so they are still painted.
* Without a segmenter mask (`own` absent), `sa = scalp`.

`skin_field` is the user's own skin carried up from the face, so a parting or the forehead
between curtain bangs continues the forehead's tone:

* The **source** pixels are those inside the `FACE_OVAL` landmark polygon whose linear luma
  (Rec.709) is between 0.65x and 1.4x the skin reference, and with `own < 0.2` when there is a
  mask. This excludes eyes, brows, lips and deep shadow.
* The **skin reference** is the median linear colour inside the convex hulls of three patches:
  forehead `[108, 151, 337, 9]`, cheek `[117, 118, 101, 36, 205, 187, 123]` and cheek
  `[346, 347, 330, 266, 425, 411, 352]`.
* The field is spread from the source pixels by multi-scale normalised convolution
  (`runtime.fill_from`, sigmas 3..192 px). On a GPU, a mip chain of `img * src` and `src`,
  sampled at a coarse level and divided, does the same job.
* With fewer than 50 source pixels, the field is the skin reference everywhere.

**Cast shadow.** `base *= 1 - 0.32 * blur(shadow, max(0.5, 0.02 hu))`. This darkens skin and
clothes around and under the hair, including the painted scalp.

**Composite.**

```
out  = H + base (1 - A)                   H = shoulder(C) A from step 7
out  = out (1 - A) + blur(out, 0.25) A    (sigma 0.25 px: practically a no-op; a runtime may skip it)
srgb = lin_to_srgb(out)
srgb += n * 0.8 * sigma_photo * A         n ~ N(0, 1), one value per pixel for all three channels
```

`sigma_photo` is the photo's noise level: `1.4826 * median|g - blur(g, 1.2)|`, where `g` is the
Rec.601 luma of the sRGB frame. The grain stops the new hair looking cleaner than the camera
image. It can be estimated every few frames.

Hard edges: the mesh depth test and the occluder cut give 1-px hard edges in the reference too.
MSAA is welcome but not required to match it.

---------------------------------------------------------------------------------------------

## 11. Own-hair hiding and the tie-back hint (optional)

A short style over long own hair needs the own hair removed. `runtime.hide_own_hair` is the
reference. It is experimental, and the judges' safeguards are part of it.

* **Own hair**: segmenter confidence with hysteresis (strong > .4, weak > .06, kept when
  connected to strong), plus a Lab colour model of this person's hair. It is never taken
  straight under the chin, where dark collars fool the segmenter.
* **Protected zone**: the face oval below the brow line (landmarks 105 to 334, raised by 6 % of
  the face height) is never filled. Eyes, brows, nose and mouth are never touched.
* **Kept**: short, skull-hugging own hair right next to the new style (95th percentile
  thickness < .20 head units) is kept and recoloured to the new hair's median colour, keeping
  its own light and shade. It reads as the cut's short sides.
* **Filled**:
  * outside the head (the `head` layer), from the background only, carried along rays from the
    head centre;
  * below the shoulder line (`A @ (0.5, 1.30)`), from the clothes;
  * inside the head, from the face's skin.
  It never fills from the face, the proxy `body` or own hair, and no ears are invented.
* **Tie-back hint**: the report says `hint = 'tie-back'` and **nothing is hidden** when any of
  these holds:
  * own hair outside the new style and head (dilated .04 head units) exceeds 0.35 x the face
    area;
  * own fringe in the protected zone left bare by the new style exceeds 0.065 x the face area;
  * more than 10 % of the face area could not be filled.

  The app should then show "tie / pin your hair back" over the plain new style, instead of
  shipping smears.
* A close camera sees only part of big hair. Decide the hint on frames that show the whole head
  and keep the decision for close-ups (the reference's `opts['hint']`).

The Android app's native renderer has no segmenter, and hair products are hidden there
(`nativeMirror`). Hairstyles need the same treatment until the native side implements this
format.

---------------------------------------------------------------------------------------------

## 12. WebGL 1 implementation notes

This is a suggested plan, not normative. The reference is the numbers above.

* **Per style at load**:
  * decode and upload the 4 textures of each view, with mipmaps (section 6);
  * decode the half-resolution Z on the CPU and build each view's grid vertex buffer:
    `(x, y, z, u, v)` per vertex, 4 225 vertices for a 512 x 512 frame and 8 385 for
    512 x 1024.
* **Per shade change**: the per-shade terms (section 9), as uniforms.
* **Per frame**:
  * yaw, view weights and `A` on the CPU (a 20-point least-squares fit);
  * the occluder vertices (468 face vertices from the landmarks plus 17 skirt and 119 neck
    vertices), as a dynamic buffer;
  * the face-probe light, which the stage already computes for the hair-colour product.
* **Drawing each view** (at most 2) into an offscreen target the size of the head's box on the
  frame, with a depth renderbuffer:
  1. Clear, then draw the occluder at depth `z_occ - 0.05`, depth only.
  2. Draw the grid. The vertex shader turns by `yaw - v` about PIVOT and applies `A`.
  3. The fragment shader samples, decodes and recolours.
  4. Store the straight colour `P/A` gamma-encoded in RGB and `A` in alpha.
  5. Draw the grid again into a second target (same depth buffer, `LEQUAL`) for scalp and
     shadow (and head and body if you hide own hair).

  RGBA8 is enough because the colour is stored straight and encoded. `WEBGL_draw_buffers`,
  where present, saves the second pass.
* **Final pass** over the head's box:
  * union and mean colour from the two views' targets;
  * shoulder, scalp, cast shadow (the shadow blurred on a reduced target), composite and grain.
* **Precision**: use `highp` where available. Dark shades reach linear values around 1e-3,
  which mediump represents but with few bits; storing straight colour gamma-encoded avoids
  8-bit banding.
* **Resolution**: the sprites are 224 to 320 texels per head unit. On the 512-px QA portraits
  the head spans 160-180 px per head unit, and about twice that on the 2x close-ups. A close
  camera therefore magnifies the sprite a little, and the bilinear filter makes it soft, not
  blocky.

---------------------------------------------------------------------------------------------

## 13. Checking an implementation

* **Recolour**: reproduce the test vectors in section 9. The JavaScript above matches
  `colour.recolour` and `colour.shoulder` to float32 precision: max abs difference 2.3e-6 on
  5 000 random texels for each of the 16 shades.
* **This document**: an independent numpy implementation of sections 3 to 9, written from this
  text alone, reproduced the reference `runtime.render_layers` (A, hair, scalp and shadow). The
  mean difference was below 5e-6. Fewer than 12 pixels per frame differed by more than 1e-3,
  all on triangle-edge ties. It was run on two portraits and four yaws, including two-view
  cross-fades.
* **Decoding and placement**: `cd tools/hair-bake && python3 qa.py <id> --selfcheck`. It checks
  four things:
  * Drawing each view at its own yaw, 1:1 onto the sprite frame, reproduces the decoded
    layers exactly (max |d| 0).
  * A view re-posed by parallax to its neighbour's yaw overlaps it (coverage IoU .72 - .83 on
    the current styles). The rest is hair that one view hides.
  * The landmark yaw agrees with the matrix yaw (0.40 deg rms).
  * Run it on both shipped styles; it exits 1 on a failure.
* **Whole frames**: run the browser runtime on the public test portraits and compare with
  `build/qa/<style>/tiles/<portrait>__<shade>__1x.png` from
  `python3 qa.py <id> --shades dark-brown,light-blonde`.
  * The portraits are `tools/face-test.png` and the public-domain `pd_*` set. Their landmarks,
    matrix and hair mask come from the site's own MediaPipe via `tools/hair-bake/detect.cjs`.
  * The reference can be driven from Python for any frame: `runtime.composite(img_srgb, det,
    runtime.load_sprite('hairstyles/<id>'), '#CBB088', hair_mask=...)` with
    `det = canon.load_detection('<name>.json')`.
* **The turntable** (`qa.py <id> --turntable`) shows the style on the proxy body from -40 to
  +40 deg through the runtime: cross-fade and parallax with no photo.

---------------------------------------------------------------------------------------------

## 14. Versioning

`format = "roja-hairstyle"`, `version = 1`. A runtime should refuse other formats and newer
major versions.

These changes keep version 1:

* more or different view yaws (read them from `views`);
* other frame sizes or `res`;
* different `bits`, `scale` or `z` values (always read them from the file);
* new informational fields.

These changes need version 2:

* a different channel layout, a new encoding or a change to the coordinate frame;
* a change to the meaning of a channel.

A change of `colour.RECOLOUR`, `SCENE_GAMMA`, `FACE_EPS`, the grid spacing or the
cross-fade rule is a runtime change, not a format change. Make it in `runtime.py` / `colour.py`
and in the site together.
