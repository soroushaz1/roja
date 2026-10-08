#!/usr/bin/env python3
"""QA composites of baked hairstyles on real portraits, through the reference runtime
(hairbake/runtime.py: placement fit, view cross-fade by yaw, parallax, recolour, scene
light, scalp, cast shadow, photo grain; optionally proto-a's own-hair hiding).

    cd tools/hair-bake
    python3 qa.py <style-id> [<style-id> ...]          # packed styles in <repo>/hairstyles/
        [--shades dark-brown,light-blonde]  shade names (catalog.js HAIR, see --list), 1-based
                                            indices, '#RRGGBB', or 'all'
        [--set public|internal|all]         which portraits (default public)
        [--only name,name]                  just these portraits (names as in --list)
        [--hide off|on|both]                own-hair hiding (default both)
        [--yaw-source matrix|landmarks]     what drives the cross-fade (default matrix)
        [--flat]                            no parallax: each view placed flat by its own anchors
        [--turntable]                       also the synthetic turntable sheet (yaw -40..40)
        [--palette]                         also the 16-shade sheet against the hair-colour product
        [--out build/qa] [--images DIR]     (extra portrait directory, searched first)
    python3 qa.py --list                    portraits, variants and shade names
    python3 qa.py <style-id> --selfcheck    numeric checks of the reference runtime (exit 1 on a fail)

Portraits
  public    tools/face-test.png (NASA, public domain), pd_* (public domain) and
            pexels_piacquadio_f_long (Pexels licence) from the scout set, plus VARIANTS made
            from them: mirrored (the yaw changes sign) and rotated in the image plane by
            +-15 degrees (roll).  Only these may be shown to the owner.
  internal  unk_* (licence unknown: QA only, never copied into the repo or owner-facing
            images), incl. the 3/4 views (-30, -39 degrees) and their mirrors (+30, +39).
            Their sheets are named INTERNAL_*.
  Variants are generated into build/qa/variants/ and their landmarks / matrix / hair mask
  detected once with detect.cjs (needs the preview server: node tools/preview.cjs).

Outputs (build/qa/<style>/)
  tiles/<portrait>__<shade>__<1x|2x>[__hide].png   every composite at full size: 1x is the
        whole photo, 2x a crop around the head magnified 2x (the photo upsampled and the hair
        composited at that resolution: what a closer camera shows).
  sheet_<set>[_only]_<n>.jpg  contact sheets (_only with --only, so a partial run never
                          overwrites the full sheets): per portrait the original, then per shade 1x, 1x
                          hidden, 2x zoom (labels: portrait, yaw, view weights, shade, hint).
  turntable.jpg           (--turntable) the style on the proxy body at yaw -40..40 in 5 degree
                          steps through the runtime (cross-fade and parallax consistency).
  palette_<portrait>.jpg  (--palette) all 16 shades: the existing hair-colour product on the
                          portrait's real hair | the swatch | the new style in the same shade,
                          with the mean colours of both (calibration of colour.RECOLOUR);
  shades_<portrait>.jpg   (--palette) all 16 shades of the style on one portrait, 2x;
  colour.txt              (--palette) the recolour alone on the front view's solid hair: mean
                          sRGB against each shade (target: within a few levels).
"""
import argparse, os, subprocess, sys, time, urllib.request
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hairbake import canon, colour, runtime as rt          # noqa: E402
from hairbake.native import BUILD                          # noqa: E402

REPO = canon.REPO
STYLES = os.path.join(REPO, 'hairstyles')
SCOUT = '/tmp/claude-0/-home-user-roja/e4193bd5-85d5-5100-b764-5ae1f62ae762/scratchpad/ultra/scout/test_portraits/crop512'
IMAGE_DIRS = [d for d in (os.environ.get('ROJA_PORTRAITS'), SCOUT, os.path.join(REPO, 'tools')) if d]
DET_DIR = os.path.join(BUILD, 'portraits')
VAR_DIR = os.path.join(BUILD, 'qa', 'variants')

