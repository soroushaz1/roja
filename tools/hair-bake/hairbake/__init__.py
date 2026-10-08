"""Roja's offline hair bake: the shared library.

Layout (tools/hair-bake/):
  hairbake/canon.py     the canonical head frame ("head units" = facemesh.js CANON frame, y down,
                        z toward the viewer), MediaPipe model <-> head units, the 20 headFit
                        ANCHORS and their affine fit, yaw rotation about PIVOT, the facial
                        transformation matrix (pose, perspective projection), detect.cjs results.
  hairbake/head.py      the CC0 MakeHuman head / neck / torso / upper arms fitted and warped onto
                        the canonical face (skull top eased to real-head height), its collision
                        SDF (collide / project / normal), the per-view occluder and part masks,
                        and the sprite Frame.
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
  build/                git-ignored: compiled library, SDF cache, portraits, test renders.

Every module works in head units; see canon.py for the exact definition.
"""
