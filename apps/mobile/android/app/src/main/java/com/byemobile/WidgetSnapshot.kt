package com.byemobile

import org.json.JSONObject

/**
 * The snapshot the app publishes through ByeWidgetBridge (next event, running timer, unseen count),
 * as the widget reads it. Its JSON is pinned by packages/contracts/test/fixtures/native/
 * widget-snapshot.json, which WidgetSnapshotTest parses.
 */
data class WidgetSnapshot(
  val title: String?,
  val startMs: Long?,
  val timerLabel: String?,
  val startedAtMs: Long?,
  val unseen: Int,
) {
  companion object {
    /** Null when nothing (readable) was published: the widget shows its empty state. */
    fun parse(json: String?): WidgetSnapshot? {
      val snapshot = json?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
      val event = snapshot.optJSONObject("nextEvent")
      val timer = snapshot.optJSONObject("timer")
      return WidgetSnapshot(
        title = event?.optString("title"),
        startMs = event?.optDouble("startMs")?.toLong(),
        timerLabel = timer?.optString("label"),
        startedAtMs = timer?.optDouble("startedAtMs")?.toLong(),
        unseen = snapshot.optInt("unseen", 0),
      )
    }
  }
}
