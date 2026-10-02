# AeroShell: Reference Document

**Hardened Electron & Chromium desktop runtime for high-performance Web CAD workloads** Status: portfolio / reference implementation · Platform: Windows 10/11 x64 · Document date: 2 Oct 2026

> **How to use this document.** It is the single source of truth for architecture, security model, code, build, test and metrics. Section 6 lists defects found in the original draft. Every code sample here already includes those fixes.

---

## 1. Purpose and honest scope

AeroShell is a minimal but production-shaped desktop shell for a WebGL/Three.js CAD viewport. It shows five engineering skills:

| Skill | Where it is demonstrated |
| --- | --- |
| Electron process-model and security hardening | §3, §4, §5.2–5.5 |
| Chromium runtime tuning and GPU diagnostics | §7 |
| Windows C++ native integration (Node-API, DXGI, Win32) | §5.1 |
| V8 / memory diagnostics and crash forensics | §7, §8 |
| Enterprise packaging, signing, CI and supply-chain hygiene | §9 |

**Positioning rules**

- This is an independent portfolio project **aligned to** Autodesk-style desktop platform work. It is **not** an Autodesk product.
- Do **not** use `com.autodesk.*` as the app ID or Autodesk branding. Use `dev.<yourhandle>.aeroshell`.
- Do not publish a number as "achieved" until you have measured it (§10).

---

## 2. Version baseline (verified Oct 2026)

| Component | Pin | Notes |
| --- | --- | --- |
| Electron | **44.x** (stable line; 44.4.x released Sep 2026) | Chromium 152, V8 15.2, Node 24.x. Electron supports only the latest 3 majors, and 8-week cadence means re-check monthly. |
| Embedded Node | **24.x** (not 22) | The original "Node 22" is stale. Electron 39 was the last Node 22 line. |
| Dev tooling Node | 24 LTS | Matches the embedded major, so tooling and runtime behave alike. |
| TypeScript | 5.x, `strict: true` |  |
| C++ | C++20, MSVC 19.4x (VS 2022 Build Tools) | Windows 10/11 SDK. |
| Node-API | `node-addon-api` 8.x, `NAPI_VERSION=9` | ABI-stable across Electron upgrades. |
| Bundler | esbuild (main, preload, renderer) | Sandboxed preload cannot `require` local files, so bundling is mandatory. |
| Packaging | electron-builder + `@electron/fuses` |  |
| Tests | Vitest (unit), Playwright `_electron` (e2e) | Spectron is archived and must not be used. |

