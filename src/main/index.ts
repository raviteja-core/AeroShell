import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { registerSchemes, registerProtocolHandlers } from './protocol-handler';
import { installSessionPolicy, hardenWebContents } from './security-guard';
import { registerIpc, fetchGpuInfoAfterReady, getNativeAddon, getActiveGpuDevice } from './ipc';
import { initCrashReporter, CrashMonitor } from './crash-monitor';
import { isGpuFallbackActive } from './gpu-fallback-policy';
import { PressureWatchdog } from './watchdog';
import { Channels } from '../shared/ipc-contract';

app.name = 'AeroShell';
app.setName('AeroShell');

// Test-only isolated userData directory override for E2E testing
if (process.env.AEROSHELL_TEST_USER_DATA) {
  app.setPath('userData', process.env.AEROSHELL_TEST_USER_DATA);
  app.setPath('crashDumps', path.join(process.env.AEROSHELL_TEST_USER_DATA, 'Crashpad'));
}

// 1) Single-instance lock: exit before ANY side effect.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  bootstrap();
}

function bootstrap(): void {
  // Start crash reporter before ready
  initCrashReporter();

  // Register privileged schemes BEFORE app is ready
  registerSchemes();

  // GPU fallback check: if 3 GPU crashes occurred in 5m within the last 7 days, disable HW accel
  try {
    const userData = app.getPath('userData');
    if (isGpuFallbackActive(userData, process.versions.electron)) {
      console.warn('[main] Hardware acceleration disabled due to GPU fallback policy.');
      app.disableHardwareAcceleration();
    }
  } catch {}

  // Test-only software rendering flag for headless / CI runners without hardware GPUs
  if (process.env.AEROSHELL_TEST_SOFTWARE_GL === '1') {
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  }

  app.whenReady().then(async () => {
    registerProtocolHandlers();
    installSessionPolicy();
    app.on('web-contents-created', (_e, wc) => hardenWebContents(wc));

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 768,
      backgroundColor: '#121212',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    registerIpc(win);

    // Attach crash monitor (handles render-process-gone and child-process-gone)
    new CrashMonitor(win);

    // Attach memory pressure watchdog
    const watchdog = new PressureWatchdog({
      win,
      getNative: getNativeAddon,
      getActiveGpu: getActiveGpuDevice,
    });
    watchdog.start();
    (global as any).__watchdog = watchdog;
    (global as any).__getNativeAddon = getNativeAddon;

    // Window state IPC emitter (Zod-validated channel)
    const sendWindowState = (state: 'normal' | 'minimized' | 'maximized' | 'hidden') => {
      if (!win.isDestroyed()) {
        win.webContents.send(Channels.windowState, { state });
      }
    };

    win.on('minimize', () => sendWindowState('minimized'));
    win.on('restore', () => sendWindowState(win.isMaximized() ? 'maximized' : 'normal'));
    win.on('maximize', () => sendWindowState('maximized'));
    win.on('unmaximize', () => sendWindowState('normal'));
    win.on('hide', () => sendWindowState('hidden'));
    win.on('show', () => sendWindowState(win.isMaximized() ? 'maximized' : 'normal'));

    win.once('ready-to-show', () => {
      win.show();
      fetchGpuInfoAfterReady();
    });

    await win.loadURL('aeroshell-app://app/index.html');

    // Test-only hook: create second window loading about:blank with same preload to verify hostile origin rejection
    if (process.env.AEROSHELL_TEST_CREATE_HOSTILE_WINDOW === '1') {
      const hostileWin = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      await hostileWin.loadURL('about:blank');
    }

    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore();
      win.focus();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
