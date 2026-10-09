"""w-long-layers: long layered hair past the shoulders, curtain bangs parted in the centre.

Recipe (port of proto-a's L5, brought up to the quality checklist):
  * scalp: women's hairline with natural jitter and a soft density falloff; a narrow
    centre part that drifts a little off the mid-line;
  * main hair (long_hair): guides grown under gravity with volume shells, crown lift and
    side asymmetry; face-framing sections fall straight down past the cheekbones (they
    do not hug the jaw); ears cleared; front / back decision at the shoulders; straight
    drape; dense strands interpolated per side of the part; layered cut; soft, broad
    S-waves in the lengths; ends bent mostly under; two-level clumping; light frizz;
  * curtain bangs from a section behind the front hairline, swept out to the cheekbones;
  * a few flyaways, broken strays on top and baby hairs at the hairline.
"""
import numpy as np
from hairbake import groom as g

STYLE = dict(id='w-long-layers', name='لایه‌ای بلند با چتری پرده‌ای', group='women')
# renderer hints: strand tip taper; sprite resolution (head units: up to 300 px per unit,
# capped by the visible hair area for the file budget); highlight strength
RENDER = dict(taper=(0.7, 1.0), res=300, max_hair_px=140000, spec=0.85)
# a little more light reaches the hair behind the neck (no black gaps beside the neck)
LIGHT = dict(ambient_floor=0.20, env_base=0.55, bounce=0.18, bounce_m=0.35)


def build(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women', jitter=0.008), g.Parting(0.505, drift=-0.012, width=0.004),
                    soft=0.035, edge=0.22)
    bang = g.bang_section(scalp, width=0.20, depth=0.13)
    hair = g.Hair(scalp, q, STYLE['id'])
    out = g.long_hair(scalp, rng, q, n=100000, n_guides=3200, accept=lambda P, N: ~bang(P, N),
                      volume=(0.06, 0.075), crown_lift=0.035, asym=0.15,
                      comb=lambda r: g.part_comb(r, scalp, down=0.35, fwd=-0.25),
                      face_frame=dict(gap=-0.015, hug=0.0, spread=0.07, k=(0.9, 0.45)),
                      waves=dict(amp=0.034, wavelength=(0.80, 1.05), start=0.95, ramp=0.6, lateral=0.2,
                                 scale=0.35, lock_jitter=0.35),
                      ends=dict(amount=0.06, under=0.6, start=0.8), front_frac=0.6,
                      frizz=(0.0008, 0.0018), stray=(0.03, 0.002, 0.008), log=log)
    S = out['strands']
    hair.add(S)
    bangs, _ = g.curtain_bangs(scalp, rng, int(4500 * q), width=0.20, depth=0.13)
    hair.add(bangs.set(opacity=0.85))
    # a few wisps breaking the curtain's clean inner edge
    hair.add(g.flyaways(bangs.P, rng, 0.03, start=(0.3, 0.7), amp=(0.02, 0.008)), kind='flyaway')
    hair.add(g.flyaways(S.P, rng, 0.006), kind='flyaway')
    r = out['roots']
    top = r.take((r.y < 0.1) & (np.abs(r.phi) < 2.4) & (np.abs(r.x - 0.5) > 0.03))
    hair.add(g.strays(top, rng, max(4, int(0.0015 * S.n)), length=(0.03, 0.09), lift=0.02), kind='stray')
    hair.add(g.baby_hairs(scalp, rng, max(8, int(0.006 * S.n))))
    return hair.finish(rng, look=dict(tone_root=-0.18, tone_lock=0.15))
