import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { registerSchemes, registerProtocolHandlers } from './protocol-handler';

// 1) Single-instance lock: exit before ANY side effect.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  bootstrap();
}

function bootstrap(): void {
  // Register privileged schemes BEFORE app is ready
  registerSchemes();

  // Test-only software rendering flag for headless / CI runners without hardware GPUs
  if (process.env.AEROSHELL_TEST_SOFTWARE_GL === '1') {
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
  }

  app.whenReady().then(async () => {
    registerProtocolHandlers();

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

    win.once('ready-to-show', () => {
      win.show();
    });

    await win.loadURL('aeroshell-app://app/index.html');

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
