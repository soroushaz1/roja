"""The groom library in one namespace, for style modules:

    from hairbake import groom as g

    STYLE = dict(id='w-example', name='...', group='women')

    def build(rng, q=1.0, log=print):
        scalp = g.Scalp(g.Hairline('women', jitter=.008), g.Parting(x=.5))
        hair = g.Hair(scalp, q, STYLE['id'])
        out = g.long_hair(scalp, rng, q, accept=..., waves=dict(amp=.02))
        hair.add(out['strands'])
        hair.add(g.baby_hairs(scalp, rng, int(400 * q)))
        hair.add(g.flyaways(out['strands'].P, rng, .01), kind='flyaway')
        return hair.finish(rng)

What is where (each module's docstring has the details):
  scalp.py     units (CM, MM), vectors (unit, tangent, rotate_about), the skull frame
               (azimuth, elevation, crown, surface_z, surface_point, face_halfwidth),
               Hairline, Parting, Scalp, Roots, ear_mask
  grow.py      grow, grow_two_phase, surface_walk, curve_from_root, gather_walk, bezier,
               catmull, on_surface; fields: combine, shoulder_field, decide_front,
               drape_field, face_frame_field, face_clear_field, ear_clear_field, toward_field
  strands.py   arclen, lengths, sample_at, resample, cut_at_y, cut, tangents, frames,
               interpolate, children, clump, smooth_noise, frizz, radial_dir, wave, helix,
               bend_ends, ragged_lengths, flyaways, strays, collide_strands
  features.py  growth_direction, part_comb, part_comb_field, long_hair, layered_cut,
               short_hair, top_section, fade_length, skin_fade, bang_section,
               curtain_bangs, fringe_section, fringe, baby_hairs, curly_locks,
               curl_centre_length, gather_point, wrap, ponytail, bun
  hair.py      KIND, Strands, Hair, load_style
  head.py      the body: collide / project / normal / body_sdf, skull, Frame
"""
from .scalp import (CM, MM, unit, tangent, rotate_about, azimuth, elevation, crown, surface_z, surface_point,
                    face_halfwidth, Hairline, Parting, Scalp, Roots, ear_mask, hash01, sample_surface, HAIRLINES)
from .grow import (grow, grow_two_phase, surface_walk, curve_from_root, gather_walk, bezier, catmull, on_surface,
                   combine, shoulder_field, decide_front, drape_field, face_frame_field, face_clear_field, ear_clear_field,
                   toward_field, Step, DOWN)
from .strands import (arclen, lengths, sample_at, resample, resample_attr, cut_at_y, cut, tangents, frames,
                      interpolate, children, clump, smooth_noise, smooth_field, frizz, radial_dir, wave, helix, bend_ends,
                      ragged_lengths, flyaways, strays, collide_strands)
from .features import (growth_direction, part_comb, part_comb_field, long_hair, layered_cut, short_hair, top_section,
                       fade_length, skin_fade, bang_section, curtain_bangs, fringe_section, fringe, baby_hairs,
                       curly_locks, curl_centre_length, gather_point, wrap, ponytail, bun,
                       CURTAIN_INNER, CURTAIN_OUTER)
from .hair import KIND, Strands, Hair, load_style
from .head import smoothstep, collide, project, normal, body_sdf, skull
