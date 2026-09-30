import XCTest

final class WidgetSnapshotTests: XCTestCase {
  func testDecodesWhatTheAppPublishes() throws {
    for fixture in try Fixtures.cases("widget-snapshot") {
      let name = fixture["name"] as? String ?? ""
      let rendered = try XCTUnwrap(fixture["rendered"] as? [String: Any])
      let snapshot = try XCTUnwrap(Snapshot.decode(try XCTUnwrap(fixture["json"] as? String)), name)
      XCTAssertEqual(snapshot.nextEvent?.title, optional(rendered["title"]), name)
      XCTAssertEqual(snapshot.nextEvent?.startMs, optional(rendered["startMs"]), name)
      XCTAssertEqual(snapshot.timer?.label, optional(rendered["timerLabel"]), name)
      XCTAssertEqual(snapshot.timer?.startedAtMs, optional(rendered["startedAtMs"]), name)
      XCTAssertEqual(snapshot.unseen, rendered["unseen"] as? Int, name)
    }
  }

  func testUnreadableSnapshotsShowNothing() {
    XCTAssertNil(Snapshot.decode(""))
    XCTAssertNil(Snapshot.decode("{"))
    XCTAssertNil(Snapshot.decode(#"{"nextEvent":null,"timer":null}"#))
    XCTAssertNil(Snapshot.decode(#"{"nextEvent":{"title":1,"startMs":0},"timer":null,"unseen":0}"#))
  }
}
