import UIKit

// Host process for ByeMobileTests. The Keychain needs an app with a keychain access group, which an
// unhosted test bundle doesn't have (errSecMissingEntitlement); this app has nothing else in it.
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
