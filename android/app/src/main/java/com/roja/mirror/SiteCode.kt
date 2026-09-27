package com.roja.mirror

import android.content.res.AssetManager

/**
 * What the native mirror shares with the website, read out of the site files the APK
 * carries: the shaders (shaders.js) and MediaPipe's canonical face mesh (facemesh.js).
 * Both renderers compile the same GLSL and paint masks in the same face space, so the
 * app cannot drift from the site.
 */
class SiteCode(assets: AssetManager) {
    /** Shader name to source, as exported from shaders.js. Fragment shaders need [precision] in front. */
    val shaders: Map<String, String>
    val precision: String

    /** Per landmark, x and y in the front-on face space the page paints masks in. */
    val canon: FloatArray

    /** The face mesh, less the triangles across the eye and mouth openings. */
    val triangles: ShortArray

    init {
        val glsl = assets.open("www/shaders.js").bufferedReader().use { it.readText() }
        shaders = Regex("export const (\\w+)=`([^`]*)`;").findAll(glsl)
            .associate { it.groupValues[1] to it.groupValues[2] }
        precision = shaders["PRECISION"] ?: error("shaders.js has no PRECISION")

        val mesh = assets.open("www/facemesh.js").bufferedReader().use { it.readText() }
        canon = numbers(mesh, "CANON").map { it.toFloat() }.toFloatArray()
        triangles = numbers(mesh, "TRIANGLES").map { it.toInt().toShort() }.toShortArray()
        check(canon.size == LANDMARKS * 2) { "facemesh.js: ${canon.size / 2} points" }
        check(triangles.isNotEmpty() && triangles.size % 3 == 0) { "facemesh.js: ${triangles.size} indices" }
    }

    fun shader(name: String): String = shaders[name] ?: error("shaders.js has no $name")

    private fun numbers(source: String, name: String): List<String> {
        val match = Regex("export const $name=new \\w+\\(\\[([^\\]]*)\\]\\)").find(source)
            ?: error("facemesh.js has no $name")
        return match.groupValues[1].split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }

    companion object {
        /** The mesh's points; MediaPipe adds ten iris points after them. */
        const val LANDMARKS = 468
    }
}