PUBLIC = ['pexels_piacquadio_f_long', 'face-test', 'pd_astronaut_collins_f_short', 'pd_grace_hopper_f_cap',
          'pd_obama_official_m_short', 'pd_obama2_m_short', 'pd_biden_official_m_short_white']
PUBLIC_VARIANTS = ['pd_obama2_m_short__mirror', 'pd_biden_official_m_short_white__mirror',
                   'pexels_piacquadio_f_long__rot15', 'pexels_piacquadio_f_long__rotm15',
                   'face-test__rot15', 'pd_obama_official_m_short__rotm15']
INTERNAL = ['unk_mtr_m_short_3q', 'unk_mtr_m_short_3q__mirror', 'unk_pyfeat_m_shaggy', 'unk_pyfeat_m_shaggy__mirror',
            'unk_vlad_group3_f_long', 'unk_pyfeat_f_bob', 'unk_pyfeat_f_long_bangs', 'unk_facetorch_f_afro_curly',
            'unk_mtr_f_slicked_back', 'unk_pyfeat_m_short', 'unk_facexlib_m_bald_old']
SHADE_KEYS = ['black', 'dark-brown', 'chocolate', 'chestnut', 'hazel', 'caramel', 'honey', 'dark-blonde',
              'ash-blonde', 'light-blonde', 'platinum', 'copper', 'mahogany', 'burgundy', 'rose-gold', 'silver']
DEFAULT_SHADES = 'dark-brown,light-blonde'
FONT = None


def font(size=13):
    global FONT
    if FONT is None:
        FONT = {}
    if size not in FONT:
        for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'):
            if os.path.exists(p):
                FONT[size] = ImageFont.truetype(p, size)
                break
        else:
            FONT[size] = ImageFont.load_default()
    return FONT[size]


# ------------------------------------------------------------------------------- shades
def palette():
    """[(key, Persian name, '#hex')] of catalog.js HAIR in order."""
    pal = colour.hair_palette()
    return [(SHADE_KEYS[i] if i < len(SHADE_KEYS) else f'shade{i + 1}', n, h) for i, (n, h) in enumerate(pal)]


def parse_shades(spec):
    pal = palette()
    if spec == 'all':
        return [(k, h) for k, _, h in pal]
    out = []
    for s in spec.split(','):
        s = s.strip()
        if s.startswith('#'):
            out.append((s, s))
        elif s.isdigit():
            k, _, h = pal[int(s) - 1]; out.append((k, h))
        else:
            hit = [(k, h) for k, n, h in pal if k == s or n == s]
            if not hit:
                raise SystemExit(f'unknown shade {s!r}; --list shows the names')
            out.append(hit[0])
    return out


# ------------------------------------------------------------------------------- portraits
def is_internal(name):
    return name.startswith('unk_')


def find_image(name):
    if '__' in name:
        p = os.path.join(VAR_DIR, name + '.png')
        return p if os.path.exists(p) else None
    for d in IMAGE_DIRS:
        for ext in ('.png', '.jpg', '.jpeg'):
            p = os.path.join(d, name + ext)
            if os.path.exists(p):
                return p
    return None


def det_path(name):
    return os.path.join(VAR_DIR if '__' in name else DET_DIR, name + '.json')


def make_variant(name):
    """build/qa/variants/<base>__mirror.png / __rot<deg>.png / __rotm<deg>.png from the base portrait."""
    base, kind = name.split('__', 1)
    src = find_image(base)
    if src is None:
        return None
    img = cv2.imread(src)
    if kind == 'mirror':
        out = img[:, ::-1]
    elif kind.startswith('rot'):
        deg = float(kind[4:]) * -1 if kind.startswith('rotm') else float(kind[3:])
        h, w = img.shape[:2]
        R = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
        out = cv2.warpAffine(img, R, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101)
    else:
        raise ValueError(kind)
    os.makedirs(VAR_DIR, exist_ok=True)
    p = os.path.join(VAR_DIR, name + '.png')
    cv2.imwrite(p, np.ascontiguousarray(out))
    return p


def server_up(base='http://127.0.0.1:4173/'):
    try:
        urllib.request.urlopen(base + 'robots.txt', timeout=3)
        return True
    except Exception:
        return False


