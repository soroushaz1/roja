# رُژا · Roja

A live mirror that runs entirely in the browser. Pick a lipstick shade and see it on your
own face, or pick a cosmetic procedure and see an approximation of the shape change.
Everything happens on the device: the camera frame becomes a GPU texture and is never
read back, uploaded or stored, and no asset is fetched from anywhere but this repository.

**[Open the mirror →](https://YOUR-USERNAME.github.io/roja/)**

> آینه‌ای زنده که کاملاً داخل مرورگر اجرا می‌شود. یک رنگ آرایش را روی صورت خودت امتحان
> کن، یا نتیجهٔ تقریبی یک عمل زیبایی را ببین. تصویر دوربین روی همان دستگاه پردازش می‌شود
> و هیچ‌جا فرستاده یا ذخیره نمی‌شود.

The interface is in Persian and laid out right-to-left.

| makeup | procedures |
|---|---|
| ![Trying a lipstick shade on a live camera feed](screenshots/makeup.png) | ![A rhinoplasty preview with the before/after seam across the face](screenshots/procedures.png) |

---

## This is not a medical tool

The procedure view is a **visual simulation of a shape change, nothing more**. It does not
model swelling, bruising, healing, scarring, skin thickness, or what any particular surgeon
would actually achieve, and it is not a prediction of a result. Colours are samples on a
screen, not measured product matches — ambient light, the camera and natural skin tone all
move what you see. For any medical decision, talk to a qualified doctor.

## What is in it

**آرایش — makeup.** Seven products in Roja's own range (76 shades): velvet and matte
lipsticks, gloss, powder and cream blush, single eyeshadows and four-pan palettes. Colour
is drawn onto contours the face model reports, with adjustable intensity and edge feather,
and an option to blend with the skin's own texture.

**عمل‌های زیبایی — procedures.** Eight named procedures, each a set of weights over a
shared field of localised deformers: rhinoplasty, lip and cheek filler, buccal fat removal,
jaw contouring, chin implant, eyelid surgery, brow lift. Several can be combined. Drag the
brass seam across your face to compare before and after.

**حالت دیباگ — debug overlay.** Every landmark the model returns, numbered, with the ones
driving the current selection picked out in a second colour — the lip contour while a
lipstick is on, the nose anchors while rhinoplasty is applied. Label size is adjustable and
the view can be narrowed to just the active points.

## How it works

- **Face tracking** — MediaPipe Face Landmarker, 468 points, running in a Web Worker so the
  interface never blocks. The model and its WebAssembly runtime are served from this repo.
- **Makeup** — 2D canvas. Contours are drawn as quadratic mid-point curves so no straight
  mesh segments show, eye openings are always excluded, and edges are feathered with a
  shadow pass that works in Safari as well as Chromium.
- **Procedures** — WebGL. The frame is carried through a 64×48 grid mesh displaced by a sum
  of smoothstep-falloff deformers anchored on landmarks. Every radius and axis is expressed
  in a face-local frame, so edits track head tilt, distance and rotation. Displacement
  decays to zero away from each anchor, so the background is never touched and an all-zero
  setting is a pixel-exact copy of the camera frame.
- **Before/after** — one extra `gl.scissor` pass redrawing the untouched mesh on one side.

No build step, no framework, no bundler. Plain ES modules served as files.

## Running it locally

Needs [Node](https://nodejs.org) (only to serve the files — nothing is compiled).

```bash
node tools/preview.cjs      # serves this folder at http://127.0.0.1:4173
```

On Windows you can double-click `run-local.cmd` instead, which starts the server and opens
the browser.

The camera works on `127.0.0.1` and `localhost` because browsers treat them as secure
contexts. It will **not** work over a plain-HTTP LAN address such as `192.168.x.x` — that
needs HTTPS.

## Tests

```bash
node tools/preview.cjs       # in one terminal
node tools/roja-check.cjs    # in another
```

A Playwright run against a simulated camera. It checks that a zero-strength procedure
reproduces the camera frame pixel-exactly, that every procedure moves pixels in its own
region and resets cleanly, that the before/after seam sits on the cut it draws, that losing
the face leaves nothing stale on screen, that the mirror never resizes when the panel's
content changes, that the phone layout keeps the mirror and its controls on one screen, and
that a device without WebGL still gets working makeup. Point it at a deployed copy with
`ROJA_URL`.

## First load

About 15 MB, mostly the face model and its WebAssembly runtime, then cached. That is the
cost of doing the tracking on the device instead of sending the camera somewhere.

## Licence

The code here is MIT — see [LICENSE](LICENSE). Bundled third-party assets keep their own
licences; see [THIRD-PARTY.md](THIRD-PARTY.md).
