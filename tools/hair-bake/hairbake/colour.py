"""Colour helpers and the REFERENCE recolour of a baked sprite (what the runtime shader does).

The bake stores neutral, colourless light (D diffuse, S1 / S2 highlights, M depth into
the hair, T tone); a hair colour is applied at runtime.  This module is the reference
implementation used by the bake previews and by qa.py, and FORMAT.md documents the same
formula for the WebGL runtime.  Shades come from the HAIR palette of catalog.js (the
colour the hair's average should become, as the existing hair-colour product does it).

    rgb_linear = gain * light * ( dye_tone(T) * dye^(k_m * M) * kd * D
                                  + spec * (k1 * S1 + k2 * dye^0.8 * S2) )

All maths in linear light; D, S1, S2 may be premultiplied by coverage (the formula is
linear in them), M and T are straight.
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


# Reference recolour constants (FORMAT.md "Recolour").  qa.py / the colour calibration may
# refine them; keep FORMAT.md in step.
RECOLOUR = dict(kd=1.3, k_m=0.6, k1=0.09, k2=0.5, tone_dark=1.3, tone_light=0.8)


def recolour(D, S1, S2, M, T, dye_srgb, light=(1.0, 1.0, 1.0), gain=1.0, spec=1.0, params=None):
    """linear RGB (..., 3) of the hair from the neutral channels (arrays of the same shape)
    and a dye colour (sRGB 0..1 triple or '#hex').  D, S1, S2 linear (straight or
    premultiplied: the output follows), M and T straight 0..1."""
    p = dict(RECOLOUR, **(params or {}))
    if isinstance(dye_srgb, str):
        dye_srgb = hex_rgb(dye_srgb)
    c = srgb_to_lin(dye_srgb)[None]
    D, S1, S2, M, T = (np.asarray(x, np.float32)[..., None] for x in (D, S1, S2, M, T))
    tone = np.power(c, p['tone_dark']) * (1 - T) + np.power(c, p['tone_light']) * T
    cd = tone * np.power(c, p['k_m'] * M)
    rgb = p['kd'] * cd * D + spec * (p['k1'] * S1 + p['k2'] * np.power(c, 0.8) * S2)
    return (rgb * np.asarray(light) * gain).astype(np.float32)
