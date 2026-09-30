package com.roja.mirror

import android.graphics.Bitmap
import android.opengl.GLES20.*
import android.opengl.GLSurfaceView
import android.os.SystemClock
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.ShortBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The native mirror's renderer, drawn under the page: the camera frame, the makeup
 * layers and the procedure warp. A port of stage.js that compiles the very shaders the
 * site uses (read from shaders.js by [SiteCode]) and places masks through the same face
 * mesh, so the app and the site draw makeup the same way.
 *
 * What is native only: turning the camera's sensor-oriented frame upright, and showing
 * the result mirrored where the page's mirror is, with its rounded corners.
 *
 * Frames arrive from [NativeMirror] with the landmarks measured on them, and each is
 * drawn with its own landmarks, so makeup sits exactly on the face in the picture.
 */
class MirrorRenderer(private val code: SiteCode) : GLSurfaceView.Renderer {

    /** One makeup layer, as the page's stageLayer() builds it; [radiusK] is its smoothing radius in face widths. */
    class Layer(
        val key: String, val color: FloatArray, val amount: Float, val mode: Float, val detail: Float,
        val gloss: Float, val matte: Float, val shimmer: Float, val smooth: Float, val bright: Float, val radiusK: Float,
        /** How much of the skin's own colour the product lets through; see SHEER in app.js. */
        val sheer: Float = 0f,
        /** A concealer lifts the shadow it sits in; a foundation keeps it. */
        val lift: Float = 0f
    )

    /** What to draw: the "after" layers and procedure amounts, and the "before" side from [seam] on. */
    class Plan(
        val after: List<Layer>, val amounts: Map<String, Float>?, val before: List<Layer>?,
        val seam: Float?, val grade: FloatArray?
    )

    /**
     * Where the page shows the mirror, in surface pixels from the top left: the rounded
     * box of the mirror, and inside it the picture itself (fitted like object-fit: contain).
     */
    class Placement(
        val x: Int, val y: Int, val w: Int, val h: Int, val radius: Float,
        val px: Int, val py: Int, val pw: Int, val ph: Int
    )

    /** A camera frame in its sensor orientation, RGBA, and the landmarks measured on it (upright, normalised). */
    class Frame(capacity: Int) {
        var width = 0
        var height = 0
        var rotation = 0
        var time = 0L
        var landmarks: FloatArray? = null
        val pixels: ByteBuffer = ByteBuffer.allocateDirect(capacity).order(ByteOrder.nativeOrder())
    }

    @Volatile var plan: Plan? = null
    @Volatile var placement: Placement? = null
    /** Frames go back to their pool once uploaded. */
    @Volatile var release: (Frame) -> Unit = {}

    private val pending = AtomicReference<Frame?>(null)
    private val jobs = ConcurrentLinkedQueue<() -> Unit>()

    // Stats, read by NativeMirror for the page's readout.
    @Volatile var drawMs = 0f
        private set
    @Volatile var draws = 0
    @Volatile var renderer = ""
        private set

    /** Hands over the newest frame; one not yet drawn is dropped for it. */
    fun submit(frame: Frame) {
        pending.getAndSet(frame)?.let { release(it) }
    }

    /** Forgets the picture, so a new camera session never flashes the last one. */
    fun clear() {
        pending.getAndSet(null)?.let { release(it) }
        jobs.add { hasFrame = false; landmarks = null }
    }

    private class MaskData(val uv: FloatArray, val width: Int, val height: Int, val alpha: ByteArray)
    private class MaskEntry(val data: MaskData, val tex: Int, val ibo: Int, val count: Int, val verts: IntArray)

    // Kept outside GL so masks can be uploaded again if the context is ever lost.
    private val maskData = HashMap<String, MaskData>()
    private val masks = HashMap<String, MaskEntry>()

    /** A mask painted by the page in face space: [uv] (x, y, w, h) bounds [alpha], [width]×[height] bytes. */
    fun setMask(key: String, uv: FloatArray, width: Int, height: Int, alpha: ByteArray) {
        val data = MaskData(uv, width, height, alpha)
        jobs.add { maskData[key] = data; uploadMask(key, data) }
    }

