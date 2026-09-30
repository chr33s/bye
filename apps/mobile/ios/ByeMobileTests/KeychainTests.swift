import Security
import XCTest

final class KeychainTests: XCTestCase {
  private let keychain = ByeKeychain(service: "email.bye.mobile.tests")
  private let key = "email.bye.session.v2|https://a.bye.test|https://a.bye.test"

  override func setUp() {
    _ = keychain.remove(key)
    _ = keychain.remove("\(key).other")
  }

  override func tearDown() { setUp() }

  func testRoundTripUpdatesInPlace() throws {
    XCTAssertEqual(keychain.read(key).failureKind, "MissingCredential")
    try keychain.write(key, value: "first").get()
    XCTAssertEqual(try keychain.read(key).get(), "first")
    try keychain.write(key, value: "second ☕").get()
    XCTAssertEqual(try keychain.read(key).get(), "second ☕")
  }

  func testSlotsAreIndependentAndRemovalIsIdempotent() throws {
    try keychain.write(key, value: "a").get()
    try keychain.write("\(key).other", value: "b").get()
    try keychain.remove(key).get()
    try keychain.remove(key).get()
    XCTAssertEqual(keychain.read(key).failureKind, "MissingCredential")
    XCTAssertEqual(try keychain.read("\(key).other").get(), "b")
    // Another service never sees this service's items.
    XCTAssertEqual(ByeKeychain(service: "email.bye.mobile.tests.elsewhere").read("\(key).other").failureKind, "MissingCredential")
  }

  func testStatusesMapToTheSharedErrorKinds() {
    let expected: [(OSStatus, String)] = [
      (errSecItemNotFound, "MissingCredential"),
      (errSecInteractionNotAllowed, "StorageUnavailable"),
      (errSecNotAvailable, "StorageUnavailable"),
      (errSecMissingEntitlement, "StorageDenied"),
      (errSecAuthFailed, "StorageDenied"),
      (errSecUserCanceled, "StorageDenied"),
      (errSecDecode, "CorruptCredential"),
      (errSecParam, "StorageUnavailable"),
    ]
    for (status, kind) in expected { XCTAssertEqual(ByeKeychain.kind(status), kind, "\(status)") }
  }
}

private extension Result where Failure == ByeKeychain.Failure {
  var failureKind: String? {
    if case .failure(let failure) = self { return failure.kind }
    return nil
  }
}
