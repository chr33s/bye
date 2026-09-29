import Foundation
import React
import UIKit
import UserNotifications

/// Push bridge (spec P1.7, E23): notification permission, the APNs device token, this device's Web
/// Push keys (ByePushCrypto) and notification taps, for `platform.push` in the shared app.
///
/// APNs callbacks and taps arrive on the app/notification-center delegates, possibly before React
/// Native has created this module (a tap that launches the app), so state is kept on `ByePushHub`
/// and the module only reads it and forwards events while JS listens.
@objc(ByePush)
final class ByePush: RCTEventEmitter {
  private var listening = false

  override init() {
    super.init()
    ByePushHub.shared.module = self
  }

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { ["ByePushToken", "ByePushOpen"] }

  override func startObserving() { listening = true }
  override func stopObserving() { listening = false }

  /// Whether JS received it (it only does while a listener is registered).
  @discardableResult
  func emit(_ name: String, _ body: Any?) -> Bool {
    guard listening else { return false }
    sendEvent(withName: name, body: body)
    return true
  }

  /// Ask once for permission, then answer `{platform, token, sandbox, p256dh, auth}` as JSON, or
  /// null when notifications are not allowed.
  @objc func requestToken(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
      granted, error in
      if let error = error { return reject("PushUnavailable", error.localizedDescription, error) }
      guard granted else { return resolve(nil) }
      ByePushHub.shared.token { result in
        switch result {
        case .success(let token):
          do {
            let keys = try ByePushCrypto.loadOrCreate()
            let body: [String: Any] = [
              "platform": "apns",
              "token": token,
              "sandbox": ByePushHub.sandbox,
              "p256dh": keys.p256dh,
              "auth": keys.authSecret,
            ]
            let json = try JSONSerialization.data(withJSONObject: body)
            resolve(String(decoding: json, as: UTF8.self))
          } catch {
            reject("PushKeys", "could not create push keys", error)
          }
        case .failure(let error):
          reject("PushUnavailable", error.localizedDescription, error)
        }
      }
    }
  }

  /// The URL of the notification whose tap launched the app, once.
  @objc func takeInitialOpen(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(ByePushHub.shared.takePendingOpen())
  }
}

/// App-lifetime push state shared by the AppDelegate, the notification-center delegate and the
/// module.
final class ByePushHub: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ByePushHub()

  weak var module: ByePush?
  private let lock = NSLock()
  private var current: String?
  private var waiting: [(Result<String, Error>) -> Void] = []
  private var pendingOpen: String?

  /// Development-signed builds get sandbox APNs tokens; App Store and TestFlight builds get
  /// production ones. The provisioning profile embedded in the app says which (App Store builds
  /// have none).
  static let sandbox: Bool = {
    guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
      let data = FileManager.default.contents(atPath: path)
    else { return false }
    let text = String(decoding: data, as: UTF8.self)
    guard let key = text.range(of: "<key>aps-environment</key>") else { return false }
    return text[key.upperBound...].prefix(80).contains("<string>development</string>")
  }()

  /// Called at launch: become the notification-center delegate (taps on a cold start arrive here)
  /// and refresh the token when permission was granted before.
  func start() {
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      guard settings.authorizationStatus == .authorized
        || settings.authorizationStatus == .provisional
      else { return }
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }
  }

  func token(_ completion: @escaping (Result<String, Error>) -> Void) {
    lock.lock()
    if let token = current {
      lock.unlock()
      return completion(.success(token))
    }
    waiting.append(completion)
    lock.unlock()
    DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
  }

  func didRegister(_ deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    lock.lock()
    let changed = current != nil && current != token
    current = token
    let callbacks = waiting
    waiting = []
    lock.unlock()
    callbacks.forEach { $0(.success(token)) }
    if changed { module?.emit("ByePushToken", nil) }
  }

  func didFail(_ error: Error) {
    lock.lock()
    let callbacks = waiting
    waiting = []
    lock.unlock()
    callbacks.forEach { $0(.failure(error)) }
  }

  func takePendingOpen() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let url = pendingOpen
    pendingOpen = nil
    return url
  }

  // Foreground: still show the banner (the shared app has no in-app notification UI).
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  // A tap: the extension put the decrypted link in `url`. Delivered to JS, or kept for launch.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    guard let url = response.notification.request.content.userInfo["url"] as? String,
      url.hasPrefix("https://")
    else { return }
    if module?.emit("ByePushOpen", url) == true { return }
    // JS isn't listening yet (the tap launched the app): kept for `takeInitialOpen`.
    lock.lock()
    pendingOpen = url
    lock.unlock()
  }
}
