"""m-textured-crop: short faded sides and back, 4-6 cm textured top pushed forward with a
slight sweep into a piecey fringe on the upper forehead.

Port of proto-a's C12 onto the shared groom library (first draft; to be refined against the
quality checklist).  Recipe:
  * scalp: men's hairline with a slight temple recession, soft 5 mm falloff;
  * every strand walks over the skull (short_hair): sides and back faded from ~1.5 mm low
    on the head to ~1.2 cm up top, combed down and back flat to the head; the top section
    (inside the parietal ridges) 4.5-5 cm, pushed forward with a sweep to the viewer's left,
    standing 1.5-2.5 cm off the scalp; the front pieces come down onto the forehead;
  * ~900 pieces with their own yaw, length and wander (messy, not combed), two-level
    clumping into pointed pieces (matte texture);
  * a skin fade: hair thins out low on the sides and nape so the scalp shows;
  * flyaways on top.
"""
import numpy as np
from hairbake import groom as g

STYLE = dict(id='m-textured-crop', name='کراپ تکسچر', group='men')
RENDER = dict(taper=(0.55, 1.0), fine_ao_r=0.008, fine_ao_d=0.010, fine_ao_min=0.35)


def build(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('men', recession=0.3, jitter=0.007), soft=0.03, edge=0.22)
    hair = g.Hair(scalp, q, STYLE['id'])
    r = scalp.roots(int(120000 * q), rng)
    top = g.top_section(r)
    front = g.smoothstep(-0.15, 0.18, r.z) * top
    back = g.smoothstep(-0.45, -0.75, r.z)
    side_len = g.fade_length(r, 0.010, 0.075, 0.50, -0.08) * (1 - 0.7 * g.smoothstep(-0.2, 0.1, r.z) * g.smoothstep(0.05, 0.25, r.y))
    top_len = (0.27 + 0.05 * rng.random(len(r))) * (1 - 0.35 * back) + 0.05 * front * g.smoothstep(0.12, 0.0, r.dist)
    L = side_len * (1 - top) + top_len * top
    fwd = g.tangent(np.stack([0.45 * r.side * g.smoothstep(0.20, 0.42, np.abs(r.x - 0.5)) - 0.38, -0.10 + 0 * r.x,
                              np.ones(len(r))], -1), r.n)
    down_back = g.tangent(np.stack([0.10 * r.side, np.ones(len(r)), -np.ones(len(r))], -1), r.n)
    sd = g.tangent(fwd * top[:, None] + down_back * (1 - top[:, None]), r.n)
    H = (0.105 + 0.05 * rng.random(len(r))) * top * (1 - 0.45 * back) * (0.55 + 0.45 * g.smoothstep(0.0, 0.10, r.dist)) \
        + (0.012 + 0.012 * g.smoothstep(0.45, 0.0, r.y)) * (1 - top)
    h_end = rng.normal(0.004, 0.028, len(r)) * top * (1 - front) - 0.75 * H * front
    s, piece = g.short_hair(r, rng, L, sd, H, nv=40, h_end=h_end, texture=top, log=log)
    op, wd = g.skin_fade(r, top=top)
    s.set(opacity=0.92 * op, width_u=0.0010 / np.sqrt(q) * wd * rng.uniform(0.75, 1.25, len(r)))
    hair.add(s)
    sel = rng.choice(np.where(top > 0.5)[0], max(4, int(0.008 * len(r))), replace=False)
    hair.add(g.flyaways(s.P, rng, sel=sel, start=(0.0, 0.0), amp=(0.014, 0.015)), kind='flyaway')
    return hair.finish(rng, look=dict(albedo_lock=0.20, albedo_strand=0.14, tone_lock=0.14, tone_end=0.12, end_len=0.3))
