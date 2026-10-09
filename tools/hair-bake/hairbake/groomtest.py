"""Checks and a contact sheet of the groom library, run on the demo grooms (demos.py).

    cd tools/hair-bake
    python3 -m hairbake.groomtest [--q .15] [--only long,crop] [--views 0,30,90,back] [--no-sheet]

For each demo: build time, strand counts, Hair.check() (no NaN, roots on the scalp
where hair grows and never on the ears, < .5 % of vertices inside the body, the part
line clear), printed as PASS / FAIL lines; then build/preview/demos.png, every demo from
the given views (simple preview shading - see preview.py).  Exit status 1 on any FAIL.
"""
import argparse, os, sys, time
import numpy as np
from . import demos, preview as pv
from .native import BUILD


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--q', type=float, default=0.15)
    ap.add_argument('--only', default='')
    ap.add_argument('--views', default='0,30,90,back')
    ap.add_argument('--res', type=int, default=110)
    ap.add_argument('--no-sheet', action='store_true')
    a = ap.parse_args()
    names = [n for n in (a.only.split(',') if a.only else demos.DEMOS)]
    rows, nfail = [], 0
    for nm in names:
        t = time.time()
        hair = demos.DEMOS[nm](np.random.default_rng(1), q=a.q, log=None)
        tb = time.time() - t
        stats, fails = hair.check()
        nfail += len(fails)
        s = ', '.join(f'{k} {v:.3g}' if isinstance(v, float) else f'{k} {v}' for k, v in stats.items())
        print(f"{'FAIL' if fails else 'PASS'} {nm}: {hair.n} strands, {tb:.1f}s; {s}")
        for f in fails:
            print('     ', f)
        if not a.no_sheet:
            rows.append(pv.preview(hair, a.views.split(','), a.res, 'brown', label=nm))
        sys.stdout.flush()
    if rows:
        out = os.path.join(BUILD, 'preview', 'demos.png')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        pv.sheet(rows, 2 if len(rows) > 3 else 1, pad=2).save(out)
        print('->', out)
    sys.exit(1 if nfail else 0)


if __name__ == '__main__':
    main()
