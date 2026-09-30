# Turn the surveyed market colours into Roja's own palette.
#
# The survey (market-colours.cjs) keeps only colour values. This picks a ladder of
# representatives from each real range, so the shades a shopper sees match what is
# actually sold here, while every name stays ours.
import json, io, colorsys, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
market = json.load(io.open('tools/market-colours.json', encoding='utf-8'))

def to_hls(h):
    r, g, b = (int(h[i:i+2], 16) / 255 for i in (1, 3, 5))
    H, L, S = colorsys.rgb_to_hls(r, g, b)
    H *= 360
    # Reds straddle 0 degrees; signing the hue lets 359 and 5 average to 2, not 182.
    return (H - 360 if H > 180 else H), L, S

def to_hex(H, L, S):
    r, g, b = colorsys.hls_to_rgb((H % 360) / 360, max(0, min(1, L)), max(0, min(1, S)))
    return '#%02X%02X%02X' % tuple(round(v * 255) for v in (r, g, b))

def usable(cat, lo=0.12, hi=0.95, min_sat=0.12, hue=(-45, 45), max_sat=0.85):
    """Real colours from a category, less the black/white placeholders and anything
    outside the hue family the category actually sells."""
    out = []
    for c in market.get(cat, []):
        H, L, S = to_hls(c)
        if lo <= L <= hi and min_sat <= S <= max_sat and hue[0] <= H <= hue[1]:
            out.append((H, L, S))
    return sorted(out, key=lambda t: t[1])

def ladder(rows, n, light=None, sat=None, shift=0.0):
    """n shades taken from the real colours themselves, lightest first to match the
    names. Real hue and saturation pairings are kept - they are realistic by
    construction - and only interpolated where the market data is sparser than n."""
    rows = sorted(rows, key=lambda t: -t[1])
    if light:
        inside = [r for r in rows if light[0] <= r[1] <= light[1]]
        rows = inside or rows
    if not rows:
        return []
    out = []
    for i in range(n):
        t = i / max(1, n - 1) * (len(rows) - 1)
        j = int(t)
        frac = t - j
        a, b = rows[j], rows[min(j + 1, len(rows) - 1)]
        H = a[0] + (b[0] - a[0]) * frac
        L = a[1] + (b[1] - a[1]) * frac
        S = a[2] + (b[2] - a[2]) * frac
        if sat:
            S = sat[1] + (sat[0] - sat[1]) * (i / max(1, n - 1))
        out.append(to_hex(H, L + shift, S))
    return out


# Name ladders, light to dark, in the families the market actually sells.
NAMES = {
 'velvet':   ['نود صدفی','نود گرم','شفتالو','هلویی','مرجانی','گل‌بهی','آجری','قرمز کلاسیک','اناری','آلبالویی','شرابی','خرمایی تیره'],
 'liquid':   ['نود مات','صورتی خاکی','هلوی مات','مرجانی مات','آجری','قرمز مات','اناری','آلبالویی','شرابی','قهوهٔ سوخته'],
 'gloss':    ['بی‌رنگ صدفی','هلوی روشن','صورتی شفاف','رزگلد','مرجانی براق','گل‌بهی','تمشکی شفاف','شرابی براق'],
 'lipliner': ['نود','هلویی','گل‌بهی','آجری','اناری','شرابی'],
 'powder-blush': ['هلویی روشن','شفتالو','گل‌بهی','مرجانی','زردآلویی','گل‌محمدی','آجری ملایم','خاکی گرم'],
 'cream-blush':  ['شفتالوی کرمی','هلویی','گل‌بهی کرمی','مرجانی','مسی','آجری'],
 'foundation':   ['عاجی','صدفی','روشن','بژ روشن','بژ','بژ گرم','گندمی روشن','گندمی','گندمی گرم','برنزی روشن','برنزی','برنزی تیره','گندمی تیره'],
 'concealer':    ['عاجی','روشن','بژ روشن','بژ','گندمی روشن','گندمی','برنزی','برنزی تیره'],
 'highlighter':  ['شامپاینی','مرواریدی','رزگلد','هلویی','برنزی'],
 'contour':      ['خاکی روشن','خاکی','خاکی گرم','قهوهٔ ملایم','قهوهٔ تیره'],
}

PLAN = [
 # our id,        market category,      count, lightness window,  saturation window
 ('velvet',       'lipstick',           12,   (0.30, 0.62),  None),
 ('liquid',       'lipstick',           10,   (0.27, 0.58),  None),
 ('gloss',        'lipstick',            8,   (0.52, 0.72),  (0.34, 0.52)),
 ('lipliner',     'lip-liner',           6,   (0.28, 0.62),  None),
 ('powder-blush', 'blush',               8,   (0.55, 0.80),  (0.40, 0.62)),
 ('cream-blush',  'blush',               6,   (0.56, 0.78),  (0.46, 0.66)),
 ('foundation',   'foundation-makeup',  13,   (0.58, 0.89),  None),
 ('concealer',    'concealer',           8,   (0.58, 0.87),  None),
 ('highlighter',  'highlighter',         5,   (0.66, 0.82),  (0.42, 0.60)),
 ('contour',      'foundation-makeup',   5,   (0.58, 0.80),  (0.30, 0.42), -0.22),
]

print('// Built by tools/build-palette.py from tools/market-colours.json.')
for our, cat, count, light, sat, *rest in PLAN:
    shift = rest[0] if rest else 0.0
    rows = usable(cat)
    if not rows:
        print(f'// {our}: no market data for {cat}')
        continue
    hexes = ladder(rows, count, light, sat, shift)
    names = NAMES[our]
    pairs = ', '.join(f"['{n}','{h}']" for n, h in zip(names, hexes))
    print(f"\n// {our} — from {len(rows)} real {cat} colours")
    print(f"{our}: [{pairs}]")
