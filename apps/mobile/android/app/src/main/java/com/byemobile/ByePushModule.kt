package com.byemobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * Push bridge (spec P1.7, E23), the Android side of iOS `ByePush`: notification permission, the
 * FCM registration token, this device's Web Push keys (ByePushCrypto) and notification taps, for
 * `platform.push` in the shared app.
 *
 * Firebase is configured from build-time values (BuildConfig, from gradle properties or the
 * environment) rather than a committed google-services.json; a build without them has no push, and
 * `requestToken` answers null.
 */
class ByePushModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "ByePush"

  init {
    instance = this
  }

  override fun invalidate() {
    if (instance === this) instance = null
    super.invalidate()
  }

  @ReactMethod
  fun requestToken(promise: Promise) {
    val context = reactApplicationContext
    if (!initializeFirebase(context)) return promise.resolve(null)
    withPermission { granted ->
      if (!granted || !NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        promise.resolve(null)
        return@withPermission
      }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (!task.isSuccessful) {
          promise.reject("PushUnavailable", task.exception?.message ?: "no FCM token")
          return@addOnCompleteListener
        }
        try {
          val keys = ByePushCrypto.loadOrCreate(context)
          ByeMessagingService.ensureChannel(context)
          promise.resolve(
            JSONObject()
              .put("platform", "fcm")
              .put("token", task.result)
              .put("sandbox", false)
              .put("p256dh", keys.p256dh)
              .put("auth", keys.authSecret)
              .toString()
          )
        } catch (error: Exception) {
          promise.reject("PushKeys", "could not create push keys")
        }
      }
    }
  }

  @ReactMethod
  fun takeInitialOpen(promise: Promise) {
    promise.resolve(takePendingOpen())
  }

  // NativeEventEmitter bookkeeping (events are only sent while JS listens).
  @ReactMethod
  fun addListener(eventName: String) {
    listeners++
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    listeners = (listeners - count.toInt()).coerceAtLeast(0)
  }

  private var listeners = 0

  private fun emit(name: String, body: String?): Boolean {
    if (listeners == 0 || !reactApplicationContext.hasActiveReactInstance()) return false
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(name, body)
    return true
  }

  /** Android 13+ asks for POST_NOTIFICATIONS at runtime; earlier versions grant it at install. */
  private fun withPermission(then: (Boolean) -> Unit) {
    val context = reactApplicationContext
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    ) return then(true)
    val activity = context.currentActivity as? PermissionAwareActivity ?: return then(false)
    activity.requestPermissions(
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      PERMISSION_REQUEST,
      PermissionListener { code, _, results ->
        if (code != PERMISSION_REQUEST) return@PermissionListener false
        then(results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED)
        true
      },
    )
  }

  companion object {
    private const val PERMISSION_REQUEST = 7201

    @Volatile private var instance: ByePushModule? = null
    @Volatile private var pendingOpen: String? = null

    /** FCM rotated the token: JS re-registers (it asks for the new one). */
    fun tokenChanged() {
      instance?.emit("ByePushToken", null)
    }

    /** A notification tap reached MainActivity. Delivered to JS, or kept for `takeInitialOpen`. */
    fun handleIntent(intent: Intent?) {
      val url = intent?.getStringExtra(ByeMessagingService.EXTRA_URL) ?: return
      intent.removeExtra(ByeMessagingService.EXTRA_URL)
      if (!url.startsWith("https://")) return
      if (instance?.emit("ByePushOpen", url) == true) return
      pendingOpen = url
    }

    @Synchronized
    private fun takePendingOpen(): String? = pendingOpen.also { pendingOpen = null }

    /** Configure Firebase once from BuildConfig; false when this build has no Firebase project. */
    fun initializeFirebase(context: Context): Boolean {
      if (FirebaseApp.getApps(context).isNotEmpty()) return true
      if (BuildConfig.FIREBASE_APP_ID.isEmpty() || BuildConfig.FIREBASE_PROJECT_ID.isEmpty()) return false
      FirebaseApp.initializeApp(
        context,
        FirebaseOptions.Builder()
          .setApplicationId(BuildConfig.FIREBASE_APP_ID)
          .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
          .setApiKey(BuildConfig.FIREBASE_API_KEY)
          .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
          .build(),
      )
      return true
    }
  }
}
