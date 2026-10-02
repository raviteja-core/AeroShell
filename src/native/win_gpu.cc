#include "win_gpu.h"
#include <windows.h>
#include <dxgi1_6.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <unordered_map>

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

struct AdapterCounterResult {
  std::string luid;
  double dedicatedUsageMB;
};

struct ProcessCounterResult {
  DWORD pid;
  double dedicatedUsageMB;
};

class GpuCountersWorker : public Napi::AsyncWorker {
 public:
  GpuCountersWorker(Napi::Env env, std::vector<DWORD> pids)
      : Napi::AsyncWorker(env, "GpuCountersWorker"),
        deferred_(Napi::Promise::Deferred::New(env)),
        pids_(std::move(pids)),
        elapsedMs_(0.0),
        success_(false) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    LARGE_INTEGER freq{};
    LARGE_INTEGER start{};
    LARGE_INTEGER end{};
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&start);

    PDH_HQUERY hQuery = nullptr;
    if (PdhOpenQueryW(nullptr, 0, &hQuery) != ERROR_SUCCESS) {
      success_ = false;
      return;
    }

    PDH_HCOUNTER hAdapter = nullptr;
    PDH_HCOUNTER hProcess = nullptr;

    const PDH_STATUS s1 = PdhAddEnglishCounterW(hQuery, L"\\GPU Adapter Memory(*)\\Dedicated Usage", 0, &hAdapter);
    const PDH_STATUS s2 = PdhAddEnglishCounterW(hQuery, L"\\GPU Process Memory(*)\\Dedicated Usage", 0, &hProcess);

    if (s1 != ERROR_SUCCESS && s2 != ERROR_SUCCESS) {
      PdhCloseQuery(hQuery);
      success_ = false;
      return;
    }

    if (PdhCollectQueryData(hQuery) != ERROR_SUCCESS) {
      PdhCloseQuery(hQuery);
      success_ = false;
      return;
    }

    // 1. Adapter dedicated usage (summed across phys_N nodes per LUID instance)
    if (s1 == ERROR_SUCCESS && hAdapter) {
      DWORD bufSize = 0;
      DWORD itemCount = 0;
      PDH_STATUS st = PdhGetFormattedCounterArrayW(hAdapter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
      if (st == PDH_MORE_DATA && bufSize > 0) {
        std::vector<BYTE> buf(bufSize);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
        if (PdhGetFormattedCounterArrayW(hAdapter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items) == ERROR_SUCCESS) {
          std::unordered_map<std::string, double> sumMap;
          for (DWORD i = 0; i < itemCount; ++i) {
            if (items[i].szName && items[i].FmtValue.CStatus == PDH_CSTATUS_VALID_DATA) {
              std::string inst = WideToUtf8(items[i].szName);
              const size_t physPos = inst.rfind("_phys_");
              if (physPos != std::string::npos) {
                std::string baseLuid = inst.substr(0, physPos) + "_phys_0";
                sumMap[baseLuid] += (items[i].FmtValue.doubleValue / kMB);
              } else {
                sumMap[inst] += (items[i].FmtValue.doubleValue / kMB);
              }
            }
          }
          for (const auto& [k, v] : sumMap) {
            adapterResults_.push_back({k, v});
          }
        }
      }
    }

    // 2. Process dedicated usage for requested PIDs (summed across all engines/adapters)
    if (s2 == ERROR_SUCCESS && hProcess && !pids_.empty()) {
      DWORD bufSize = 0;
      DWORD itemCount = 0;
      PDH_STATUS st = PdhGetFormattedCounterArrayW(hProcess, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
      if (st == PDH_MORE_DATA && bufSize > 0) {
        std::vector<BYTE> buf(bufSize);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
        if (PdhGetFormattedCounterArrayW(hProcess, PDH_FMT_DOUBLE, &bufSize, &itemCount, items) == ERROR_SUCCESS) {
          std::unordered_map<DWORD, double> pidMap;
          for (DWORD i = 0; i < itemCount; ++i) {
            if (items[i].szName && items[i].FmtValue.CStatus == PDH_CSTATUS_VALID_DATA) {
              std::string inst = WideToUtf8(items[i].szName);
              if (inst.rfind("pid_", 0) == 0) {
                const size_t nextUnderscore = inst.find('_', 4);
                if (nextUnderscore != std::string::npos) {
                  try {
                    const DWORD parsedPid = static_cast<DWORD>(std::stoul(inst.substr(4, nextUnderscore - 4)));
                    for (const DWORD targetPid : pids_) {
                      if (parsedPid == targetPid) {
                        pidMap[parsedPid] += (items[i].FmtValue.doubleValue / kMB);
                        break;
                      }
                    }
                  } catch (...) {}
                }
              }
            }
          }
          for (const DWORD targetPid : pids_) {
            const double usage = pidMap.count(targetPid) ? pidMap[targetPid] : 0.0;
            processResults_.push_back({targetPid, usage});
          }
        }
      }
    }

    PdhCloseQuery(hQuery);
    QueryPerformanceCounter(&end);
    if (freq.QuadPart > 0) {
      elapsedMs_ = static_cast<double>(end.QuadPart - start.QuadPart) * 1000.0 / static_cast<double>(freq.QuadPart);
    }
    success_ = true;
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!success_) {
      deferred_.Resolve(env.Null());
      return;
    }

    Napi::Object res = Napi::Object::New(env);

    Napi::Array adapters = Napi::Array::New(env, adapterResults_.size());
    for (size_t i = 0; i < adapterResults_.size(); ++i) {
      Napi::Object a = Napi::Object::New(env);
      a.Set("luid", Napi::String::New(env, adapterResults_[i].luid));
      a.Set("dedicatedUsageMB", Napi::Number::New(env, adapterResults_[i].dedicatedUsageMB));
      adapters.Set(static_cast<uint32_t>(i), a);
    }
    res.Set("adapters", adapters);

    Napi::Array processes = Napi::Array::New(env, processResults_.size());
    for (size_t i = 0; i < processResults_.size(); ++i) {
      Napi::Object p = Napi::Object::New(env);
      p.Set("pid", Napi::Number::New(env, processResults_[i].pid));
      p.Set("dedicatedUsageMB", Napi::Number::New(env, processResults_[i].dedicatedUsageMB));
      processes.Set(static_cast<uint32_t>(i), p);
    }
    res.Set("processes", processes);
    res.Set("elapsedMs", Napi::Number::New(env, elapsedMs_));

    deferred_.Resolve(res);
  }

  void OnError(const Napi::Error& /* e */) override {
    deferred_.Resolve(Env().Null());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<DWORD> pids_;
  std::vector<AdapterCounterResult> adapterResults_;
  std::vector<ProcessCounterResult> processResults_;
  double elapsedMs_;
  bool success_;
};

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

    // Formatted LUID matching Windows PDH counter instance names: luid_0xHIGH_0xLOW_phys_0
    char luidBuf[64];
    snprintf(luidBuf, sizeof(luidBuf), "luid_0x%08X_0x%08X_phys_0",
             static_cast<unsigned int>(d.AdapterLuid.HighPart),
             static_cast<unsigned int>(d.AdapterLuid.LowPart));
    o.Set("luid", Napi::String::New(env, luidBuf));

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

Napi::Value GetGpuCounters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Invalid argument: expected an array of PIDs").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array pidArr = info[0].As<Napi::Array>();
  if (pidArr.Length() > 16) {
    Napi::RangeError::New(env, "PID array exceeds maximum of 16 elements").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<DWORD> pids;
  pids.reserve(pidArr.Length());
  for (uint32_t i = 0; i < pidArr.Length(); ++i) {
    Napi::Value item = pidArr[i];
    if (!item.IsNumber()) {
      Napi::TypeError::New(env, "PID elements must be integers").ThrowAsJavaScriptException();
      return env.Null();
    }
    const int64_t val = item.As<Napi::Number>().Int64Value();
    if (val <= 0 || val > 0xFFFFFF) {
      Napi::RangeError::New(env, "PID must be a valid positive integer").ThrowAsJavaScriptException();
      return env.Null();
    }
    pids.push_back(static_cast<DWORD>(val));
  }

  auto* worker = new GpuCountersWorker(env, std::move(pids));
  auto promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace aero::native
