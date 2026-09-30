import Foundation
import Security

/// Keychain-backed secure store for the desktop device session (spec §10 Desktop sign-in).
/// - Generic password items, one per namespaced key (environment/API origin).
/// - Never synchronized to iCloud Keychain; readable only on this device after first unlock.
/// - Errors are typed so the app can distinguish missing, locked/unavailable and denied storage.
///   There is no plaintext fallback.
/// The Keychain calls live in ByeKeychain.swift.
@objc(ByeSecureStore)
final class ByeSecureStore: NSObject {
  private lazy var keychain = ByeKeychain(service: "email.bye.desktop")

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
