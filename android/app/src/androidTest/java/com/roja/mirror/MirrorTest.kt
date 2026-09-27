package com.roja.mirror

import android.Manifest
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The site as the app carries it, on a real Android WebView: served from the APK with
 * no network permission, the face model loading in its worker, the camera reaching
 * the page through the app, and a photo tracked and drawn on the WebGL stage.
 */
@RunWith(AndroidJUnit4::class)
class MirrorTest {
    @get:Rule val camera: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)
    @get:Rule val activity = ActivityScenarioRule(MainActivity::class.java)

    /** Runs a script in the page and returns its result, JSON-encoded as WebView reports it. */
    private fun js(script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        activity.scenario.onActivity { it.web.evaluateJavascript(script) { value -> result = value ?: ""; latch.countDown() } }
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
    fun pageIsUp() = waitFor("document.documentElement.dataset.ready||''", "\"1\"", 90)

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
