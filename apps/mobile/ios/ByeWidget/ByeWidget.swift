import SwiftUI
import WidgetKit

// Home-screen widget: next event, running timer, and unseen count. Reads only the snapshot the app
// publishes into the App Group (Snapshot.swift); it holds no credentials and makes no network
// requests.

struct Entry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
}

struct Provider: TimelineProvider {
  func load() -> Snapshot? {
    UserDefaults(suiteName: "group.email.bye")?.string(forKey: "widgetSnapshot").flatMap(Snapshot.decode)
  }

  func placeholder(in context: Context) -> Entry { Entry(date: .now, snapshot: nil) }

  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now, snapshot: load())) }

  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [Entry(date: .now, snapshot: load())], policy: .after(.now.addingTimeInterval(15 * 60))))
  }
}

struct ByeWidgetView: View {
  let entry: Entry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("bye").font(.caption).foregroundStyle(.secondary)
      if let event = entry.snapshot?.nextEvent {
        Text(event.title).font(.headline).lineLimit(2)
        Text(Date(timeIntervalSince1970: event.startMs / 1000), style: .relative).font(.caption)
      } else {
        Text("Nothing scheduled").font(.headline)
      }
      if let timer = entry.snapshot?.timer {
        Label { Text(Date(timeIntervalSince1970: timer.startedAtMs / 1000), style: .timer) } icon: { Image(systemName: "timer") }.font(.caption)
      }
      if let unseen = entry.snapshot?.unseen, unseen > 0 {
        Text("\(unseen) new for you").font(.caption2).foregroundStyle(.secondary)
      }
    }
    .widgetURL(URL(string: "bye://calendar"))
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

@main
struct ByeWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "ByeWidget", provider: Provider()) { entry in ByeWidgetView(entry: entry) }
      .configurationDisplayName("bye")
      .description("Your next event and running timer.")
      .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
  }
}
