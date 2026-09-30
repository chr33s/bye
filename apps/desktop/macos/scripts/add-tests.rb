# Adds ByeDesktopTests, an unhosted XCTest bundle for the Keychain store (ByeKeychain.swift). It
# compiles that source directly, so it needs neither CocoaPods nor the React Native build.
# Idempotent; run after configure-project.rb with CocoaPods' Ruby:
#   GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/add-tests.rb
# Run the tests:
#   xcodebuild test -project ByeDesktop.xcodeproj -scheme ByeDesktopTests -destination 'platform=macOS'
require "xcodeproj"

root = File.expand_path("..", __dir__)
path = File.join(root, "ByeDesktop.xcodeproj")
project = Xcodeproj::Project.open(path)
NAME = "ByeDesktopTests"

def ensure_file(group, name, dir)
  wanted = group.path ? name : File.join(dir, name)
  ref = group.files.find { |f| File.basename(f.path.to_s) == name }
  ref ||= group.new_reference(wanted)
  ref.path = wanted
  ref.source_tree = "<group>"
  ref
end

target = project.targets.find { |t| t.name == NAME } || project.new_target(:unit_test_bundle, NAME, :osx, "14.0", nil, :swift)
group = project.main_group[NAME] || project.main_group.new_group(NAME, NAME)
Dir.children(File.join(root, NAME)).select { |f| f.end_with?(".swift") }.sort.each do |f|
  target.source_build_phase.add_file_reference(ensure_file(group, f, NAME), true)
end
app_group = project.main_group["ByeDesktop-macOS"] or abort("ByeDesktop-macOS group missing")
target.source_build_phase.add_file_reference(ensure_file(app_group, "ByeKeychain.swift", "ByeDesktop-macOS"), true)

target.build_configurations.each do |c|
  s = c.build_settings
  s["PRODUCT_NAME"] = "$(TARGET_NAME)"
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "email.bye.desktop.tests"
  s["GENERATE_INFOPLIST_FILE"] = "YES"
  s["SWIFT_VERSION"] = "5.0"
  s["SDKROOT"] = "macosx"
  s["MACOSX_DEPLOYMENT_TARGET"] = "14.0"
  s["CODE_SIGN_STYLE"] = "Manual"
  s["CODE_SIGN_IDENTITY"] = "-"
  s["DEVELOPMENT_TEAM"] = ""
  s.delete("TEST_HOST")
  s.delete("BUNDLE_LOADER")
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target, false)
scheme.add_test_target(target)
scheme.save_as(path, NAME, true)
puts "#{NAME}: #{target.source_build_phase.files_references.map(&:display_name).sort.join(', ')}"
