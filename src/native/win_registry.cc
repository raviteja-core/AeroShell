#include "win_registry.h"
#include <windows.h>
#include <string>
#include <vector>

namespace {
struct Allowed {
  HKEY root;
  const wchar_t* sub;
};

const Allowed kAllowed[] = {
  { HKEY_CURRENT_USER,  L"Software\\Microsoft\\DirectX\\UserGpuPreferences" },
  { HKEY_LOCAL_MACHINE, L"SOFTWARE\\Policies\\AeroShell" },
};

std::wstring ToW(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (n <= 1) return {};
  std::wstring w(static_cast<size_t>(n - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}
}  // namespace

namespace aero::native {

// readRegistry(areaIndex: 0|1, valueName: string) -> string | number | null
Napi::Value ReadRegistry(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "readRegistry(area, name)").ThrowAsJavaScriptException();
    return env.Null();
  }

  const int area = info[0].As<Napi::Number>().Int32Value();
  if (area < 0 || area >= static_cast<int>(std::size(kAllowed))) {
    return env.Null();
  }

  const std::wstring name = ToW(info[1].As<Napi::String>().Utf8Value());

  DWORD type = 0;
  DWORD size = 0;
  const DWORD flags = RRF_RT_REG_SZ | RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY;

  if (RegGetValueW(kAllowed[area].root, kAllowed[area].sub, name.c_str(), flags, &type, nullptr, &size) != ERROR_SUCCESS) {
    return env.Null();
  }

  if (type == REG_DWORD) {
    DWORD v = 0;
    size = sizeof(v);
    if (RegGetValueW(kAllowed[area].root, kAllowed[area].sub, name.c_str(), RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &v, &size) != ERROR_SUCCESS) {
      return env.Null();
    }
    return Napi::Number::New(env, v);
  }

  // String value (REG_SZ)
  std::wstring buf(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(kAllowed[area].root, kAllowed[area].sub, name.c_str(), RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, buf.data(), &size) != ERROR_SUCCESS) {
    return env.Null();
  }

  while (!buf.empty() && buf.back() == L'\0') {
    buf.pop_back();
  }

  return Napi::String::New(env, reinterpret_cast<const char16_t*>(buf.c_str()), buf.size());
}

}  // namespace aero::native
