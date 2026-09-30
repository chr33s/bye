import Foundation

/// The `bye://compose` link the Share Extension leaves in the App Group for the app to pick up
/// (takePendingShare → deepLinkToRoute). Pinned by packages/contracts/test/fixtures/native/
/// share-handoff.json.
enum ShareHandoff {
  static let maxText = 4000

  static func link(text: String?, url: String?) -> String? {
    var components = URLComponents()
    components.scheme = "bye"
    components.host = "compose"
    components.queryItems = [
      text.map { URLQueryItem(name: "text", value: String($0.prefix(maxText))) },
      url.map { URLQueryItem(name: "url", value: $0) },
    ].compactMap { $0 }
    // URLComponents leaves "+" as is, and the app's URLSearchParams reads a bare "+" as a space.
    components.percentEncodedQuery = components.percentEncodedQuery?
      .replacingOccurrences(of: "+", with: "%2B")
    return components.url?.absoluteString
  }
}
