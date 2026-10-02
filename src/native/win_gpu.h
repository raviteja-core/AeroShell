#pragma once
#include <napi.h>

namespace aero::native {
Napi::Value GetGpuHardwareInfo(const Napi::CallbackInfo& info);
}  // namespace aero::native
