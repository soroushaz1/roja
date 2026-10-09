"""m-textured-crop: short tapered sides and back, a 4-6 cm textured top pushed forward with
a slight sweep into a choppy, broken fringe on the upper forehead.

Recipe (port of proto-a's C12, brought up to the quality checklist):
  * scalp: men's hairline with a slight temple recession and a soft falloff;
  * every strand walks over the skull (short_hair), in two sections that share one length /
    height / direction field so they blend without a seam:
      - sides and back: a taper from ~1.5 mm low on the head to ~1.2 cm up top, combed down
        and back flat to the head, smooth (no piece texture, hardly any clumping: a clumped
        fade reads as spots);
      - the top (inside the parietal ridges): 4.5-5 cm, pushed forward with a sweep to the
        viewer's left, standing 1.5-2.5 cm off the scalp, in ~700 pieces with their own yaw,
        length and a gentle bend, clumped into pointed pieces (matte, piecey - not curly);
        the front pieces come down onto the forehead at irregular lengths;
  * the taper thins the hair low on the sides and the nape a little so the skin shows
    through, but keeps the sideburns;
  * flyaways on top.
"""
import numpy as np
from hairbake import groom as g

STYLE = dict(id='m-textured-crop', name='کراپ تکسچر', group='men')
RENDER = dict(taper=(0.55, 1.0), fine_ao_r=0.008, fine_ao_d=0.010, fine_ao_min=0.40, res=320, max_hair_px=140000, spec=0.85)


def build(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('men', recession=0.3, jitter=0.007), soft=0.03, edge=0.22)
    hair = g.Hair(scalp, q, STYLE['id'])
    r = scalp.roots(int(120000 * q), rng)
    top = g.top_section(r)
    front = g.smoothstep(-0.15, 0.18, r.z) * top
    back = g.smoothstep(-0.45, -0.75, r.z)
    side_len = g.fade_length(r, 0.010, 0.075, 0.50, -0.08) * (1 - 0.6 * g.smoothstep(-0.2, 0.1, r.z) * g.smoothstep(0.05, 0.25, r.y))
    # the top: 4.5-5 cm, shorter behind the crown; the front roots are cut short so the
    # fringe ends 2-4 cm above the brows (the roots behind them lie on top and reach about
    # as far): a choppy edge on the upper forehead, not a curtain down to the eyebrows
    top_len = (0.27 + 0.05 * rng.random(len(r))) * (1 - 0.35 * back) * (1 - 0.42 * front * g.smoothstep(0.17, 0.0, r.dist))
    L = side_len * (1 - top) + top_len * top
    fwd = g.tangent(np.stack([0.45 * r.side * g.smoothstep(0.20, 0.42, np.abs(r.x - 0.5)) - 0.38, -0.10 + 0 * r.x,
                              np.ones(len(r))], -1), r.n)
    down_back = g.tangent(np.stack([0.10 * r.side, np.ones(len(r)), -np.ones(len(r))], -1), r.n)
    sd = g.tangent(fwd * top[:, None] + down_back * (1 - top[:, None]), r.n)
    H = (0.105 + 0.05 * rng.random(len(r))) * top * (1 - 0.45 * back) * (0.55 + 0.45 * g.smoothstep(0.0, 0.10, r.dist)) \
        + (0.010 + 0.010 * g.smoothstep(0.45, 0.0, r.y)) * (1 - top)
    h_end = rng.normal(0.006, 0.028, len(r)) * top * (1 - front) - 0.70 * H * front
    # the two sections: dithered across the blend so there is no line where they meet
    is_top = (top + 0.25 * (g.hash01(r.p, 5) - 0.5)) > 0.5
    op, wd = g.skin_fade(r, y0=0.22, y1=0.52, strength=0.30, top=top)
    width = 0.0010 / np.sqrt(q) * wd * rng.uniform(0.75, 1.25, len(r))
    groups = []
    for sel, kw in ((~is_top, dict(pieces=200, piece_yaw=0.10, piece_len=0.05, strand_yaw=0.05, bend=0.0,
                                   clumps=((4000, 0.0, 0.18, 1.0),), frizz=(0.0002, 0.0006))),
                    (is_top, dict(pieces=700, piece_yaw=0.30, piece_len=0.18, strand_yaw=0.05, bend=0.20,
                                  clumps=((900, 0.05, 0.62, 0.8), (6000, 0.08, 0.30, 1.0)), frizz=(0.0003, 0.0012)))):
        rs = r.take(sel)
        s, _ = g.short_hair(rs, rng, L[sel], sd[sel], H[sel], nv=40, h_end=h_end[sel], texture=top[sel], log=log, **kw)
        s.set(opacity=0.92 * op[sel], width_u=width[sel])
        hair.add(s)
        groups.append(s)
    tp = groups[1]
    sel = rng.choice(tp.n, max(4, int(0.006 * tp.n)), replace=False)
    hair.add(g.flyaways(tp.P, rng, sel=sel, start=(0.0, 0.0), amp=(0.012, 0.012)), kind='flyaway')
    # tone: only slightly lighter ends and darker roots - the recolour amplifies tone for
    # light shades, and more (.12 / -.16) gave blondes white frosted tips
    return hair.finish(rng, look=dict(albedo_lock=0.20, albedo_strand=0.14, tone_lock=0.14, tone_end=0.05, end_len=0.3,
                                      tone_root=-0.12))
