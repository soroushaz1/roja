"""Demo grooms: one per family of primitives, small enough to read as templates.

    python3 -m hairbake.preview demo:<name> [--q .25]

  long      long layers + curtain bangs, centre part (the proto-a L5 recipe on the library)
  sleek     very straight, two-phase comb-then-fall growth, deep side part, no bangs
  locks     long hair densified by guide + children (proto-b) instead of interpolation
  waves     long beach waves, side part
  bob       chin-length bob with a full brow-skimming fringe (fringe + layered_cut)
  crop      men's textured crop: faded sides, piecey forward top (the proto-a C12 recipe)
  sidepart  men's side part: combed-over top, tapered sides
  buzz      buzz cut, natural growth direction, scalp showing
  curls     shoulder-length ringlets (curly_locks)
  pony      high ponytail (gather_walk + tail + wrap)
  bun       low bun (twisted rope coil)
"""
import numpy as np
from . import groom as g


def _extras(hair, out, rng, q, fly=0.012, stray=0.004, baby=0.006, scalp=None):
    S = out['strands'].P
    if fly:
        hair.add(g.flyaways(S, rng, fly), kind='flyaway')
    if stray:
        r = out['roots']
        top = r.take((r.y < 0.1) & (np.abs(r.phi) < 2.4) & (np.abs(r.x - 0.5) > 0.03))
        hair.add(g.strays(top, rng, max(4, int(stray * len(S)))), kind='stray')
    if baby:
        hair.add(g.baby_hairs(scalp or hair.scalp, rng, max(8, int(baby * len(S)))))


