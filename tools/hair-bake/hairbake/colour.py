"""Colour helpers and the REFERENCE recolour of a baked sprite (what the runtime shader does).

The bake stores neutral, colourless light (D diffuse, S1 / S2 highlights, M depth into
the hair, T tone); a hair colour is applied at runtime.  This module is the reference
implementation used by the bake previews, runtime.py and qa.py, and FORMAT.md documents the
same formula for the WebGL runtime.  Shades come from the HAIR palette of catalog.js: the
colour the new hair's AVERAGE becomes, as the existing hair-colour product makes the user's
real hair average to it (shaders.js LAYER_FRAG: hex x light x pixel luma / region luma).

recolour() (full formula in its docstring): per dye, its linear luminance Y, chroma ch =
c / Y and lightness l = Y^(1/2.2) set a diffuse gain, a tonal contrast, a saturation and a
highlight strength / tint (dye_terms()); per texel the body colour is
kd' Y D0 (D/D0)^gamma' x tone(T) x depth(M) x hue-preserving saturation x warm shadows,
plus the two highlights.  Then shoulder() rolls the highlights off softly.

Calibration (qa.py --palette writes build/qa/<style>/colour.txt): on the front view's solid
hair, light 1, every one of the 16 shades averages within ~11 sRGB levels of its hex in
luminance (most within 5; black / dark brown on the glossy long style run 5-11 levels light
from the sheen), with light shades a little less saturated than the hex on purpose (blue
+8..+15 levels on honey, light blonde, copper): darker roots and lowlights, warm golden /
beige-brown shadows instead of olive, cream-white (not yellow) highlights.

All maths in linear light; D, S1, S2 may be premultiplied by coverage (the output follows;
pass A so the saturation / warmth terms read the straight brightness), M and T straight.
"""
import functools, os, re
import numpy as np
from .canon import REPO

LUMA = np.array([0.2126, 0.7152, 0.0722])


def srgb_to_lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float64), 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hex_rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


@functools.lru_cache(None)
def hair_palette():
    """[(Persian name, '#RRGGBB'), ...] of catalog.js HAIR (16 shades)."""
    src = open(os.path.join(REPO, 'catalog.js'), encoding='utf-8').read()
    block = re.search(r'const HAIR=\[(.*?)\];', src, re.S).group(1)
    return [(n, h) for n, h in re.findall(r"\['([^']+)','(#[0-9A-Fa-f]{6})'\]", block)]


# Reference recolour (FORMAT.md "Recolour" specifies the same maths for the WebGL runtime).
# Calibrated by eye and by numbers (qa.py --palette: build/qa/<style>/colour.txt and palette_*.jpg) so every
# HAIR shade's new hair averages close to the shade itself (as the hair-colour product makes
# real hair average to it) and reads as natural hair: no grey darks, no lemon / olive / straw
# blondes.  Ideas: the dye's luminance and chroma are handled apart; depth (M) and tone (T)
# darken around their style averages (M0, T0) so the average stays on the shade; saturation
# rises gently into depth and lowlights but is hue-preserving (chroma scaled in linear RGB,
# never by raising the colour to a power, which turns ash and beige shades olive) and lower
# for light shades; highlights are tinted toward the dye for dark shades and stay nearly
# neutral for light ones; light shades get more tonal contrast (darker roots, lowlights).
RECOLOUR = dict(
    kd=1.38,          # diffuse gain (D is exposure-normalised: median 0.6 over solid hair) ...
    kd_light=0.49,    # ... x (1 + kd_light (l - 0.4)): the light shades' wider tonal spread
                      #     needs more linear light for the same sRGB average
    k_m=0.55,         # depth absorption: lum x (Y^k_m exp(-k_ml l))^(M - M0): dark dyes darken
    k_ml=0.6,         #     more inside; light shades get extra depth (dimension) from k_ml
    M0=0.52, T0=0.50,  # the styles' average depth and tone (stay on the shade)
    tone=1.6,         # tonal contrast of T (roots, lowlights, lighter ends): exp(tone' (T - T0))
    tone_light=1.2,   # ... tone' = tone (1 + tone_light l): more for light shades (l = luma^(1/2.2))
    sat=1.08,         # body saturation x the dye's own chroma ...
    sat_light=0.22,   # ... x (1 - sat_light l): light shades less saturated (no lemon / straw;
                      #     .30 made light blonde read cream-white on the QA portraits)
    sat_m=0.6,        # + deeper hair more saturated
    sat_t=0.8,        # + darker tone (roots, lowlights) more saturated
    sat_max=1.35,
    D0=0.6,           # the diffuse level of the average lit hair (bake exposure target)
    contrast_light=0.35,  # diffuse contrast gamma' = 1 - contrast_light l (light shades softer)
    desat_hi=0.15,    # brighter-than-average hair a little less saturated (no yellow glow; .35
                      #     washed the lit tops of blondes to white)
    warm=0.6,         # shadows and depth of light shades shift warm (golden / beige-brown, never
    warm_rgb=(1.25, 1.0, 0.72),  # olive or khaki): chroma x mix(1, warm_rgb / luma, warm l dark)
    k1=0.075,         # primary highlight (R lobe) strength ...
    k1_dark=0.55,     # ... x mix(k1_dark, 1, l): darker shades a softer sheen (it greyed them)
    tint1=0.55,       # its tint toward the dye's chroma for the darkest shades ...
    tint1_light=0.18,  # ... falling to this for the lightest (a cream sheen, not yellow, not white)
    k2=0.45,          # secondary highlight (TRT, through the fibre): k2 Y^e2 x chroma(sat2)
    e2=0.75, sat2=1.15,
)


