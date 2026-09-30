import Foundation
import Security

/// The Keychain half of ByeSecureStore, free of React Native so ByeDesktopTests can run it:
/// generic password items, one per namespaced key, never synchronized to iCloud Keychain,
/// readable only on this device after first unlock.
struct ByeKeychain {
  /// A failed Keychain call as the shared SecureStoreError kind plus its OSStatus.
  struct Failure: Error, Equatable {
    let kind: String
    let status: OSStatus
  }

  let service: String

  /// Signed builds with a keychain-access-group use the Data Protection keychain. Unsigned/dev
  /// builds lack that entitlement and use the user's login keychain instead — still OS-protected,
  /// never a plaintext file.
  let useDataProtection: Bool

  init(service: String) {
    self.service = service
    useDataProtection = Self.dataProtectionAvailable(service: service)
  }

  /// A write probe is required: without the entitlement, reads report "not found" while writes
  /// fail with errSecMissingEntitlement (-34018).
  static func dataProtectionAvailable(service: String) -> Bool {
    let probe: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "probe",
      kSecUseDataProtectionKeychain as String: true
    ]
    var add = probe
    add[kSecValueData as String] = Data([1])
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    SecItemDelete(probe as CFDictionary)
    return status != errSecMissingEntitlement
  }

  /// Maps OSStatus to the shared SecureStoreError kinds (codes only; never the secret).
  static func kind(_ status: OSStatus) -> String {
    switch status {
    case errSecItemNotFound:
      return "MissingCredential"
    case errSecInteractionNotAllowed, errSecNotAvailable, errSecNoSuchKeychain:
      return "StorageUnavailable"
    case errSecMissingEntitlement, errSecAuthFailed, errSecUserCanceled:
      return "StorageDenied"
    case errSecDecode:
      return "CorruptCredential"
    default:
      return "StorageUnavailable"
    }
  }

  private func failure(_ status: OSStatus) -> Failure { Failure(kind: Self.kind(status), status: status) }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
      kSecUseDataProtectionKeychain as String: useDataProtection
    ]
  }

  func read(_ key: String) -> Result<String, Failure> {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else { return .failure(failure(status)) }
    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else { return .failure(failure(errSecDecode)) }
    return .success(value)
  }

  func write(_ key: String, value: String) -> Result<Void, Failure> {
    guard let data = value.data(using: .utf8) else { return .failure(failure(errSecParam)) }
    // Update in place when present so a failed write never deletes the previous credential.
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    var status = SecItemUpdate(baseQuery(key) as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = baseQuery(key)
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(add as CFDictionary, nil)
    }
    return status == errSecSuccess ? .success(()) : .failure(failure(status))
  }

  func remove(_ key: String) -> Result<Void, Failure> {
    let status = SecItemDelete(baseQuery(key) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound ? .success(()) : .failure(failure(status))
  }
}
