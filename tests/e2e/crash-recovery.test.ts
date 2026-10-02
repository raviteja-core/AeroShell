import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

function findDmpFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(findDmpFiles(fullPath));
      } else if (entry.name.endsWith('.dmp')) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

test.describe('Crash Monitor, Recovery, and Fallback (E2E)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
      },
    });

    page = await app.firstWindow();
    await page.waitForURL(/^aeroshell-app:\/\/app\//, { timeout: 10000 });
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  test('render-process-gone: logs incident, writes Crashpad minidump, recovers window, and getTelemetry works afterwards', async () => {
    const { userData, crashDumps } = await app.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      crashDumps: electronApp.getPath('crashDumps'),
    }));

    console.log('[crash-test] userData:', userData);
    console.log('[crash-test] crashDumps path:', crashDumps);

    // Forcefully terminate renderer process and await automatic reload
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error('Window not found');

      const reloaded = new Promise<void>((resolve) => {
        w.webContents.once('did-finish-load', () => resolve());
      });

      w.webContents.forcefullyCrashRenderer();
      await reloaded;
    });

    // 1. Verify incident logged in crashes.jsonl
    const logPath = path.join(userData, 'Diagnostics', 'crashes.jsonl');
    let exists = false;
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(logPath)) {
        exists = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(exists).toBe(true);

    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toContain('render-process-gone');
    expect(logContent).toContain('renderer');

    // 2. Search recursively for .dmp in crashDumps directory
    const dmpFiles = findDmpFiles(crashDumps);
    console.log(`[crash-test] Discovered .dmp files in Crashpad tree:`, dmpFiles);
    // On Windows, Crashpad places dumps under crashDumps/reports/<UUID>.dmp
    expect(fs.existsSync(crashDumps)).toBe(true);
    expect(dmpFiles.length).toBeGreaterThan(0);

    // 3. Verify window is fully functional and getTelemetry works afterwards in reloaded renderer
    const telemetry = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error('Window not found');
      return await w.webContents.executeJavaScript('window.aeroPlatform.getTelemetry()');
    });

    expect(telemetry).toBeDefined();
    expect((telemetry as { system?: unknown })?.system).toBeDefined();
  });

  test('render-process-gone loop guard: exceeding 3 crashes in 5 minutes loads static error page', async () => {
    // Perform 3 crashes and automatic reloads
    const finalUrl = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error('Window not found');

      // 3 crashes with automated reloads
      for (let i = 0; i < 3; i++) {
        const reloaded = new Promise<void>((resolve) => {
          w.webContents.once('did-finish-load', () => resolve());
        });
        w.webContents.forcefullyCrashRenderer();
        await reloaded;
      }

      // 4th crash: Exceeds 3 crashes in 5 minutes -> loads static crash-error.html
      const errorLoaded = new Promise<string>((resolve) => {
        w.webContents.once('did-finish-load', () => resolve(w.webContents.getURL()));
      });
      w.webContents.forcefullyCrashRenderer();
      return await errorLoaded;
    });

    console.log(`[crash-loop] Final URL after loop guard triggered: ${finalUrl}`);
    expect(finalUrl).toContain('crash-error.html');
  });

  test('@hardware GPU-kill: kill GPU process, record Chromium native behavior, and verify recovery', async () => {
    if (process.env.AEROSHELL_TEST_SOFTWARE_GL === '1') {
      test.skip(true, 'Skipping hardware GPU kill test under AEROSHELL_TEST_SOFTWARE_GL=1 (no hardware GPU present)');
      return;
    }

    // Acquire GPU process PID from app.getAppMetrics()
    const gpuPid = await app.evaluate(({ app: electronApp }) => {
      const gpuMetric = electronApp.getAppMetrics().find((m) => m.type === 'GPU');
      return gpuMetric?.pid;
    });

    expect(gpuPid).toBeDefined();
    expect(typeof gpuPid).toBe('number');
    console.log(`[gpu-kill] Target GPU process PID: ${gpuPid}`);

    // Set up renderer listener for webglcontextlost
    await page.evaluate(() => {
      (window as unknown as { __contextLostFired?: boolean }).__contextLostFired = false;
      const canvas = document.getElementById('cad-canvas');
      canvas?.addEventListener('webglcontextlost', () => {
        (window as unknown as { __contextLostFired?: boolean }).__contextLostFired = true;
      });
    });

    // Kill GPU process natively
    const killResult = await app.evaluate(({}, targetPid) => {
      try {
        process.kill(targetPid);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message };
      }
    }, gpuPid!);

    expect(killResult.success).toBe(true);

    // Wait for Chromium to observe process loss and respawn or notify context loss
    await page.waitForTimeout(1500);

    // Observe what Chromium does natively
    const observation = await app.evaluate(({ app: electronApp }, oldPid) => {
      const metrics = electronApp.getAppMetrics();
      const newGpu = metrics.find((m) => m.type === 'GPU');
      return {
        hasGpuProcess: !!newGpu,
        newGpuPid: newGpu?.pid,
        restarted: newGpu && newGpu.pid !== oldPid,
      };
    }, gpuPid);

    console.log(`[gpu-kill] Chromium native GPU observation:`, JSON.stringify(observation));

    // Chromium automatically respawns the GPU process upon termination
    expect(observation.hasGpuProcess).toBe(true);
    expect(observation.newGpuPid).not.toBe(gpuPid);

    // Verify telemetry continues to work
    const telemetry = await page.evaluate(async () => {
      return (window as unknown as { aeroPlatform?: { getTelemetry: () => Promise<unknown> } }).aeroPlatform?.getTelemetry();
    });
    expect(telemetry).toBeDefined();
  });
});