    fun keepMasks(keep: Set<String>) {
        jobs.add {
            for (key in masks.keys.toList()) if (key !in keep) dropMask(key)
            maskData.keys.retainAll(keep)
        }
    }

    /** The picture as drawn, not mirrored, at the frame's own size (the page mirrors it when saving). */
    fun snapshot(done: (Bitmap?) -> Unit) {
        jobs.add { done(readOutput()) }
    }

    /* ---------------------------------------------------------------- GL state */

    private inner class Program(vert: String, frag: String) {
        val id: Int
        val pos: Int
        val uv: Int
        private val uniforms = HashMap<String, Int>()

        init {
            fun compile(type: Int, source: String): Int {
                val s = glCreateShader(type)
                glShaderSource(s, source)
                glCompileShader(s)
                val ok = IntArray(1)
                glGetShaderiv(s, GL_COMPILE_STATUS, ok, 0)
                if (ok[0] == 0) error("shader: " + glGetShaderInfoLog(s))
                return s
            }
            id = glCreateProgram()
            glAttachShader(id, compile(GL_VERTEX_SHADER, vert))
            glAttachShader(id, compile(GL_FRAGMENT_SHADER, frag))
            glLinkProgram(id)
            val ok = IntArray(1)
            glGetProgramiv(id, GL_LINK_STATUS, ok, 0)
            if (ok[0] == 0) error("program: " + glGetProgramInfoLog(id))
            pos = glGetAttribLocation(id, "a_pos")
            uv = glGetAttribLocation(id, "a_uv")
        }

        fun u(name: String): Int = uniforms.getOrPut(name) { glGetUniformLocation(id, name) }
    }

    private class Target(val tex: Int, val fbo: Int, val w: Int, val h: Int)
    private class Box(val x: Float, val y: Float, val w: Float, val h: Float)

    private lateinit var out: Program
    private lateinit var down: Program
    private lateinit var stats: Program
    private lateinit var layerP: Program
    private lateinit var maskP: Program
    private lateinit var upright: Program
    private lateinit var blit: Program
    private lateinit var corners: Program

    private var quad = 0
    private var gridPos = 0
    private var gridUv = 0
    private var gridIdx = 0
    private var facePosBuf = 0
    private var canonBuf = 0

    private var sensor = 0
    private var camera: Target? = null
    private var pairA: Array<Target>? = null
    private var pairB: Array<Target>? = null
    private var maskT: Target? = null
    private var low1: Target? = null
    private var low2: Target? = null
    private var output: Target? = null
    private var statsT: Target? = null
    private var size = intArrayOf(0, 0)

    private var surfaceW = 1
    private var surfaceH = 1
    private var hasFrame = false
    private var landmarks: FloatArray? = null

    private val positions = FloatArray(GRID * 2)
    private val positionData: FloatBuffer = floats(GRID * 2)
    private val facePos = FloatArray(SiteCode.LANDMARKS * 2)
    private val facePosData: FloatBuffer = floats(SiteCode.LANDMARKS * 2)
    private val offset = FloatArray(2)

    override fun onSurfaceCreated(unused: GL10?, config: EGLConfig?) {
        renderer = glGetString(GL_RENDERER) ?: ""
        val f = code.precision
        out = Program(code.shader("MESH_VERT"), f + code.shader("OUT_FRAG"))
        down = Program(code.shader("QUAD_VERT"), f + code.shader("DOWN_FRAG"))
        stats = Program(code.shader("QUAD_VERT"), f + code.shader("STATS_FRAG"))
        layerP = Program(code.shader("QUAD_VERT"), f + code.shader("LAYER_FRAG"))
        maskP = Program(code.shader("MASK_VERT"), f + code.shader("MASK_FRAG"))
        upright = Program(code.shader("QUAD_VERT"), f + UPRIGHT_FRAG)
        blit = Program(BLIT_VERT, f + BLIT_FRAG)
        corners = Program(code.shader("QUAD_VERT"), f + CORNER_FRAG)

        quad = buffer(GL_ARRAY_BUFFER, floats(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)), GL_STATIC_DRAW)
        val uv = FloatArray(GRID * 2)
        var v = 0
        for (r in 0..ROWS) for (c in 0..COLS) {
            uv[v++] = c.toFloat() / COLS
            uv[v++] = r.toFloat() / ROWS
        }
        val idx = ShortArray(COLS * ROWS * 6)
        var i = 0
        for (r in 0 until ROWS) for (c in 0 until COLS) {
            val a = r * (COLS + 1) + c
            val b = a + 1
            val d = a + COLS + 1
            val e = d + 1
            idx[i++] = a.toShort(); idx[i++] = b.toShort(); idx[i++] = d.toShort()
            idx[i++] = b.toShort(); idx[i++] = e.toShort(); idx[i++] = d.toShort()
        }
        gridPos = buffer(GL_ARRAY_BUFFER, positionData, GL_DYNAMIC_DRAW)
        gridUv = buffer(GL_ARRAY_BUFFER, floats(uv), GL_STATIC_DRAW)
        gridIdx = buffer(GL_ELEMENT_ARRAY_BUFFER, shorts(idx), GL_STATIC_DRAW)
        facePosBuf = buffer(GL_ARRAY_BUFFER, facePosData, GL_DYNAMIC_DRAW)
        canonBuf = buffer(GL_ARRAY_BUFFER, floats(code.canon), GL_STATIC_DRAW)

