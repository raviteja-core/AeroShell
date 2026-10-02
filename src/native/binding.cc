#include <napi.h>
#include "win_gpu.h"
#include "win_memory.h"
#include "win_registry.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getGpuHardwareInfo",  Napi::Function::New(env, aero::native::GetGpuHardwareInfo));
  exports.Set("getGpuCounters",      Napi::Function::New(env, aero::native::GetGpuCounters));
  exports.Set("getSystemMemoryInfo", Napi::Function::New(env, aero::native::GetSystemMemoryInfo));
  exports.Set("readRegistry",        Napi::Function::New(env, aero::native::ReadRegistry));
  return exports;
}

NODE_API_MODULE(aero_win_bridge, Init)
