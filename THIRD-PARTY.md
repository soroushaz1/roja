# Third-party assets

The code in this repository is MIT licensed (see `LICENSE`). The files below are
redistributed here under their own terms so the app can run offline, with nothing
fetched from a third-party CDN.

## MediaPipe Tasks Vision — `vendor/`

`@mediapipe/tasks-vision` 1.0.1 and the `face_landmarker.task` model, by Google.

- Licence: Apache License 2.0 — full text in `vendor/LICENSE-Apache-2.0.txt`
- Home: https://mediapipe.dev
- Privacy notice: https://goo.gle/mediapipe-privacy

The ES-module WebAssembly variant and the source maps that ship with the package were
removed; this app loads the classic-worker runtime only.

## Estedad — `fonts/`

The Estedad variable Persian typeface, by the Estedad Project Authors.

- Licence: SIL Open Font License 1.1 — full text in `fonts/OFL.txt`
- Home: https://github.com/aminabedi68/Estedad

## Test portrait — `tools/face-test.png`

A public-domain NASA astronaut portrait, used only by the test harness as a stand-in for
a webcam. It is not part of the site and is never served to visitors.