        sensor = texture(0, 0)
        statsT = target(1, 1, GL_NEAREST)
        camera = null; pairA = null; pairB = null; maskT = null; low1 = null; low2 = null; output = null
        size = intArrayOf(0, 0)
        hasFrame = false
        // A new context: everything on the GPU is gone, masks included.
        masks.clear()
        for ((key, data) in maskData) uploadMask(key, data)
    }

    override fun onSurfaceChanged(unused: GL10?, width: Int, height: Int) {
        surfaceW = max(1, width)
        surfaceH = max(1, height)
    }

    override fun onDrawFrame(unused: GL10?) {
        while (true) jobs.poll()?.invoke() ?: break
        pending.getAndSet(null)?.let { frame ->
            takeFrame(frame)
            release(frame)
        }

        glBindFramebuffer(GL_FRAMEBUFFER, 0)
        glViewport(0, 0, surfaceW, surfaceH)
        glDisable(GL_SCISSOR_TEST)
        glClearColor(PAGE_BG[0], PAGE_BG[1], PAGE_BG[2], 1f)
        glClear(GL_COLOR_BUFFER_BIT)
        val place = placement ?: return
        if (!hasFrame) return

        val start = SystemClock.elapsedRealtimeNanos()
        compose()
        show(place)
        drawMs = drawMs * .85f + (SystemClock.elapsedRealtimeNanos() - start) / 1e6f * .15f
        draws++
    }

    /* ------------------------------------------------------------ the frame */

    private fun takeFrame(frame: Frame) {
        val w = frame.width
        val h = frame.height
        glActiveTexture(GL_TEXTURE0)
        glBindTexture(GL_TEXTURE_2D, sensor)
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4)
        frame.pixels.position(0)
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, frame.pixels)
        // Upright, the frame the landmarks were measured in.
        val sideways = frame.rotation == 90 || frame.rotation == 270
        val fw = if (sideways) h else w
        val fh = if (sideways) w else h
        ensureTargets(fw, fh)
        val cam = camera!!
        glBindFramebuffer(GL_FRAMEBUFFER, cam.fbo)
        glViewport(0, 0, fw, fh)
        useQuad(upright)
        bindTex(0, sensor, upright.u("u_tex"))
        // sensor (s, t) from upright (u, v), both with row 0 at the top
        val (s, t) = when (frame.rotation) {
            90 -> floatArrayOf(0f, 1f, 0f) to floatArrayOf(-1f, 0f, 1f)
            180 -> floatArrayOf(-1f, 0f, 1f) to floatArrayOf(0f, -1f, 1f)
            270 -> floatArrayOf(0f, -1f, 1f) to floatArrayOf(1f, 0f, 0f)
            else -> floatArrayOf(1f, 0f, 0f) to floatArrayOf(0f, 1f, 0f)
        }
        glUniform3f(upright.u("u_s"), s[0], s[1], s[2])
        glUniform3f(upright.u("u_t"), t[0], t[1], t[2])
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
        landmarks = frame.landmarks
        hasFrame = true
    }

    /** Everything stage.js draws, into [output], with row 0 at the top of the frame. */
    private fun compose() {
        val w = size[0]
        val h = size[1]
        val p = plan
        val lm = landmarks
        val face = lm != null && lm.size >= SiteCode.LANDMARKS * 3
        val after = p?.after ?: emptyList()
        val before = p?.before
        val faceWidth = if (face) hypot((lm!![454 * 3] - lm[234 * 3]) * w, (lm[454 * 3 + 1] - lm[234 * 3 + 1]) * h) else 0f
        if (face && (after.isNotEmpty() || !before.isNullOrEmpty())) {
            for (i in 0 until SiteCode.LANDMARKS) {
                facePos[i * 2] = lm!![i * 3] * 2 - 1
                facePos[i * 2 + 1] = lm[i * 3 + 1] * 2 - 1
            }
            facePosData.position(0); facePosData.put(facePos); facePosData.position(0)
            glBindBuffer(GL_ARRAY_BUFFER, facePosBuf)
            glBufferSubData(GL_ARRAY_BUFFER, 0, facePos.size * 4, facePosData)
            buildLow()
        }
        val probe = if (face) probesOf(lm!!) else FloatArray(8) { .5f }
        val time = (SystemClock.elapsedRealtime() % 100_000L) / 1000f
        val cam = camera!!.tex
        val afterTex = if (face && after.isNotEmpty()) composite(after, pairA!!, probe, time, faceWidth) else cam
        val beforeTex = if (before != null) {
            if (face && before.isNotEmpty()) composite(before, pairB!!, probe, time, faceWidth) else cam
        } else null

        val o = output!!
        glBindFramebuffer(GL_FRAMEBUFFER, o.fbo)
        glViewport(0, 0, w, h)
        glDisable(GL_SCISSOR_TEST)
        glUseProgram(out.id)
        val g = p?.grade ?: ONE
        glUniform3f(out.u("u_grade"), g[0], g[1], g[2])
        val amounts = p?.amounts
        val afterDefs = if (face && amounts != null) Deform.deformers(lm!!, w.toFloat(), h.toFloat(), amounts) else emptyList()
        drawMesh(afterTex, afterDefs, w, h)
        val seam = p?.seam
        if (beforeTex != null && seam != null) {
            val from = (seam * w).roundToInt().coerceIn(0, w)
            glEnable(GL_SCISSOR_TEST)
            glScissor(from, 0, w - from, h)
            drawMesh(beforeTex, emptyList(), w, h)
            glDisable(GL_SCISSOR_TEST)
        }
    }

    /** The composed frame on the surface, mirrored, where the page's mirror is. */
    private fun show(place: Placement) {
        glBindFramebuffer(GL_FRAMEBUFFER, 0)
        // GL counts rows from the bottom; the page from the top.
        val bx = place.x
        val by = surfaceH - (place.y + place.h)
        glEnable(GL_SCISSOR_TEST)
        glScissor(bx, by, place.w, place.h)
        glClearColor(STAGE_BG[0], STAGE_BG[1], STAGE_BG[2], 1f)
        glClear(GL_COLOR_BUFFER_BIT)
        glViewport(place.px, surfaceH - (place.py + place.ph), place.pw, place.ph)
        useQuad(blit)
        bindTex(0, output!!.tex, blit.u("u_tex"))
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
        // The page's mirror has rounded corners: outside them, the page's background.
        glViewport(bx, by, place.w, place.h)
        glEnable(GL_BLEND)
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)
        useQuad(corners)
        glUniform4f(corners.u("u_rect"), bx.toFloat(), by.toFloat(), (bx + place.w).toFloat(), (by + place.h).toFloat())
        glUniform1f(corners.u("u_radius"), place.radius)
        glUniform3f(corners.u("u_color"), PAGE_BG[0], PAGE_BG[1], PAGE_BG[2])
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
        glDisable(GL_BLEND)
        glDisable(GL_SCISSOR_TEST)
    }

    private fun readOutput(): Bitmap? {
        val o = output ?: return null
        if (!hasFrame) return null
        compose()
        val data = ByteBuffer.allocateDirect(o.w * o.h * 4).order(ByteOrder.nativeOrder())
        glBindFramebuffer(GL_FRAMEBUFFER, o.fbo)
        glPixelStorei(GL_PACK_ALIGNMENT, 4)
        glReadPixels(0, 0, o.w, o.h, GL_RGBA, GL_UNSIGNED_BYTE, data)
        glBindFramebuffer(GL_FRAMEBUFFER, 0)
        data.position(0)
        // Row 0 of the target is the top of the frame, as it is in a bitmap.
        return Bitmap.createBitmap(o.w, o.h, Bitmap.Config.ARGB_8888).apply { copyPixelsFromBuffer(data) }
    }

    /* ------------------------------------------------- the stage.js passes */

    private fun ensureTargets(w: Int, h: Int) {
        if (camera != null && size[0] == w && size[1] == h) return
        listOfNotNull(camera, maskT, low1, low2, output).forEach(::dropTarget)
        pairA?.forEach(::dropTarget); pairB?.forEach(::dropTarget)
        camera = target(w, h)
        pairA = arrayOf(target(w, h), target(w, h))
        pairB = arrayOf(target(w, h), target(w, h))
        maskT = target(w, h)
        low1 = target(max(1, (w / 4f).roundToInt()), max(1, (h / 4f).roundToInt()))
        low2 = target(max(1, (w / 8f).roundToInt()), max(1, (h / 8f).roundToInt()))
        output = target(w, h)
        size = intArrayOf(w, h)
    }

    private fun buildLow() {
        val l1 = low1!!
        val l2 = low2!!
        useQuad(down)
        glBindFramebuffer(GL_FRAMEBUFFER, l1.fbo)
        glViewport(0, 0, l1.w, l1.h)
        bindTex(0, camera!!.tex, down.u("u_tex"))
        glUniform2f(down.u("u_step"), 1f / size[0], 1f / size[1])
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
        glBindFramebuffer(GL_FRAMEBUFFER, l2.fbo)
        glViewport(0, 0, l2.w, l2.h)
        bindTex(0, l1.tex, down.u("u_tex"))
        glUniform2f(down.u("u_step"), .5f / l1.w, .5f / l1.h)
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun screenBox(mask: MaskEntry): Box? {
        var x0 = 1f; var y0 = 1f; var x1 = -1f; var y1 = -1f
        for (i in mask.verts) {
            val x = facePos[i * 2]
            val y = facePos[i * 2 + 1]
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
        }
        val px = 2f / size[0]
        val py = 2f / size[1]
        val a = max(0f, (x0 + 1) / 2 - px)
        val b = min(1f, (x1 + 1) / 2 + px)
        val c = max(0f, (y0 + 1) / 2 - py)
        val d = min(1f, (y1 + 1) / 2 + py)
        return if (b > a && d > c) Box(a, c, b - a, d - c) else null
    }

    private fun renderMask(mask: MaskEntry) {
        val t = maskT!!
        glBindFramebuffer(GL_FRAMEBUFFER, t.fbo)
        glViewport(0, 0, t.w, t.h)
        glClearColor(0f, 0f, 0f, 0f)
        glClear(GL_COLOR_BUFFER_BIT)
        glUseProgram(maskP.id)
        glBindBuffer(GL_ARRAY_BUFFER, facePosBuf)
        glEnableVertexAttribArray(maskP.pos)
        glVertexAttribPointer(maskP.pos, 2, GL_FLOAT, false, 0, 0)
        glBindBuffer(GL_ARRAY_BUFFER, canonBuf)
        glEnableVertexAttribArray(maskP.uv)
        glVertexAttribPointer(maskP.uv, 2, GL_FLOAT, false, 0, 0)
        bindTex(0, mask.tex, maskP.u("u_mask"))
        val uv = mask.data.uv
        glUniform4f(maskP.u("u_box"), uv[0], uv[1], uv[2], uv[3])
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, mask.ibo)
        glDrawElements(GL_TRIANGLES, mask.count, GL_UNSIGNED_SHORT, 0)
        glDisableVertexAttribArray(maskP.uv)
    }

    private fun scissorTo(a: Box, b: Box?) {
        var x0 = a.x; var y0 = a.y; var x1 = a.x + a.w; var y1 = a.y + a.h
        if (b != null) {
            x0 = min(x0, b.x); y0 = min(y0, b.y); x1 = max(x1, b.x + b.w); y1 = max(y1, b.y + b.h)
        }
        val w = size[0]
        val h = size[1]
        val sx = max(0, floor(x0 * w).toInt() - 1)
        val sy = max(0, floor(y0 * h).toInt() - 1)
        glScissor(sx, sy, min(w, ceil(x1 * w).toInt() + 1) - sx, min(h, ceil(y1 * h).toInt() + 1) - sy)
    }

    private fun composite(layers: List<Layer>, pair: Array<Target>, probes: FloatArray, time: Float, faceWidth: Float): Int {
        var input = camera!!.tex
        var flip = 0
        var passes = 0
        var previous: Box? = null
        for (layer in layers) {
            val mask = masks[layer.key] ?: continue
            if (mask.count == 0 || !(layer.amount > 0 || layer.gloss > 0 || layer.shimmer > 0)) continue
            val box = screenBox(mask) ?: continue
            glDisable(GL_SCISSOR_TEST)
            renderMask(mask)
            // this layer's region statistics
            useQuad(stats)
            glBindFramebuffer(GL_FRAMEBUFFER, statsT!!.fbo)
            glViewport(0, 0, 1, 1)
            bindTex(0, low2!!.tex, stats.u("u_low"))
            bindTex(1, maskT!!.tex, stats.u("u_mask"))
            glUniform4f(stats.u("u_box"), box.x, box.y, box.x + box.w, box.y + box.h)
            glUniform4f(stats.u("u_probeA"), probes[0], probes[1], probes[2], probes[3])
            glUniform4f(stats.u("u_probeB"), probes[4], probes[5], probes[6], probes[7])
            glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
            // the layer itself
            val o = pair[flip]
            flip = flip xor 1
            useQuad(layerP)
            glBindFramebuffer(GL_FRAMEBUFFER, o.fbo)
            glViewport(0, 0, size[0], size[1])
            bindTex(0, input, layerP.u("u_src"))
            bindTex(1, low2!!.tex, layerP.u("u_low"))
            bindTex(2, maskT!!.tex, layerP.u("u_mask"))
            bindTex(3, statsT!!.tex, layerP.u("u_stats"))
            glUniform3f(layerP.u("u_color"), layer.color[0], layer.color[1], layer.color[2])
            glUniform1f(layerP.u("u_amount"), layer.amount)
            glUniform1f(layerP.u("u_mode"), layer.mode)
            glUniform1f(layerP.u("u_detail"), layer.detail)
            glUniform1f(layerP.u("u_gloss"), layer.gloss)
            glUniform1f(layerP.u("u_matte"), layer.matte)
            glUniform1f(layerP.u("u_shimmer"), layer.shimmer)
            glUniform1f(layerP.u("u_sheer"), layer.sheer)
            glUniform1f(layerP.u("u_lift"), layer.lift)
            glUniform1f(layerP.u("u_smooth"), layer.smooth)
            glUniform1f(layerP.u("u_bright"), layer.bright)
            glUniform2f(layerP.u("u_texel"), 1f / size[0], 1f / size[1])
            glUniform1f(layerP.u("u_radius"), max(2f, faceWidth * layer.radiusK))
            glUniform1f(layerP.u("u_time"), time)
            glEnable(GL_SCISSOR_TEST)
            if (passes < 2) scissorTo(FULL, null) else scissorTo(box, previous)
            glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)
            glDisable(GL_SCISSOR_TEST)
            input = o.tex
            previous = box
            passes++
        }
        return input
    }

    /** The frame through the procedure grid, into a target: row 0 at the top, as in every target here. */
    private fun drawMesh(tex: Int, defs: List<Deform.Def>, width: Int, height: Int) {
        var i = 0
        for (r in 0..ROWS) {
            val py = r.toFloat() / ROWS * height
            for (c in 0..COLS) {
                val px = c.toFloat() / COLS * width
                var x = px
                var y = py
                if (defs.isNotEmpty()) {
                    Deform.displace(defs, px, py, offset)
                    x += offset[0]
                    y += offset[1]
                }
                positions[i++] = x / width * 2 - 1
                positions[i++] = y / height * 2 - 1
            }
        }
        positionData.position(0); positionData.put(positions); positionData.position(0)
        glBindBuffer(GL_ARRAY_BUFFER, gridPos)
        glBufferSubData(GL_ARRAY_BUFFER, 0, positions.size * 4, positionData)
        glEnableVertexAttribArray(out.pos)
        glVertexAttribPointer(out.pos, 2, GL_FLOAT, false, 0, 0)
        glBindBuffer(GL_ARRAY_BUFFER, gridUv)
        glEnableVertexAttribArray(out.uv)
        glVertexAttribPointer(out.uv, 2, GL_FLOAT, false, 0, 0)
        bindTex(0, tex, out.u("u_tex"))
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, gridIdx)
        glDrawElements(GL_TRIANGLES, COLS * ROWS * 6, GL_UNSIGNED_SHORT, 0)
        glDisableVertexAttribArray(out.uv)
    }

    private fun probesOf(lm: FloatArray): FloatArray {
        val out = FloatArray(8)
        var k = 0
        for (i in intArrayOf(50, 280, 151, 199)) {
            out[k++] = lm[i * 3].coerceIn(.01f, .99f)
            out[k++] = lm[i * 3 + 1].coerceIn(.01f, .99f)
        }
        return out
    }

    /* ---------------------------------------------------------------- masks */

    private fun uploadMask(key: String, data: MaskData) {
        masks[key]?.let { glDeleteTextures(1, intArrayOf(it.tex), 0); glDeleteBuffers(1, intArrayOf(it.ibo), 0) }
        val tex = texture(0, 0)
        glBindTexture(GL_TEXTURE_2D, tex)
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1)
        val pixels = ByteBuffer.allocateDirect(data.alpha.size).put(data.alpha)
        pixels.position(0)
        glTexImage2D(GL_TEXTURE_2D, 0, GL_ALPHA, data.width, data.height, 0, GL_ALPHA, GL_UNSIGNED_BYTE, pixels)
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4)
        val (tris, verts) = trianglesIn(data.uv)
        val ibo = buffer(GL_ELEMENT_ARRAY_BUFFER, shorts(tris), GL_STATIC_DRAW)
        masks[key] = MaskEntry(data, tex, ibo, tris.size, verts)
    }

    private fun dropMask(key: String) {
        masks.remove(key)?.let { glDeleteTextures(1, intArrayOf(it.tex), 0); glDeleteBuffers(1, intArrayOf(it.ibo), 0) }
    }

    /** The mesh triangles that reach into a box of face space, and their corners (trianglesIn() in stage.js). */
    private fun trianglesIn(uv: FloatArray): Pair<ShortArray, IntArray> {
        val x0 = uv[0]; val y0 = uv[1]; val x1 = uv[0] + uv[2]; val y1 = uv[1] + uv[3]
        val c = code.canon
        val t = code.triangles
        val tris = ArrayList<Short>()
        val verts = LinkedHashSet<Int>()
        var k = 0
        while (k < t.size) {
            val a = t[k].toInt(); val b = t[k + 1].toInt(); val d = t[k + 2].toInt()
            k += 3
            val ax = c[a * 2]; val bx = c[b * 2]; val dx = c[d * 2]
            val ay = c[a * 2 + 1]; val by = c[b * 2 + 1]; val dy = c[d * 2 + 1]
            if (maxOf(ax, bx, dx) < x0 || minOf(ax, bx, dx) > x1 || maxOf(ay, by, dy) < y0 || minOf(ay, by, dy) > y1) continue
            tris.add(a.toShort()); tris.add(b.toShort()); tris.add(d.toShort())
            verts.add(a); verts.add(b); verts.add(d)
        }
        return tris.toShortArray() to verts.toIntArray()
    }

    /* -------------------------------------------------------------- helpers */

    private fun useQuad(p: Program) {
        glUseProgram(p.id)
        glBindBuffer(GL_ARRAY_BUFFER, quad)
        glEnableVertexAttribArray(p.pos)
        glVertexAttribPointer(p.pos, 2, GL_FLOAT, false, 0, 0)
    }

    private fun bindTex(unit: Int, tex: Int, uniform: Int) {
        glActiveTexture(GL_TEXTURE0 + unit)
        glBindTexture(GL_TEXTURE_2D, tex)
        glUniform1i(uniform, unit)
    }

    private fun texture(w: Int, h: Int, filter: Int = GL_LINEAR): Int {
        val ids = IntArray(1)
        glGenTextures(1, ids, 0)
        glBindTexture(GL_TEXTURE_2D, ids[0])
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter)
        if (w > 0) glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, null)
        return ids[0]
    }

    private fun target(w: Int, h: Int, filter: Int = GL_LINEAR): Target {
        val tex = texture(w, h, filter)
        val ids = IntArray(1)
        glGenFramebuffers(1, ids, 0)
        glBindFramebuffer(GL_FRAMEBUFFER, ids[0])
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0)
        glBindFramebuffer(GL_FRAMEBUFFER, 0)
        return Target(tex, ids[0], w, h)
    }

    private fun dropTarget(t: Target) {
        glDeleteFramebuffers(1, intArrayOf(t.fbo), 0)
        glDeleteTextures(1, intArrayOf(t.tex), 0)
    }

    private fun buffer(kind: Int, data: java.nio.Buffer, usage: Int): Int {
        val ids = IntArray(1)
        glGenBuffers(1, ids, 0)
        glBindBuffer(kind, ids[0])
        val bytes = when (data) {
            is FloatBuffer -> data.capacity() * 4
            is ShortBuffer -> data.capacity() * 2
            else -> data.capacity()
        }
        data.position(0)
        glBufferData(kind, bytes, data, usage)
        return ids[0]
    }

    private companion object {
        const val COLS = 64
        const val ROWS = 48
        const val GRID = (COLS + 1) * (ROWS + 1)
        val FULL = Box(0f, 0f, 1f, 1f)
        val ONE = floatArrayOf(1f, 1f, 1f)
        // The page's --bg, and the mirror's own darker ground.
        val PAGE_BG = floatArrayOf(0x14 / 255f, 0x0C / 255f, 0x11 / 255f)
        val STAGE_BG = floatArrayOf(0x12 / 255f, 0x0B / 255f, 0x0F / 255f)

        // The sensor frame turned upright: sensor (s, t) = (u_s · (u, v, 1), u_t · (u, v, 1)).
        const val UPRIGHT_FRAG = """uniform sampler2D u_tex;uniform vec3 u_s;uniform vec3 u_t;varying vec2 v_uv;
void main(){vec3 q=vec3(v_uv,1.);gl_FragColor=vec4(texture2D(u_tex,vec2(dot(u_s,q),dot(u_t,q))).rgb,1.);}"""

        // The frame on the surface, mirrored like the page's selfie view; screen top is frame top.
        const val BLIT_VERT = """attribute vec2 a_pos;varying vec2 v_uv;
void main(){v_uv=vec2(.5-a_pos.x*.5,.5-a_pos.y*.5);gl_Position=vec4(a_pos,0.,1.);}"""
        const val BLIT_FRAG = """uniform sampler2D u_tex;varying vec2 v_uv;
void main(){gl_FragColor=vec4(texture2D(u_tex,v_uv).rgb,1.);}"""

        // Outside a rounded rectangle (window pixels), the page's colour; inside, nothing.
        const val CORNER_FRAG = """uniform vec4 u_rect;uniform float u_radius;uniform vec3 u_color;varying vec2 v_uv;
void main(){
  vec2 c=(u_rect.xy+u_rect.zw)*.5,extent=(u_rect.zw-u_rect.xy)*.5;
  vec2 q=abs(gl_FragCoord.xy-c)-extent+vec2(u_radius);
  float d=length(max(q,0.))+min(max(q.x,q.y),0.)-u_radius;
  float a=clamp(d+.5,0.,1.);
  if(a<=0.)discard;
  gl_FragColor=vec4(u_color,a);
}"""

        fun floats(n: Int): FloatBuffer = ByteBuffer.allocateDirect(n * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        fun floats(a: FloatArray): FloatBuffer = floats(a.size).apply { put(a); position(0) }
        fun shorts(a: ShortArray): ShortBuffer =
            ByteBuffer.allocateDirect(max(2, a.size * 2)).order(ByteOrder.nativeOrder()).asShortBuffer().apply { put(a); position(0) }
    }
}
