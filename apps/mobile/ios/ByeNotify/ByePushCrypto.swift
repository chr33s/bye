import CryptoKit
import Foundation
import Security

/// This device's Web Push keys and message decryption (RFC 8291, aes128gcm per RFC 8188), shared
/// by the app (which registers the public half) and the Notification Service Extension (which
/// decrypts). Instances encrypt notifications to these keys; Bye's push gateway and Apple only ever
/// see ciphertext (spec P1.7). The same steps as `decryptWebPush` in
/// packages/platform-cloudflare/src/transport/push/webpush.ts, checked against the RFC 8291
/// Appendix A vector by scripts/push-crypto-vector.sh.
///
/// The private key and auth secret live in the Data Protection keychain under a keychain access
/// group both targets hold, `AfterFirstUnlockThisDeviceOnly` (the extension runs while the phone is
/// locked), never synchronized to iCloud.
enum ByePushCrypto {
  static let service = "email.bye.push"
  static let account = "webpush-keys"
  /// `$(AppIdentifierPrefix)email.bye.push` in both targets' `keychain-access-groups`.
  static var accessGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "ByeKeychainGroup") as? String
  }

  struct Keys {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    /// Uncompressed P-256 point (65 bytes), base64url: the subscription's `p256dh`.
    var p256dh: String { base64url(privateKey.publicKey.x963Representation) }
    var authSecret: String { base64url(auth) }
  }

  enum Failure: Error {
    case truncated
    case keychain(OSStatus)
    case delimiter
  }

  private static func query() -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let group = accessGroup { q[kSecAttrAccessGroup as String] = group }
    return q
  }

  /// The stored keys, or nil when none were created yet.
  static func load() throws -> Keys? {
    var q = query()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data, data.count == 48 else {
      throw Failure.keychain(status)
    }
    return Keys(
      privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: data.prefix(32)),
      auth: data.suffix(16)
    )
  }

  /// The stored keys, created on first use.
  static func loadOrCreate() throws -> Keys {
    if let keys = try load() { return keys }
    let keys = Keys(privateKey: P256.KeyAgreement.PrivateKey(), auth: randomBytes(16))
    var add = query()
    add[kSecValueData as String] = keys.privateKey.rawRepresentation + keys.auth
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    // A concurrent first use (app and extension) may have stored its keys first: use those.
    if status == errSecDuplicateItem, let stored = try load() { return stored }
    guard status == errSecSuccess else { throw Failure.keychain(status) }
    return keys
  }

  /// Decrypt one aes128gcm Web Push message (a single record) with this device's keys.
  static func decrypt(_ message: Data, keys: Keys) throws -> Data {
    let bytes = [UInt8](message)
    guard bytes.count > 21 else { throw Failure.truncated }
    let salt = Data(bytes[0..<16])
    let idLength = Int(bytes[20])
    guard bytes.count > 21 + idLength + 16 else { throw Failure.truncated }
    let serverPublicRaw = Data(bytes[21..<(21 + idLength)])
    let ciphertext = Data(bytes[(21 + idLength)...])

    let serverPublic = try P256.KeyAgreement.PublicKey(x963Representation: serverPublicRaw)
    let shared = try keys.privateKey.sharedSecretFromKeyAgreement(with: serverPublic)
    let keyInfo =
      Data("WebPush: info\0".utf8) + keys.privateKey.publicKey.x963Representation + serverPublicRaw
    let ikm = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: keys.auth, sharedInfo: keyInfo, outputByteCount: 32)
    let cek = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: aes128gcm\0".utf8),
      outputByteCount: 16)
    let nonce = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: nonce\0".utf8),
      outputByteCount: 12
    ).withUnsafeBytes { Data($0) }

    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce),
      ciphertext: ciphertext.dropLast(16),
      tag: ciphertext.suffix(16)
    )
    var record = [UInt8](try AES.GCM.open(box, using: cek))
    // Strip padding back to the last-record delimiter (0x02).
    while let last = record.last, last == 0 { record.removeLast() }
    guard record.last == 2 else { throw Failure.delimiter }
    record.removeLast()
    return Data(record)
  }

  static func base64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func fromBase64url(_ value: String) -> Data? {
    var s = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
  }

  private static func randomBytes(_ count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    return Data(bytes)
  }
}
