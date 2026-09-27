# رُژا برای اندروید · Roja for Android

> **دانلود:** https://github.com/soroushaz1/roja/releases/latest/download/roja.apk
>
> این لینک همیشه تازه‌ترین نسخه را می‌دهد. فایل را روی گوشی باز کن و اگر اندروید پرسید، اجازهٔ
> نصب از این منبع را بده. برنامه به اینترنت دسترسی ندارد: تمام سایت داخل خود برنامه است و
> تصویر دوربین از گوشی بیرون نمی‌رود.

The same mirror as the website, as an installable Android app (Android 8.0 and later),
with the live camera done natively. The site at the root of this repository is copied
into the app's assets at build time and is the app's interface, shown in a WebView, so
every feature — makeup, the brush, looks, the shade finder, procedures, debug mode —
works the same in both. The heavy part of the live mirror, the camera, face tracking and
drawing, runs natively under the page, for a picture that keeps up with the face.

## How it works

- **Served from the APK.** `WebViewAssetLoader` serves `assets/www` under
  `https://appassets.androidplatform.net`, a secure origin, so the camera, the
  face-tracking worker, its WebAssembly runtime and WebGL behave as they do in a browser.
- **No network permission.** The manifest does not ask for `INTERNET`. Nothing the app
  shows comes from the internet, and nothing the camera sees can leave the phone.
- **The native mirror.** When the page starts the camera, `NativeMirror.kt` opens it with
  CameraX, runs MediaPipe's face landmarker on each frame (on the GPU; on the CPU where
  the GPU is only emulated in software, as on the emulator) and hands the frame, with the
  landmarks measured on it, to `MirrorRenderer.kt`, an OpenGL ES 2.0 port of the site's
  `stage.js`. It draws in a `GLSurfaceView` under the WebView, which is transparent; the
  page leaves a hole where its mirror is and tells the app where that is. Each frame is
  drawn with its own landmarks, so the makeup never trails the face.
- **One source of truth.** The renderer compiles the site's own shaders and face mesh,
  read out of `shaders.js` and `facemesh.js` in the APK (`SiteCode.kt`). The page still
  paints the makeup masks, once per change, in the face's own space, and sends them with
  the list of layers; the renderer places them on the face through the mesh every frame.
  The procedure warp (`Deform.kt`) and the landmark smoothing (`Smoother.kt`) are ports of
  `deform.js` and the One Euro filter in `makeup.js`, and must change with them.
- **Camera permission.** Asked for when the mirror first starts. When the app is hidden,
  the camera is turned off. Photos are drawn by the page's own WebGL, as on the web.
- **Photos.** «انتخاب عکس» opens the system photo picker, which needs no storage permission.
- **Saving.** Snapshots go to *Pictures/Roja* and debug exports to *Download/Roja*. On
  Android 8 and 9, which have no shared folders without a storage permission, a save dialog
  asks where to put the file instead.
- **The rest.** The screen stays on while the mirror is live. Back closes an open dialog,
  menu or the brush before it leaves the app. Rotation does not reload the page.

## Building

The GitHub workflow `.github/workflows/android.yml` builds the APK on every push, on any
branch, and runs `app/src/androidTest` on an emulator. Those tests check that the
site loads from the APK, the face model loads in its worker, the camera reaches the page,
and a dropped photo is tracked and drawn on the WebGL stage; that the native camera runs;
and, feeding the test portrait through the native pipeline as a camera frame, that the
face is found, the lipstick colours the lips and nothing else, and a frame from a sensor
turned a quarter turn comes out the same way up, landmarks and picture alike.

Locally, with Android Studio or the Android SDK and JDK 17:

```bash
cd android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew connectedDebugAndroidTest   # with a device or emulator attached
```

Open the `android` folder in Android Studio to run it on a phone directly.

## Publishing

Every push to `main` that passes the emulator tests becomes a
[release](https://github.com/soroushaz1/roja/releases) named after its version
(`v1.0.<run number>`), with the APK attached as `roja.apk`. So
`https://github.com/soroushaz1/roja/releases/latest/download/roja.apk` always downloads the
newest build, and needs no GitHub account. Other branches get an APK in their run's
artifacts but no release.

Without a signing key the release carries the debug APK, which is signed with a throw-away
key: each build installs as a different signer, so the old one has to be uninstalled first.
For updates that install in place, and for Google Play, sign with your own key; releases
then carry the signed release APK instead:

1. Create a key once, and keep it safe — losing it means you cannot update the app:
   `keytool -genkeypair -v -keystore roja.jks -keyalg RSA -keysize 4096 -validity 10000 -alias roja`
2. In the repository's *Settings → Secrets and variables → Actions*, add
   `ROJA_KEYSTORE_BASE64` (the output of `base64 -w0 roja.jks`), `ROJA_KEYSTORE_PASSWORD`,
   `ROJA_KEY_ALIAS` (`roja`) and `ROJA_KEY_PASSWORD`.
3. The next run also produces a signed `app-release.apk` and an `app-release.aab` for Play,
   and the next release carries the signed APK. To publish one straight away, run the
   workflow by hand on `main` (*Actions → Android app → Run workflow*). Anyone who installed
   a debug-signed release uninstalls it once; from then on updates install in place.

The application id is `com.roja.mirror`. Change it in `app/build.gradle.kts` before the first
upload to Google Play if you want another one; after that it cannot change.
