# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# bye native modules: React Native resolves these reflectively (module names, @ReactMethod).
-keep class com.byemobile.ByeNativePackage { *; }
-keep class com.byemobile.ByeSecureStoreModule { *; }
-keep class com.byemobile.ByeWidgetBridgeModule { *; }
# Home-screen widget provider is instantiated by the system from the manifest.
-keep class com.byemobile.ByeWidgetProvider { *; }
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod *; }
# React Native's native libraries look up these classes through JNI at load time (InspectorFlags
# loads libreact_devsupportjni even in release). R8 can't see JNI references, so keep them.
-keep class com.facebook.react.devsupport.** { *; }
-keep class com.facebook.jni.** { *; }
-keep @com.facebook.proguard.annotations.DoNotStrip class * { *; }
-keepclassmembers class * { @com.facebook.proguard.annotations.DoNotStrip *; }
