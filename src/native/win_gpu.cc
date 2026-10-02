#include "win_gpu.h"
#include <windows.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <string>

using Microsoft::WRL::ComPtr;

namespace {
constexpr double kMB = 1024.0 * 1024.0;

std::string WideToUtf8(const wchar_t* w) {
  if (!w || !*w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}
}  // namespace

namespace aero::native {

Napi::Value GetGpuHardwareInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  ComPtr<IDXGIFactory1> factory1;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory1)))) {
    Napi::Error::New(env, "CreateDXGIFactory1 failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  ComPtr<IDXGIFactory6> factory6;
  factory1.As(&factory6);  // May be null on older Windows versions

  Napi::Array adapters = Napi::Array::New(env);
  uint32_t out = 0;

  for (UINT i = 0;; ++i) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT hr = factory6
        ? factory6->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(&adapter))
        : factory1->EnumAdapters1(i, &adapter);
    if (hr == DXGI_ERROR_NOT_FOUND || FAILED(hr)) break;

    DXGI_ADAPTER_DESC1 d{};
    if (FAILED(adapter->GetDesc1(&d))) continue;

    Napi::Object o = Napi::Object::New(env);
    o.Set("index", Napi::Number::New(env, i));
    o.Set("name", Napi::String::New(env, WideToUtf8(d.Description)));
    o.Set("vendorId", Napi::Number::New(env, d.VendorId));
    o.Set("deviceId", Napi::Number::New(env, d.DeviceId));
    o.Set("isSoftware", Napi::Boolean::New(env, (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0));
    o.Set("dedicatedVramMB", Napi::Number::New(env, static_cast<double>(d.DedicatedVideoMemory) / kMB));
    o.Set("sharedSystemMB", Napi::Number::New(env, static_cast<double>(d.SharedSystemMemory) / kMB));

    // Live VRAM accounting via IDXGIAdapter3
    ComPtr<IDXGIAdapter3> a3;
    if (SUCCEEDED(adapter.As(&a3))) {
      DXGI_QUERY_VIDEO_MEMORY_INFO vm{};
      if (SUCCEEDED(a3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &vm))) {
        o.Set("vramBudgetMB", Napi::Number::New(env, static_cast<double>(vm.Budget) / kMB));
        o.Set("vramUsageMB", Napi::Number::New(env, static_cast<double>(vm.CurrentUsage) / kMB));
      }
    }
    adapters.Set(out++, o);
  }

  return adapters;
}

}  // namespace aero::native
