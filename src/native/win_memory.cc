#include "win_memory.h"
#include <windows.h>

namespace aero::native {

Napi::Value GetSystemMemoryInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  MEMORYSTATUSEX s{};
  s.dwLength = sizeof(s);
  if (!GlobalMemoryStatusEx(&s)) {
    Napi::Error::New(env, "GlobalMemoryStatusEx failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  constexpr double MB = 1024.0 * 1024.0;
  Napi::Object o = Napi::Object::New(env);
  o.Set("memoryLoadPercent", Napi::Number::New(env, s.dwMemoryLoad));
  o.Set("totalPhysMB", Napi::Number::New(env, static_cast<double>(s.ullTotalPhys) / MB));
  o.Set("availPhysMB", Napi::Number::New(env, static_cast<double>(s.ullAvailPhys) / MB));
  o.Set("totalCommitMB", Napi::Number::New(env, static_cast<double>(s.ullTotalPageFile) / MB));
  o.Set("availCommitMB", Napi::Number::New(env, static_cast<double>(s.ullAvailPageFile) / MB));
  return o;
}

}  // namespace aero::native
