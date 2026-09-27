package com.roja.mirror

import kotlin.math.PI
import kotlin.math.hypot

/**
 * Steadies the landmarks without making the makeup trail a moving face: the One Euro
 * filter of createSmoother() in makeup.js, one gain for the whole face so its shape is
 * never bent. At rest the jitter is smoothed away; the faster the face moves, the less
 * it is smoothed.
 */
class Smoother(private val minCutoff: Float = 1.5f, private val beta: Float = 20f, private val dCutoff: Float = 1f) {
    private var prev: FloatArray? = null
    private var prevT = 0L
    private var speed = 0f

    fun reset() {
        prev = null
    }

    private fun gain(cutoff: Float, dt: Float) = 1f / (1f + 1f / (2f * PI.toFloat() * cutoff * dt))

    /** [next] holds x, y, z per point; [timeMs] is when its frame was taken. Returns the smoothed copy. */
    fun smooth(next: FloatArray?, timeMs: Long): FloatArray? {
        if (next == null) {
            prev = null
            return null
        }
        val last = prev
        if (last == null || last.size != next.size) {
            prev = next.copyOf()
            prevT = timeMs
            speed = 0f
            return prev
        }
        val dt = ((timeMs - prevT) / 1000f).coerceAtLeast(.001f)
        prevT = timeMs
        var move = 0f
        for (i in PROBES) move += hypot(next[i * 3] - last[i * 3], next[i * 3 + 1] - last[i * 3 + 1]) / PROBES.size
        // Do not drag a stale mask onto a reacquired face.
        if (move > .1f) {
            prev = next.copyOf()
            speed = 0f
            return prev
        }
        speed += gain(dCutoff, dt) * (move / dt - speed)
        val a = gain(minCutoff + beta * speed, dt)
        val out = next.copyOf()
        for (i in 0 until next.size / 3) {
            out[i * 3] = last[i * 3] + (next[i * 3] - last[i * 3]) * a
            out[i * 3 + 1] = last[i * 3 + 1] + (next[i * 3 + 1] - last[i * 3 + 1]) * a
        }
        prev = out
        return out
    }

    private companion object {
        val PROBES = intArrayOf(1, 10, 152, 234, 454)
    }
}
