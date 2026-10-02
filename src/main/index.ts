import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';

// 1) Single-instance lock: exit before ANY side effect.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  bootstrap();
}

function bootstrap(): void {
  // Test-only software rendering flag for headless / CI runners without hardware GPUs
  if (process.env.AEROSHELL_TEST_SOFTWARE_GL === '1') {
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
  }

  app.whenReady().then(async () => {
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

    // M0 loads blank page while custom protocol handlers are staged in M2
    await win.loadURL('about:blank');

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
