"""Roja's offline hair bake: the shared library.

Layout (tools/hair-bake/):
  hairbake/canon.py     the canonical head frame ("head units" = facemesh.js CANON frame, y down,
                        z toward the viewer), MediaPipe model <-> head units, the 20 headFit
                        ANCHORS and their affine fit, yaw rotation about PIVOT, the facial
                        transformation matrix (pose, perspective projection), detect.cjs results.
  hairbake/head.py      the CC0 MakeHuman head / neck / torso / upper arms fitted and warped onto
                        the canonical face (skull top eased to real-head height), its collision
                        SDF without the arms (collide / project / normal), the per-view occluder
                        and part masks, and the sprite Frame.
  hairbake/native.py    ctypes bindings to raster.c (strand rasterizer with occlusion, z-buffered
                        triangles, density splats), compiled on first use into build/.
  hairbake/scalp.py     where hair grows: Hairline (women / men tables, jitter, recession, widow's
                        peak), Parting (narrow zig-zag part line, z_front / z_back), Scalp (density
                        with a soft falloff inside the hairline, ears excluded, root sampling, blue
                        noise for guides), Roots, the skull frame (azimuth, elevation, crown,
                        surface_z, face_halfwidth), hash01 (dithered section edges).
  hairbake/grow.py      growth integrators: grow (proto-a gravity + volume shells), grow_two_phase
                        (proto-b comb-then-fall), surface_walk (short hair), curve_from_root,
                        gather_walk (updos), bezier / catmull / on_surface; force fields: shoulder
                        front/back decision, straight drape, face framing, ear clearing.
  hairbake/strands.py   strand-array operations: resample / cut, frames (parallel transport),
                        interpolate (guides -> dense), children (proto-b locks), clump, frizz,
                        smooth_field, wave, helix (curls, ropes), bend_ends, ragged_lengths,
                        flyaways, strays, collide_strands.
  hairbake/features.py  the high-level primitives styles assemble: long_hair, short_hair (+ fades),
                        curtain_bangs, fringe, baby_hairs, curly_locks, ponytail, bun, wrap.
  hairbake/hair.py      Strands / Hair containers, per-strand appearance attributes and defaults,
                        Hair.check(), load_style (styles/<id>.py).
  hairbake/groom.py     all of the above in one namespace: `from hairbake import groom as g`.
  hairbake/volume.py    deep-opacity helpers for the shader (proto-a): hair optical depth toward a
                        light, soft body visibility through the SDF, Fibonacci directions.
  hairbake/shade.py     per-vertex shading in neutral channels (proto-a): deep-opacity key-light
                        self-shadow, hair + body ambient occlusion, Marschner-style R (S1) and TRT
                        (S2) lobes with per-strand jitter, M (depth into the hair); Shader(S, attrs)
                        does the view-independent work once, .view(yaw) per baked view.
  hairbake/render.py    one view: the groom turned by the view's yaw, rasterised against the turned
                        body (hard head/torso, arms only for hair behind the shoulders, soft neck
                        edge), clump-gap AO; body layers (cast shadow, scalp, head / face / body
                        masks); finish_view -> the shipped float channels; sprite_frame (POT sides).
  hairbake/pack.py      the shipped files: lossless RGB WebP per view (hair / aux / mask / depth)
                        + style.json; read_style / upsample read them back (LAYOUT, BITS).
  hairbake/colour.py    sRGB <-> linear, the catalog.js HAIR palette, the calibrated reference
                        recolour (dye_terms, recolour, shoulder).
  hairbake/runtime.py   the REFERENCE RUNTIME: a packed style placed on a photo as the site will do
                        it (yaw from the matrix or landmarks, view weights, anchor fit at the current
                        yaw, parallax grid mesh, the face mesh as occluder, mip-filtered sampling
                        of the encoded textures, recolour, union cross-fade, scene light,
                        skin-field scalp, cast shadow,
                        grain), proto-a's own-hair hiding with safeguards, and the existing
                        hair-colour product (for calibration).
  qa.py                 composites styles on the test portraits (public / internal, mirrored and
                        rotated variants, 1x and 2x), contact sheets, turntable, palette checks:
                            python3 qa.py <style-id> [--set public|internal|all] [--palette] [--turntable]
  hairbake/bake.py      the command line: groom -> shade -> 3 views -> pack -> preview:
                            python3 -m hairbake.bake <style-id | path | demo:name> [--q 1] [--views -30,0,30]
                        -> <repo>/hairstyles/<id>/ and build/bake/<id>/preview.png
  hairbake/preview.py   quick shape previews of a style from any yaw / pitch:
                            python3 -m hairbake.preview <style-id | path | demo:name> [--q .25]
  hairbake/demos.py     demo grooms, one per primitive family (templates for style authors).
  hairbake/groomtest.py checks every demo (Hair.check) and writes build/preview/demos.png:
                            python3 -m hairbake.groomtest [--q .15]
  styles/<id>.py        one module per hairstyle: STYLE = dict(id, name, group), build(rng, q, log).
  hairbake/selftest.py  numeric checks and test renders of the core (canon, head, native):
                            node tools/hair-bake/detect.cjs --out tools/hair-bake/build/portraits <images>
                            cd tools/hair-bake && python3 -m hairbake.selftest
                        -> build/selftest/{views,sdf,raster,portraits}.png
  detect.cjs            landmarks + matrix + hair mask of still images with the site's own MediaPipe.
  assets/makehuman/     the MakeHuman base-mesh extract (CC0) and the script that rebuilds it.
  build/                git-ignored: compiled library, SDF / body-AO caches, portraits, test renders,
                        bake caches (build/bake/<id>/: groom and per-view layers, preview.png).

Every module works in head units; see canon.py for the exact definition.
"""
