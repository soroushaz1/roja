package com.roja.mirror

import android.graphics.Bitmap
import android.opengl.EGL14
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.SystemClock
import android.util.Log
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The heavy part of the mirror, native: the camera (CameraX), face tracking (MediaPipe,
 * on the GPU where there is a real one) and the drawing ([MirrorRenderer]). The page
 * stays the interface: it sends what to draw and gets the landmarks back for its own
 * uses (the guide, measurements, the brush, the debug overlay).
 *
 * Each camera frame is measured, then drawn with its own landmarks: the picture and the
 * makeup can never be out of step. Nothing leaves the phone.
 */
class NativeMirror(
    private val activity: ComponentActivity,
    private val renderer: MirrorRenderer,
    private val view: GLSurfaceView,
    private val events: Events
) {
    interface Events {
        /** The first frame is on screen; [width]×[height] is the upright frame. */
        fun onStart(width: Int, height: Int)
        /** Landmarks and stats for the page, as JSON, a few times a second. */
        fun onFrame(json: String)
        fun onError(name: String, message: String)
    }

    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var landmarker: FaceLandmarker? = null
    @Volatile var delegate = ""
        private set
    private var gpuNote = ""

    @Volatile var running = false
        private set
    @Volatile var frozen = false
    @Volatile var wantSkin = false
    @Volatile var wantExtras = false

    /** A still picture instead of the camera, turned by [stillRotation] like a sensor frame (for tests). */
    @Volatile var still: Bitmap? = null
    @Volatile var stillRotation = 0
    private var feeder: ScheduledFuture<*>? = null
    private var provider: ProcessCameraProvider? = null
    private var session = 0

    private val smoother = Smoother()
    private val pool = ArrayBlockingQueue<MirrorRenderer.Frame>(POOL)
    private var poolBytes = 0
    private var input: Bitmap? = null
    private var lastTime = 0L
    private var started = false
    private var lastSent = 0L

    // Stats for the page's readout.
    private var inferMs = 0f
    private var tracked = 0
    private var hz = 0
    private var fps = 0
    private var since = 0L
    private var drawsAt = 0

    init {
        renderer.release = { frame -> pool.offer(frame) }
    }

    fun start() {
        if (running) return
        running = true
        started = false
        val token = ++session
        worker.execute {
            try {
                ensureLandmarker()
            } catch (e: Throwable) {
                Log.e(TAG, "tracker", e)
                stopOn(token)
                events.onError("TrackerError", e.message ?: e.toString())
                return@execute
            }
            if (token != session) return@execute
            val picture = still
            if (picture != null) {
                feeder = worker.scheduleWithFixedDelay({ if (token == session) feedStill(picture) }, 0, 66, TimeUnit.MILLISECONDS)
            } else {
                activity.runOnUiThread { bindCamera(token) }
            }
        }
    }

    fun stop() {
        if (!running) return
        running = false
        session++
        feeder?.cancel(false)
        feeder = null
        provider?.unbindAll()
        worker.execute { smoother.reset() }
        renderer.clear()
        view.requestRender()
    }

    fun close() {
        stop()
        worker.execute { landmarker?.close(); landmarker = null }
        worker.shutdown()
    }

    private fun stopOn(token: Int) {
        if (token == session) activity.runOnUiThread { stop() }
    }

    /* ---------------------------------------------------------------- camera */

    private fun bindCamera(token: Int) {
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            if (token != session) return@addListener
            try {
                val cameras = future.get()
                provider = cameras
                // What the tracker needs, and what the page draws the mirror at.
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder().setResolutionStrategy(
                            ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
                        ).build()
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .build()
                analysis.setAnalyzer(worker) { image -> onImage(image, token) }
                val selector = if (cameras.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) CameraSelector.DEFAULT_FRONT_CAMERA
                else CameraSelector.DEFAULT_BACK_CAMERA
                cameras.unbindAll()
                cameras.bindToLifecycle(activity, selector, analysis)
            } catch (e: Throwable) {
                Log.e(TAG, "camera", e)
                stop()
                events.onError("NotReadableError", e.message ?: e.toString())
            }
        }, ContextCompat.getMainExecutor(activity))
    }

    private fun onImage(image: ImageProxy, token: Int) {
        try {
            if (token != session || (frozen && started && !wantSkin)) return
            val plane = image.planes[0]
            val w = image.width
            val h = image.height
            val frame = obtain(w, h) ?: return
            val src = plane.buffer
            val row = plane.rowStride
            frame.pixels.clear()
            if (row == w * 4) {
                src.position(0)
                src.limit(w * h * 4)
                frame.pixels.put(src)
            } else {
                val line = ByteArray(w * 4)
                for (y in 0 until h) {
                    src.position(y * row)
                    src.get(line)
                    frame.pixels.put(line)
                }
            }
            frame.rotation = image.imageInfo.rotationDegrees
            process(frame, token)
        } finally {
            image.close()
        }
    }

    private fun feedStill(picture: Bitmap) {
        if (frozen && started && !wantSkin) return
        val frame = obtain(picture.width, picture.height) ?: return
        frame.pixels.clear()
        picture.copyPixelsToBuffer(frame.pixels)
        frame.rotation = stillRotation
        process(frame, session)
    }

    private fun obtain(w: Int, h: Int): MirrorRenderer.Frame? {
        val bytes = w * h * 4
        if (bytes != poolBytes) {
            pool.clear()
            repeat(POOL) { pool.offer(MirrorRenderer.Frame(bytes)) }
            poolBytes = bytes
        }
        // All frames busy: this one is dropped, the next will do.
        val frame = pool.poll() ?: return null
        frame.width = w
        frame.height = h
        return frame
    }

    /* --------------------------------------------------------------- tracker */

    private fun ensureLandmarker() {
        if (landmarker != null) return
        // On the GPU the model is several times faster, unless the GPU is only emulated
        // in software (as on the Android emulator), where the CPU wins.
        val soft = softwareGpu()
        if (soft == null) {
            try {
                ensureLandmarkerOn(Delegate.GPU)
            } catch (e: Throwable) {
                gpuNote = e.message ?: e.toString()
            }
        } else gpuNote = "software GPU ($soft)"
        if (landmarker == null) ensureLandmarkerOn(Delegate.CPU)
    }

    /** The GPU's name if it is a software one, from a throwaway EGL context. */
    private fun softwareGpu(): String? {
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        if (!EGL14.eglInitialize(display, version, 0, version, 1)) return "no EGL"
        try {
            val configs = arrayOfNulls<android.opengl.EGLConfig>(1)
            val count = IntArray(1)
            val attributes = intArrayOf(EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT, EGL14.EGL_NONE)
            if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] == 0) return "no config"
            val context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
            val surface = EGL14.eglCreatePbufferSurface(display, configs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            try {
                if (!EGL14.eglMakeCurrent(display, surface, surface, context)) return "no context"
                val name = GLES20.glGetString(GLES20.GL_RENDERER) ?: ""
                return if (Regex("swiftshader|llvmpipe|softpipe|software", RegexOption.IGNORE_CASE).containsMatchIn(name)) name else null
            } finally {
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                EGL14.eglDestroySurface(display, surface)
                EGL14.eglDestroyContext(display, context)
            }
        } finally {
            EGL14.eglTerminate(display)
        }
    }

    private fun process(frame: MirrorRenderer.Frame, token: Int) {
        val model = landmarker
        if (model == null || token != session) {
            pool.offer(frame)
            return
        }
        val w = frame.width
        val h = frame.height
        val bitmap = input?.takeIf { it.width == w && it.height == h }
            ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { input = it }
        frame.pixels.position(0)
        bitmap.copyPixelsFromBuffer(frame.pixels)
        frame.pixels.position(0)
        // VIDEO mode wants strictly increasing timestamps.
        val now = max(SystemClock.uptimeMillis(), lastTime + 1)
        lastTime = now
        frame.time = now
        val begin = SystemClock.elapsedRealtimeNanos()
        val result = try {
            model.detectForVideo(
                BitmapImageBuilder(bitmap).build(),
                ImageProcessingOptions.builder().setRotationDegrees(frame.rotation).build(),
                now
            )
        } catch (e: Throwable) {
            Log.e(TAG, "detect", e)
            pool.offer(frame)
            if (delegate == "GPU") {
                // Drop to the CPU for good and carry on.
                gpuNote = e.message ?: e.toString()
                landmarker?.close()
                landmarker = null
                try {
                    ensureLandmarkerOn(Delegate.CPU)
                } catch (err: Throwable) {
                    stopOn(token)
                    events.onError("TrackerError", err.message ?: err.toString())
                }
            }
            return
        }
        inferMs = inferMs * .85f + (SystemClock.elapsedRealtimeNanos() - begin) / 1e6f * .15f
        tracked++
        val face = result.faceLandmarks().firstOrNull()
        val raw = face?.let { points ->
            FloatArray(points.size * 3).also { out ->
                points.forEachIndexed { i, p -> out[i * 3] = p.x(); out[i * 3 + 1] = p.y(); out[i * 3 + 2] = p.z() }
            }
        }
        val landmarks = smoother.smooth(raw, now)
        frame.landmarks = landmarks
        val sideways = frame.rotation == 90 || frame.rotation == 270
        val fw = if (sideways) h else w
        val fh = if (sideways) w else h
        val skin = if (wantSkin && landmarks != null) sampleSkin(frame, landmarks, fw, fh) else null

        renderer.submit(frame)
        view.requestRender()
        if (!started) {
            started = true
            activity.runOnUiThread { if (token == session) events.onStart(fw, fh) }
        }

        // The page gets the landmarks at most every 50 ms: enough for its guide, brush
        // and overlays, which do not draw the makeup.
        val t = SystemClock.elapsedRealtime()
        if (t - since >= 1000) {
            val draws = renderer.draws
            hz = (tracked * 1000f / max(1L, t - since)).roundToInt()
            fps = ((draws - drawsAt) * 1000f / max(1L, t - since)).roundToInt()
            tracked = 0
            drawsAt = draws
            since = t
        }
        if (t - lastSent < 50 && skin == null) return
        lastSent = t
        val json = StringBuilder(landmarks?.size?.times(8) ?: 64)
        json.append("{\"lm\":")
        if (landmarks == null) json.append("null") else {
            json.append('[')
            for (i in landmarks.indices) {
                if (i > 0) json.append(',')
                json.append(String.format(Locale.ROOT, "%.5f", landmarks[i]))
            }
            json.append(']')
        }
        if (face != null) {
            result.facialTransformationMatrixes().orElse(null)?.firstOrNull()?.let { m ->
                json.append(",\"m\":[").append(m.joinToString(",") { String.format(Locale.ROOT, "%.5f", it) }).append(']')
            }
            if (wantExtras) result.faceBlendshapes().orElse(null)?.firstOrNull()?.let { cats ->
                json.append(",\"bs\":[").append(cats.joinToString(",") {
                    "[\"" + it.categoryName() + "\"," + String.format(Locale.ROOT, "%.4f", it.score()) + "]"
                }).append(']')
            }
        }
        if (wantSkin) {
            json.append(",\"skin\":")
            if (skin == null) json.append("null")
            else json.append("{\"rgb\":[").append(skin.first.joinToString(",") { String.format(Locale.ROOT, "%.2f", it) })
                .append("],\"patches\":").append(skin.second).append('}')
        }
        json.append(",\"st\":{\"hz\":").append(hz).append(",\"fps\":").append(fps)
            .append(",\"infer\":").append(String.format(Locale.ROOT, "%.1f", inferMs))
            .append(",\"draw\":").append(String.format(Locale.ROOT, "%.1f", renderer.drawMs))
            .append(",\"delegate\":\"").append(delegate).append("\",\"note\":")
            .append(org.json.JSONObject.quote(gpuNote)).append(",\"gpu\":")
            .append(org.json.JSONObject.quote(renderer.renderer)).append("}}")
        val message = json.toString()
        activity.runOnUiThread { if (token == session) events.onFrame(message) }
    }

    private fun ensureLandmarkerOn(kind: Delegate) {
        landmarker = FaceLandmarker.createFromOptions(
            activity,
            FaceLandmarker.FaceLandmarkerOptions.builder()
                .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL).setDelegate(kind).build())
                .setRunningMode(RunningMode.VIDEO)
                .setNumFaces(1)
                .setMinFaceDetectionConfidence(.55f)
                .setMinFacePresenceConfidence(.55f)
                .setMinTrackingConfidence(.55f)
                .setOutputFaceBlendshapes(true)
                .setOutputFacialTransformationMatrixes(true)
                .build()
        )
        delegate = if (kind == Delegate.GPU) "GPU" else "CPU"
    }

    /**
     * The skin colour for the foundation shade finder: sampleSkin() in face-core.js.
     * Small patches on both cheeks, the forehead and the chin, each dropped if too uneven
     * to be bare skin, then the median. [w]×[h] is the upright frame; the pixels are in
     * the sensor's orientation.
     */
    private fun sampleSkin(frame: MirrorRenderer.Frame, lm: FloatArray, w: Int, h: Int): Pair<FloatArray, Int>? {
        val sw = frame.width
        val sh = frame.height
        val px = frame.pixels
        fun sensor(u: Float, v: Float): Pair<Int, Int> {
            val (s, t) = when (frame.rotation) {
                90 -> v to 1 - u
                180 -> 1 - u to 1 - v
                270 -> 1 - v to u
                else -> u to v
            }
            return (s * sw).roundToInt() to (t * sh).roundToInt()
        }
        val face = hypot((lm[454 * 3] - lm[234 * 3]) * w, (lm[454 * 3 + 1] - lm[234 * 3 + 1]) * h)
        val half = max(2, (face * .025f).roundToInt())
        val found = ArrayList<FloatArray>()
        for (index in intArrayOf(50, 280, 101, 330, 151, 199, 205, 425)) {
            val (cx, cy) = sensor(lm[index * 3], lm[index * 3 + 1])
            if (cx - half < 0 || cy - half < 0 || cx + half >= sw || cy + half >= sh) continue
            var r = 0f; var g = 0f; var b = 0f; var n = 0; var l2 = 0f
            for (y in cy - half..cy + half) for (x in cx - half..cx + half) {
                val i = (y * sw + x) * 4
                val pr = (px.get(i).toInt() and 255).toFloat()
                val pg = (px.get(i + 1).toInt() and 255).toFloat()
                val pb = (px.get(i + 2).toInt() and 255).toFloat()
                r += pr; g += pg; b += pb; n++
                val l = pr * .299f + pg * .587f + pb * .114f
                l2 += l * l
            }
            r /= n; g /= n; b /= n
            val mean = r * .299f + g * .587f + b * .114f
            val spread = sqrt(max(0f, l2 / n - mean * mean))
            if (spread > 22 || mean < 25 || mean > 245) continue
            found.add(floatArrayOf(r, g, b))
        }
        if (found.size < 2) return null
        fun median(k: Int): Float {
            val v = found.map { it[k] }.sorted()
            val m = v.size / 2
            return if (v.size % 2 == 1) v[m] else (v[m - 1] + v[m]) / 2
        }
        return floatArrayOf(median(0), median(1), median(2)) to found.size
    }

    private companion object {
        const val TAG = "RojaMirror"
        const val POOL = 3
        /** The site's own copy of the model, in the APK's assets. */
        const val MODEL = "www/vendor/face_landmarker.task"
    }
}
