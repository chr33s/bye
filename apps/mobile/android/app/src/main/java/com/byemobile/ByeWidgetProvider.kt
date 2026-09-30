package com.byemobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews

/**
 * Home-screen widget (C10), the Android counterpart of the iOS WidgetKit widget: next event, the
 * running timer and the new-for-you count. It reads only the snapshot the app publishes through
 * `ByeWidgetBridge`; it holds no credentials and makes no network requests. Tapping opens
 * bye://calendar.
 */
class ByeWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = render(context, manager, ids)

  companion object {
    fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
      val json = ByeWidgetBridgeModule.snapshotPrefs(context).getString(ByeWidgetBridgeModule.SNAPSHOT_KEY, null)
      val snapshot = WidgetSnapshot.parse(json)
      val views = RemoteViews(context.packageName, R.layout.bye_widget)

      val title = snapshot?.title
      val start = snapshot?.startMs
      if (title != null && start != null) {
        views.setTextViewText(R.id.widget_title, title)
        views.setTextViewText(R.id.widget_when, DateUtils.getRelativeTimeSpanString(start, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS))
        views.setViewVisibility(R.id.widget_when, View.VISIBLE)
      } else {
        views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_nothing_scheduled))
        views.setViewVisibility(R.id.widget_when, View.GONE)
      }

      val startedAt = snapshot?.startedAtMs
      if (startedAt != null) {
        // Chronometer counts up from the timer's start, converted to the elapsed-realtime clock.
        val base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - startedAt)
        views.setChronometer(R.id.widget_timer, base, "${snapshot.timerLabel} %s", true)
        views.setViewVisibility(R.id.widget_timer, View.VISIBLE)
      } else {
        views.setChronometer(R.id.widget_timer, SystemClock.elapsedRealtime(), null, false)
        views.setViewVisibility(R.id.widget_timer, View.GONE)
      }

      val unseen = snapshot?.unseen ?: 0
      if (unseen > 0) {
        views.setTextViewText(R.id.widget_unseen, context.resources.getQuantityString(R.plurals.widget_unseen, unseen, unseen))
        views.setViewVisibility(R.id.widget_unseen, View.VISIBLE)
      } else {
        views.setViewVisibility(R.id.widget_unseen, View.GONE)
      }

      val open = Intent(Intent.ACTION_VIEW, Uri.parse("bye://calendar")).setPackage(context.packageName)
      views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      manager.updateAppWidget(ids, views)
    }
  }
}