def ensure_detections(names, log=print):
    """variant images and their detections (detect.cjs, one browser for all of them)."""
    todo = []
    for n in names:
        if '__' in n and find_image(n) is None:
            make_variant(n)
        if not os.path.exists(det_path(n)) and find_image(n):
            todo.append(n)
    if not todo:
        return
    if not server_up():
        log('qa: the preview server is down (node tools/preview.cjs); cannot detect ' + ', '.join(todo))
        return
    for out_dir in {os.path.dirname(det_path(n)) for n in todo}:
        files = [find_image(n) for n in todo if os.path.dirname(det_path(n)) == out_dir]
        log(f'qa: detecting {len(files)} portraits -> {out_dir}')
        subprocess.run(['node', os.path.join(HERE, 'detect.cjs'), '--out', out_dir] + files, cwd=REPO, check=True)


def load_portrait(name):
    """(img_srgb float (h, w, 3), det, hair mask (h, w) 0..1) or None."""
    p = find_image(name); dp = det_path(name)
    if p is None or not os.path.exists(dp):
        return None
    det = canon.load_detection(dp)
    if det is None:
        return None
    img = cv2.imread(p)[..., ::-1].astype(np.float32) / 255
    hm = None
    if os.path.exists(det['hair']):
        hm = cv2.imread(det['hair'])[..., 2].astype(np.float32) / 255
        if hm.shape != img.shape[:2]:
            hm = cv2.resize(hm, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)
    return img, det, hm


def zoom_input(img, det, hm, k=2.0, centre=(0.5, 0.30)):
    """the 2x zoom: a crop of (size / k) around the head (head units `centre`, the upper face
    and crown) magnified k times, with the landmarks and the hair mask moved along: the
    runtime then composites at the magnified resolution."""
    h, w = img.shape[:2]
    A = canon.head_fit(det['L'], 0.0)
    cx, cy = canon.apply_fit(A, *centre)
    cw, ch = w / k, h / k
    x0 = float(np.clip(cx - cw / 2, 0, w - cw)); y0 = float(np.clip(cy - ch / 2, 0, h - ch))
    M = np.float32([[k, 0, -k * x0], [0, k, -k * y0]])
    zi = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT_101)
    zi = np.clip(zi, 0, 1)
    zh = cv2.warpAffine(hm, M, (w, h), flags=cv2.INTER_LINEAR) if hm is not None else None
    d2 = dict(det)
    L = det['L'].copy()
    L[:, 0] = (L[:, 0] - x0) * k; L[:, 1] = (L[:, 1] - y0) * k; L[:, 2] *= k
    d2['L'] = L
    return zi, d2, zh


# ------------------------------------------------------------------------------- drawing
def to8(x):
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


def label(im, lines, size=13):
    d = ImageDraw.Draw(im)
    f = font(size)
    y = 3
    for t in lines:
        if not t:
            continue
        bb = d.textbbox((0, 0), t, font=f)
        d.rectangle([2, y - 1, 8 + bb[2], y + bb[3] + 2], fill=(0, 0, 0))
        d.text((5, y), t, fill=(255, 255, 255), font=f)
        y += bb[3] + 4
    return im


