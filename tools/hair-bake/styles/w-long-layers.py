"""w-long-layers: long layered hair past the shoulders, curtain bangs parted in the centre.

Port of proto-a's L5 onto the shared groom library (first draft; to be refined against the
quality checklist).  Recipe:
  * scalp: women's hairline with natural jitter and a soft 6 mm density falloff, a narrow
    centre part (~1.5 mm of scalp);
  * main hair (long_hair): 3200 guides grown under gravity with volume shells, crown lift
    and a little side asymmetry, face-framing sections along the cheeks, ears cleared,
    front/back decision at the shoulders, straight drape; 100k strands interpolated per
    side of the part; L5's layered cut (face-framing layers from the chin); soft coherent
    waves in the lengths; ends bent mostly under; two-level clumping; frizz; strays;
  * curtain bangs (4.5 % of the strands) from a section behind the front hairline;
  * flyaways (1.2 %), broken strays on top (0.4 %), baby hairs at the hairline (0.6 %).
"""
import numpy as np
from hairbake import groom as g

STYLE = dict(id='w-long-layers', name='لایه‌ای بلند با چتری پرده‌ای', group='women')
# optional hints for the renderer (proto-a RENDER_KW): strand tip taper
RENDER = dict(taper=(0.7, 1.0))


def build(rng, q=1.0, log=print):
    scalp = g.Scalp(g.Hairline('women', jitter=0.008), g.Parting(0.5, width=0.0045), soft=0.035, edge=0.22)
    bang = g.bang_section(scalp, width=0.20, depth=0.13)
    hair = g.Hair(scalp, q, STYLE['id'])
    out = g.long_hair(scalp, rng, q, n=100000, n_guides=3200, accept=lambda P, N: ~bang(P, N),
                      volume=(0.055, 0.07), crown_lift=0.02, asym=0.12,
                      waves=dict(amp=0.026, wavelength=(0.42, 0.56), start=0.7, ramp=1.0, lateral=0.5), log=log)
    S = out['strands']
    hair.add(S)
    bangs, _ = g.curtain_bangs(scalp, rng, int(4500 * q), width=0.20, depth=0.13)
    hair.add(bangs.set(opacity=0.8))
    hair.add(g.flyaways(S.P, rng, 0.012), kind='flyaway')
    r = out['roots']
    top = r.take((r.y < 0.1) & (np.abs(r.phi) < 2.4) & (np.abs(r.x - 0.5) > 0.03))
    hair.add(g.strays(top, rng, max(4, int(0.004 * S.n))), kind='stray')
    hair.add(g.baby_hairs(scalp, rng, max(8, int(0.006 * S.n))))
    return hair.finish(rng)
