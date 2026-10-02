import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test.describe('Real Memory Pressure Pipeline & Watchdog E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let tempUserData: string;

  test.beforeAll(async () => {
    tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroshell-watchdog-e2e-'));
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_FORCE_RAM_PRESSURE: '1', // Test-only override setting impossible RAM floor
        AEROSHELL_TEST_USER_DATA: tempUserData,
      },
    });

    page = await app.firstWindow();
    await page.waitForURL(/^aeroshell-app:\/\/app\//, { timeout: 10000 });
    await page.waitForLoadState('networkidle');
  });

  test.afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (tempUserData) {
      try {
        fs.rmSync(tempUserData, { recursive: true, force: true });
      } catch {}
    }
  });

  test('Impossible RAM floor triggers WARN through real pipeline, lifting override restores NORMAL', async () => {
    // 1. Wait for watchdog tick (runs initially at t=0 then every 2.5s)
    const containerLocator = page.locator('#viewport-container');
    const pressureBadge = page.locator('#hud-pressure');

    // Assert WARN reaches renderer: CSS class .pressure-warn
    await expect(containerLocator).toHaveClass(/pressure-warn/, { timeout: 8000 });
    await expect(pressureBadge).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(pressureBadge).toContainText('PRESSURE: WARN');

    const warnRatio = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport;
      return vp?.getMetrics().pixelRatio;
    });
    // With DPR=1: WARN = 0.75; with DPR>1: WARN = 1.0
    expect(warnRatio).toBeLessThanOrEqual(1);

    // 2. Lift the test override in the running Electron main process and step through hysteresis
    await app.evaluate(async () => {
      delete process.env.AEROSHELL_TEST_FORCE_RAM_PRESSURE;
      const watchdog = (global as any).__watchdog;
      if (watchdog) {
        for (let i = 0; i < 4; i++) {
          await watchdog.tick();
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    });

    // 3. Wait for watchdog to observe healthy ticks and de-escalate through 3-tick hysteresis
    await expect(containerLocator).not.toHaveClass(/pressure-warn/, { timeout: 15000 });
    await expect(pressureBadge).toHaveClass(/hidden/, { timeout: 5000 });

    const restoredRatio = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport;
      return vp?.getMetrics().pixelRatio;
    });
    const expectedBaseRatio = await page.evaluate(() => Math.min(window.devicePixelRatio || 1, 2));
    expect(restoredRatio).toBe(expectedBaseRatio);
  });

  test('Watchdog timing & CPU: asserts per-tick wall time p95 < 25 ms, measures CPU with watchdog on vs off', async () => {
    // 1. Execute consecutive ticks and measure per-tick wall times via performance.now
    const tickStats = await app.evaluate(async () => {
      const watchdog = (global as any).__watchdog;
      if (!watchdog) return null;

      // Run 5 explicit ticks to ensure robust timing population
      for (let i = 0; i < 5; i++) {
        await watchdog.tick();
        await new Promise((r) => setTimeout(r, 100));
      }

      return watchdog.getTickMetrics();
    });

    expect(tickStats).toBeDefined();
    console.log(`[watchdog-timing] Per-tick wall time metrics: p50=${tickStats.p50}ms, p95=${tickStats.p95}ms, samples=${tickStats.samples.length}`);
    // CI assertion on tick time: p95 must be < 25 ms (typically 0.2 - 2.5 ms)
    expect(tickStats.p95).toBeLessThan(25);

    // 2. Measure process.cpuUsage() delta over 3 runs each with watchdog on vs off
    const cpuComparison = await app.evaluate(async () => {
      const watchdog = (global as any).__watchdog;
      const measureCpu = async (durationMs: number) => {
        const start = process.cpuUsage();
        await new Promise((r) => setTimeout(r, durationMs));
        const diff = process.cpuUsage(start);
        // Returns percentage of CPU core used over interval
        return ((diff.user + diff.system) / (durationMs * 1000)) * 100;
      };

      // 3 runs with Watchdog ON
      const onSamples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const pct = await measureCpu(2000);
        onSamples.push(Number(pct.toFixed(3)));
      }

      // Stop watchdog
      if (watchdog) {
        watchdog.stop();
      }

      // 3 runs with Watchdog OFF
      const offSamples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const pct = await measureCpu(2000);
        offSamples.push(Number(pct.toFixed(3)));
      }

      return {
        onSamples,
        offSamples,
        avgOn: Number((onSamples.reduce((a, b) => a + b, 0) / onSamples.length).toFixed(3)),
        avgOff: Number((offSamples.reduce((a, b) => a + b, 0) / offSamples.length).toFixed(3)),
      };
    });

    console.log(`[watchdog-cpu] Watchdog ON cpuUsage (%): ${JSON.stringify(cpuComparison.onSamples)} (avg: ${cpuComparison.avgOn}%)`);
    console.log(`[watchdog-cpu] Watchdog OFF cpuUsage (%): ${JSON.stringify(cpuComparison.offSamples)} (avg: ${cpuComparison.avgOff}%)`);

    expect(cpuComparison.avgOn).toBeDefined();
    expect(cpuComparison.avgOff).toBeDefined();
  });
});
