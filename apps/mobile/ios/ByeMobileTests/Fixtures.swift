import CryptoKit
import Foundation
import XCTest

/// The bridge contracts in packages/contracts/test/fixtures/native, shared with the TypeScript
/// (packages/native-shared/test/bridge.test.ts) and Kotlin (android/app/src/test) suites. Read from
/// the checkout: simulator test processes can reach the host file system.
enum Fixtures {
  static let root = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../packages/contracts/test/fixtures/native")
    .standardizedFileURL

  static func load(_ name: String) throws -> [String: Any] {
    let data = try Data(contentsOf: root.appendingPathComponent("\(name).json"))
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  static func cases(_ name: String, _ key: String = "cases") throws -> [[String: Any]] {
    try XCTUnwrap(try load(name)[key] as? [[String: Any]])
  }

  /// The RFC 8291 Appendix A receiver as this device's keys.
  static func receiverKeys() throws -> (keys: ByePushCrypto.Keys, vector: [String: String]) {
    let vector = try XCTUnwrap(try load("webpush")["rfc8291"] as? [String: String])
    let raw = try XCTUnwrap(ByePushCrypto.fromBase64url(try XCTUnwrap(vector["uaPrivate"])))
    let auth = try XCTUnwrap(ByePushCrypto.fromBase64url(try XCTUnwrap(vector["auth"])))
    let keys = ByePushCrypto.Keys(
      privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: raw), auth: auth)
    return (keys, vector)
  }
}

/// JSON null decodes to NSNull; the fixtures use it for "absent".
func optional<T>(_ value: Any?) -> T? { value is NSNull ? nil : value as? T }
