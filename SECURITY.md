# AeroShell Security Architecture & Threat Model

AeroShell is a hardened Electron runtime designed for high-performance WebGL/Three.js CAD visualization. This document summarizes the core security principles, threat mitigations, and accepted residual risks.

---

## 1. Process Architecture & Trust Boundaries

```
┌────────────────────────────────────────────────────────────────────────────┐
│ UNTRUSTED RENDERER                                                         │
│  - Origin: aeroshell-app://app/                                            │
│  - Sandbox: true, contextIsolation: true, nodeIntegration: false           │
│  - No Node.js globals: typeof require === 'undefined', process is undefined│
│  - WebviewTag disabled, navigation strictly gated                         │
└───────────────────────────────▲────────────────────────────────────────────┘
                                │ window.aeroPlatform (frozen, allowlisted)
┌───────────────────────────────┴────────────────────────────────────────────┐
│ PRELOAD SCRIPT                                                             │
│  - Bundled CJS, isolated world                                             │
│  - No raw ipcRenderer, send(), on(), or event objects exposed              │
└───────────────────────────────▲────────────────────────────────────────────┘
                                │ Typed IPC (invoke)
┌───────────────────────────────┴────────────────────────────────────────────┐
│ MAIN PROCESS (Authoritative Security Perimeter)                            │
│  - Origin verification: event.senderFrame.url.startsWith('aeroshell-app:') │
│  - Bidirectional payload validation with Zod (.strict())                   │
│  - Protocol handlers: canonical path guard & streaming                     │
│  - Windows native bridge queries                                           │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Model & Mitigations (STRIDE-lite)

| Threat | Attack Vector | Hardening Mitigation |
|---|---|---|
| **Remote Code Execution (RCE)** | XSS via compromised CAD model metadata or geometry attributes | Strict Content-Security-Policy (no `'unsafe-inline'`, no `'unsafe-eval'`), external assets only, DOM updates via `textContent` only, zero Node globals. |
| **Path Traversal & Arbitrary File Read** | Malicious URLs such as `aeroshell-asset://models/..%5c..%5cWindows` | Canonical path guard in `src/main/path-guard.ts`: URI decoding, NUL byte rejection, colon rejection (blocks drive letters and NTFS alternate data streams), prefix collision prevention (`path.relative`), and canonical re-check via `fs.realpathSync.native`. |
| **NTFS Quirk Exploitation** | Trailing dots (`model.glb.`), trailing spaces (`model.glb `), or Windows device names (`CON`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) | Explicit token rejection in `path-guard.ts` for trailing spaces/dots and reserved DOS/Windows device namespaces. |
| **Junction / Symlink Escapes** | Creating an NTFS junction inside `<userData>/Models` pointing to sensitive directories | `fs.realpathSync.native` resolves all filesystem redirection before validating containment within the canonical root. |
| **Privilege Escalation via IPC** | Untrusted frames attempting `ipcRenderer.invoke` | `event.senderFrame.url` validated against `aeroshell-app://app/`, Zod `.strict()` schema enforcement on inputs and outputs. |
| **Navigation Hijacking** | Renderer redirecting to `https://evil.com` or local `file://` | `will-navigate`, `will-redirect`, `will-frame-navigate` gated to `aeroshell-app://app/`. `setWindowOpenHandler` always denies in-app popups, routing allowlisted HTTPS hosts to the system browser. |
| **Binary & Runtime Tampering** | Manipulating `app.asar`, injecting Node flags (`--inspect`, `ELECTRON_RUN_AS_NODE`) | Electron Fuses flipped: `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`, `EnableNodeCliInspectArguments=false`, `EnableEmbeddedAsarIntegrityValidation=true`, `OnlyLoadAppFromAsar=true`. |

---

## 3. Content Security Policy (CSP) & Isolation

The application UI is served over standard scheme `aeroshell-app://app/` with HTTP response headers:

```http
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' aeroshell-asset: data: blob:; font-src 'self'; connect-src 'self' aeroshell-asset:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
X-Content-Type-Options: nosniff
```

Assets (`aeroshell-asset://models/...`) carry:
```http
Access-Control-Allow-Origin: aeroshell-app://app
Vary: Origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Accept-Ranges: bytes
```

---

## 4. Accepted Residual Risks & TOCTOU Analysis

