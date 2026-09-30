import XCTest

final class ShareHandoffTests: XCTestCase {
  func testLinksMatchTheSharedContract() throws {
    for fixture in try Fixtures.cases("share-handoff") {
      XCTAssertEqual(
        ShareHandoff.link(text: optional(fixture["text"]), url: optional(fixture["url"])),
        fixture["link"] as? String, fixture["name"] as? String ?? "")
    }
  }

  func testSharedTextIsBounded() throws {
    let link = try XCTUnwrap(ShareHandoff.link(text: String(repeating: "a", count: 10_000), url: nil))
    let text = try XCTUnwrap(URLComponents(string: link)?.queryItems?.first { $0.name == "text" }?.value)
    XCTAssertEqual(text.count, ShareHandoff.maxText)
  }
}
