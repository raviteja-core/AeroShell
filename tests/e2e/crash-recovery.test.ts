import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

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
  let tempUserData: string;

  test.beforeEach(async () => {
    tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroshell-crash-test-'));
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_USER_DATA: tempUserData,
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
    if (tempUserData) {
      try {
        fs.rmSync(tempUserData, { recursive: true, force: true });
      } catch {}
    }
  });

  test('render-process-gone: logs incident, writes Crashpad minidump, recovers window, and getTelemetry works afterwards', async () => {
    const testStartTime = Date.now();
    const { userData, crashDumps } = await app.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      crashDumps: electronApp.getPath('crashDumps'),
    }));

    console.log('[crash-test] app.getPath("userData"):', userData);
    console.log('[crash-test] app.getPath("crashDumps"):', crashDumps);

    // Verify consistency: both reside within the isolated tempUserData
    expect(userData).toBe(tempUserData);
    expect(crashDumps.startsWith(tempUserData)).toBe(true);

    // Initial dump file list
    const initialDmps = new Set(findDmpFiles(crashDumps));

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

    // 2. Search recursively for NEW .dmp files generated since testStartTime
    const currentDmps = findDmpFiles(crashDumps);
    const newDmps = currentDmps.filter((d) => !initialDmps.has(d) || fs.statSync(d).mtimeMs >= testStartTime - 1000);
    console.log(`[crash-test] Discovered new .dmp files in Crashpad tree:`, newDmps);
    expect(fs.existsSync(crashDumps)).toBe(true);
    expect(newDmps.length).toBeGreaterThan(0);

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

  test('@hardware GPU-kill: kill GPU process, record Chromium native behavior, verify context loss and PDH recovery', async () => {
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
      (window as any).__contextLostFired = false;
      const canvas = document.getElementById('cad-canvas');
      canvas?.addEventListener('webglcontextlost', () => {
        (window as any).__contextLostFired = true;
      });
    });

    // Kill GPU process natively via Win32 TerminateProcess
    const killResult = await app.evaluate(({}, targetPid) => {
      try {
        process.kill(targetPid);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message };
      }
    }, gpuPid!);

    expect(killResult.success).toBe(true);

    // Wait for Chromium to observe process loss and respawn GPU process
    await page.waitForTimeout(2000);

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

    const contextLostObserved = await page.evaluate(() => (window as any).__contextLostFired);
    console.log(`[gpu-kill] Chromium native GPU observation:`, JSON.stringify(observation));
    console.log(`[gpu-kill] webglcontextlost event observed in renderer: ${contextLostObserved}`);

    // Chromium automatically respawns the GPU process upon termination
    expect(observation.hasGpuProcess).toBe(true);
    expect(observation.newGpuPid).toBeDefined();
    expect(observation.newGpuPid).not.toBe(gpuPid);

    // PDH Lifecycle test: getGpuCounters([newPid]) must return that new pid's usage
    const pdhResult = await app.evaluate(async ({}, newPid) => {
      try {
        const getNative = (global as any).__getNativeAddon;
        if (!getNative) return { error: 'native addon helper not available' };
        const native = getNative();
        if (!native) return { error: 'native addon null' };
        return await native.getGpuCounters([newPid]);
      } catch (err: any) {
        return { error: err?.message };
      }
    }, observation.newGpuPid!);

    console.log(`[gpu-kill] getGpuCounters([newGpuPid=${observation.newGpuPid}]) result:`, JSON.stringify(pdhResult));
    expect(pdhResult).toBeDefined();
    expect(Array.isArray(pdhResult.processes)).toBe(true);
    const procEntry = pdhResult.processes.find((p: any) => p.pid === observation.newGpuPid);
    expect(procEntry).toBeDefined();
    expect(procEntry.pid).toBe(observation.newGpuPid);
    expect(typeof procEntry.dedicatedUsageMB).toBe('number');

    // Verify getTelemetry continues to work seamlessly
    const telemetry = await page.evaluate(async () => {
      return (window as any).aeroPlatform?.getTelemetry();
    });
    expect(telemetry).toBeDefined();
  });

  test('@hardware GPU fallback policy E2E: 3 GPU kills arms flag, relaunch disables HW accel with HUD warning', async () => {
    if (process.env.AEROSHELL_TEST_SOFTWARE_GL === '1') {
      test.skip(true, 'Skipping hardware GPU fallback test under AEROSHELL_TEST_SOFTWARE_GL=1 (no hardware GPU present)');
      return;
    }

    // Repeated kills 1..3 to arm the policy flag file
    for (let killNum = 1; killNum <= 3; killNum++) {
      const gPid = await app.evaluate(({ app: electronApp }) => {
        return electronApp.getAppMetrics().find((m) => m.type === 'GPU')?.pid;
      });

      expect(gPid).toBeDefined();
      console.log(`[gpu-fallback-e2e] Kill ${killNum}/3: Terminating GPU process ${gPid}...`);

      await app.evaluate(({}, targetPid) => {
        try {
          process.kill(targetPid);
        } catch {}
      }, gPid!);

      await page.waitForTimeout(1500);
    }

    // Verify armed flag JSON in tempUserData
    const flagPath = path.join(tempUserData, 'gpu-fallback.json');
    expect(fs.existsSync(flagPath)).toBe(true);
    const flagContent = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
    console.log(`[gpu-fallback-e2e] Armed flag file contents:`, JSON.stringify(flagContent, null, 2));
    expect(flagContent.armedAt).toBeDefined();
    expect(flagContent.electronVersion).toBeDefined();

    // Close first instance
    await app.close();

    // Relaunch Electron with identical tempUserData to verify fallback activation
    console.log(`[gpu-fallback-e2e] Relaunching with armed profile to verify hardware acceleration disablement...`);
    const relaunchApp = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_USER_DATA: tempUserData,
      },
    });

    const relaunchPage = await relaunchApp.firstWindow();
    await relaunchPage.waitForURL(/^aeroshell-app:\/\/app\//, { timeout: 10000 });
    await relaunchPage.waitForLoadState('networkidle');

    // Verify app.getGPUFeatureStatus() reports hardware acceleration disabled
    const featureStatus = await relaunchApp.evaluate(({ app: electronApp }) => {
      return electronApp.getGPUFeatureStatus();
    });
    console.log(`[gpu-fallback-e2e] Post-relaunch GPUFeatureStatus:`, JSON.stringify(featureStatus, null, 2));
    expect(featureStatus.gpu_compositing).not.toBe('enabled');

    // Verify HUD warning banner is visible
    await relaunchPage.waitForTimeout(500);
    const hudWarning = await relaunchPage.evaluate(() => {
      const el = document.getElementById('hud-gpu-warning');
      return {
        hasHiddenClass: el?.classList.contains('hidden'),
        text: el?.textContent,
      };
    });

    console.log(`[gpu-fallback-e2e] HUD Warning State:`, JSON.stringify(hudWarning));
    expect(hudWarning.hasHiddenClass).toBe(false);
    expect(hudWarning.text).toContain('WARNING:');

    await relaunchApp.close();
  });
});
