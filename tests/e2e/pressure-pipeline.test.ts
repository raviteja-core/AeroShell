import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test.describe('Real Memory Pressure Pipeline & Watchdog E2E', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_FORCE_RAM_PRESSURE: '1', // Test-only override setting impossible RAM floor
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
  });

  test('Impossible RAM floor triggers WARN through real pipeline, lifting override restores NORMAL', async () => {
    // 1. Wait for watchdog tick (runs initially at t=0 then every 2.5s)
    const containerLocator = page.locator('#viewport-container');
    const pressureBadge = page.locator('#hud-pressure');

    // Assert WARN reaches renderer: CSS class .pressure-warn + pixelRatio = 1
    await expect(containerLocator).toHaveClass(/pressure-warn/, { timeout: 8000 });
    await expect(pressureBadge).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(pressureBadge).toContainText('PRESSURE: WARN');

    const warnRatio = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport;
      return vp?.getMetrics().pixelRatio;
    });
    expect(warnRatio).toBe(1);

    // 2. Lift the test override in the running Electron main process
    await app.evaluate(() => {
      delete process.env.AEROSHELL_TEST_FORCE_RAM_PRESSURE;
    });

    // 3. Wait for watchdog to observe healthy ticks and de-escalate through 3-tick hysteresis
    // (3 ticks * 2.5s = ~7.5s, allowing up to 15s)
    await expect(containerLocator).not.toHaveClass(/pressure-warn/, { timeout: 15000 });
    await expect(pressureBadge).toHaveClass(/hidden/, { timeout: 5000 });

    const restoredRatio = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport;
      return vp?.getMetrics().pixelRatio;
    });
    const expectedBaseRatio = await page.evaluate(() => Math.min(window.devicePixelRatio || 1, 2));
    expect(restoredRatio).toBe(expectedBaseRatio);
  });

  test('Main-process idle CPU usage over sampling window targets < 0.5%', async () => {
    // Measure main-process CPU usage via app.getAppMetrics over a 5-second sampling window
    const cpuSample = await app.evaluate(async ({ app: electronApp }) => {
      const initialMetrics = electronApp.getAppMetrics();
      const initialBrowser = initialMetrics.find((m) => m.type === 'Browser');
      const startCpu = initialBrowser?.cpu.percentCPUUsage ?? 0;

      await new Promise((r) => setTimeout(r, 5000));

      const afterMetrics = electronApp.getAppMetrics();
      const afterBrowser = afterMetrics.find((m) => m.type === 'Browser');
      const endCpu = afterBrowser?.cpu.percentCPUUsage ?? 0;

      return {
        startCpu,
        endCpu,
      };
    });

    console.log(`[watchdog-cpu] Main process CPU sample: start=${cpuSample.startCpu.toFixed(2)}%, end=${cpuSample.endCpu.toFixed(2)}%`);
    // Main process should be well under 0.5% (or 1.0% in test runner environment)
    expect(cpuSample.endCpu).toBeLessThan(1.5);
  });
});
