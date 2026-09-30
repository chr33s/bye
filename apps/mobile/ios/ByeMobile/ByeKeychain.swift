import Foundation
import Security

/// The Keychain half of ByeSecureStore, free of React Native so ByeMobileTests can run it:
/// generic password items, one per namespaced key, in the Data Protection keychain,
/// `AfterFirstUnlockThisDeviceOnly`, never synchronized to iCloud.
struct ByeKeychain {
  /// A failed Keychain call as the shared SecureStoreError kind plus its OSStatus.
  struct Failure: Error, Equatable {
    let kind: String
    let status: OSStatus
  }

  let service: String

  /// Maps OSStatus to the shared SecureStoreError kinds (codes only; never the secret).
  static func kind(_ status: OSStatus) -> String {
    switch status {
    case errSecItemNotFound:
      return "MissingCredential"
    case errSecInteractionNotAllowed, errSecNotAvailable:
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
      kSecUseDataProtectionKeychain as String: true
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
