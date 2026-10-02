#pragma once
#include <napi.h>

namespace aero::native {
Napi::Value ReadRegistry(const Napi::CallbackInfo& info);
}  // namespace aero::native
