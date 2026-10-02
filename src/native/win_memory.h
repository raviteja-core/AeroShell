#pragma once
#include <napi.h>

namespace aero::native {
Napi::Value GetSystemMemoryInfo(const Napi::CallbackInfo& info);
}  // namespace aero::native
