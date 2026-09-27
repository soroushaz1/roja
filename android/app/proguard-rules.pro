# The page calls these through window.RojaAndroid; keep them by name.
-keepclassmembers class com.roja.mirror.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}

# MediaPipe reaches its Java classes from native code and reads protobuf messages by
# reflection; R8 must leave both alone.
-keep class com.google.mediapipe.** { *; }
-keep class com.google.protobuf.** { *; }
-dontwarn com.google.mediapipe.**
-dontwarn com.google.protobuf.**
-dontwarn com.google.auto.value.**
-dontwarn javax.annotation.**
