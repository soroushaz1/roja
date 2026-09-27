package com.roja.mirror

import kotlin.math.hypot
import kotlin.math.sqrt

/**
 * The displacement field behind the procedure preview: a port of deformers() and
 * displace() in deform.js, which the page still uses for its measurements and the
 * debug overlay. The gains, radii and anchors here must stay as they are there.
 *
 * Every shape edit is a sum of localised deformers anchored on landmarks, in a
 * face-local frame. Each decays to zero at its radius, and all-zero amounts are
 * exactly the identity.
 */
object Deform {
    const val AXIS = 0
    const val RADIAL = 1
    const val SHIFT = 2

    class Def(val x: Float, val y: Float, val r: Float, val kind: Int, val vx: Float, val vy: Float, val a: Float)

    private data class V(val x: Float, val y: Float)

    private fun sub(a: V, b: V) = V(a.x - b.x, a.y - b.y)
    private fun mix(a: V, b: V, t: Float) = V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    private fun unit(v: V): V {
        val l = hypot(v.x, v.y).takeIf { it > 0f } ?: 1f
        return V(v.x / l, v.y / l)
    }
    private fun blend(a: V, ka: Float, b: V, kb: Float) = unit(V(a.x * ka + b.x * kb, a.y * ka + b.y * kb))
    private fun neg(v: V) = V(-v.x, -v.y)

    /** [landmarks] holds x, y, z per point, normalised to the frame. */
    fun deformers(landmarks: FloatArray, width: Float, height: Float, amounts: Map<String, Float>): List<Def> {
        fun p(i: Int) = V(landmarks[i * 3] * width, landmarks[i * 3 + 1] * height)
        val left = p(234)
        val right = p(454)
        val ex = unit(sub(right, left))
        val ey = V(-ex.y, ex.x)
        val up = neg(ey)
        val face = hypot(right.x - left.x, right.y - left.y).takeIf { it > 0f } ?: 1f
        val out = ArrayList<Def>()
        fun at(id: String) = (amounts[id] ?: 0f) / 100f

        fun axis(anchor: V, r: Float, v: V, gain: Float) {
            if (gain != 0f) out.add(Def(anchor.x, anchor.y, r, AXIS, v.x, v.y, gain))
        }
        fun radial(anchor: V, r: Float, gain: Float) {
            if (gain != 0f) out.add(Def(anchor.x, anchor.y, r, RADIAL, 0f, 0f, gain))
        }
        fun shift(anchor: V, r: Float, v: V, gain: Float) {
            if (gain != 0f) out.add(Def(anchor.x, anchor.y, r, SHIFT, v.x * r, v.y * r, gain))
        }

        /* nose */
        axis(mix(p(1), p(2), .5f), face * .20f, ex, at("nose-width") * .75f)
        axis(mix(p(168), p(6), .5f), face * .14f, ex, at("nose-bridge") * .70f)
        shift(p(1), face * .16f, up, at("nose-tip") * .60f)
        radial(mix(p(1), p(4), .5f), face * .10f, at("nose-tip-size") * .45f)

        /* lips */
        axis(mix(p(0), p(17), .5f), face * .26f, ey, at("lip-fullness") * .75f)
        axis(mix(p(0), p(13), .5f), face * .13f, ey, at("lip-upper") * .65f)
        axis(mix(p(14), p(17), .5f), face * .14f, ey, at("lip-lower") * .65f)
        axis(mix(p(13), p(14), .5f), face * .30f, ex, at("lip-width") * .35f)
        shift(p(61), face * .08f, up, at("lip-corners") * .30f)
        shift(p(291), face * .08f, up, at("lip-corners") * .30f)
        shift(p(0), face * .10f, up, at("lip-lift") * .28f)

        /* cheeks and temples */
        radial(p(50), face * .24f, at("cheek-volume") * .58f)
        radial(p(280), face * .24f, at("cheek-volume") * .58f)
        radial(mix(p(50), p(61), .62f), face * .21f, -at("cheek-hollow") * .60f)
        radial(mix(p(280), p(291), .62f), face * .21f, -at("cheek-hollow") * .60f)
        shift(mix(p(132), p(58), .5f), face * .20f, ex, at("cheek-hollow") * .16f)
        shift(mix(p(361), p(288), .5f), face * .20f, neg(ex), at("cheek-hollow") * .16f)
        shift(mix(mix(p(162), p(21), .5f), p(70), .3f), face * .15f, neg(ex), at("temple") * .25f)
        shift(mix(mix(p(389), p(251), .5f), p(300), .3f), face * .15f, ex, at("temple") * .25f)

        /* jaw and chin */
        shift(p(172), face * .34f, neg(ex), at("jaw-width") * .32f)
        shift(p(397), face * .34f, ex, at("jaw-width") * .32f)
        shift(mix(p(150), p(136), .5f), face * .20f, blend(up, .85f, ex, .5f), at("jowl") * .22f)
        shift(mix(p(379), p(365), .5f), face * .20f, blend(up, .85f, neg(ex), .5f), at("jowl") * .22f)
        shift(p(152), face * .26f, ey, at("chin-length") * .34f)
        axis(p(175), face * .17f, ex, at("chin-width") * .55f)

        /* eyes and brows */
        val leftEye = mix(p(33), p(133), .5f)
        val rightEye = mix(p(362), p(263), .5f)
        radial(leftEye, face * .15f, at("eye-size") * .55f)
        radial(rightEye, face * .15f, at("eye-size") * .55f)
        axis(leftEye, face * .13f, ey, at("eye-open") * .60f)
        axis(rightEye, face * .13f, ey, at("eye-open") * .60f)
        shift(p(33), face * .085f, blend(up, 1f, neg(ex), .3f), at("eye-tilt") * .24f)
        shift(p(263), face * .085f, blend(up, 1f, ex, .3f), at("eye-tilt") * .24f)
        shift(mix(p(105), p(107), .5f), face * .20f, up, at("brow-lift") * .22f)
        shift(mix(p(334), p(336), .5f), face * .20f, up, at("brow-lift") * .22f)
        shift(mix(p(70), p(46), .5f), face * .10f, up, at("brow-tail") * .28f)
        shift(mix(p(300), p(276), .5f), face * .10f, up, at("brow-tail") * .28f)
        return out
    }

    /** d(q) = Σ amount · smoothstep(1 − |q−anchor|/r) · direction, into [out] (x, y). */
    fun displace(defs: List<Def>, x: Float, y: Float, out: FloatArray) {
        var dx = 0f
        var dy = 0f
        for (d in defs) {
            val ax = x - d.x
            val ay = y - d.y
            val dist2 = ax * ax + ay * ay
            if (dist2 >= d.r * d.r) continue
            val t = 1f - sqrt(dist2) / d.r
            val s = t * t * (3f - 2f * t) * d.a
            when (d.kind) {
                AXIS -> {
                    val proj = ax * d.vx + ay * d.vy
                    dx += s * proj * d.vx
                    dy += s * proj * d.vy
                }
                RADIAL -> {
                    dx += s * ax
                    dy += s * ay
                }
                else -> {
                    dx += s * d.vx
                    dy += s * d.vy
                }
            }
        }
        out[0] = dx
        out[1] = dy
    }
}
