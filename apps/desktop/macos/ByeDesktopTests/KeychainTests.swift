import Security
import XCTest

/// ByeKeychain as the desktop app uses it. Unhosted test bundles lack the keychain-access-group
/// entitlement, so this also exercises the login-keychain fallback that unsigned builds take.
final class KeychainTests: XCTestCase {
  private let keychain = ByeKeychain(service: "email.bye.desktop.tests")
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
    XCTAssertEqual(ByeKeychain(service: "email.bye.desktop.tests.elsewhere").read("\(key).other").failureKind, "MissingCredential")
  }

  func testTheProbeLeavesNothingBehind() {
    _ = ByeKeychain.dataProtectionAvailable(service: "email.bye.desktop.tests")
    XCTAssertEqual(keychain.read("probe").failureKind, "MissingCredential")
  }

  func testStatusesMapToTheSharedErrorKinds() {
    let expected: [(OSStatus, String)] = [
      (errSecItemNotFound, "MissingCredential"),
      (errSecInteractionNotAllowed, "StorageUnavailable"),
      (errSecNotAvailable, "StorageUnavailable"),
      (errSecNoSuchKeychain, "StorageUnavailable"),
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