def sheet(tiles, cols, pad=3, bg=(22, 22, 22)):
    w = max(t.width for t in tiles); h = max(t.height for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    S = Image.new('RGB', (cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad), bg)
    for i, t in enumerate(tiles):
        S.paste(t, (pad + (i % cols) * (w + pad), pad + (i // cols) * (h + pad)))
    return S


def fmt_w(sp, w):
    return ' '.join(f'{int(y):+d}:{x:.2f}' for y, x in zip(sp.yaws, w) if x > 0)


def run_style(style, names, shades, hide_modes, opts, out_root, tile=320, rows_per_sheet=4, log=print, tag=''):
    sp = rt.load_sprite(os.path.join(STYLES, style))
    out = os.path.join(out_root, style)
    os.makedirs(os.path.join(out, 'tiles'), exist_ok=True)
    groups = {'public': [n for n in names if not is_internal(n)], 'internal': [n for n in names if is_internal(n)]}
    written = []
    for set_name, ns in groups.items():
        rows = []
        for n in ns:
            P = load_portrait(n)
            if P is None:
                log(f'qa: {n}: no image or detection, skipped')
                continue
            img, det, hm = P
            row = [label(Image.fromarray(to8(img)).resize((tile, tile), Image.LANCZOS),
                         [n[:38], f'yaw {rt.head_yaw(det, opts["yaw_source"]):+.1f}  roll {det["roll"]:+.0f}', 'original'])]
            zi, zd, zh = zoom_input(img, det, hm)
            for skey, hexc in shades:
                hint1 = None
                for hide in hide_modes:
                    o = dict(opts, hide=hide)
                    t0 = time.time()
                    res, info = rt.composite(img, det, sp, hexc, opts=o, hair_mask=hm, yaw_source=opts['yaw_source'])
                    fn = f'{n}__{skey}__1x{"__hide" if hide else ""}.png'
                    Image.fromarray(to8(res)).save(os.path.join(out, 'tiles', fn))
                    lines = [f'{skey} {hexc}  1x{"  hidden" if hide else ""}',
                             f'yaw {info["yaw"]:+.1f}  views {fmt_w(sp, info["weights"])}']
                    if hide:
                        hint1 = info.get('hint', '')
                    if hide and info.get('hint'):
                        lines.append(f'HINT: tie hair back ({info["big_hair"]:.2f})')
                    row.append(label(Image.fromarray(to8(res)).resize((tile, tile), Image.LANCZOS), lines))
                    log(f'qa: {style} {n} {skey} 1x hide={hide} {time.time() - t0:.2f}s yaw {info["yaw"]:+.1f} '
                        f'{info.get("hint", "")}')
                # the 2x zoom with the last hide mode (hidden if both); the close-up keeps the
                # tie-back decision of the whole-head frame (as the app keeps it per session)
                hz = hide_modes[-1]
                rz, iz = rt.composite(zi, zd, sp, hexc, opts=dict(opts, hide=hz, hint=hint1 if hz else None), hair_mask=zh,
                                      yaw_source=opts['yaw_source'])
                fn = f'{n}__{skey}__2x{"__hide" if hz else ""}.png'
                Image.fromarray(to8(rz)).save(os.path.join(out, 'tiles', fn))
                row.append(label(Image.fromarray(to8(rz)).resize((tile, tile), Image.LANCZOS),
                                 [f'{skey}  2x zoom{"  hidden" if hz else ""}'] + (['HINT: tie hair back'] if iz.get('hint') else [])))
            rows.append(row)
        if not rows:
            continue
        cols = len(rows[0])
        for i in range(0, len(rows), rows_per_sheet):
            part = [t for r in rows[i:i + rows_per_sheet] for t in r]
            S = sheet(part, cols)
            pre = 'INTERNAL_' if set_name == 'internal' else ''
            p = os.path.join(out, f'{pre}sheet_{set_name}{tag}_{i // rows_per_sheet + 1}.jpg')
            S.save(p, quality=90)
            written.append(p)
            log(f'qa: sheet -> {p}')
    return written


def turntable(style, shades, opts, out_root, yaws=range(-40, 45, 5), tile=300, log=print):
    """the style on the proxy body, turned through `yaws`, via the runtime: synthetic
    landmarks are the canonical face turned by the yaw and drawn orthographically into a
    frame of the body render (bake.body_backdrop) - tests cross-fade and parallax alone."""
    from hairbake import bake, head
    sp = rt.load_sprite(os.path.join(STYLES, style))
    H, _ = canon.face_mesh()
    fr = head.Frame(-0.75, -0.55, 600, 640, 240)
    tiles = []
    for skey, hexc in shades:
        for y in yaws:
            bg, skin = bake.body_backdrop(fr, y)
            img = colour.lin_to_srgb(bg).astype(np.float32)
            P = canon.rotate_yaw(H, y)
            px, py = fr.to_px(P[:, 0], P[:, 1])
            L = np.zeros((478, 3)); L[:468, 0] = px; L[:468, 1] = py; L[:468, 2] = -P[:, 2] * fr.res / rt.LANDMARK_Z
            det = dict(L=L, M=None)
            res, info = rt.composite(img, det, sp, hexc, opts=dict(opts, hide=False, grain=0), yaw=float(y))
            tiles.append(label(Image.fromarray(to8(res)).resize((tile, int(tile * fr.H / fr.W)), Image.LANCZOS),
                               [f'{skey} yaw {y:+d}', f'views {fmt_w(sp, info["weights"])}']))
    cols = len(list(yaws))
    p = os.path.join(out_root, style, 'turntable.jpg')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    S = sheet(tiles, min(cols, 9))
    S.save(p, quality=90)
    log(f'qa: turntable -> {p}')
    return p


def hair_stats(img_srgb, m):
    """mean sRGB and luma spread of the pixels in mask m."""
    px = img_srgb[m]
    Y = px @ rt.LUMA601
    return px.mean(0), float(np.std(Y))


def palette_sheet(style, portrait, opts, out_root, tile=256, log=print):
    """all 16 shades: the hair-colour product on the portrait's own hair | the new style in
    the same shade (hidden own hair), 2x zoom, with mean colours."""
    sp = rt.load_sprite(os.path.join(STYLES, style))
    P = load_portrait(portrait)
    img, det, hm = P
    zi, zd, zh = zoom_input(img, det, hm, centre=(0.5, 0.45))
    tiles = []
    rows = []
    for key, name, hexc in palette():
        prod = rt.hair_colour_product(zi, zd['L'], zh, hexc)
        res, parts = rt.composite(zi, zd, sp, hexc, opts=dict(opts, hide=True), hair_mask=zh, return_parts=True)
        mreal = zh > 0.8
        mnew = parts['layers']['A'] > 0.95
        a, sa = hair_stats(prod, mreal)
        b, sb = hair_stats(res, mnew)
        rows.append((key, hexc, a, b, sa, sb))
        sw = Image.new('RGB', (tile // 3, tile), tuple(int(hexc[i:i + 2], 16) for i in (1, 3, 5)))
        t1 = label(Image.fromarray(to8(prod)).resize((tile, tile), Image.LANCZOS), [f'{key} product', '#%02X%02X%02X' % tuple(to8(a))])
        t2 = label(Image.fromarray(to8(res)).resize((tile, tile), Image.LANCZOS), [f'{key} new style', '#%02X%02X%02X' % tuple(to8(b))])
        comb = Image.new('RGB', (tile * 2 + tile // 3 + 4, tile), (22, 22, 22))
        comb.paste(t1, (0, 0)); comb.paste(sw, (tile + 2, 0)); comb.paste(t2, (tile + tile // 3 + 4, 0))
        tiles.append(comb)
    p = os.path.join(out_root, style, f'palette_{portrait}.jpg' if not is_internal(portrait) else f'INTERNAL_palette_{portrait}.jpg')
    sheet(tiles, 4).save(p, quality=90)
    log(f'qa: palette -> {p}')
    for key, hexc, a, b, sa, sb in rows:
        log(f'  {key:12s} {hexc}  product mean #{"%02X%02X%02X" % tuple(to8(a))} (luma sd {sa:.3f})   '
            f'new #{"%02X%02X%02X" % tuple(to8(b))} (luma sd {sb:.3f})')
    return p, rows


def colour_table(style, out_root, log=print):
    """the recolour on its own: each shade on the front view's solid hair (coverage > .95,
    no photo, light 1): mean sRGB against the shade, luma spread.  Written to
    build/qa/<style>/colour.txt.  The calibration target is |mean - shade| of a few levels."""
    from hairbake import pack
    st = pack.read_style(os.path.join(STYLES, style))
    v = pack.upsample(min(st['views'], key=lambda x: abs(x['yaw'])), st['frame'])
    m = v['A'] > 0.95
    a = v['A'][m]
    lines = [f'{style}: recolour of the front view\'s solid hair ({int(m.sum())} texels) against each shade',
             'shade         hex      mean     d(R G B) sRGB levels   luma sd  p5 / p50 / p95']
    for key, name, hexc in palette():
        rgb = colour.recolour(v['Dp'][m] / a, v['S1p'][m] / a, v['S2'][m], v['M'][m], v['T'][m], hexc,
                              spec=st['meta'].get('look', {}).get('spec', 1.0))
        srgb = colour.lin_to_srgb(colour.shoulder(rgb))
        mean = srgb.mean(0); d = (mean - colour.hex_rgb(hexc)) * 255
        Y = srgb @ rt.LUMA601; pc = np.percentile(Y, [5, 50, 95])
        lines.append(f'{key:12s}  {hexc}  #{"%02X%02X%02X" % tuple(to8(mean))}  {d[0]:+4.0f} {d[1]:+4.0f} {d[2]:+4.0f}'
                     f'          {Y.std():.3f}    {pc[0]:.2f} / {pc[1]:.2f} / {pc[2]:.2f}')
    p = os.path.join(out_root, style, 'colour.txt')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write('\n'.join(lines) + '\n')
    for ln in lines:
        log(ln)
    return p


def shades_sheet(style, portrait, opts, out_root, tile=240, log=print):
    """all 16 shades of the style on one portrait (2x zoom, own hair hidden), each over its
    swatch: how the palette reads on a real face."""
    sp = rt.load_sprite(os.path.join(STYLES, style))
    img, det, hm = load_portrait(portrait)
    group = sp.meta.get('group', '')
    zi, zd, zh = zoom_input(img, det, hm, centre=(0.5, 0.40) if group == 'women' else (0.5, 0.25))
    tiles = []
    for key, name, hexc in palette():
        res, info = rt.composite(zi, zd, sp, hexc, opts=dict(opts, hide=True), hair_mask=zh)
        im = Image.fromarray(to8(res)).resize((tile, tile), Image.LANCZOS)
        t = Image.new('RGB', (tile, tile + 22))
        t.paste(im, (0, 0))
        t.paste(Image.new('RGB', (tile, 22), tuple(int(hexc[i:i + 2], 16) for i in (1, 3, 5))), (0, tile))
        tiles.append(label(t, [f'{key} {hexc}'], size=12))
    pre = 'INTERNAL_' if is_internal(portrait) else ''
    p = os.path.join(out_root, style, f'{pre}shades_{portrait}.jpg')
    sheet(tiles, 8).save(p, quality=92)
    log(f'qa: shades -> {p}')
    return p


def selfcheck(style, log=print):
    """numeric checks of the reference runtime on a style: (1) drawn at 1:1 with the sprite
    frame at yaw = view yaw, every decoded layer is reproduced exactly (mesh, sampling,
    decoding); (2) each side view re-posed by parallax to the next view's yaw overlaps it
    (coverage IoU; the rest is hair one view hides); (3) yaw from the landmarks against the
    matrix yaw on the cached portraits.  Returns True when (1) holds and (3) is within 2 degrees rms."""
    from hairbake import pack
    sp = rt.load_sprite(os.path.join(STYLES, style))
    fr = sp.frame
    st = pack.read_style(os.path.join(STYLES, style))
    A = np.array([[fr.res, 0, -fr.x0 * fr.res], [0, fr.res, -fr.y0 * fr.res]])
    ok = True
    for v, r in zip(sp.views, st['views']):
        L = rt.draw_view(sp, v, A, v['yaw'], (fr.H, fr.W))
        ru = pack.upsample(r, fr)
        e = max(float(np.abs(L[k] - r[k]).max()) for k in ('A', 'Dp', 'S1p'))
        e2 = max(float(np.abs(L[k] - ru[k])[8:-8, 8:-8].mean()) for k in ('M', 'T', 'shadow', 'scalp', 'head', 'Z'))
        good = e < 1e-5 and e2 < 1e-3
        ok &= good
        log(f'selfcheck {style}: view {v["yaw"]:+g} drawn 1:1 reproduces the decoded layers: max |d| {e:.2g} '
            f'(full res), mean |d| {e2:.2g} (half res) {"PASS" if good else "FAIL"}')
    order = np.argsort(sp.yaws)
    for i, j in zip(order[:-1], order[1:]):
        for a_, b_ in ((i, j), (j, i)):
            va, vb = sp.views[a_], sp.views[b_]
            La = rt.draw_view(sp, va, A, vb['yaw'], (fr.H, fr.W))
            Lb = rt.draw_view(sp, vb, A, vb['yaw'], (fr.H, fr.W))
            x, y = La['A'] > 0.5, Lb['A'] > 0.5
            log(f'selfcheck {style}: view {va["yaw"]:+g} re-posed to {vb["yaw"]:+g}: coverage IoU {(x & y).sum() / max((x | y).sum(), 1):.3f}')
    errs = []
    for p in sorted(os.listdir(DET_DIR)):
        if p.endswith('.json'):
            d = canon.load_detection(os.path.join(DET_DIR, p))
            if d is not None and d['M'] is not None:
                errs.append(rt.yaw_from_landmarks(d['L']) - d['yaw'])
    if errs:
        rms = float(np.sqrt(np.mean(np.square(errs))))
        ok &= rms < 2
        log(f'selfcheck: yaw from landmarks vs matrix on {len(errs)} portraits: rms {rms:.2f} deg, max {np.abs(errs).max():.2f}')
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('styles', nargs='*')
    ap.add_argument('--shades', default=DEFAULT_SHADES)
    ap.add_argument('--set', default='public', choices=('public', 'internal', 'all'))
    ap.add_argument('--only', default=None)
    ap.add_argument('--hide', default='both', choices=('off', 'on', 'both'))
    ap.add_argument('--yaw-source', default='matrix', choices=('matrix', 'landmarks'))
    ap.add_argument('--flat', action='store_true')
    ap.add_argument('--turntable', action='store_true')
    ap.add_argument('--palette', action='store_true')
    ap.add_argument('--palette-portrait', default='pexels_piacquadio_f_long')
    ap.add_argument('--no-sheets', action='store_true')
    ap.add_argument('--selfcheck', action='store_true', help='numeric checks of the reference runtime')
    ap.add_argument('--tile', type=int, default=320)
    ap.add_argument('--out', default=os.path.join(BUILD, 'qa'))
    ap.add_argument('--images', default=None)
    ap.add_argument('--list', action='store_true')
    a = ap.parse_args()
    if a.images:
        IMAGE_DIRS.insert(0, a.images)
    if a.list:
        print('public: ' + ', '.join(PUBLIC + PUBLIC_VARIANTS))
        print('internal (QA only): ' + ', '.join(INTERNAL))
        for i, (k, n, h) in enumerate(palette()):
            print(f'  shade {i + 1:2d} {k:12s} {h}  {n}')
        return
    if not a.styles:
        ap.error('name at least one style (hairstyles/<id>)')
    names = []
    if a.set in ('public', 'all'):
        names += PUBLIC + PUBLIC_VARIANTS
    if a.set in ('internal', 'all'):
        names += INTERNAL
    if a.only:
        names = [n.strip() for n in a.only.split(',')]
    ensure_detections(names + ([a.palette_portrait] if a.palette else []))
    shades = parse_shades(a.shades)
    hide_modes = {'off': [False], 'on': [True], 'both': [False, True]}[a.hide]
    opts = dict(rt.DEFAULTS, parallax=not a.flat, yaw_source=a.yaw_source)
    opts_rt = {k: v for k, v in opts.items() if k != 'yaw_source'}
    log = lambda *x: print(*x, flush=True)
    bad = False
    for st in a.styles:
        if a.selfcheck:
            bad |= not selfcheck(st, log=log)
            continue
        if not a.no_sheets:
            run_style(st, names, shades, hide_modes, dict(opts_rt, yaw_source=a.yaw_source), a.out, tile=a.tile, log=log,
                      tag='_only' if a.only else '')
        if a.turntable:
            turntable(st, shades, opts_rt, a.out, log=log)
        if a.palette:
            colour_table(st, a.out, log=log)
            palette_sheet(st, a.palette_portrait, opts_rt, a.out, log=log)
            grp = rt.load_sprite(os.path.join(STYLES, st)).meta.get('group', '')
            shades_sheet(st, a.palette_portrait if grp == 'women' else 'pd_obama_official_m_short', opts_rt, a.out, log=log)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
