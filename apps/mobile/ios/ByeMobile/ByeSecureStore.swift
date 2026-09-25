import Foundation
import Security

/// Keychain-backed secure store for the mobile device session (spec §10 device sessions, X01).
/// Same JS interface and error kinds as the desktop module (`apps/desktop/.../ByeSecureStore.swift`):
/// - generic password items, one per namespaced key (environment/API origin);
/// - Data Protection keychain, `AfterFirstUnlockThisDeviceOnly`, never synchronized to iCloud;
/// - typed failures (missing, locked/unavailable, denied, corrupt); no plaintext fallback.
@objc(ByeSecureStore)
final class ByeSecureStore: NSObject {
  private let service = "email.bye.mobile"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
      kSecUseDataProtectionKeychain as String: true
    ]
  }

  /// Maps OSStatus to the shared SecureStoreError kinds (codes only; never the secret).
  private func reject(_ reject: RCTPromiseRejectBlock, _ status: OSStatus) {
    let kind: String
    switch status {
    case errSecItemNotFound:
      kind = "MissingCredential"
    case errSecInteractionNotAllowed, errSecNotAvailable:
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
