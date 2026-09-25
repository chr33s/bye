// ByeDesktop.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "ByeDesktop.h"

#include "AutolinkedNativeModules.g.h"

#include "NativeModules.h"

#include <winrt/Microsoft.Windows.AppLifecycle.h>
#include <winrt/Windows.ApplicationModel.Activation.h>
#include <winrt/Windows.Foundation.h>

#include "ByeActivation.h"
#include "ByeSecureStore.h"

using winrt::Microsoft::Windows::AppLifecycle::AppActivationArguments;
using winrt::Microsoft::Windows::AppLifecycle::AppInstance;
using winrt::Microsoft::Windows::AppLifecycle::ExtendedActivationKind;

// bye:// protocol activation URI, if this activation carries one.
static std::optional<std::string> ProtocolUri(AppActivationArguments const &args) {
  if (args.Kind() != ExtendedActivationKind::Protocol) return std::nullopt;
  auto protocol = args.Data().as<winrt::Windows::ApplicationModel::Activation::IProtocolActivatedEventArgs>();
  return winrt::to_string(protocol.Uri().AbsoluteUri());
}

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
#include <optional>

_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE instance, HINSTANCE, PSTR /* commandLine */, int showCmd) {
  // Initialize WinRT
  winrt::init_apartment(winrt::apartment_type::single_threaded);

  // Single instance: a bye:// activation (e.g. the OAuth callback from the browser) launched while
  // the app is running is redirected to the existing instance, which forwards it to JavaScript.
  auto activation = AppInstance::GetCurrent().GetActivatedEventArgs();
  auto mainInstance = AppInstance::FindOrRegisterForKey(L"main");
  if (!mainInstance.IsCurrent()) {
    mainInstance.RedirectActivationToAsync(activation).get();
    return 0;
  }
  if (auto uri = ProtocolUri(activation)) bye::ByeActivation::Deliver(*uri, true);
  mainInstance.Activated([](auto const &, AppActivationArguments const &args) {
    if (auto uri = ProtocolUri(args)) bye::ByeActivation::Deliver(*uri, false);
  });

  // Enable per monitor DPI scaling
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Find the path hosting the app exe file
  WCHAR appDirectory[MAX_PATH];
  GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
  PathCchRemoveFileSpec(appDirectory, MAX_PATH);

  // Create a ReactNativeWin32App with the ReactNativeAppBuilder
  auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};

  // Configure the initial InstanceSettings for the app's ReactNativeHost
  auto settings{reactNativeWin32App.ReactNativeHost().InstanceSettings()};
  // Register any autolinked native modules
  RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
  // Register any native modules defined within this app project
  settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

    // When loading the JS bundle from a file (not Metro):
  // Set the path (on disk) where the .bundle file is located
  settings.BundleRootPath(std::wstring(L"file://").append(appDirectory).append(L"\\Bundle\\").c_str());

  // Set the name of the bundle file (without the .bundle extension)
  settings.JavaScriptBundleFile(L"index.windows");

  // JS Entry file to use when loading from Metro:
  settings.DebugBundlePath(L"index");

#if BUNDLE
  // Disable hot reload - bundle will be loaded from prebuilt bundle file.
  settings.UseFastRefresh(false);
#else
  // Enable hot reload - load the JS bundle from Metro
  settings.UseFastRefresh(true);
#endif
#if _DEBUG
  // For Debug builds
  // Enable Direct Debugging of JS
  settings.UseDirectDebugger(true);
  // Enable the Developer Menu
  settings.UseDeveloperSupport(true);
#else
  // For Release builds:
  // Disable Direct Debugging of JS
  settings.UseDirectDebugger(false);
  // Disable the Developer Menu
  settings.UseDeveloperSupport(false);
#endif

  // Get the AppWindow so we can configure its initial title and size
  auto appWindow{reactNativeWin32App.AppWindow()};
  appWindow.Title(L"ByeDesktop");
  appWindow.Resize({1000, 1000});

  // Get the ReactViewOptions so we can set the initial RN component to load
  auto viewOptions{reactNativeWin32App.ReactViewOptions()};
  viewOptions.ComponentName(L"ByeDesktop");

  // Start the app
  reactNativeWin32App.Start();
}
