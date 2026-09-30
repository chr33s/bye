# Adds the Keychain module (ByeSecureStore + ByeKeychain) to the macOS target and sets bundle identity. Idempotent. Run with CocoaPods' Ruby:
#   GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/configure-project.rb
require "xcodeproj"

project = Xcodeproj::Project.open(File.expand_path("../ByeDesktop.xcodeproj", __dir__))
target = project.targets.find { |t| t.name == "ByeDesktop-macOS" } or abort("macOS target missing")
group = project.main_group["ByeDesktop-macOS"] or abort("group missing")
%w[ByeSecureStore.swift ByeSecureStore.m ByeKeychain.swift].each do |name|
  wanted = group.path ? name : File.join("ByeDesktop-macOS", name)
  ref = group.files.find { |f| File.basename(f.path.to_s) == name } || group.new_reference(wanted)
  ref.path = wanted
  ref.source_tree = "<group>"
  target.source_build_phase.add_file_reference(ref, true) unless target.source_build_phase.files_references.include?(ref)
end
target.build_configurations.each do |c|
  c.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "email.bye.desktop"
  c.build_settings["PRODUCT_NAME"] = "bye"
  c.build_settings["SWIFT_OBJC_BRIDGING_HEADER"] = "ByeDesktop-macOS/ByeDesktop-macOS-Bridging-Header.h"
  c.build_settings["SWIFT_VERSION"] = "5.0"
  # Notarization requires the hardened runtime; versions match apps/desktop/package.json.
  c.build_settings["ENABLE_HARDENED_RUNTIME"] = "YES"
  c.build_settings["MARKETING_VERSION"] = "0.2.0"
  c.build_settings["CURRENT_PROJECT_VERSION"] = "1"
end
project.save
puts "configured #{target.name}"