### Time-of-Check to Time-of-Use (TOCTOU) Gap in Asset Streaming
- **Description:** In `src/main/protocol-handler.ts`, file containment is verified via `resolveInside(modelRoot, requested)` using `fs.realpathSync.native`. Subsequently, the file is opened for streaming via `fs.createReadStream(file)`. There is a microscopic theoretical time window between resolving the canonical path and opening the read stream descriptor where an attacker could replace the verified target with a symlink or junction.
- **Threat Vector:** A local process running under the same user account modifies files inside `<userData>/Models` concurrently during asset loading.
- **Accepted Risk Justification & Countermeasures:**
  1. **Single-User Desktop Model:** Electron runs as the local user on Windows. An attacker capable of executing arbitrary code with concurrent filesystem write permissions to the user's `%APPDATA%` directory already possesses identical privileges to the application and could compromise the process via user-space memory or binary manipulation.
  2. **DACL Protection:** The application's `userData` folder inherits standard Windows user DACLs; other unprivileged standard users cannot write to or tamper with the local user's AppData directory.
  3. **Handle Locking:** `fs.createReadStream` acquires a shared file handle immediately upon opening, preventing deletion or atomic replacement while streaming is active.
  4. **Enterprise Multi-User Guidance:** For multi-user workstations or shared model repositories, the model directory should be configured with restricted NTFS permissions (read/execute only, disallowing standard users from creating junctions or modifying contents).

---

## 5. Crashpad Minidump Offline Symbolication Workflow

Minidumps (`.dmp`) generated by Crashpad are **never parsed in-process** within AeroShell. In-process crash parsing introduces severe memory corruption attack surface (untrusted minidump parser libraries executing inside privileged main or browser processes) and risks secondary crashes during fault handling.

### Crashpad Directory Layout
Crashpad writes minidumps to the application's local user data path:
```
%APPDATA%\AeroShell\Crashpad\
  ├── metadata
  ├── settings.dat
  ├── attachments/
  └── reports/
      └── <UUID>.dmp     <-- Native minidump (~400-600 KB)
```
Accompanying incident metadata is appended to `%APPDATA%\AeroShell\Diagnostics\crashes.jsonl` (with size rotation at 1 MB, max 3 files) containing process type, exit code, crash reason, and timestamp.

### Offline Symbolication Procedure

To symbolicate a `.dmp` file collected from a user workstation or CI runner:

#### Prerequisites
1. **Application PDBs:** Retain the release PDBs archived during CI build:
   - Native addon: `build/Release/aero_win_bridge.pdb`
2. **Electron PDBs:** Download matching Electron debug symbols from GitHub releases:
   - `https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-win32-x64-pdb.zip`
3. **Microsoft Public Symbol Server:** For Windows OS binaries (`ntdll.dll`, `kernel32.dll`, `dxgi.dll`, `pdh.dll`).

#### Method A: Windows Debugger (WinDbg / cdb.exe)
Run `cdb.exe` (part of the Windows SDK / Debugging Tools for Windows):
```cmd
cdb.exe -z "C:\path\to\reports\<UUID>.dmp" ^
  -y "srv*C:\Symbols*https://msdl.microsoft.com/download/symbols;C:\path\to\aeroshell\symbols;C:\path\to\electron-v44.5.1-pdb" ^
  -c "!analyze -v; lm; ~*k; q" > crash_analysis.txt
```
Key commands in the debugger:
- `!analyze -v`: Automated fault analysis showing the crashing exception code, faulting instruction, and faulting module.
- `~*k`: Unwinds the call stacks for all active threads.
- `lm`: Lists loaded modules with symbol resolution status (`pdb symbols` vs `export symbols`).

#### Method B: Google Breakpad / Crashpad Tools (`minidump_stackwalk`)
If integrating into a Linux-based or automated CI triage pipeline:
1. Extract Breakpad symbol format using `dump_syms.exe`:
   ```cmd
   dump_syms.exe aero_win_bridge.pdb > aero_win_bridge.sym
   ```
2. Place symbols into Breakpad directory structure:
   ```
   symbols/aero_win_bridge.pdb/<DEBUG_ID>/aero_win_bridge.sym
   ```
3. Run `minidump_stackwalk`:
   ```bash
   minidump_stackwalk <UUID>.dmp symbols/ > stacktrace.txt
   ```
The output produces line numbers, function names, and register values for the crashing frame.
