import Foundation

/// The snapshot the app publishes into the App Group (ByeWidgetBridge.publish): next event, running
/// timer and unseen count. Its JSON is pinned by packages/contracts/test/fixtures/native/
/// widget-snapshot.json, which ByeMobileTests decodes.
struct Snapshot: Decodable {
  struct Event: Decodable { let title: String; let startMs: Double }
  struct Timer: Decodable { let label: String; let startedAtMs: Double }
  let nextEvent: Event?
  let timer: Timer?
  let unseen: Int

  static func decode(_ json: String) -> Snapshot? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Snapshot.self, from: data)
  }
}
