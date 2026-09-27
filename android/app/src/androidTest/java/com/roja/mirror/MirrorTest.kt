package com.roja.mirror

import android.Manifest
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * The site as the app carries it, on a real Android WebView: served from the APK with
 * no network permission, the face model loading in its worker, the camera reaching
 * the page through the app, and a photo tracked and drawn on the WebGL stage. Then the
 * native mirror: the camera running natively, and a face tracked by MediaPipe and drawn
 * with makeup by the native renderer, the right way up whichever way the sensor sends it.
 */
@RunWith(AndroidJUnit4::class)
class MirrorTest {
    @get:Rule val camera: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)
    @get:Rule val activity = ActivityScenarioRule(MainActivity::class.java)

    private lateinit var app: MainActivity

    /**
     * Runs a script in the page and returns its result, JSON-encoded as WebView reports it.
     * Posted to the main thread rather than run through the scenario, so a main thread
     * that is stuck fails the test instead of hanging the run.
     */
    private fun js(script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        app.runOnUiThread { app.web.evaluateJavascript(script) { value -> result = value ?: ""; latch.countDown() } }
        check(latch.await(20, TimeUnit.SECONDS)) { "the page did not answer ${script.take(80)}" }
        return result
    }

    private fun waitFor(script: String, expected: String, seconds: Long) {
        val until = System.currentTimeMillis() + seconds * 1000
        var last = ""
        while (System.currentTimeMillis() < until) {
            last = js(script)
            if (last == expected) return
            Thread.sleep(300)
        }
        throw AssertionError("${script.take(120)} was $last, expected $expected")
    }

    @Before
    fun pageIsUp() {
        activity.scenario.onActivity { app = it }
        waitFor("document.documentElement.dataset.ready||''", "\"1\"", 90)
    }

    /** A script's result as the value it is (evaluateJavascript hands back JSON). */
    private fun value(script: String): Any? = JSONTokener(js(script)).nextValue()

    private fun state(): JSONObject = JSONObject(value("JSON.stringify(window.rojaState())") as String)

    /** The test portrait as the camera would send it: turned [degrees] (clockwise), as PNG in base64. */
    private fun portrait(degrees: Float): String {
        val bytes = InstrumentationRegistry.getInstrumentation().context.assets.open("face-test.png").use { it.readBytes() }
        var picture = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (degrees != 0f) picture = Bitmap.createBitmap(picture, 0, 0, picture.width, picture.height, Matrix().apply { postRotate(degrees) }, true)
        val out = ByteArrayOutputStream()
        picture.compress(Bitmap.CompressFormat.PNG, 100, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    /** Starts the native mirror on a still picture and waits for the face. */
    private fun startOnStill(png: String, rotation: Int): JSONObject {
        js("RojaAndroid.mirrorTestFrames('$png',$rotation);document.querySelector('#start').click();'started'")
        waitFor("(()=>{const s=window.rojaState();return s.native&&s.face})()", "true", 180)
        return state()
    }

    private fun stopMirror() {
        js("document.querySelector('#stop').click();RojaAndroid.mirrorTestFrames('',0);'stopped'")
        waitFor("window.rojaState().native", "false", 20)
    }

    /**
     * The native renderer's picture, read back, as the mean colour of 5×5 pixels around
     * each of [at] (x, y as fractions of the frame): [[r, g, b], ...].
     */
    private fun sample(at: List<List<Double>>): JSONArray {
        js("""window.__sample=null;(async()=>{
            const url=await new Promise(done=>{const was=rojaNative.onSnapshot;
              rojaNative.onSnapshot=u=>{rojaNative.onSnapshot=was;was(u);done(u);};RojaAndroid.mirrorSnapshot();});
            const image=new Image();image.src=url;await image.decode();
            const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
            const x=c.getContext('2d');x.drawImage(image,0,0);
            window.__sample=JSON.stringify(${JSONArray(at)}.map(([px,py])=>{
              const cx=Math.round(px*c.width),cy=Math.round(py*c.height);
              const d=x.getImageData(cx-2,cy-2,5,5).data;let r=0,g=0,b=0;
              for(let k=0;k<d.length;k+=4){r+=d[k];g+=d[k+1];b+=d[k+2];}
              return [r/25,g/25,b/25];}));
          })();'sampling'""")
        val until = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < until) {
            val got = value("window.__sample")
            if (got is String) return JSONArray(got)
            Thread.sleep(200)
        }
        throw AssertionError("the native mirror gave no picture")
    }

    private fun difference(a: JSONArray, b: JSONArray): Double =
        (0 until 3).sumOf { abs(a.getDouble(it) - b.getDouble(it)) }

    @Test
    fun theAppServesTheSite() {
        assertEquals("true", js("!!window.RojaAndroid"))
        assertEquals("\"https:\"", js("location.protocol"))
        assertEquals("true", js("window.isSecureContext"))
        // Full-screen is the app's job, so the page hides its own button.
        assertEquals("true", js("document.querySelector('#fullscreen').hidden"))
        Log.i("RojaTest", "WebGL: " + js("!!document.createElement('canvas').getContext('webgl')") +
            ", WebView " + js("navigator.userAgent"))
    }

    @Test
    fun theFaceModelLoadsInItsWorker() {
        js("""window.__probe='';(()=>{const w=new Worker('face-worker.js');
            w.onmessage=e=>{window.__probe=e.data.type;};
            w.onerror=e=>{window.__probe='error '+(e.message||'');};})();'started'""")
        waitFor("window.__probe", "\"ready\"", 180)
    }

    @Test
    fun theCameraReachesThePage() {
        js("""window.__camera='';navigator.mediaDevices.getUserMedia({video:true,audio:false}).then(
            s=>{window.__camera='live '+s.getVideoTracks().length;s.getTracks().forEach(t=>t.stop());},
            e=>{window.__camera='error '+e.name;});'asked'""")
        waitFor("window.__camera", "\"live 1\"", 60)
    }

    @Test
    fun theNativeCameraRuns() {
        assertEquals("true", js("RojaAndroid.nativeMirror()"))
        js("document.querySelector('#start').click();'started'")
        // The emulator's camera shows a room, not a face: frames flow and are tracked,
        // with nothing found.
        waitFor("window.rojaState().native", "true", 120)
        waitFor("(window.rojaState().info.hz||0)>0", "true", 30)
        Log.i("RojaTest", "native camera: " + state().getJSONObject("info"))
        stopMirror()
    }

    @Test
    fun theNativeMirrorDrawsMakeupOnAStill() {
        startOnStill(portrait(0f), 0)
        // Let the tracking settle, then keep these positions for every picture below.
        Thread.sleep(2500)
        val upright = state()
        val points = upright.getJSONArray("points")
        fun x(i: Int) = points.getJSONArray(i).getDouble(0)
        fun y(i: Int) = points.getJSONArray(i).getDouble(1)
        assertTrue("the eyes are not above the nose", y(33) < y(1) && y(263) < y(1))
        assertTrue("the nose is not above the mouth", y(1) < y(13))
        assertTrue("the face came out mirrored", x(33) < x(263))
        // The lipstick that is on at the start colours the lips, and only the lips: the
        // cheeks, the nose, the forehead and between the brows stay as they were.
        val lips = listOf(14, 17)
        val elsewhere = listOf(50, 280, 1, 9, 6)
        val at = (lips + elsewhere).map { listOf(x(it), y(it)) }
        val withLipstick = sample(at)
        js("document.querySelector('#clear-look').click();'cleared'")
        Thread.sleep(1500)
        val bare = sample(at)
        val lipChange = lips.indices.maxOf { difference(withLipstick.getJSONArray(it), bare.getJSONArray(it)) }
        assertTrue("the lipstick did not colour the lips ($lipChange)", lipChange > 20)
        for (k in elsewhere.indices) {
            val d = difference(withLipstick.getJSONArray(lips.size + k), bare.getJSONArray(lips.size + k))
            assertTrue("the lipstick changed landmark ${elsewhere[k]} ($d)", d < 6)
        }
        stopMirror()

        // The same face as a sensor turned a quarter turn would send it: the landmarks and
        // the picture must come out the same way up.
        startOnStill(portrait(-90f), 90)
        Thread.sleep(2500)
        val turned = state()
        assertEquals(upright.getInt("width"), turned.getInt("width"))
        assertEquals(upright.getInt("height"), turned.getInt("height"))
        val moved = turned.getJSONArray("points")
        for (i in listOf(1, 33, 263, 13, 152)) {
            val dx = abs(moved.getJSONArray(i).getDouble(0) - x(i))
            val dy = abs(moved.getJSONArray(i).getDouble(1) - y(i))
            assertTrue("landmark $i moved by ($dx, $dy) when the sensor turned", dx < .03 && dy < .03)
        }
        val turnedBare = sample(at)
        for (k in at.indices) {
            val d = difference(bare.getJSONArray(k), turnedBare.getJSONArray(k))
            assertTrue("the turned picture differs at sample $k ($d)", d < 30)
        }
        stopMirror()
    }

    @Test
    fun aPhotoIsTrackedAndDrawn() {
        val portrait = InstrumentationRegistry.getInstrumentation().context.assets.open("face-test.png").use { it.readBytes() }
        val data = Base64.encodeToString(portrait, Base64.NO_WRAP)
        // The same path as dropping a photo on the mirror.
        js("""(async()=>{const blob=await (await fetch('data:image/png;base64,$data')).blob();
            const drop=new DataTransfer();drop.items.add(new File([blob],'face.png',{type:'image/png'}));
            document.querySelector('#viewport').dispatchEvent(new DragEvent('drop',{dataTransfer:drop,bubbles:true,cancelable:true}));
            })();'dropped'""")
        // Tracked: the positioning guide goes away. Drawn: the WebGL stage is showing.
        waitFor("document.querySelector('#welcome').hidden&&document.querySelector('#guide').hidden&&!document.querySelector('#stage').hidden",
            "true", 240)
    }
}
