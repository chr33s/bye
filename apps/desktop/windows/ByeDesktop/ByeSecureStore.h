#pragma once

// Windows secure store for the desktop device session (spec §10 Desktop sign-in, secure storage).
// Generic credentials in Credential Manager with CRED_PERSIST_LOCAL_MACHINE: persists for the
// current Windows user across logons on this computer (not shared with other users, not roamed).
// Errors map to the shared SecureStoreError kinds; values are never logged. No plaintext fallback.

#include "pch.h"
#include <wincred.h>
#include <string>
#include "NativeModules.h"

#pragma comment(lib, "advapi32.lib")

namespace bye {

REACT_MODULE(ByeSecureStore, L"ByeSecureStore")
struct ByeSecureStore {
  static std::wstring Target(std::string const &key) {
    return std::wstring(L"email.bye.desktop/") + std::wstring(winrt::to_hstring(key));
  }

  static void Reject(winrt::Microsoft::ReactNative::ReactPromise<void> const &promise, DWORD error) noexcept {
    promise.Reject(Error(error));
  }

  static winrt::Microsoft::ReactNative::ReactError Error(DWORD error) noexcept {
    winrt::Microsoft::ReactNative::ReactError e{};
    switch (error) {
      case ERROR_NOT_FOUND:
        e.Code = "MissingCredential";
        break;
      case ERROR_NO_SUCH_LOGON_SESSION:
        e.Code = "StorageUnavailable";
        break;
      case ERROR_ACCESS_DENIED:
        e.Code = "StorageDenied";
        break;
      case ERROR_INVALID_DATA:
        e.Code = "CorruptCredential";
        break;
      default:
        e.Code = "StorageUnavailable";
        break;
    }
    e.Message = "credential manager: " + e.Code;
    e.UserInfo["nativeCode"] = std::to_string(error);
    return e;
  }

  REACT_METHOD(Read, L"read")
  void Read(std::string key, winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept {
    PCREDENTIALW credential = nullptr;
    auto target = Target(key);
    if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
      promise.Reject(Error(GetLastError()));
      return;
    }
    std::string value(reinterpret_cast<char const *>(credential->CredentialBlob), credential->CredentialBlobSize);
    SecureZeroMemory(credential->CredentialBlob, credential->CredentialBlobSize);
    CredFree(credential);
    promise.Resolve(value);
  }

  REACT_METHOD(Write, L"write")
  void Write(std::string key, std::string value, winrt::Microsoft::ReactNative::ReactPromise<void> promise) noexcept {
    if (value.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE) {
      Reject(promise, ERROR_INVALID_DATA);
      return;
    }
    auto target = Target(key);
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<LPWSTR>(target.c_str());
    credential.UserName = const_cast<LPWSTR>(L"bye-device-session");
    credential.CredentialBlobSize = static_cast<DWORD>(value.size());
    credential.CredentialBlob = reinterpret_cast<LPBYTE>(value.data());
    // Local-machine persistence for this user; CRED_PERSIST_ENTERPRISE would roam with the profile.
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    // CredWriteW replaces an existing credential atomically; the old value survives a failed write.
    if (!CredWriteW(&credential, 0)) {
      Reject(promise, GetLastError());
      return;
    }
    promise.Resolve();
  }

  REACT_METHOD(Remove, L"remove")
  void Remove(std::string key, winrt::Microsoft::ReactNative::ReactPromise<void> promise) noexcept {
    auto target = Target(key);
    if (!CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0)) {
      auto error = GetLastError();
      if (error != ERROR_NOT_FOUND) {
        Reject(promise, error);
        return;
      }
    }
    promise.Resolve();
  }
};

} // namespace bye
