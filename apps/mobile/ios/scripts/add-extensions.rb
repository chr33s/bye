# Adds the WidgetKit, Share and Notification Service extensions plus the widget and push bridges
# to ByeMobile.xcodeproj.
# Idempotent. Run with CocoaPods' Ruby:
#   GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/add-extensions.rb
require "xcodeproj"

root = File.expand_path("..", __dir__)
project = Xcodeproj::Project.open(File.join(root, "ByeMobile.xcodeproj"))
app = project.targets.find { |t| t.name == "ByeMobile" } or abort("app target missing")
DEPLOYMENT = "17.0"

# `dir` is the on-disk folder; groups without a path of their own need the folder in the reference.
def ensure_file(project, group, name, dir = group.display_name)
  wanted = group.path ? name : File.join(dir, name)
  ref = group.files.find { |f| File.basename(f.path.to_s) == name }
  ref ||= group.new_reference(wanted)
  ref.path = wanted
  ref.source_tree = "<group>"
  ref
end

# App: bridge sources, bridging header, entitlements, bundle id.
app_group = project.main_group["ByeMobile"]
%w[ByeWidgetBridge.swift ByeWidgetBridge.m ByePush.swift ByePush.m ByeKeychain.swift].each do |name|
  ref = ensure_file(project, app_group, name)
  app.source_build_phase.add_file_reference(ref, true)
end
ensure_file(project, app_group, "ByeMobile.entitlements")
app.build_configurations.each do |c|
  c.build_settings["CODE_SIGN_ENTITLEMENTS"] = "ByeMobile/ByeMobile.entitlements"
  c.build_settings["SWIFT_OBJC_BRIDGING_HEADER"] = "ByeMobile/ByeMobile-Bridging-Header.h"
  c.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "email.bye.app"
  c.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = DEPLOYMENT
end

def extension(project, app, name:, type:, sources:, bundle_id:, frameworks: [])
  target = project.targets.find { |t| t.name == name }
  unless target
    target = project.new_target(type, name, :ios, DEPLOYMENT, nil, :swift)
    group = project.main_group[name] || project.main_group.new_group(name, name)
    ensure_file(project, group, "Info.plist")
    ensure_file(project, group, "#{name}.entitlements")
    frameworks.each { |f| target.add_system_framework(f) }
    app.add_dependency(target)
    embed = app.copy_files_build_phases.find { |p| p.name == "Embed Foundation Extensions" } || app.new_copy_files_build_phase("Embed Foundation Extensions")
    embed.dst_subfolder_spec = "13" # PlugIns
    build_file = embed.add_file_reference(target.product_reference, true)
    build_file.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
  end
  group = project.main_group[name]
  # Sources are (re)applied on every run so files added later reach existing targets.
  sources.each { |s| target.source_build_phase.add_file_reference(ensure_file(project, group, s, name), true) }
  # Privacy manifest (App Group UserDefaults, reason 1C8F.1), bundled as a resource.
  privacy = ensure_file(project, group, "PrivacyInfo.xcprivacy", name)
  target.resources_build_phase.add_file_reference(privacy, true) unless target.resources_build_phase.files_references.include?(privacy)
  target.build_configurations.each do |c|
    s = c.build_settings
    s["PRODUCT_NAME"] = "$(TARGET_NAME)"
    s["INFOPLIST_FILE"] = "#{name}/Info.plist"
    s["GENERATE_INFOPLIST_FILE"] = "YES"
    s["PRODUCT_BUNDLE_IDENTIFIER"] = bundle_id
    s["CODE_SIGN_ENTITLEMENTS"] = "#{name}/#{name}.entitlements"
    s["SWIFT_VERSION"] = "5.0"
    s["TARGETED_DEVICE_FAMILY"] = "1,2"
    s["SKIP_INSTALL"] = "YES"
    s["MARKETING_VERSION"] = "0.2.0"
    s["CURRENT_PROJECT_VERSION"] = "1"
    s["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]
  end
  target
end

extension(project, app, name: "ByeWidget", type: :app_extension, sources: ["ByeWidget.swift", "Snapshot.swift"], bundle_id: "email.bye.app.widget", frameworks: %w[WidgetKit SwiftUI])
extension(project, app, name: "ByeShare", type: :app_extension, sources: ["ShareViewController.swift", "ShareHandoff.swift"], bundle_id: "email.bye.app.share", frameworks: %w[UniformTypeIdentifiers])
# Notification Service Extension: decrypts pushes relayed by Bye's push gateway (spec P1.7).
extension(project, app, name: "ByeNotify", type: :app_extension, sources: ["NotificationService.swift", "ByePushCrypto.swift"], bundle_id: "email.bye.app.notify", frameworks: %w[UserNotifications])

# The app registers the public half of the keys the extension decrypts with: same source file.
crypto = ensure_file(project, project.main_group["ByeNotify"], "ByePushCrypto.swift", "ByeNotify")
app.source_build_phase.add_file_reference(crypto, true) unless app.source_build_phase.files_references.include?(crypto)

project.save
puts "ByeMobile.xcodeproj: #{project.targets.map(&:name).join(', ')}"
