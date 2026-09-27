# The page calls these through window.RojaAndroid; keep them by name.
-keepclassmembers class com.roja.mirror.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
