# AeroShell Deviations Register

This document tracks all intentional divergences from `docs/REFERENCE.md`, noting the reason, the affected files, and the alternative implementation.

| # | Reference Section | Specified Behavior | Divergence / Actual Implementation | Rationale |
|---|---|---|---|---|
| DEV-001 | §2 Baseline, §5.6 package.json | `electron: "44.4.5"` | Pinned exactly to `electron: "44.5.1"` | `44.5.1` is the newest stable patch in the Electron 44.x line (verified via `npm view electron@44 version`). Same version used in `compile:native`. |
| DEV-002 | §2 Baseline, §5.1 Native | `cmake-js: 7.x` | Pinned to `cmake-js: "8.0.0"` | `8.0.0` is the current stable major with full support for Node 24 LTS and modern CMake toolchains. |
| DEV-003 | §5.3 Main process | M0 imports protocol-handler, ipc, watchdog, crash-monitor | M0 `src/main/index.ts` is minimal (single-instance lock + blank `BrowserWindow` with hardened webPreferences). Subsequent modules are integrated in M1–M5. | As specified in the milestone execution plan to verify scaffolding and typecheck cleanly before downstream modules are implemented. |
| DEV-004 | §5.6 Scripts & Gates | M0 gate: `npm start` | Added automated smoke test `tests/e2e/smoke.test.ts` (Playwright launch, wait for `ready-to-show`, exit 0) for verifiable CI and CLI gating. | Prevents hanging headless/terminal sessions during automated gate verification. |
| DEV-005 | §7.1 Chromium Switches | Software GL flags | `AEROSHELL_TEST_SOFTWARE_GL=1` env var triggers `--use-gl=angle --use-angle=swiftshader` strictly for tests/CI; never present in prod code. | Allows test execution in headless Windows environments without physical GPUs. |
