# Adds ByeMobileTests, an XCTest bundle for the native code that React Native doesn't reach: push
# decryption, the notification decoder, the widget snapshot, the share handoff and the Keychain
# store. It compiles those sources directly and runs inside ByeTestHost, an empty app that exists only
# so the Keychain has an access group (ad-hoc signed; no team needed), so it needs neither CocoaPods
# nor the React Native build. Shared bridge fixtures come from packages/contracts/test/fixtures/native.
# Idempotent; run after add-extensions.rb with CocoaPods' Ruby:
#   GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/add-tests.rb
# Run the tests:
#   xcodebuild test -project ByeMobile.xcodeproj -scheme ByeMobileTests \
#     -destination 'platform=iOS Simulator,name=iPhone 16' 
require "xcodeproj"

root = File.expand_path("..", __dir__)
path = File.join(root, "ByeMobile.xcodeproj")
project = Xcodeproj::Project.open(path)
NAME = "ByeMobileTests"
HOST = "ByeTestHost"
DEPLOYMENT = "17.0"

def ensure_file(group, name, dir)
  wanted = group.path ? name : File.join(dir, name)
  ref = group.files.find { |f| File.basename(f.path.to_s) == name }
  ref ||= group.new_reference(wanted)
  ref.path = wanted
  ref.source_tree = "<group>"
  ref
end

host = project.targets.find { |t| t.name == HOST } || project.new_target(:application, HOST, :ios, DEPLOYMENT, nil, :swift)
host_group = project.main_group[HOST] || project.main_group.new_group(HOST, HOST)
host.source_build_phase.add_file_reference(ensure_file(host_group, "main.swift", HOST), true)
host.build_configurations.each do |c|
  s = c.build_settings
  s["PRODUCT_NAME"] = "$(TARGET_NAME)"
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "email.bye.app.testhost"
  s["GENERATE_INFOPLIST_FILE"] = "YES"
  s["INFOPLIST_KEY_UILaunchScreen_Generation"] = "YES"
  s["SWIFT_VERSION"] = "5.0"
  s["SDKROOT"] = "iphoneos"
  s["IPHONEOS_DEPLOYMENT_TARGET"] = DEPLOYMENT
  s["TARGETED_DEVICE_FAMILY"] = "1,2"
  s["CODE_SIGN_STYLE"] = "Manual"
  s["CODE_SIGN_IDENTITY"] = "-"
  s["DEVELOPMENT_TEAM"] = ""
  s["SKIP_INSTALL"] = "YES"
end

target = project.targets.find { |t| t.name == NAME } || project.new_target(:unit_test_bundle, NAME, :ios, DEPLOYMENT, nil, :swift)
group = project.main_group[NAME] || project.main_group.new_group(NAME, NAME)
tests = Dir.children(File.join(root, NAME)).select { |f| f.end_with?(".swift") }.sort
tests.each { |f| target.source_build_phase.add_file_reference(ensure_file(group, f, NAME), true) }

# Product sources under test, shared with their own targets (same file references).
{
  "ByeNotify" => %w[ByePushCrypto.swift NotificationService.swift],
  "ByeWidget" => %w[Snapshot.swift],
  "ByeShare" => %w[ShareHandoff.swift],
  "ByeMobile" => %w[ByeKeychain.swift],
}.each do |dir, files|
  owner = project.main_group[dir] or abort("#{dir} group missing (run add-extensions.rb first)")
  files.each { |f| target.source_build_phase.add_file_reference(ensure_file(owner, f, dir), true) }
end
target.add_system_framework("UserNotifications")

target.build_configurations.each do |c|
  s = c.build_settings
  s["PRODUCT_NAME"] = "$(TARGET_NAME)"
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "email.bye.app.tests"
  s["GENERATE_INFOPLIST_FILE"] = "YES"
  s["SWIFT_VERSION"] = "5.0"
  s["SDKROOT"] = "iphoneos"
  s["SUPPORTED_PLATFORMS"] = "iphonesimulator iphoneos"
  s["IPHONEOS_DEPLOYMENT_TARGET"] = DEPLOYMENT
  s["TARGETED_DEVICE_FAMILY"] = "1,2"
  s["CODE_SIGN_STYLE"] = "Manual"
  s["CODE_SIGN_IDENTITY"] = "-"
  s["DEVELOPMENT_TEAM"] = ""
  s["TEST_HOST"] = "$(BUILT_PRODUCTS_DIR)/#{HOST}.app/#{HOST}"
  s["BUNDLE_LOADER"] = "$(TEST_HOST)"
end
target.add_dependency(host) unless target.dependencies.any? { |d| d.target == host }
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(host, false)
scheme.add_build_target(target, false)
scheme.add_test_target(target)
scheme.save_as(path, NAME, true)
puts "#{NAME}: #{target.source_build_phase.files_references.map(&:display_name).sort.join(', ')}"
