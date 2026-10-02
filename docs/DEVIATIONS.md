# AeroShell Deviations Register

This document tracks all intentional divergences from `docs/REFERENCE.md`, noting the reason, the affected files, and the alternative implementation.

| # | Reference Section | Specified Behavior | Divergence / Actual Implementation | Rationale |
|---|---|---|---|---|
| DEV-001 | §2 Baseline, §5.6 package.json | `electron: "44.4.5"` | Pinned exactly to `electron: "44.5.1"` | `44.5.1` is the newest stable patch in the Electron 44.x line (verified via `npm view electron@44 version`). Same version used in `compile:native`. |
| DEV-002 | §2 Baseline, §5.1 Native | `cmake-js: 7.x` | Pinned to `cmake-js: "8.0.0"` | `8.0.0` is the current stable major with full support for Node 24 LTS and modern CMake toolchains. |
| DEV-003 | §5.3 Main process | M0 imports protocol-handler, ipc, watchdog, crash-monitor | M0 `src/main/index.ts` is minimal (single-instance lock + blank `BrowserWindow` with hardened webPreferences). Subsequent modules are integrated in M1–M5. | As specified in the milestone execution plan to verify scaffolding and typecheck cleanly before downstream modules are implemented. |
| DEV-004 | §5.6 Scripts & Gates | M0 gate: `npm start` | Added automated smoke test `tests/e2e/smoke.test.ts` (Playwright launch, wait for `ready-to-show`, exit 0) for verifiable CI and CLI gating. | Prevents hanging headless/terminal sessions during automated gate verification. |
| DEV-005 | §7.1 Chromium Switches | Software GL flags | `AEROSHELL_TEST_SOFTWARE_GL=1` env var triggers `--use-gl=angle --use-angle=swiftshader` strictly for tests/CI; never present in prod code. | Allows test execution in headless Windows environments without physical GPUs. |
| DEV-006 | §5.1 Native module | `win_memory.cc` implicit ULONGLONG cast | Explicit `static_cast<double>(...)` applied to all `MEMORYSTATUSEX` ULONGLONG fields. | Prevents MSVC warning C4244 ('conversion from ULONGLONG to double, possible loss of data') which fails under `/W4 /WX`. |
| DEV-007 | §5.1 Native module | `/Qspectre` in compile options | Removed `/Qspectre` compiler flag | The MSVC v143 Spectre-mitigated libraries component is not installed in the build environment. Retaining the flag produces fatal error D8040 / link failure without the component. |
| DEV-008 | §5.1 Native module | System header warning isolation | Added `/external:anglebrackets /external:W0` and designated `node-addon-api` / Node headers as `SYSTEM`. | Guarantees `/W4 /WX` strictly audits AeroShell native codebase while preventing third-party header warnings from halting compilation. |
| DEV-009 | §9.1 CI, §9.2 Hardening | E2E test execution vs fused binary | E2E tests run against the development/unfused build; fuse validation is executed against the packaged distribution installer in M7. | Electron fuses (`RunAsNode=false`, `OnlyLoadAppFromAsar=true`) preclude test runner automation hooks on unpacked dev binaries. |
