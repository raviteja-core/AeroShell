import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test.describe('IPC Layer, Preload Contract & Security Gates (E2E)', () => {
  let app: ElectronApplication;
  let page: Page;
  let hostilePage: Page | null = null;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST_SOFTWARE_GL: '1',
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_CREATE_HOSTILE_WINDOW: '1',
      },
    });

    // Wait for the authoritative main window
    page = await app.firstWindow();
    await page.waitForURL(/^aeroshell-app:\/\/app\//, { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Acquire hostile window (about:blank) created in test build
    const windows = app.windows();
    hostilePage = windows.find((w) => w !== page) ?? null;
  });

  test.afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  test('Preload contract: window.aeroPlatform exposed keys match allowlist exactly', async () => {
    const keys = await page.evaluate(() => {
      // @ts-expect-error aeroPlatform untyped in global test context
      return Object.keys(window.aeroPlatform || {}).sort();
    });

    expect(keys).toEqual(['captureHeapSnapshot', 'getTelemetry', 'onMemoryPressure', 'onWindowState']);
  });

  test('Preload isolation: Node primitives are strictly undefined in renderer', async () => {
    const primitives = await page.evaluate(() => {
      return {
        requireType: typeof (window as unknown as { require?: unknown }).require,
        processType: typeof (window as unknown as { process?: unknown }).process,
        ipcRendererType: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
      };
    });

    expect(primitives.requireType).toBe('undefined');
    expect(primitives.processType).toBe('undefined');
    expect(primitives.ipcRendererType).toBe('undefined');
  });

  test('Preload isolation: Function constructor evaluation cannot access Node process (CSP blocked)', async () => {
    const evalResult = await page.evaluate(() => {
      try {
        // @ts-expect-error aeroPlatform untyped in global test context
        const fn = window.aeroPlatform.getTelemetry.constructor('return typeof process');
        return fn();
      } catch (err: unknown) {
        return (err as Error).message;
      }
    });

    // Under our strict CSP ('unsafe-eval' absent), new Function() is blocked by Chromium
    expect(evalResult).toMatch(/eval|unsafe-eval|content security policy|undefined/i);
  });

  test('IPC getTelemetry: returns valid schema with mapped mainProcessVramUsageMB and physical RAM', async () => {
    const telemetry = await page.evaluate(async () => {
      // @ts-expect-error aeroPlatform untyped in global test context
      return await window.aeroPlatform.getTelemetry();
    });

    expect(telemetry).toBeDefined();
    expect(Array.isArray(telemetry.gpus)).toBe(true);
    expect(telemetry.gpus.length).toBeGreaterThan(0);

    const primaryGpu = telemetry.gpus[0];
    expect(typeof primaryGpu.name).toBe('string');
    expect(typeof primaryGpu.dedicatedVramMB).toBe('number');
    // DEV-012 mapping check
    if (primaryGpu.mainProcessVramUsageMB !== undefined) {
      expect(typeof primaryGpu.mainProcessVramUsageMB).toBe('number');
    }

    expect(typeof telemetry.system.totalPhysMB).toBe('number');
    expect(telemetry.system.totalPhysMB).toBeGreaterThan(0);
    expect(typeof telemetry.system.availPhysMB).toBe('number');
    expect(telemetry.system.availPhysMB).toBeGreaterThan(0);

    expect(typeof telemetry.v8.usedHeapMB).toBe('number');
    expect(telemetry.v8.usedHeapMB).toBeGreaterThan(0);
  });

  test('IPC captureHeapSnapshot: streams CDP chunks to file starting with {"snapshot" and detaches debugger', async () => {
    const res = await page.evaluate(async () => {
      // @ts-expect-error aeroPlatform untyped in global test context
      return await window.aeroPlatform.captureHeapSnapshot('e2e_verify');
    });

    expect(res).toBeDefined();
    expect(typeof res.file).toBe('string');
    expect(res.file).toContain('e2e_verify');
    expect(fs.existsSync(res.file)).toBe(true);

    // Verify snapshot file begins with {"snapshot"
    const fileSnippet = fs.readFileSync(res.file, 'utf8').slice(0, 100);
    expect(fileSnippet.trimStart().startsWith('{"snapshot"')).toBe(true);

    // Verify webContents debugger is detached in finally
    const isAttached = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]?.webContents.debugger.isAttached() ?? false;
    });
    expect(isAttached).toBe(false);

    // Clean up created snapshot
    try {
      fs.unlinkSync(res.file);
    } catch {}
  });

  test('IPC Security: Hostile frame (about:blank) has aeroPlatform object but is rejected by assertTrusted', async () => {
    expect(hostilePage).not.toBeNull();

    // Verify preload executed and exposed window.aeroPlatform on hostile page
    const hasBridge = await hostilePage!.evaluate(() => {
      return typeof (window as unknown as { aeroPlatform?: unknown }).aeroPlatform === 'object';
    });
    expect(hasBridge).toBe(true);

    // Assert that invocation rejects with assertTrusted error
    const result = await hostilePage!.evaluate(async () => {
      try {
        // @ts-expect-error aeroPlatform untyped in global test context
        await window.aeroPlatform.getTelemetry();
        return 'SUCCESS_UNEXPECTED';
      } catch (err: unknown) {
        return (err as Error).message;
      }
    });

    expect(result).toMatch(/IPC rejected: (unauthorized sender frame|untrusted origin)/i);
  });

  test('IPC Resilience: Calling getTelemetry() succeeds seamlessly after page.reload()', async () => {
    await page.reload({ waitUntil: 'networkidle' });

    const telemetry = await page.evaluate(async () => {
      // @ts-expect-error aeroPlatform untyped in global test context
      return await window.aeroPlatform.getTelemetry();
    });

    expect(telemetry).toBeDefined();
    expect(telemetry.gpus.length).toBeGreaterThan(0);
  });

  test('Navigation Gate: External navigation to untrusted URL is blocked while in-origin navigation succeeds', async () => {
    // 1. In-origin navigation to aeroshell-app://app/index.html succeeds
    await page.goto('aeroshell-app://app/index.html');
    await page.waitForLoadState('networkidle');
    expect(page.url()).toMatch(/^aeroshell-app:\/\/app\/index\.html/);

    // 2. External navigation attempt to untrusted URL is blocked by will-navigate / will-frame-navigate
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'https://evil.com/hack';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    await page.waitForTimeout(300);
    // Page remains on authoritative standard origin
    expect(page.url()).toMatch(/^aeroshell-app:\/\/app\//);
  });




  test('Window Open Gate: Allowlisted HTTPS domain invokes shell.openExternal; untrusted domain does not; both return action deny', async () => {
    const initialWindowCount = app.windows().length;

    // Stub shell.openExternal in Electron main process
    await app.evaluate(({ shell }) => {
      const recorded: string[] = [];
      shell.openExternal = async (url: string) => {
        recorded.push(url);
      };
      (globalThis as unknown as { __openExternalCalls?: string[] }).__openExternalCalls = recorded;
    });

    // Trigger window.open on allowlisted HTTPS domain
    await page.evaluate(() => {
      window.open('https://www.autodesk.com/support');
    });
    await page.waitForTimeout(150);

    // Trigger window.open on non-allowlisted domain
    await page.evaluate(() => {
      window.open('https://evil.com/phish');
    });
    await page.waitForTimeout(150);

    const recorded = await app.evaluate(() => {
      return (globalThis as unknown as { __openExternalCalls?: string[] }).__openExternalCalls || [];
    });

    // Only allowlisted domain was passed to system browser
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBe('https://www.autodesk.com/support');

    // In both cases, action: 'deny' was enforced and no new BrowserWindow was created
    expect(app.windows().length).toBe(initialWindowCount);
  });

});

