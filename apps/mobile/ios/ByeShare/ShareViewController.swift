import UIKit
import UniformTypeIdentifiers

/// Share Extension: accepts shared text and URLs and hands them to the app's composer through the
/// App Group as a `bye://compose` link. The app picks it up on activation; nothing is sent from here.
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    Task { await handle() }
  }

  private func handle() async {
    var text: String?
    var link: String?
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    for provider in providers {
      if link == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
         let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, ["http", "https"].contains(url.scheme ?? "") {
        link = url.absoluteString
      } else if text == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                let value = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
        text = String(value.prefix(4000))
      }
    }
    var components = URLComponents()
    components.scheme = "bye"
    components.host = "compose"
    components.queryItems = [text.map { URLQueryItem(name: "text", value: $0) }, link.map { URLQueryItem(name: "url", value: $0) }].compactMap { $0 }
    if let value = components.url?.absoluteString {
      UserDefaults(suiteName: "group.email.bye")?.set(value, forKey: "pendingShare")
    }
    await MainActor.run { showDone() }
  }

  private func showDone() {
    let alert = UIAlertController(title: "Saved to bye", message: "Open bye to finish your message.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
      self?.extensionContext?.completeRequest(returningItems: nil)
    })
    present(alert, animated: true)
  }
}
