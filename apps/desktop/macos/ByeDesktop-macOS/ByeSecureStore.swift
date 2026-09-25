import Foundation
import Security

/// Keychain-backed secure store for the desktop device session (spec §10 Desktop sign-in).
/// - Generic password items, one per namespaced key (environment/API origin).
/// - Never synchronized to iCloud Keychain; readable only on this device after first unlock.
/// - Errors are typed so the app can distinguish missing, locked/unavailable and denied storage.
///   There is no plaintext fallback.
@objc(ByeSecureStore)
final class ByeSecureStore: NSObject {
  private let service = "email.bye.desktop"

  /// Signed builds with a keychain-access-group use the Data Protection keychain. Unsigned/dev
  /// builds lack that entitlement and use the user's login keychain instead — still OS-protected,
  /// never a plaintext file.
  private lazy var useDataProtection: Bool = {
    // A write probe is required: without the entitlement, reads report "not found" while writes
    // fail with errSecMissingEntitlement (-34018).
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
  }()

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
      kSecUseDataProtectionKeychain as String: useDataProtection
    ]
  }

  /// Maps OSStatus to the shared SecureStoreError kinds (codes only; never the secret).
  private func reject(_ reject: RCTPromiseRejectBlock, _ status: OSStatus) {
    let kind: String
    switch status {
    case errSecItemNotFound:
      kind = "MissingCredential"
    case errSecInteractionNotAllowed, errSecNotAvailable, errSecNoSuchKeychain:
      kind = "StorageUnavailable"
    case errSecMissingEntitlement, errSecAuthFailed, errSecUserCanceled:
      kind = "StorageDenied"
    case errSecDecode:
      kind = "CorruptCredential"
    default:
      kind = "StorageUnavailable"
    }
    let error = NSError(domain: "email.bye.securestore", code: Int(status), userInfo: ["nativeCode": String(status)])
    reject(kind, "keychain \(kind) (\(status))", error)
  }

  @objc func read(_ key: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else { return self.reject(reject, status) }
    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else { return self.reject(reject, errSecDecode) }
    resolve(value)
  }

  @objc func write(_ key: String, value: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let data = value.data(using: .utf8) else { return self.reject(reject, errSecParam) }
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
    status == errSecSuccess ? resolve(nil) : self.reject(reject, status)
  }

  @objc func remove(_ key: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let status = SecItemDelete(baseQuery(key) as CFDictionary)
    status == errSecSuccess || status == errSecItemNotFound ? resolve(nil) : self.reject(reject, status)
  }
}
