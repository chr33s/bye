import XCTest

final class PushCryptoTests: XCTestCase {
  func testRFC8291AppendixA() throws {
    let (keys, v) = try Fixtures.receiverKeys()
    XCTAssertEqual(keys.p256dh, v["uaPublic"])
    XCTAssertEqual(keys.authSecret, v["auth"])
    let body = try XCTUnwrap(ByePushCrypto.fromBase64url(try XCTUnwrap(v["body"])))
    let plain = try ByePushCrypto.decrypt(body, keys: keys)
    XCTAssertEqual(String(decoding: plain, as: UTF8.self), v["plaintext"])
  }

  func testRejectsTruncatedAndTamperedMessages() throws {
    let (keys, v) = try Fixtures.receiverKeys()
    let body = try XCTUnwrap(ByePushCrypto.fromBase64url(try XCTUnwrap(v["body"])))
    XCTAssertThrowsError(try ByePushCrypto.decrypt(body.prefix(21), keys: keys))
    XCTAssertThrowsError(try ByePushCrypto.decrypt(body.prefix(body.count - 1), keys: keys))
    var tampered = body
    tampered[tampered.count - 1] ^= 0x01
    XCTAssertThrowsError(try ByePushCrypto.decrypt(tampered, keys: keys))
  }

  func testBase64urlRoundTrip() throws {
    for count in 0..<40 {
      let data = Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 37 &+ 250) })
      let encoded = ByePushCrypto.base64url(data)
      XCTAssertFalse(encoded.contains("=") || encoded.contains("+") || encoded.contains("/"))
      XCTAssertEqual(ByePushCrypto.fromBase64url(encoded), data)
    }
  }

  func testRegistrationMatchesTheSharedContract() throws {
    let (keys, _) = try Fixtures.receiverKeys()
    let produced = try Fixtures.cases("push-token", "produced").filter { $0["platform"] as? String == "apns" }
    XCTAssertFalse(produced.isEmpty)
    for fixture in produced {
      let json = try ByePushCrypto.registration(
        token: try XCTUnwrap(fixture["token"] as? String),
        sandbox: try XCTUnwrap(fixture["sandbox"] as? Bool), keys: keys)
      let emitted = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: Data(json.utf8)) as? NSDictionary)
      XCTAssertEqual(emitted, try XCTUnwrap(fixture["expected"] as? NSDictionary), "\(fixture["name"] ?? "")")
    }
  }

  func testNotificationServiceDecodesGatewayNotices() throws {
    let (keys, _) = try Fixtures.receiverKeys()
    for fixture in try Fixtures.cases("webpush", "notices") {
      let expected = try XCTUnwrap(fixture["expected"] as? [String: Any])
      let userInfo: [AnyHashable: Any] = ["bye": ["p": try XCTUnwrap(fixture["message"] as? String)]]
      let notice = try XCTUnwrap(NotificationService.decode(userInfo) { keys }, "\(fixture["name"] ?? "")")
      XCTAssertEqual(notice.title, expected["title"] as? String)
      XCTAssertEqual(notice.body, expected["body"] as? String)
      XCTAssertEqual(notice.url, optional(expected["url"]))
      XCTAssertEqual(notice.tag, optional(expected["tag"]))
    }
  }

  func testNotificationServiceKeepsTheGenericAlertWhenItCannotDecrypt() throws {
    let (keys, _) = try Fixtures.receiverKeys()
    let message = try XCTUnwrap(try Fixtures.cases("webpush", "notices").first?["message"] as? String)
    var keysRead = false
    XCTAssertNil(NotificationService.decode(["aps": ["alert": "x"]]) { keysRead = true; return keys })
    XCTAssertFalse(keysRead, "keys are read only when there is ciphertext")
    XCTAssertNil(NotificationService.decode(["bye": ["p": message]]) { nil })
    XCTAssertNil(NotificationService.decode(["bye": ["p": "not*base64"]]) { keys })
    XCTAssertNil(NotificationService.decode(["bye": ["p": String(message.dropLast(4))]]) { keys })
  }
}
