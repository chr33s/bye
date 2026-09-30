import Foundation
import Security

/// Keychain-backed secure store for the mobile device session (spec §10 device sessions, X01).
/// Same JS interface and error kinds as the desktop module (`apps/desktop/.../ByeSecureStore.swift`):
/// - generic password items, one per namespaced key (environment/API origin);
/// - Data Protection keychain, `AfterFirstUnlockThisDeviceOnly`, never synchronized to iCloud;
/// - typed failures (missing, locked/unavailable, denied, corrupt); no plaintext fallback.
/// The Keychain calls live in ByeKeychain.swift.
@objc(ByeSecureStore)
final class ByeSecureStore: NSObject {
  private let keychain = ByeKeychain(service: "email.bye.mobile")

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func settle<T>(_ result: Result<T, ByeKeychain.Failure>, _ resolve: RCTPromiseResolveBlock, _ reject: RCTPromiseRejectBlock, _ value: (T) -> Any?) {
    switch result {
    case .success(let success):
      resolve(value(success))
    case .failure(let failure):
      let error = NSError(domain: "email.bye.securestore", code: Int(failure.status), userInfo: ["nativeCode": String(failure.status)])
      reject(failure.kind, "keychain \(failure.kind) (\(failure.status))", error)
    }
  }

  @objc func read(_ key: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    settle(keychain.read(key), resolve, reject) { $0 }
  }

  @objc func write(_ key: String, value: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    settle(keychain.write(key, value: value), resolve, reject) { nil }
  }

  @objc func remove(_ key: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    settle(keychain.remove(key), resolve, reject) { nil }
  }
}
