#pragma once

// Delivers `bye:` protocol activations (deep links and the OAuth callback bye://oauth/callback)
// to JavaScript. The first instance registers for the "main" key; later launches redirect their
// activation to it and exit, so a browser callback reaches the window that started sign-in.

#include "pch.h"
#include <mutex>
#include <optional>
#include <string>
#include "NativeModules.h"

namespace bye {

REACT_MODULE(ByeActivation, L"ByeActivation")
struct ByeActivation {
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    std::lock_guard lock{Mutex()};
    Context() = context;
  }

  REACT_METHOD(GetInitialUrl, L"getInitialUrl")
  void GetInitialUrl(winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept {
    std::lock_guard lock{Mutex()};
    auto url = Initial().value_or("");
    Initial().reset();
    promise.Resolve(url);
  }

  /** Called from WinMain for the launch activation and from the Activated event for redirects. */
  static void Deliver(std::string const &url, bool initial) noexcept {
    std::lock_guard lock{Mutex()};
    if (initial || !Context()) {
      Initial() = url;
      return;
    }
    auto context = *Context();
    context.JSDispatcher().Post([context, url]() noexcept { context.EmitJSEvent(L"RCTDeviceEventEmitter", L"byeUrl", url); });
  }

 private:
  static std::mutex &Mutex() {
    static std::mutex m;
    return m;
  }
  static std::optional<winrt::Microsoft::ReactNative::ReactContext> &Context() {
    static std::optional<winrt::Microsoft::ReactNative::ReactContext> c;
    return c;
  }
  static std::optional<std::string> &Initial() {
    static std::optional<std::string> u;
    return u;
  }
};

} // namespace bye