Electron 44 ships x64/arm64 only (no ia32). Re-verify at [https://releases.electronjs.org](https://releases.electronjs.org) before pinning.

---

## 3. Architecture

### 3.1 Layer diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│ RENDERER  (sandboxed, contextIsolation, no Node)                           │
│  Three.js CAD viewport · UI · origin: aeroshell-app://app                  │
│  CSP: default-src 'none' · loads models via aeroshell-asset://models/…     │
└───────────────▲────────────────────────────────────────────────────────────┘
                │ window.aeroPlatform  (frozen, allowlisted, typed)
┌───────────────┴────────────────────────────────────────────────────────────┐
│ PRELOAD  (bundled CJS, isolated world)                                     │
│  contextBridge · channel allowlist · NO raw ipcRenderer exposed            │
└───────────────▲────────────────────────────────────────────────────────────┘
                │ ipcRenderer.invoke / webContents.send
┌───────────────┴────────────────────────────────────────────────────────────┐
│ MAIN  (Node 24, the ONLY trust boundary that matters)                      │
│  lifecycle · single-instance lock · session policy · navigation gates      │
│  IPC: sender-frame check + Zod validation · protocol handlers              │
│  memory watchdog · crash monitor · GPU-recovery policy · diagnostics       │
└───────────────▲────────────────────────────────────────────────────────────┘
                │ Node-API (ABI stable)
┌───────────────┴────────────────────────────────────────────────────────────┐
│ NATIVE  aero_win_bridge.node  (C++20, MSVC, CFG/CET)                       │
│  DXGI 1.6 adapters + IDXGIAdapter3 VRAM budget/usage                       │
│  GlobalMemoryStatusEx · allowlisted registry reads (GPU pref, IT policy)   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Trust boundaries

| Boundary | Rule |
| --- | --- |
| Renderer → Preload | Renderer is **untrusted** (assume XSS). Preload exposes named functions only. |
| Preload → Main | The preload is **not** a trust boundary. Main re-validates every payload (Zod) and checks `event.senderFrame.url`. |
| Main → Native | Native exports are read-only query functions. No arbitrary registry path, no arbitrary file path, no process spawn. |
| Main → Disk | Only through `resolveInside()` with `realpath` re-check, inside `userData/Models`. |
| Main → Network | Deny-by-default `onBeforeRequest`. Only allowlisted HTTPS hosts. |

### 3.3 Key data flows

1. **Startup:** lock → fuses already baked → switches → crash reporter → schemes registered → `ready` → protocols + session policy → window → `ready-to-show`.
2. **Asset streaming:** renderer `fetch('aeroshell-asset://models/part.glb')` → main resolves safe path → `net.fetch(file://…, bypassCustomProtocolHandlers)` → streamed `Response` (verify Range support in tests).
3. **Telemetry:** main watchdog (adaptive timer) → native + `app.getAppMetrics()` + V8 stats → `webContents.send('aeroshell:memory-pressure')` with hysteresis.
4. **Failure:** `render-process-gone` / `child-process-gone(GPU)` → JSONL incident log → recovery policy (§8).

### 3.4 Why a custom scheme for the UI (not `loadFile`)

`file://` pages get a weak, shared origin and make CSP `'self'` unreliable. Serving the UI from `aeroshell-app://app/` gives a real standard-scheme origin, so CSP, `will-navigate` checks and IPC sender checks can all pin to one origin.

---

## 4. Threat model (STRIDE-lite)

| Threat | Vector | Mitigation |
| --- | --- | --- |
| RCE via renderer compromise | XSS in a CAD file name, model metadata | No Node in renderer, sandbox, strict CSP, `textContent` only, Trusted Types (optional) |
| Privilege escalation via IPC | Malicious frame calls `invoke` | Sender-origin check, Zod schemas, channel allowlist, no generic `send(channel)` |
| Path traversal | `aeroshell-asset://models/..%5c..%5cWindows` | `path.relative` containment, reject `:` / NUL / reserved names, `realpath` re-check, extension allowlist |
| Prefix-bypass | `…\Models-evil\x` passes `startsWith` | Use `path.relative`, never `startsWith(root)` |
| Navigation hijack / phishing | `location = https://evil` | `will-navigate`, `will-redirect`, `will-frame-navigate`, `setWindowOpenHandler` deny |
| Binary tampering | Edited `app.asar`, `ELECTRON_RUN_AS_NODE` | Fuses (§9.2), ASAR integrity, Authenticode signing |
| Debug-port abuse | `--inspect` flag injection | Fuse `EnableNodeCliInspectArguments=false`, `EnableNodeOptionsEnvironmentVariable=false` |
| Supply chain | Malicious npm dep | Lockfile, `npm ci`, `npm audit signatures`, SBOM, pinned Actions SHAs |
| DoS via memory exhaustion | Huge model | Watchdog, size caps, renderer reload policy |
| Registry abuse | Arbitrary key read | Native allowlist of two subkeys only |

---

## 5. Implementation

### 5.0 Repository layout (revised)

```
aeroshell/
├── .github/workflows/build-and-test.yml
├── build-scripts/        bundle.mjs · after-pack.mjs (fuses)
├── cmake/                (only if you keep a custom Find module)
├── src/
│   ├── shared/ipc-contract.ts     Zod schemas + channel names (used by main AND preload)
│   ├── main/{index,protocol-handler,security-guard,ipc,memory-watchdog,crash-monitor,diagnostics}.ts
│   ├── preload/index.ts
│   ├── renderer/{index.html,main.ts,cad-viewport.ts}
│   └── native/{CMakeLists.txt,binding.cc,win_gpu.{h,cc},win_memory.{h,cc},win_registry.{h,cc}}
├── tests/{native,main,e2e}/
├── electron-builder.yml · tsconfig.json · package.json · README.md · SECURITY.md
```

### 5.1 Native module (C++20 / Node-API)

**`src/native/CMakeLists.txt`**

```cmake
cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)
project(aero_win_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

execute_process(COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR OUTPUT_STRIP_TRAILING_WHITESPACE)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

# cmake-js on Windows: generate node.lib for Node-API
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF}
                  /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()

add_library(${PROJECT_NAME} SHARED
  binding.cc win_memory.cc win_gpu.cc win_registry.cc ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=9 NAPI_CPP_EXCEPTIONS NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_compile_options(${PROJECT_NAME} PRIVATE /W4 /WX /EHsc /guard:cf /Qspectre /Zi)
target_link_options(${PROJECT_NAME} PRIVATE /DEBUG /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /CETCOMPAT /GUARD:CF)
target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB} dxgi.lib advapi32.lib)
```

If the addon fails to load with "The specified module could not be found", the cause is the Windows `node.exe` import name versus `electron.exe`. Add cmake-js's `win_delay_load_hook` and link `/DELAYLOAD:NODE.EXE`, or fall back to `node-gyp`, which handles it by default.

**`win_gpu.h`**

```cpp
#pragma once
#include <napi.h>
namespace aero::native { Napi::Value GetGpuHardwareInfo(const Napi::CallbackInfo&); }
```

**`win_gpu.cc`**: enumerates *all* adapters, skips nothing silently (flags software), reports **VRAM budget and live usage**

```cpp
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
  factory1.As(&factory6);  // may be null on older Windows 10

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
    o.Set("index", i);
    o.Set("name", WideToUtf8(d.Description));
    o.Set("vendorId", d.VendorId);
    o.Set("deviceId", d.DeviceId);
    o.Set("isSoftware", (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0);
    o.Set("dedicatedVramMB", static_cast<double>(d.DedicatedVideoMemory) / kMB);  // TOTAL, not free
    o.Set("sharedSystemMB", static_cast<double>(d.SharedSystemMemory) / kMB);

    // Live VRAM accounting: this is what a watchdog must use.
    ComPtr<IDXGIAdapter3> a3;
    if (SUCCEEDED(adapter.As(&a3))) {
      DXGI_QUERY_VIDEO_MEMORY_INFO vm{};
      if (SUCCEEDED(a3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &vm))) {
        o.Set("vramBudgetMB", static_cast<double>(vm.Budget) / kMB);
        o.Set("vramUsageMB", static_cast<double>(vm.CurrentUsage) / kMB);
      }
    }
    adapters.Set(out++, o);
  }
  return adapters;
}

}  // namespace aero::native
```

`DXGI_ADAPTER_DESC.DedicatedVideoMemory` is **total** VRAM. The original watchdog compared it to a "low threshold", which never reflects pressure. Use `QueryVideoMemoryInfo` (`Budget`, `CurrentUsage`). Note this reports usage for the **calling process** only, so combine it with `app.getAppMetrics()` for the GPU process view.

**`win_memory.cc`** (unchanged logic, tightened)

```cpp
#include "win_memory.h"
#include <windows.h>
namespace aero::native {
Napi::Value GetSystemMemoryInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  MEMORYSTATUSEX s{}; s.dwLength = sizeof(s);
  if (!GlobalMemoryStatusEx(&s)) {
    Napi::Error::New(env, "GlobalMemoryStatusEx failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  constexpr double MB = 1024.0 * 1024.0;
  Napi::Object o = Napi::Object::New(env);
  o.Set("memoryLoadPercent", s.dwMemoryLoad);
  o.Set("totalPhysMB", s.ullTotalPhys / MB);   o.Set("availPhysMB", s.ullAvailPhys / MB);
  o.Set("totalCommitMB", s.ullTotalPageFile / MB); o.Set("availCommitMB", s.ullAvailPageFile / MB);
  return o;
}
}
```

`ullTotalPageFile` is the **commit limit**, so it is named `totalCommitMB` to avoid mislabelling it as "page file".

**`win_registry.cc`**: two legitimate uses, strict allowlist

1. `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`, value name = full exe path, data `GpuPreference=2;`. This tells you whether Windows pins the app to the high-performance GPU on hybrid laptops.
2. `HKLM\SOFTWARE\Policies\<Vendor>\AeroShell`, IT-managed policy (e.g. `DisableTelemetry`, `AllowedHosts`).

```cpp
#include "win_registry.h"
#include <windows.h>
#include <string>
#include <vector>
namespace {
struct Allowed { HKEY root; const wchar_t* sub; };
const Allowed kAllowed[] = {
  { HKEY_CURRENT_USER,  L"Software\\Microsoft\\DirectX\\UserGpuPreferences" },
  { HKEY_LOCAL_MACHINE, L"SOFTWARE\\Policies\\AeroShell" },
};
std::wstring ToW(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n - 1, L'\0'); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n); return w;
}
}
namespace aero::native {
// readRegistry(areaIndex: 0|1, valueName: string) -> string | number | null
Napi::Value ReadRegistry(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString())
    { Napi::TypeError::New(env, "readRegistry(area, name)").ThrowAsJavaScriptException(); return env.Null(); }
  const int area = info[0].As<Napi::Number>().Int32Value();
  if (area < 0 || area >= static_cast<int>(std::size(kAllowed))) return env.Null();
  const std::wstring name = ToW(info[1].As<Napi::String>().Utf8Value());

  DWORD type = 0, size = 0;
  const DWORD flags = RRF_RT_REG_SZ | RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY;
  if (RegGetValueW(kAllowed[area].root, kAllowed[area].sub, name.c_str(), flags, &type, nullptr, &size) != ERROR_SUCCESS)
    return env.Null();
  if (type == REG_DWORD) {
    DWORD v = 0; size = sizeof(v);
    if (RegGetValueW(kAllowed[area].root, kAllowed[area].sub, name.c_str(), RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &v, &size) != ERROR_SUCCESS) return env.Null();
    return Napi::Number::New(env, v);
  }
  std::wstring buf(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(kAllowed[area].root, kAllowed[area].sub, name.c_str(), RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, buf.data(), &size) != ERROR_SUCCESS) return env.Null();
  while (!buf.empty() && buf.back() == L'\0') buf.pop_back();
  return Napi::String::New(env, reinterpret_cast<const char16_t*>(buf.c_str()), buf.size());
}
}
```

**`binding.cc`**

```cpp
#include <napi.h>
#include "win_gpu.h"
#include "win_memory.h"
#include "win_registry.h"
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getGpuHardwareInfo",  Napi::Function::New(env, aero::native::GetGpuHardwareInfo));
  exports.Set("getSystemMemoryInfo", Napi::Function::New(env, aero::native::GetSystemMemoryInfo));
  exports.Set("readRegistry",        Napi::Function::New(env, aero::native::ReadRegistry));
  return exports;
}
NODE_API_MODULE(aero_win_bridge, Init)
```

### 5.2 Shared IPC contract (single source of truth)

**`src/shared/ipc-contract.ts`**

```ts
import { z } from 'zod';

export const Channels = {
  getTelemetry: 'aeroshell:get-telemetry',
  memoryPressure: 'aeroshell:memory-pressure',
  captureHeapSnapshot: 'aeroshell:capture-heap-snapshot',
} as const;

export const GpuAdapter = z.object({
  index: z.number().int(), name: z.string(), vendorId: z.number(), deviceId: z.number(),
  isSoftware: z.boolean(), dedicatedVramMB: z.number(), sharedSystemMB: z.number(),
  vramBudgetMB: z.number().optional(), vramUsageMB: z.number().optional(),
});
export const Telemetry = z.object({
  gpus: z.array(GpuAdapter),
  system: z.object({ memoryLoadPercent: z.number(), totalPhysMB: z.number(), availPhysMB: z.number(),
                     totalCommitMB: z.number(), availCommitMB: z.number() }),
  processes: z.array(z.object({ type: z.string(), pid: z.number(), workingSetMB: z.number() })),
  v8: z.object({ usedHeapMB: z.number(), heapLimitMB: z.number() }),
});
export const PressureEvent = z.object({
  severity: z.enum(['WARN', 'CRITICAL']),
  reasons: z.array(z.string()),
  availPhysMB: z.number(), vramUsagePct: z.number().nullable(),
});
export type Telemetry = z.infer<typeof Telemetry>;
export type PressureEvent = z.infer<typeof PressureEvent>;
// Request payloads: .strict() so unknown keys are rejected.
export const SnapshotRequest = z.object({ reason: z.string().max(80) }).strict();
```

### 5.3 Main process

**`src/main/index.ts`**

```ts
import { app, BrowserWindow, crashReporter } from 'electron';
import * as path from 'node:path';
import { registerSchemes, registerProtocolHandlers } from './protocol-handler';
import { installSessionPolicy, hardenWebContents } from './security-guard';
import { registerIpc } from './ipc';
import { startMemoryWatchdog } from './memory-watchdog';
import { startCrashMonitor, shouldDisableGpu } from './crash-monitor';

// 1) Single-instance: exit before ANY other side effect.
if (!app.requestSingleInstanceLock()) { app.exit(0); } else { bootstrap(); }

function bootstrap(): void {
  // 2) Must run before 'ready'.
  registerSchemes();
  crashReporter.start({
    productName: 'AeroShell', companyName: 'AeroShell',
    submitURL: '', uploadToServer: false, compress: true,   // offline; dumps go to app.getPath('crashDumps')
    extra: { appVersion: app.getVersion(), electron: process.versions.electron },
  });
  if (shouldDisableGpu()) app.disableHardwareAcceleration();   // crash-loop recovery (§8)

  // 3) Chromium switches: minimal, justified, benchmarked (§7.1)
  if (process.env.AEROSHELL_IGNORE_GPU_BLOCKLIST === '1') app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');   // renderer heap ceiling; no --expose-gc in prod
  app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');     // only valid with COOP/COEP headers (§7.4)

  app.whenReady().then(async () => {
    registerProtocolHandlers();
    installSessionPolicy();
    app.on('web-contents-created', (_e, wc) => hardenWebContents(wc));
    startCrashMonitor();

    const win = new BrowserWindow({
      width: 1440, height: 900, minWidth: 1024, minHeight: 768,
      backgroundColor: '#121212', show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, backgroundThrottling: false,   // CAD viewport must keep rendering when unfocused
        spellcheck: false,
      },
    });
    registerIpc(win);
    startMemoryWatchdog(win);
    win.once('ready-to-show', () => win.show());
    await win.loadURL('aeroshell-app://app/index.html');

    app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
```

`SharedArrayBuffer` is only available when the page is cross-origin isolated (COOP `same-origin` + COEP `require-corp`). Add those headers in the app-protocol `Response` (§5.4). Drop the switch if you do not use WASM threads.

**`src/main/protocol-handler.ts`**

```ts
import { app, protocol, net } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'aeroshell-app';
export const ASSET_SCHEME = 'aeroshell-asset';
const ASSET_EXT = new Set(['.glb', '.gltf', '.bin', '.drc', '.ktx2', '.wasm', '.json']);

export const CSP = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'",
  `img-src 'self' ${ASSET_SCHEME}: data: blob:`, "font-src 'self'",
  `connect-src 'self' ${ASSET_SCHEME}:`, "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
].join('; ');

export function registerSchemes(): void {   // BEFORE ready
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME,   privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

/** Resolve `requested` strictly inside `root`. Returns null on any violation. */
export function resolveInside(root: string, requested: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(requested); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes(':')) return null;       // NUL, drive letters, ADS (file.glb:stream)
  const candidate = path.resolve(root, '.' + path.sep + decoded.replace(/^[/\\]+/, ''));
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  try {                                                                     // defeat symlink/junction escapes
    const real = fs.realpathSync(candidate);
    const rr = path.relative(fs.realpathSync(root), real);
    if (rr === '..' || rr.startsWith('..' + path.sep) || path.isAbsolute(rr)) return null;
    return real;
  } catch { return null; }
}

export function registerProtocolHandlers(): void {   // AFTER ready
  const uiRoot = path.join(app.getAppPath(), 'dist', 'renderer');
  const modelRoot = path.join(app.getPath('userData'), 'Models');
  fs.mkdirSync(modelRoot, { recursive: true });

  protocol.handle(APP_SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('Not Found', { status: 404 });
    const file = resolveInside(uiRoot, u.pathname === '/' ? '/index.html' : u.pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
    const h = new Headers(res.headers);
    h.set('Content-Security-Policy', CSP);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  });

  protocol.handle(ASSET_SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'models') return new Response('Not Found', { status: 404 });
    const file = resolveInside(modelRoot, u.pathname);
    if (!file || !ASSET_EXT.has(path.extname(file).toLowerCase()))
      return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString(),
      { bypassCustomProtocolHandlers: true, headers: req.headers });   // forward Range; verify in tests
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  });
}
```

Assets use COEP `require-corp`, so asset responses must carry `Cross-Origin-Resource-Policy`. If Range requests are not honoured by `net.fetch(file://)` in your Electron build, implement 206 handling with `fs.createReadStream({start,end})` and `Readable.toWeb()`. A test for this is in §10.

**`src/main/security-guard.ts`**

```ts
import { session, shell, WebContents } from 'electron';
import { APP_SCHEME, ASSET_SCHEME } from './protocol-handler';

const TRUSTED_HTTPS = ['autodesk.com'];                 // exact or subdomain; make IT-configurable via registry policy
const hostOk = (h: string) => TRUSTED_HTTPS.some(d => h === d || h.endsWith('.' + d));
const parse = (s: string) => { try { return new URL(s); } catch { return null; } };
const isAppUrl = (u: URL) => u.protocol === `${APP_SCHEME}:` && u.host === 'app';

export function installSessionPolicy(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Deny-by-default network: app + asset schemes only. Add allowlisted HTTPS hosts here if needed.
  ses.webRequest.onBeforeRequest((d, cb) => {
    const u = parse(d.url);
    const ok = !!u && (u.protocol === `${ASSET_SCHEME}:` || isAppUrl(u) ||
      u.protocol === 'devtools:' || u.protocol === 'data:' || u.protocol === 'blob:');
    cb({ cancel: !ok });
  });
}

export function hardenWebContents(wc: WebContents): void {
  const gate = (e: Electron.Event, url: string) => {
    const u = parse(url);
    if (!u || !isAppUrl(u)) { e.preventDefault(); console.warn('[security] blocked navigation:', url); }
  };
  wc.on('will-navigate', gate);
  wc.on('will-redirect', gate);
  wc.on('will-frame-navigate', gate);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    const u = parse(url);
    if (u && u.protocol === 'https:' && hostOk(u.hostname)) void shell.openExternal(url);  // system browser, never in-app
    return { action: 'deny' };
  });
}
```

**`src/main/ipc.ts`**: sender check plus Zod on both directions

```ts
import { BrowserWindow, ipcMain, IpcMainInvokeEvent, app, webContents } from 'electron';
import * as v8 from 'node:v8';
import * as path from 'node:path';
import { Channels, Telemetry, SnapshotRequest } from '../shared/ipc-contract';
import { collectTelemetry } from './memory-watchdog';

function assertTrusted(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!url.startsWith('aeroshell-app://app/')) throw new Error('IPC rejected: untrusted sender');
}

export function registerIpc(win: BrowserWindow): void {
  ipcMain.handle(Channels.getTelemetry, async (e) => {
    assertTrusted(e);
    return Telemetry.parse(await collectTelemetry());      // never return unvalidated shapes
  });
  ipcMain.handle(Channels.captureHeapSnapshot, async (e, raw) => {
    assertTrusted(e);
    const { reason } = SnapshotRequest.parse(raw);
    const file = path.join(app.getPath('userData'), 'Diagnostics',
      `heap-${Date.now()}-${reason.replace(/[^\w-]/g, '_')}.heapsnapshot`);
    return { file: v8.writeHeapSnapshot(file) };           // main-process heap; renderer: see §7.3
  });
}
```

**`src/main/memory-watchdog.ts`**: adaptive, hysteresis, correct units

```ts
import { app, BrowserWindow } from 'electron';
import * as v8 from 'node:v8';
import * as path from 'node:path';
import { Channels, PressureEvent, Telemetry } from '../shared/ipc-contract';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require(path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'build', 'Release', 'aero_win_bridge.node'));

export async function collectTelemetry(): Promise<Telemetry> {
  const heap = v8.getHeapStatistics();
  return {
    gpus: native.getGpuHardwareInfo(),
    system: native.getSystemMemoryInfo(),
    processes: app.getAppMetrics().map(m => ({ type: m.type, pid: m.pid, workingSetMB: m.memory.workingSetSize / 1024 })), // KB → MB
    v8: { usedHeapMB: heap.used_heap_size / 1048576, heapLimitMB: heap.heap_size_limit / 1048576 },
  };
}

export function startMemoryWatchdog(win: BrowserWindow): void {
  let lastSeverity: 'OK' | 'WARN' | 'CRITICAL' = 'OK';
  let timer: NodeJS.Timeout;

  const tick = async () => {
    if (win.isDestroyed()) return;
    try {
      const t = await collectTelemetry();
      const gpu = t.gpus.find(g => !g.isSoftware) ?? t.gpus[0];
      const vramPct = gpu?.vramBudgetMB && gpu.vramUsageMB != null ? (gpu.vramUsageMB / gpu.vramBudgetMB) * 100 : null;
      const lowRam = Math.max(500, t.system.totalPhysMB * 0.08);
      const reasons: string[] = [];
      if (t.system.availPhysMB < lowRam) reasons.push('LOW_PHYSICAL_RAM');
      if (vramPct !== null && vramPct > 90) reasons.push('VRAM_NEAR_BUDGET');
      if (t.v8.usedHeapMB / t.v8.heapLimitMB > 0.85) reasons.push('V8_HEAP_NEAR_LIMIT');
      const sev = reasons.length >= 2 || vramPct! > 97 ? 'CRITICAL' : reasons.length ? 'WARN' : 'OK';
      if (sev !== 'OK' && sev !== lastSeverity) {                     // only on transition → no event storm
        const evt = PressureEvent.parse({ severity: sev, reasons, availPhysMB: t.system.availPhysMB, vramUsagePct: vramPct });
        win.webContents.send(Channels.memoryPressure, evt);
      }
      lastSeverity = sev;
    } catch (err) { console.error('[watchdog]', err); }
    timer = setTimeout(tick, win.isVisible() && !win.isMinimized() ? 2500 : 15000);   // back off when hidden
    timer.unref();
  };
  void tick();
  win.on('closed', () => clearTimeout(timer));
}
```

**`src/main/crash-monitor.ts`**: forensics and GPU crash-loop policy

```ts
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = () => path.join(app.getPath('userData'), 'Diagnostics');
const incidentLog = () => path.join(dir(), 'incidents.jsonl');
const gpuFlag = () => path.join(dir(), 'disable-gpu.flag');

function record(kind: string, data: object) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.appendFileSync(incidentLog(), JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
}
export function shouldDisableGpu(): boolean { return fs.existsSync(gpuFlag()); }

export function startCrashMonitor(): void {
  const gpuCrashes: number[] = [];
  app.on('child-process-gone', (_e, d) => {
    record('child-process-gone', { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name });
    if (d.type === 'GPU') {
      const now = Date.now(); gpuCrashes.push(now);
      while (gpuCrashes.length && now - gpuCrashes[0] > 5 * 60_000) gpuCrashes.shift();
      if (gpuCrashes.length >= 3) { fs.writeFileSync(gpuFlag(), String(now)); record('gpu-fallback-armed', {}); }
    }
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('render-process-gone', (_ev, d) => record('render-process-gone', { reason: d.reason, exitCode: d.exitCode }));
    wc.on('unresponsive', () => record('renderer-unresponsive', {}));
  });
}
```

### 5.4 Preload

**`src/preload/index.ts`** (bundled with esbuild; Zod is bundled in)

```ts
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { Channels, PressureEvent, Telemetry } from '../shared/ipc-contract';

const api = Object.freeze({
  getTelemetry: async (): Promise<Telemetry> => Telemetry.parse(await ipcRenderer.invoke(Channels.getTelemetry)),
  captureHeapSnapshot: (reason: string) => ipcRenderer.invoke(Channels.captureHeapSnapshot, { reason }),
  onMemoryPressure: (cb: (e: PressureEvent) => void): (() => void) => {
    const h = (_: IpcRendererEvent, raw: unknown) => { const p = PressureEvent.safeParse(raw); if (p.success) cb(p.data); };
    ipcRenderer.on(Channels.memoryPressure, h);
    return () => ipcRenderer.removeListener(Channels.memoryPressure, h);
  },
});
contextBridge.exposeInMainWorld('aeroPlatform', api);
```

Never expose `ipcRenderer`, a generic `send(channel, …)`, or `on(channel, …)`. Never expose the raw `event` object to the callback; it leaks `sender`.

### 5.5 Renderer

**`src/renderer/index.html`** (external CSS/JS only; no inline script, no inline style)

```html
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' aeroshell-asset: data: blob:; connect-src 'self' aeroshell-asset:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>AeroShell Viewport</title>
<link rel="stylesheet" href="./styles.css" />
</head><body>
<div id="hud"><strong>AeroShell</strong><div id="gpu">GPU: …</div><div id="mem">Memory: …</div><div id="pressure" hidden></div></div>
<canvas id="cad-canvas"></canvas>
<script src="./main.js"></script>
</body></html>
```

The header CSP (set in the protocol handler) is authoritative. The meta tag is a second layer. Inline `style` attributes are blocked by `style-src 'self'`, so move the styles to `styles.css` and toggle classes instead.

**`cad-viewport.ts` essentials (Three.js)**

```ts
renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); stopLoop(); showBanner('GPU context lost, recovering'); });
canvas.addEventListener('webglcontextrestored', () => { rebuildGpuResources(); startLoop(); });
// Disposal discipline: on model unload → geometry.dispose(), material.dispose(), texture.dispose()
// Observability: renderer.info.memory {geometries, textures}, renderer.info.render {calls, triangles}
// Heavy parsing → Worker + transferable ArrayBuffers; use OffscreenCanvas where possible
```

`main.ts` writes telemetry with `textContent` (never `innerHTML`), toggles a CSS class on pressure, and on `CRITICAL` unloads LOD levels or evicts caches instead of only painting a red border.

### 5.6 Packaging

**`electron-builder.yml`**

```yaml
appId: dev.yourhandle.aeroshell          # NOT com.autodesk.*
productName: AeroShell
directories: { output: release, buildResources: build }
files:
  - dist/**/*
  - package.json
  - "!**/*.map"
asar: true
asarUnpack:
  - "build/Release/*.node"               # native addons cannot load from inside asar
extraResources: []
afterPack: build-scripts/after-pack.mjs  # flips fuses
win:
  target: [{ target: nsis, arch: [x64] }]
  artifactName: "${productName}-Setup-${version}.${ext}"
  requestedExecutionLevel: asInvoker
  # Signing: Azure Artifact Signing (formerly Trusted Signing) or EV cert; sign .exe, installer AND aero_win_bridge.node
nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, createDesktopShortcut: true }
```

**`build-scripts/after-pack.mjs`** (the "hardened" claim lives here)

```js
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import path from 'node:path';
export default async function (ctx) {
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
```

Unpacked `.node` files are **outside** ASAR integrity coverage, so Authenticode-sign the addon and verify the signature in CI.

**`package.json` scripts**

```json
{
  "scripts": {
    "compile:native": "cmake-js compile -d src/native --runtime electron --runtime-version 44.4.5 --arch x64 -O build",
    "bundle": "node build-scripts/bundle.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "start": "npm run bundle && electron dist/main/index.js",
    "dist": "npm run compile:native && npm run bundle && electron-builder"
  }
}
```

Bundler config: main, preload and renderer run through esbuild (`platform:'node'`, `format:'cjs'`, `external:['electron','*.node']` for main and preload; `platform:'browser'` for the renderer). Check the exact cmake-js output path flags against your installed cmake-js version.

---

## 6. Defect register: what changed from the original draft

| # | Original | Problem | Fix |
| --- | --- | --- | --- |
| 1 | `dedicatedVRAM_MB < 512` as "pressure" | `DedicatedVideoMemory` is **total** VRAM, not free. The check is meaningless. | `IDXGIAdapter3::QueryVideoMemoryInfo` (budget + usage) |
| 2 | `CreateDXGIFactory` + `EnumAdapters(0)` | Old API; adapter 0 may be software or integrated | `CreateDXGIFactory1`, `EnumAdapterByGpuPreference`, `isSoftware` flag, return all adapters |
| 3 | `registerAssetProtocolHandler()` never called | Protocol silently not registered | Both handlers registered in `ready` |
| 4 | `startsWith(ALLOWED_ASSET_ROOT)` | Prefix bypass (`Models-evil`), no symlink check | `path.relative` + `realpath` + reject `:`/NUL |
| 5 | `aeroshell-asset://x/y` → used only `pathname` | For standard schemes the first segment becomes the **host** | Pin host (`models`), use `pathname` |
| 6 | `will-navigate` allowed any `file:` | A renderer-controlled `file://` navigation is an escape hatch | Allow only `aeroshell-app://app` |
| 7 | Hostname exact match only | Rejects legit subdomains; `new URL` can throw | Suffix match, safe parse |
| 8 | `loadFile()` for UI | Weak `file://` origin | Custom `aeroshell-app://` scheme |
| 9 | CSP: `style-src 'unsafe-inline'`, no `worker-src`/`wasm` | Weakens CSP; breaks DRACO/Basis/WASM workers | `style-src 'self'`; `worker-src 'self' blob:`; `'wasm-unsafe-eval'` |
| 10 | Zod promised, absent | Architecture diagram not implemented | Shared `ipc-contract.ts`, validated in main **and** preload |
| 11 | No IPC sender check | Any frame can invoke | `event.senderFrame.url` check |
| 12 | `tsc` output used as preload | Sandboxed preload cannot `require('./contracts')` | esbuild bundle |
| 13 | `app.quit()` then continuing | Code after lock failure still ran | `app.exit(0)` + `else` branch |
| 14 | `process.getProcessMemoryInfo()` only | Main process only; misses GPU/renderer | `app.getAppMetrics()` (KB→MB converted) |
| 15 | `setInterval`, no hysteresis | Event storm, runs when hidden | Adaptive `setTimeout`, transition-only events |
| 16 | `--expose-gc` in prod; `ignore-gpu-blocklist` always on | Enterprise instability / security surface | Dev-only, opt-in via env |
| 17 | `crashDumpsDir` unused; "minidump parser in main" | Dead code; parsing dumps in-process is risky | Use `app.getPath('crashDumps')`; symbolicate **offline** |
| 18 | `.node` loaded from `app.getAppPath()` | Fails inside ASAR | `asarUnpack` + `app.asar.unpacked` path |
| 19 | CMake missing `node-addon-api` include, defines, Advapi32, hardening | Would not build/link | Rewritten (§5.1) |
| 20 | `win_registry.*` listed, not provided; arbitrary-registry risk | Missing + unsafe | Allowlisted two-key reader |
| 21 | Spectron | Deprecated/archived | Playwright `_electron` |
| 22 | Node 22 | Stale | Electron 44 → Node 24 |
| 23 | `appId com.autodesk.*` | Implies Autodesk ownership | Own reverse-DNS ID |
| 24 | Metrics table of "achieved" numbers | Unmeasured; some implausible | §10 targets + method |
| 25 | "Zero Node primitives" validated by "AST audit" | Vague | Contract test enumerating exposed keys |

---

## 7. Chromium and V8 diagnostics playbook

### 7.1 Chromium switches: what they do and what they don't

| Switch | Reality | Policy |
| --- | --- | --- |
| `enable-gpu-rasterization` | Already default on most Windows GPUs; affects 2D/UI raster, **not** WebGL | Omit unless a benchmark shows gain |
| `enable-zero-copy` | Affects compositor tile upload | Benchmark A/B before adopting |
| `ignore-gpu-blocklist` | Overrides Chromium's driver-bug protections; can cause crashes | Opt-in env flag only; never default |
| `js-flags=--max-old-space-size` | Renderer V8 old-space ceiling | Set deliberately; document memory budget |
| `--expose-gc` | Lets scripts call `gc()` | Diagnostic builds only |
| `use-angle=d3d11` / alternatives | ANGLE backend (D3D11 default on Windows) | Switch only to isolate a driver bug |

Method: change **one** switch at a time, run the same scripted scene 10×, compare frame-time p50/p95/p99 and GPU-process crash count.

### 7.2 Introspection APIs

| Need | API |
| --- | --- |
| GPU feature state | `app.getGPUFeatureStatus()`, `await app.getGPUInfo('complete')` |
| Per-process memory/CPU | `app.getAppMetrics()` (working set in KB) |
| Main-process heap | `v8.getHeapStatistics()`, `v8.writeHeapSnapshot()`, `--heap-prof` |
| Renderer heap / CPU | CDP through `webContents.debugger` (§7.3) |
| System trace | `contentTracing.startRecording()` → Perfetto / `chrome://tracing` |
| WebGL stats | `renderer.info.memory`, `renderer.info.render`, `WEBGL_debug_renderer_info` |
| Precise memory (renderer) | `performance.measureUserAgentSpecificMemory()` (needs cross-origin isolation) |
| Windows-level | WPR/ETW, PIX, GPUView, RenderDoc for GPU frames |

### 7.3 Renderer heap snapshot via CDP

```ts
const dbg = win.webContents.debugger;
dbg.attach('1.3');
let chunks: string[] = [];
dbg.on('message', (_e, method, p) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(p.chunk); });
await dbg.sendCommand('HeapProfiler.collectGarbage');
await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
fs.writeFileSync(file, chunks.join('')); dbg.detach();
```

Gate this behind a diagnostics-only build flag or admin policy, because it grants full heap access.

### 7.4 Leak-hunting protocol (soak test)

1. Load model → unload, ×N cycles, forcing GC (CDP `collectGarbage`) after each.
2. Record `usedJSHeapSize`, `renderer.info.memory`, GPU-process working set per cycle.
3. Fit a slope. **Pass:** heap and GPU slopes within tolerance (e.g. \< 1 MB/cycle after warm-up).
4. Compare two snapshots (cycle 5 vs 25); inspect retained `BufferGeometry` / `Texture` / detached DOM.
5. Validate the detector against **seeded leak fixtures** (a deliberately un-disposed texture) and report true/false-positive rates, instead of claiming "100% accuracy".

---

## 8. Failure handling and recovery

| Event | Handling |
| --- | --- |
| `webglcontextlost` | Stop loop, show banner, rebuild GPU resources on `webglcontextrestored` |
| `render-process-gone` | Log → offer reload; persist user work before the next load |
| GPU process crash ×3 in 5 min | Arm `disable-gpu.flag` → next launch `app.disableHardwareAcceleration()` (software fallback, with in-app notice) |
| `unresponsive` | Log; offer wait/reload |
| Native crash | Minidumps in `crashDumps`; symbolicate offline with matching PDB (`/Zi /DEBUG` is already enabled) |
| Memory CRITICAL | Renderer evicts caches / lowers LOD; main logs incident |

Keep PDBs for every release in an internal symbol store keyed by build ID.

---

## 9. Build, CI, supply chain

### 9.1 CI (`.github/workflows/build-and-test.yml`, Windows runner)

1. `actions/checkout` (pin SHAs), `actions/setup-node` (Node 24), MSVC via `ilammy/msvc-dev-cmd`.
2. `npm ci` → `npm audit signatures` → `npm audit --omit=dev`.
3. `npm run compile:native` (fail on warnings: `/WX`).
4. `npm run typecheck` → `npm test` → `npm run bundle`.
5. `npm run test:e2e` (Playwright Electron).
6. `electron-builder` → verify fuse state (`npx @electron/fuses read --app …`) → Authenticode sign → verify signature.
7. Upload installer, PDBs, SBOM (CycloneDX) as artifacts.
8. Scheduled: Dependabot/Renovate for Electron (8-week cadence), CodeQL, Electronegativity scan.

### 9.2 Hardening checklist (maps to Electron's official security guidance)

- [x] Sandbox on · \[x\] `contextIsolation` on · \[x\] `nodeIntegration` off · \[x\] `webviewTag` off
- [x] CSP header + meta · \[x\] Permission handlers deny · \[x\] Navigation + window-open gates
- [x] No `file://` privileges · \[x\] IPC sender + schema validation · \[x\] No raw `ipcRenderer`
- [x] Fuses flipped · \[x\] ASAR integrity · \[x\] Signed binaries · \[x\] Current Electron major

---

## 10. Testing and measurable metrics

### 10.1 Tests

| Layer | Tool | Cases |
| --- | --- | --- |
| Path guard | Vitest | `..\\`, `%2e%2e`, `Models-evil`, `C:`, NUL, ADS `a.glb:x`, symlink/junction escape, extension deny |
| Navigation | Vitest + mocks / e2e | external URL blocked, `file://` blocked, `window.open` denied, allowlisted → system browser |
| IPC | Vitest | wrong sender URL rejected, unknown keys rejected (`.strict()`), oversize strings |
| Preload contract | e2e | `Object.keys(window.aeroPlatform)` equals the allowlist exactly; `typeof require`, `process` are `undefined` in renderer |
| Native | Vitest (Node-API loads in plain Node) | adapter array shape, `vramBudgetMB ≥ vramUsageMB`, registry allowlist returns `null` for others |
| Range requests | e2e | `Range: bytes=0-99` on a model returns 206 / 100 bytes |
| Fuses | CI | read-back equals expected |
| Crash policy | Unit | 3 GPU crashes in window arms flag |

### 10.2 Metrics: targets to **measure**, not claims

| Metric | Original claim | Realistic target / how to measure |
| --- | --- | --- |
| Time to first WebGL frame | "\< 420 ms" | Electron cold start is usually higher on typical hardware. **Target:** window visible \< 800 ms warm; first frame \< 1.5 s on your reference PC. Measure with `performance.now()` marks + WPR; report p50/p95 over 20 launches and name the hardware. |
| Exposed Node primitives | "0" | **Target:** 0 Node/Electron globals, N allowlisted functions. Proven by the contract test. |
| Asset streaming | "2.4 GB/s" | Bounded by disk/OS cache, not Electron. **Measure:** MB/s for cold and warm reads of a 1 GB model via the protocol vs `fs.createReadStream`; publish both with drive type. |
| Leak detection | "100% accuracy" | Seeded-fixture detection rate and slope threshold (§7.4). |
| Installer size | "\< 75 MB" | Electron installers are typically in the high-70s to 100+ MB. Report the measured size, and what you cut. |
| Watchdog overhead | n/a | Target \< 0.5% CPU; measure with `app.getAppMetrics()` delta. |
| GPU-crash recovery | n/a | Kill GPU process in test (`process.kill(gpuPid)`) → app recovers without restart; report time-to-recover. |

---

## 11. Roadmap

| Milestone | Deliverable | Done when |
| --- | --- | --- |
| M0 | Repo, TS, esbuild, Electron 44 runs blank window | `npm start` works |
| M1 | Native addon (memory, GPU, registry) | Native tests green on Windows |
| M2 | Custom schemes + path guard + CSP | Path-guard suite green |
| M3 | Preload + Zod contract + IPC checks | Contract tests green |
| M4 | Three.js viewport + context-loss handling + HUD | Visible scene, loss/restore verified |
| M5 | Watchdog + crash monitor + GPU fallback | Kill-GPU test passes |
| M6 | Diagnostics (heap snapshot, trace) + soak test | Soak report generated |
| M7 | Packaging, fuses, signing, CI | Signed installer, fuse read-back passes |
| M8 | Benchmarks + README + SECURITY.md | Metrics table filled with **measured** numbers |

---

## 12. Interview mapping

| Topic | Evidence to point at |
| --- | --- |
| Electron/Chromium internals | §3 process model, §7.1 switch reasoning, custom-scheme origin design |
| Windows C++ | §5.1 DXGI 1.6, `IDXGIAdapter3`, Node-API ABI stability, CFG/CET, PDB workflow |
| V8 diagnostics | §7.2–7.4, soak test with seeded leaks |
| Enterprise security | §4 threat model, §5.3 guards, §9.2 fuses/signing, registry policy channel |
| Engineering judgement | §6: you audited your own draft, fixed 25 defects and replaced unmeasured claims |

Good answers to likely questions: why VRAM *budget* and not *dedicated*; why validation lives in main; why the UI isn't served from `file://`; why `ignore-gpu-blocklist` is not default; how you'd symbolicate a customer crash.

---

## 13. Sources

- Electron releases and timeline: releases.electronjs.org · electronjs.org/docs/latest/tutorial/electron-timelines
- Electron 44 notes (Chromium 152, V8 15.2, Node 24.x): electronjs.org/blog/electron-44-0
- Electron security tutorial, fuses, `protocol.handle`, `crashReporter`, `app.getAppMetrics`: electronjs.org/docs/latest
- Microsoft Learn: `IDXGIAdapter3::QueryVideoMemoryInfo`, `IDXGIFactory6::EnumAdapterByGpuPreference`, `GlobalMemoryStatusEx`, `RegGetValueW`
- Node-API / node-addon-api and cmake-js docs on GitHub