def luma_lin(c):
    return np.asarray(c, np.float64) @ LUMA


def dye_terms(dye_srgb, params=None):
    """per-dye constants of the recolour (what a runtime computes once per shade): Y (linear
    luminance), ch (chroma: the colour / Y), l (perceptual lightness 0..1), and the derived
    tone contrast, saturation, highlight strength / tint."""
    p = dict(RECOLOUR, **(params or {}))
    if isinstance(dye_srgb, str):
        dye_srgb = hex_rgb(dye_srgb)
    c = srgb_to_lin(dye_srgb)
    Y = max(float(luma_lin(c)), 1e-4)
    ch = c / Y
    l = Y ** (1 / 2.2)
    return dict(c=c, Y=Y, ch=ch, l=l,
                kd=p['kd'] * (1 + p['kd_light'] * (l - 0.4)),
                gamma=1 - p['contrast_light'] * l,
                tone=p['tone'] * (1 + p['tone_light'] * l),
                sat=p['sat'] * (1 - p['sat_light'] * l),
                k1=p['k1'] * (p['k1_dark'] + (1 - p['k1_dark']) * l),
                tint1=p['tint1'] + (p['tint1_light'] - p['tint1']) * l)


def recolour(D, S1, S2, M, T, dye_srgb, light=(1.0, 1.0, 1.0), gain=1.0, spec=1.0, params=None, A=None):
    """linear RGB (..., 3) of the hair from the neutral channels (arrays of the same shape)
    and a dye colour (sRGB 0..1 triple or '#hex').  D, S1, S2 linear (straight or
    premultiplied: the output follows; with premultiplied inputs pass the coverage A, used
    only to read D's straight brightness for the saturation / warmth terms), M and T straight.

        Y, ch, l             dye luminance, chroma (c / Y), lightness Y^(1/2.2)
        rel   = D / D0                        (D straight: premultiplied D / A)
        lum   = kd' Y D0 rel^gamma' exp(tone' (T - T0)) (Y^k_m exp(-k_ml l))^(M - M0)
        s     = min(sat_max, sat' (1 + sat_m (M - M0) + sat_t (T0 - T)) (1 - desat_hi clamp(rel - 1, 0, 1)))
        dark  = clamp(.5 (1 - rel) + (M - M0) + .5 (T0 - T), 0, 1)
        warm  = 1 + (warm_rgb / luma(warm_rgb) - 1) warm l dark
        body  = lum * max(0, 1 + (ch - 1) s) * warm
        hl1   = k1' S1 * (1 + (ch - 1) tint1')
        hl2   = k2 Y^e2 S2 * max(0, 1 + (ch - 1) sat2)
        rgb   = (body + spec (hl1 + hl2)) * light * gain
    (times A for premultiplied output), with kd', gamma', tone', sat', k1', tint1' from
    dye_terms()."""
    p = dict(RECOLOUR, **(params or {}))
    t = dye_terms(dye_srgb, p)
    Y, ch = t['Y'], t['ch'].astype(np.float32)
    D, S1, S2, M, T = (np.asarray(x, np.float32)[..., None] for x in (D, S1, S2, M, T))
    # brightness relative to the average lit hair, from the STRAIGHT diffuse (pass A when D,
    # S1, S2 are premultiplied, so soft edges are not mistaken for shadow)
    Ac = 1.0 if A is None else np.maximum(np.asarray(A, np.float32)[..., None], 1e-3)
    rel = D / Ac / p['D0']
    # light hair scatters light through itself: softer shading (lifted shadows, gentler
    # highlights) than dark hair - the diffuse contrast is compressed by gamma' = 1 - contrast_light l
    Dc = Ac * p['D0'] * np.power(np.maximum(rel, 0), t['gamma'])
    absorb = Y ** p['k_m'] * np.exp(-p['k_ml'] * t['l'])
    lum = t['kd'] * Y * Dc * np.exp(t['tone'] * (T - p['T0'])) * np.power(absorb, M - p['M0'])
    s = t['sat'] * (1 + p['sat_m'] * (M - p['M0']) + p['sat_t'] * (p['T0'] - T))
    s = np.minimum(p['sat_max'], s * (1 - p['desat_hi'] * np.clip(rel - 1, 0, 1)))
    dark = np.clip(0.5 * (1 - rel) + (M - p['M0']) + 0.5 * (p['T0'] - T), 0, 1)
    wv = np.asarray(p['warm_rgb'], np.float32); wv = wv / float(wv @ LUMA)
    warm = 1 + (wv - 1) * (p['warm'] * t['l'] * dark)
    body = lum * np.maximum(0, 1 + (ch - 1) * s) * warm
    hl1 = t['k1'] * S1 * (1 + (ch - 1) * t['tint1'])
    hl2 = p['k2'] * Y ** p['e2'] * S2 * np.maximum(0, 1 + (ch - 1) * p['sat2'])
    rgb = body + spec * (hl1 + hl2)
    return (rgb * np.asarray(light, np.float32) * gain).astype(np.float32)


SHOULDER = 0.72      # linear level where the hair's highlights start to roll off


def shoulder(rgb, k=SHOULDER):
    """soft roll-off of the hair's linear colour above k (a camera's highlight shoulder), so
    light shades in bright photos keep texture instead of clipping to flat white: identity
    below k, approaching 1 smoothly above.  Apply to STRAIGHT colour (divide by coverage)."""
    x = np.asarray(rgb, np.float32)
    over = np.maximum(x - k, 0)
    return np.where(x > k, k + (1 - k) * np.tanh(over / (1 - k)), x).astype(np.float32)
