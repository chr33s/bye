import Foundation
import WidgetKit

/// Bridge between the React Native app and its extensions. Data crosses only through the shared
/// App Group: a widget snapshot (no message content, no credentials) and a pending share handoff.
@objc(ByeWidgetBridge)
final class ByeWidgetBridge: NSObject {
  static let appGroup = "group.email.bye"
  static let snapshotKey = "widgetSnapshot"
  static let pendingShareKey = "pendingShare"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func publish(_ json: String) {
    guard let defaults = UserDefaults(suiteName: Self.appGroup), json.utf8.count < 16_384 else { return }
    defaults.set(json, forKey: Self.snapshotKey)
    WidgetCenter.shared.reloadAllTimelines()
  }

  @objc func takePendingShare(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let defaults = UserDefaults(suiteName: Self.appGroup) else { return resolve(nil) }
    let value = defaults.string(forKey: Self.pendingShareKey)
    defaults.removeObject(forKey: Self.pendingShareKey)
    resolve(value)
  }
}
