package com.roja.mirror

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * Roja on Android: the website, carried inside the app and shown in a WebView, with the
 * live mirror done natively underneath it.
 *
 * Every file is served from the APK's assets under https://appassets.androidplatform.net,
 * a secure origin. The page is the interface; for the live camera it hands the heavy
 * part to [NativeMirror] (CameraX, MediaPipe on the GPU, and [MirrorRenderer] in OpenGL),
 * drawn in a surface under the WebView, which lets it show through where the page's
 * mirror is. Photos still go through the page's own WebGL. The app has no network
 * permission: nothing it shows comes from the internet, and nothing the camera sees can
 * leave the phone.
 */
class MainActivity : ComponentActivity() {

    internal lateinit var web: WebView
        private set

    private var pendingCamera: PermissionRequest? = null
    private var pendingMirror = false

    // The native mirror. Null if it could not be set up, and the page then uses the
    // browser camera as it does on the web.
    private var mirror: NativeMirror? = null
    private var renderer: MirrorRenderer? = null
    private var mirrorView: GLSurfaceView? = null
    private var pendingPhoto: ValueCallback<Array<Uri>>? = null
    private var pendingSave: ByteArray? = null

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (pendingMirror) {
            pendingMirror = false
            if (granted) mirror?.start()
            else {
                page("window.rojaNative&&rojaNative.onError('NotAllowedError','')")
                toast(R.string.camera_denied)
            }
        }
        val request = pendingCamera ?: return@registerForActivityResult
        pendingCamera = null
        if (granted) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
            toast(R.string.camera_denied)
        }
    }
    private val pickPhoto = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        // null tells the page the picker was cancelled.
        pendingPhoto?.onReceiveValue(uri?.let { arrayOf(it) })
        pendingPhoto = null
    }
    private val saveImageAs = registerForActivityResult(ActivityResultContracts.CreateDocument("image/png")) { writePending(it) }
    private val saveJsonAs = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { writePending(it) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val background = getColor(R.color.roja_bg)
        val root = FrameLayout(this).apply { setBackgroundColor(background) }
        val fill = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        // The native mirror's surface, under the page. It fills the same area, so the
        // page's coordinates are its coordinates.
        try {
            val drawer = MirrorRenderer(SiteCode(assets))
            val surface = GLSurfaceView(this).apply {
                setEGLContextClientVersion(2)
                preserveEGLContextOnPause = true
                setRenderer(drawer)
                renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
            }
            root.addView(surface, fill)
            renderer = drawer
            mirrorView = surface
            mirror = NativeMirror(this, drawer, surface, MirrorEvents())
        } catch (e: Throwable) {
            Log.e(TAG, "native mirror unavailable", e)
        }
        // Transparent, so the native mirror shows through where the page leaves a hole.
        web = WebView(this).apply { setBackgroundColor(if (mirror != null) Color.TRANSPARENT else background) }
        root.addView(web, fill)
        setContentView(root)
        // Keep the page clear of the status bar, the navigation bar, a camera cutout
        // and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val edges = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            view.setPadding(edges.left, edges.top, edges.right, edges.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val site = WebViewAssetLoader.Builder()
            .addPathHandler("/", SiteFiles(assets))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The camera preview starts after an asynchronous permission prompt, which
            // is no longer "during a tap".
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        web.addJavascriptInterface(Bridge(), "RojaAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                site.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                // Anything else, a licence link say, opens in the browser.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val camera = PermissionRequest.RESOURCE_VIDEO_CAPTURE
                if (request.origin.host != WebViewAssetLoader.DEFAULT_DOMAIN || camera !in request.resources) {
                    request.deny()
                    return
                }
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(camera))
                } else {
                    pendingCamera?.deny()
                    pendingCamera = request
                    askCamera.launch(Manifest.permission.CAMERA)
                }
            }

            // «انتخاب عکس»: the system photo picker, which needs no storage permission.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pendingPhoto?.onReceiveValue(null)
                pendingPhoto = callback
                pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                return true
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }

        // Back closes whatever the page has open on top first, then leaves.
        onBackPressedDispatcher.addCallback(this) {
            web.evaluateJavascript("window.rojaBack?window.rojaBack():false") { handled ->
                if (handled != "true") finish()
            }
        }

        web.loadUrl(START_URL)
    }

    // The page turns the camera off when it is hidden, so leaving the app releases it;
    // the native camera is stopped here, and the page told.
    override fun onPause() {
        mirror?.let {
            if (it.running) {
                it.stop()
                page("window.rojaNative&&rojaNative.onStop()")
            }
        }
        mirrorView?.onPause()
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        mirrorView?.onResume()
        web.onResume()
    }

    override fun onDestroy() {
        mirror?.close()
        web.destroy()
        super.onDestroy()
    }

    private fun page(script: String) = runOnUiThread { web.evaluateJavascript(script, null) }

    private inner class MirrorEvents : NativeMirror.Events {
        override fun onStart(width: Int, height: Int) = page("window.rojaNative&&rojaNative.onStart($width,$height)")
        override fun onFrame(json: String) = page("window.rojaNative&&rojaNative.onFrame($json)")
        override fun onError(name: String, message: String) =
            page("window.rojaNative&&rojaNative.onError(${JSONObject.quote(name)},${JSONObject.quote(message)})")
    }

    private fun startMirror() {
        val m = mirror ?: return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED || m.still != null) m.start()
        else {
            pendingMirror = true
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun layers(array: JSONArray?): List<MirrorRenderer.Layer>? {
        if (array == null) return null
        return (0 until array.length()).map { i ->
            val l = array.getJSONObject(i)
            val c = l.getJSONArray("color")
            MirrorRenderer.Layer(
                l.getString("key"), floatArrayOf(c.getDouble(0).toFloat(), c.getDouble(1).toFloat(), c.getDouble(2).toFloat()),
                l.optDouble("amount", 0.0).toFloat(), l.optDouble("mode", 0.0).toFloat(), l.optDouble("detail", 0.0).toFloat(),
                l.optDouble("gloss", 0.0).toFloat(), l.optDouble("matte", 0.0).toFloat(), l.optDouble("shimmer", 0.0).toFloat(),
                l.optDouble("smooth", 0.0).toFloat(), l.optDouble("bright", 0.0).toFloat(), l.optDouble("radiusK", .03).toFloat()
            )
        }
    }

    /** What the page may ask of the app, through `window.RojaAndroid`. Runs on a WebView thread. */
    private inner class Bridge {
        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String): String {
            val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return "error"
            val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return saveToMediaStore(bytes, safeName, mime)
            // Android 8 and 9 have no shared folders without a storage permission, so the
            // person picks where the file goes.
            pendingSave = bytes
            runOnUiThread { if (mime.startsWith("image/")) saveImageAs.launch(safeName) else saveJsonAs.launch(safeName) }
            return "picker"
        }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) = runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        /* The native mirror. The page calls these instead of using the browser camera. */

        @JavascriptInterface
        fun nativeMirror(): Boolean = mirror != null

        @JavascriptInterface
        fun mirrorStart() = runOnUiThread { startMirror() }

        @JavascriptInterface
        fun mirrorStop() = runOnUiThread { mirror?.stop() }

        @JavascriptInterface
        fun mirrorFreeze(on: Boolean) {
            mirror?.frozen = on
        }

        /** Where the page's mirror is, in device pixels: {x, y, w, h, r} and the picture {px, py, pw, ph}. */
        @JavascriptInterface
        fun mirrorPlace(json: String) {
            val o = JSONObject(json)
            renderer?.placement = MirrorRenderer.Placement(
                o.getInt("x"), o.getInt("y"), o.getInt("w"), o.getInt("h"), o.optDouble("r", 0.0).toFloat(),
                o.getInt("px"), o.getInt("py"), o.getInt("pw"), o.getInt("ph")
            )
            mirrorView?.requestRender()
        }

        /** What to draw: {after, amounts, before, seam, grade}, as the page's plan() gives it. */
        @JavascriptInterface
        fun mirrorPlan(json: String) {
            val o = JSONObject(json)
            val amounts = o.optJSONObject("amounts")?.let { a -> a.keys().asSequence().associateWith { a.getDouble(it).toFloat() } }
            val grade = o.optJSONArray("grade")?.let { g -> floatArrayOf(g.getDouble(0).toFloat(), g.getDouble(1).toFloat(), g.getDouble(2).toFloat()) }
            renderer?.plan = MirrorRenderer.Plan(
                layers(o.optJSONArray("after")) ?: emptyList(), amounts, layers(o.optJSONArray("before")),
                if (o.isNull("seam")) null else o.getDouble("seam").toFloat(), grade
            )
            mirrorView?.requestRender()
        }

        /** One mask, painted by the page in face space: [box] is [x, y, w, h] there; [alpha] is base64, one byte a pixel. */
        @JavascriptInterface
        fun mirrorMask(key: String, box: String, width: Int, height: Int, alpha: String) {
            val b = JSONArray(box)
            val bytes = Base64.decode(alpha, Base64.DEFAULT)
            if (bytes.size != width * height) return
            renderer?.setMask(key, floatArrayOf(b.getDouble(0).toFloat(), b.getDouble(1).toFloat(), b.getDouble(2).toFloat(), b.getDouble(3).toFloat()), width, height, bytes)
            mirrorView?.requestRender()
        }

        @JavascriptInterface
        fun mirrorKeep(keys: String) {
            val a = JSONArray(keys)
            renderer?.keepMasks((0 until a.length()).map { a.getString(it) }.toSet())
            mirrorView?.requestRender()
        }

        @JavascriptInterface
        fun mirrorSkin(on: Boolean) {
            mirror?.wantSkin = on
        }

        @JavascriptInterface
        fun mirrorExtras(on: Boolean) {
            mirror?.wantExtras = on
        }

        /** The picture as drawn, delivered to rojaNative.onSnapshot as a PNG data URL (or null). */
        @JavascriptInterface
        fun mirrorSnapshot() {
            val drawer = renderer ?: return
            drawer.snapshot { bitmap ->
                val url = bitmap?.let {
                    val out = ByteArrayOutputStream()
                    it.compress(Bitmap.CompressFormat.PNG, 100, out)
                    "'data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP) + "'"
                } ?: "null"
                page("window.rojaNative&&rojaNative.onSnapshot($url)")
            }
            mirrorView?.requestRender()
        }

        /**
         * For the device tests: a still picture (PNG, base64) stands in for the camera,
         * turned by [rotation] as a sensor frame would be. An empty string goes back to the camera.
         */
        @JavascriptInterface
        fun mirrorTestFrames(png: String, rotation: Int) {
            val m = mirror ?: return
            if (png.isEmpty()) {
                m.useStill(null, 0)
                return
            }
            val bytes = Base64.decode(png, Base64.DEFAULT)
            m.useStill(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.copy(Bitmap.Config.ARGB_8888, false), rotation)
        }
    }

    /** Snapshots go to Pictures/Roja, anything else to Download/Roja. */
    @RequiresApi(Build.VERSION_CODES.Q)
    private fun saveToMediaStore(bytes: ByteArray, name: String, mime: String): String {
        val image = mime.startsWith("image/")
        val collection = if (image) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH,
                (if (image) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS) + "/Roja")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(collection, values) ?: return "error"
        return try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IOException("no output stream")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            "saved"
        } catch (e: IOException) {
            Log.w(TAG, "saving $name failed", e)
            contentResolver.delete(uri, null, null)
            "error"
        }
    }

    private fun writePending(uri: Uri?) {
        val bytes = pendingSave
        pendingSave = null
        if (uri == null || bytes == null) return
        val written = runCatching { contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null }.getOrDefault(false)
        toast(if (written) R.string.saved else R.string.save_failed)
    }

    private fun toast(message: Int) = runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    companion object {
        private const val TAG = "Roja"
        const val START_URL = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/index.html"
    }
}

/** Serves the site out of `assets/www`, with the content types the page relies on (wasm above all). */
private class SiteFiles(private val assets: AssetManager) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val name = path.trimStart('/').ifEmpty { "index.html" }
        val type = TYPES[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
        val text = type.startsWith("text/") || type.endsWith("json")
        return try {
            WebResourceResponse(type, if (text) "utf-8" else null, assets.open("www/$name"))
        } catch (e: IOException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    companion object {
        val TYPES = mapOf(
            "html" to "text/html", "js" to "text/javascript", "css" to "text/css",
            "wasm" to "application/wasm", "svg" to "image/svg+xml", "png" to "image/png",
            "woff2" to "font/woff2", "json" to "application/json", "task" to "application/octet-stream",
            "txt" to "text/plain", "md" to "text/markdown"
        )
    }
}
