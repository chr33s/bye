import Foundation
import UserNotifications

/// Notification Service Extension (spec P1.7). Pushes reach the phone through Bye's push gateway as
/// Web Push ciphertext under `bye.p`, with a generic alert Apple can see. Here, on the device, the
/// payload is decrypted with this device's keys (ByePushCrypto) and the real title, body and link
/// replace the generic alert. Anything that fails leaves the generic alert: a notification is never
/// dropped, and nothing readable ever left the instance unencrypted.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      return contentHandler(request.content)
    }
    fallback = content

    if let notice = Self.decode(request.content.userInfo) {
      content.title = notice.title
      content.body = notice.body
      if let tag = notice.tag { content.threadIdentifier = tag }
      if let url = notice.url { content.userInfo["url"] = url }
    }
    content.userInfo["bye"] = nil  // the ciphertext isn't needed past this point
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let handler = contentHandler, let content = fallback { handler(content) }
  }

  struct Notice {
    let title: String
    let body: String
    let url: String?
    let tag: String?
  }

  static func decode(_ userInfo: [AnyHashable: Any]) -> Notice? {
    guard let envelope = userInfo["bye"] as? [String: Any],
      let sealed = envelope["p"] as? String,
      let message = ByePushCrypto.fromBase64url(sealed),
      let keys = try? ByePushCrypto.load(),
      let plain = try? ByePushCrypto.decrypt(message, keys: keys),
      let payload = try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
    else { return nil }
    let text = { (key: String) -> String? in
      (payload[key] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(500)) }
    }
    return Notice(
      title: text("title") ?? "bye",
      body: text("body") ?? "New notification",
      url: text("url").flatMap { $0.hasPrefix("https://") ? $0 : nil },
      tag: text("collapseId")
    )
  }
}
