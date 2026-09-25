package com.byemobile

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Bridge between the React Native app and the home-screen widget (C10), mirroring the iOS
 * `ByeWidgetBridge`: the app publishes a small snapshot (next event, running timer, unseen count;
 * no message content, no credentials) and the widget renders it without network access.
 */
class ByeWidgetBridgeModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "ByeWidgetBridge"

  @ReactMethod
  fun publish(json: String) {
    if (json.length >= 16_384) return
    val context = reactApplicationContext
    snapshotPrefs(context).edit().putString(SNAPSHOT_KEY, json).apply()
    val manager = AppWidgetManager.getInstance(context)
    val ids = manager.getAppWidgetIds(ComponentName(context, ByeWidgetProvider::class.java))
    if (ids.isNotEmpty()) ByeWidgetProvider.render(context, manager, ids)
  }

  @ReactMethod
  fun takePendingShare(promise: Promise) {
    // Android delivers shares as SEND intents to MainActivity (handled by the deep-link path), so
    // there is never a pending handoff to collect here; kept for interface parity with iOS.
    promise.resolve(null)
  }

  companion object {
    const val SNAPSHOT_KEY = "widgetSnapshot"
    fun snapshotPrefs(context: Context) = context.getSharedPreferences("bye_widget", Context.MODE_PRIVATE)
  }
}