def long(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'), g.Parting(0.5))
    bang = g.bang_section(scalp, 0.20, 0.13)
    hair = g.Hair(scalp, q, 'demo:long')
    out = g.long_hair(scalp, rng, q, accept=lambda P, N: ~bang(P, N), waves=dict(amp=0.026), log=log)
    hair.add(out['strands'])
    b, _ = g.curtain_bangs(scalp, rng, int(4500 * q))
    hair.add(b)
    _extras(hair, out, rng, q)
    return hair.finish(rng)


def sleek(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'), g.Parting(0.40, drift=-0.01))
    hair = g.Hair(scalp, q, 'demo:sleek')
    out = g.long_hair(scalp, rng, q, method='two_phase', volume=(0.03, 0.035), crown_lift=0.008, flat_front=0.3,
                      cut=lambda r, rng, lock: g.layered_cut(r, rng, lock, length_y=2.45, centre_shorter=0.05, frame=False, jitter=(0.02, 0.01)),
                      ends=dict(amount=0.02, under=0.9), clumps=((900, 0.05, 0.35, 1.0), (5000, 0.15, 0.30, 1.0)),
                      frizz=(0.0008, 0.0012), stray=(0.01, 0.002, 0.006), log=log)
    hair.add(out['strands'])
    _extras(hair, out, rng, q, fly=0.004, stray=0.0015)
    return hair.finish(rng, look=dict(albedo_lock=0.15, albedo_strand=0.12, tone_lock=0.08))


def locks(rng, q=1.0, log=print):
    """long hair densified with proto-b's guide + children (chunkier locks), deep side part."""
    scalp = g.Scalp(g.Hairline('women'), g.Parting(0.36, drift=-0.02))
    hair = g.Hair(scalp, q, 'demo:locks')
    out = g.long_hair(scalp, rng, q, dense='children', volume=(0.06, 0.08), asym=0.2,
                      waves=dict(amp=0.02, wavelength=(0.5, 0.7), start=0.6), log=log)
    hair.add(out['strands'])
    _extras(hair, out, rng, q)
    return hair.finish(rng)


def waves(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'), g.Parting(0.37, drift=-0.02))
    hair = g.Hair(scalp, q, 'demo:waves')
    out = g.long_hair(scalp, rng, q, volume=(0.06, 0.09), asym=0.25,
                      waves=dict(amp=0.040, wavelength=(0.42, 0.58), start=0.45, ramp=0.5, lateral=0.7),
                      ends=dict(amount=0.03, under=0.5), log=log)
    hair.add(out['strands'])
    _extras(hair, out, rng, q, fly=0.018)
    return hair.finish(rng)


def bob(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'), g.Parting(0.5, width=0.0035, z_front=0.16))
    sec = g.fringe_section(scalp, half_width=0.30, depth=0.16)
    hair = g.Hair(scalp, q, 'demo:bob')
    out = g.long_hair(scalp, rng, q, n=80000, length=1.6, nv=70, nv_out=50, accept=lambda P, N: ~sec(P, N),
                      volume=(0.05, 0.06), shoulders=False, drape=False,
                      cut=lambda r, rng, lock: g.layered_cut(r, rng, lock, length_y=1.08, back_extra=-0.12, centre_shorter=0.0,
                                                             frame=False, jitter=(0.025, 0.012)),
                      ends=dict(amount=0.035, under=0.95, start=0.7), log=log)
    hair.add(out['strands'])
    f, _ = g.fringe(scalp, rng, int(9000 * q), sec, end_y=0.19, arch=0.05, h=0.010, h_back=0.02)
    hair.add(f)
    _extras(hair, out, rng, q, fly=0.008, baby=0.0)
    return hair.finish(rng)


def crop(rng, q=1.0, log=print):
    hl = g.Hairline('men', recession=0.3)
    scalp = g.Scalp(hl, soft=0.03)
    hair = g.Hair(scalp, q, 'demo:crop')
    r = scalp.roots(int(120000 * q), rng)
    top = g.top_section(r)
    front = g.smoothstep(-0.15, 0.18, r.z) * top
    back = g.smoothstep(-0.45, -0.75, r.z)
    side_len = g.fade_length(r, 0.010, 0.075, 0.50, -0.08) * (1 - 0.7 * g.smoothstep(-0.2, 0.1, r.z) * g.smoothstep(0.05, 0.25, r.y))
    top_len = (0.27 + 0.05 * rng.random(len(r))) * (1 - 0.35 * back) + 0.05 * front * g.smoothstep(0.12, 0.0, r.dist)
    L = side_len * (1 - top) + top_len * top
    fwd = g.tangent(np.stack([0.45 * r.side * g.smoothstep(0.20, 0.42, np.abs(r.x - 0.5)) - 0.38, -0.10 + 0 * r.x, np.ones(len(r))], -1), r.n)
    down_back = g.tangent(np.stack([0.10 * r.side, np.ones(len(r)), -np.ones(len(r))], -1), r.n)
    sd = g.tangent(fwd * top[:, None] + down_back * (1 - top[:, None]), r.n)
    H = (0.105 + 0.05 * rng.random(len(r))) * top * (1 - 0.45 * back) * (0.55 + 0.45 * g.smoothstep(0.0, 0.10, r.dist)) \
        + (0.012 + 0.012 * g.smoothstep(0.45, 0.0, r.y)) * (1 - top)
    h_end = rng.normal(0.004, 0.028, len(r)) * top * (1 - front) - 0.75 * H * front
    s, piece = g.short_hair(r, rng, L, sd, H, nv=40, h_end=h_end, texture=top, log=log)
    op, wd = g.skin_fade(r, top=top)
    s.set(opacity=0.92 * op, width_u=0.0010 / np.sqrt(q) * wd * rng.uniform(0.75, 1.25, len(r)))
    hair.add(s)
    hair.add(g.flyaways(s.P, rng, sel=rng.choice(np.where(top > 0.5)[0], int(0.008 * len(r)), replace=False),
                        start=(0.0, 0.0), amp=(0.014, 0.015)), kind='flyaway')
    return hair.finish(rng, look=dict(albedo_lock=0.20, albedo_strand=0.14, tone_lock=0.14, tone_end=0.12))


def sidepart(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('men', recession=0.2), g.Parting(0.33, drift=0.0, width=0.004))
    hair = g.Hair(scalp, q, 'demo:sidepart')
    r = scalp.roots(int(110000 * q), rng)
    top = g.top_section(r, half_width=(0.46, 0.32))
    L = g.fade_length(r, 0.012, 0.06, 0.50, 0.0) * (1 - top) + (0.26 + 0.04 * rng.random(len(r))) * top
    over = g.tangent(np.stack([np.where(r.side > 0, 1.0, -1.0), 0.15 + 0 * r.x, -0.25 + 0 * r.x], -1), r.n)
    down_back = g.tangent(np.stack([0.10 * np.sign(r.x - 0.5), np.ones(len(r)), -np.ones(len(r))], -1), r.n)
    w = top * scalp.parting.along(r.p) ** 0.5           # combed over only along the part; behind it, down
    sd = g.tangent(over * w[:, None] + down_back * (1 - w[:, None]), r.n)
    H = (0.05 + 0.03 * rng.random(len(r))) * top * g.smoothstep(0.0, 0.08, r.pd) + 0.012 * (1 - top)
    s, _ = g.short_hair(r, rng, L, sd, H, nv=40, texture=0.35 * top, piece_yaw=0.2, bend=0.25,
                        clumps=((1500, 0.05, 0.55, 0.8), (8000, 0.10, 0.30, 1.0)), log=log)
    hair.add(s)
    return hair.finish(rng)


def buzz(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('men', recession=0.35, jitter=0.006), soft=0.025, edge=0.15)
    hair = g.Hair(scalp, q, 'demo:buzz')
    r = scalp.roots(int(140000 * q), rng)
    L = 0.035 * rng.uniform(0.8, 1.2, len(r))
    s, _ = g.short_hair(r, rng, L, g.growth_direction(r), H=0.008 + 0 * L, nv=8, pieces=3000, piece_yaw=0.3,
                        piece_len=0.1, bend=0.1, clumps=(), frizz=(0.0003, 0.0008), collide=0.002, log=log)
    s.set(width_u=0.0008 / np.sqrt(q), opacity=0.8)
    hair.add(s)
    return hair.finish(rng)


def curls(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'), g.Parting(0.5, width=0.005))
    hair = g.Hair(scalp, q, 'demo:curls')
    gr = scalp.roots(max(60, int(1400 * min(1, 0.4 + 0.6 * q))), rng, blue=True)
    d0 = g.part_comb(gr, scalp) + 0.6 * gr.n
    hair_len = 1.35 + 0.15 * rng.random(len(gr))
    nv = 70
    front = g.smoothstep(1.25, 0.85, np.abs(gr.phi)) * g.smoothstep(-0.6, -0.3, gr.z)
    field = g.combine(g.face_frame_field(front, gr.side, rng.random(len(gr)), gap=0.06),
                      g.ear_clear_field(1 - front, gr.side))
    C = g.grow(gr.p, d0, nv, 1.0 / nv, shell=lambda k, s: 0.03 + 0.12 * g.smoothstep(0.0, 0.5, s), field=field,
               gravity=lambda k, s: 0.05 + 0.20 * g.smoothstep(0.1, 0.6, s), stiff=0.9)
    Lc = g.curl_centre_length(hair_len, 0.035, 0.11)
    C = g.cut(C, Lc)
    s, gi, _ = g.curly_locks(C, gr.n, rng, per=max(4, int(60 * q)), radius=(0.028, 0.042), pitch=(0.09, 0.13),
                             tube=0.012, radius_end=0.85, scalp=scalp)
    hair.add(s)
    hair.add(g.baby_hairs(scalp, rng, max(8, int(300 * q)), curl=0.01))
    return hair.finish(rng, look=dict(tone_end=0.08))


def pony(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'))
    hair = g.Hair(scalp, q, 'demo:pony')
    out = g.ponytail(scalp, rng, q, gather=(0.5, -0.15, -0.78), tail_len=1.5, waves=dict(amp=0.015), log=log)
    for k in ('scalp', 'tail', 'wrap'):
        hair.add(out[k])
    hair.add(g.baby_hairs(scalp, rng, max(8, int(500 * q))))
    return hair.finish(rng)


def bun_demo(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women'))
    hair = g.Hair(scalp, q, 'demo:bun')
    out = g.bun(scalp, rng, q, gather=(0.5, 0.30, -0.86), radius=0.16, height=0.12, log=log)
    hair.add(out['scalp']); hair.add(out['bun'])
    hair.add(g.baby_hairs(scalp, rng, max(8, int(500 * q))))
    return hair.finish(rng)


DEMOS = dict(long=long, sleek=sleek, locks=locks, waves=waves, bob=bob, crop=crop, sidepart=sidepart, buzz=buzz, curls=curls,
             pony=pony, bun=bun_demo)
