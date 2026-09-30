package com.byemobile

import com.byemobile.Fixtures.longOrNull
import com.byemobile.Fixtures.stringOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetSnapshotTest {
  @Test
  fun readsWhatTheAppPublishes() {
    for (fixture in Fixtures.cases("widget-snapshot")) {
      val rendered = fixture.getJSONObject("rendered")
      assertEquals(
        fixture.getString("name"),
        WidgetSnapshot(
          title = rendered.stringOrNull("title"),
          startMs = rendered.longOrNull("startMs"),
          timerLabel = rendered.stringOrNull("timerLabel"),
          startedAtMs = rendered.longOrNull("startedAtMs"),
          unseen = rendered.getInt("unseen"),
        ),
        WidgetSnapshot.parse(fixture.getString("json")),
      )
    }
  }

  @Test
  fun unreadableSnapshotsShowTheEmptyState() {
    assertNull(WidgetSnapshot.parse(null))
    assertNull(WidgetSnapshot.parse(""))
    assertNull(WidgetSnapshot.parse("{"))
    assertEquals(WidgetSnapshot(null, null, null, null, 0), WidgetSnapshot.parse("{}"))
  }
}
