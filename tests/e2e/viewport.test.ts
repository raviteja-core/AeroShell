import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test.describe('WebGL Viewport, HUD, Context Loss & GPU Truth Check (E2E)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    // Launch Electron in normal hardware acceleration mode
    const modelRoot = path.resolve(process.cwd(), 'assets', 'models');
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_MODEL_ROOT: modelRoot,
      },
    });

    page = await app.firstWindow();

    // Register strict CSP violation listener before any page scripts execute
    await page.addInitScript(() => {
      const recorded: Array<{ directive: string; blockedURI: string }> = [];
      (window as unknown as { __cspViolations: Array<{ directive: string; blockedURI: string }> }).__cspViolations = recorded;
      const handler = (e: Event) => {
        const evt = e as SecurityPolicyViolationEvent;
        recorded.push({
          directive: evt.effectiveDirective,
          blockedURI: evt.blockedURI,
        });
      };
      window.addEventListener('securitypolicyviolation', handler);
      document.addEventListener('securitypolicyviolation', handler);
    });

    await page.waitForURL(/^aeroshell-app:\/\/app\//, { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      const recorded: Array<{ directive: string; blockedURI: string }> = [];
      (window as unknown as { __cspViolations: Array<{ directive: string; blockedURI: string }> }).__cspViolations = recorded;
      const handler = (e: Event) => {
        const evt = e as SecurityPolicyViolationEvent;
        recorded.push({
          directive: evt.effectiveDirective,
          blockedURI: evt.blockedURI,
        });
      };
      window.addEventListener('securitypolicyviolation', handler);
      document.addEventListener('securitypolicyviolation', handler);
    });
  });

  test.afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  test('HUD renders FPS, ms frame times (p50/p95), VRAM total, and VRAM budget (OS)', async () => {
    // Wait for render loop to produce initial frames
    await page.waitForTimeout(500);

    const hudData = await page.evaluate(() => {
      return {
        fps: document.getElementById('hud-fps')?.textContent,
        frameTime: document.getElementById('hud-frame-time')?.textContent,
        metrics: document.getElementById('hud-metrics')?.textContent,
        vramTotal: document.getElementById('hud-vram-total')?.textContent,
        vramBudget: document.getElementById('hud-vram-budget')?.textContent,
        vramUsage: document.getElementById('hud-vram-usage')?.textContent,
        rawHud: document.getElementById('hud')?.textContent,
      };
    });

    expect(hudData.fps).toMatch(/FPS:\s*\d+/);
    expect(hudData.frameTime).toMatch(/Frame time:\s*[\d.]+\s*ms\s*\(p50\)\s*\/\s*[\d.]+\s*ms\s*\(p95\)/);
    expect(hudData.metrics).toMatch(/Draw calls:\s*\d+\s*\|\s*Triangles:\s*\d+\s*\|\s*Geometries:\s*\d+\s*\|\s*Textures:\s*\d+/);
    expect(hudData.vramTotal).toMatch(/VRAM total:\s*\d+\s*MB/);
    expect(hudData.vramBudget).toMatch(/VRAM budget \(OS\):\s*([\d.]+\s*MB|N\/A)/);
    expect(hudData.vramUsage).toMatch(/VRAM used \(adapter\):\s*(\d+\s*MB|n\/a)/);

    // DEV-012: HUD must NEVER display main-process VRAM usage
    expect(hudData.rawHud).not.toContain('mainProcessVramUsageMB');
    expect(hudData.rawHud).not.toContain('vramUsageMB');
  });

  test('Off-thread worker executes and transfers ArrayBuffer under COEP', async () => {
    await page.waitForFunction(() => (window as unknown as { __workerOk?: boolean }).__workerOk === true, {
      timeout: 5000,
    });

    const isWorkerOk = await page.evaluate(() => {
      return (window as unknown as { __workerOk?: boolean }).__workerOk;
    });
    expect(isWorkerOk).toBe(true);
  });

  test('GPU truth check: normal physical machine run does NOT show software-GL warning', async () => {
    await page.waitForTimeout(500);

    const warningState = await page.evaluate(() => {
      const el = document.getElementById('hud-gpu-warning');
      return {
        isHidden: el?.classList.contains('hidden'),
        text: el?.textContent,
      };
    });

    expect(warningState.isHidden).toBe(true);
    expect(warningState.text).toBe('');
  });

  test('Asset pipeline: load cube.glb via custom protocol and verify scene geometry', async () => {
    const loadSuccess = await page.evaluate(async () => {
      const vp = (window as unknown as { __cadViewport?: { loadModelFromAsset: (u: string) => Promise<void> } }).__cadViewport;
      if (!vp) return false;
      await vp.loadModelFromAsset('aeroshell-asset://models/cube.glb');
      return true;
    });

    expect(loadSuccess).toBe(true);

    const metrics = await page.evaluate(() => {
      return (window as unknown as { __cadViewport?: { getMetrics: () => { geometries: number; triangles: number } } }).__cadViewport?.getMetrics();
    });

    expect(metrics).toBeDefined();
    expect(metrics!.geometries).toBeGreaterThan(0);
    expect(metrics!.triangles).toBeGreaterThan(0);
  });

  test('Context loss & recovery: loseContext() pauses loop and displays banner; restoreContext() resumes loop and restores geometries', async () => {
    // 1. Verify WEBGL_lose_context support
    const hasExtension = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getGlContext: () => WebGLRenderingContext } }).__cadViewport;
      if (!vp) return false;
      const gl = vp.getGlContext();
      return !!gl.getExtension('WEBGL_lose_context');
    });

    if (!hasExtension) {
      test.skip(true, 'WEBGL_lose_context extension is not available on this platform/GPU');
      return;
    }

    // 2. Trigger artificial WebGL context loss
    await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getGlContext: () => WebGLRenderingContext } }).__cadViewport!;
      const gl = vp.getGlContext();
      const ext = gl.getExtension('WEBGL_lose_context');
      (window as unknown as { __loseContextExt?: unknown }).__loseContextExt = ext;
      (ext as unknown as { loseContext: () => void }).loseContext();
    });

    await page.waitForTimeout(100);

    // Assert context-loss banner is visible
    const bannerState = await page.evaluate(() => {
      const banner = document.getElementById('context-loss-banner');
      return {
        isHidden: banner?.classList.contains('hidden'),
        text: banner?.textContent,
      };
    });

    expect(bannerState.isHidden).toBe(false);
    expect(bannerState.text).toContain('WebGL context lost');

    // Assert render loop is paused (frame counter does not advance)
    const frameAtLoss1 = await page.evaluate(() => {
      return (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport?.getMetrics().frame;
    });
    await page.waitForTimeout(200);
    const frameAtLoss2 = await page.evaluate(() => {
      return (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport?.getMetrics().frame;
    });
    expect(frameAtLoss1).toBe(frameAtLoss2);

    // 3. Restore WebGL context manually
    await page.evaluate(() => {
      const ext = (window as unknown as { __loseContextExt?: { restoreContext: () => void } }).__loseContextExt;
      ext?.restoreContext();
    });

    await page.waitForTimeout(200);

    // Assert banner is hidden
    const bannerRestored = await page.evaluate(() => {
      const banner = document.getElementById('context-loss-banner');
      return banner?.classList.contains('hidden');
    });
    expect(bannerRestored).toBe(true);

    // Assert render loop resumed (frame counter advances) and geometries restored
    await page.waitForTimeout(100);
    const frameAfterRestore1 = await page.evaluate(() => {
      return (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport?.getMetrics().frame;
    });
    await page.waitForTimeout(200);
    const frameAfterRestore2 = await page.evaluate(() => {
      return (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number; geometries: number } } }).__cadViewport?.getMetrics();
    });

    expect(frameAfterRestore2!.frame).toBeGreaterThan(frameAfterRestore1!);
    expect(frameAfterRestore2!.geometries).toBeGreaterThan(0);
  });

  test('Memory pressure response: WARN lowers pixel ratio; CRITICAL lowers ratio and invokes cache eviction hook', async () => {
    // Initial pixel ratio
    const initialRatio = await page.evaluate(() => {
      return (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport?.getMetrics().pixelRatio;
    });
    expect(initialRatio).toBeGreaterThanOrEqual(1);

    // 1. Emit synthetic WARN memory pressure from main process
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('aeroshell:memory-pressure', {
        severity: 'WARN',
        reasons: ['High working set'],
        availPhysMB: 450,
        vramUsagePct: 80,
      });
    });

    await page.waitForTimeout(100);

    const warnState = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport;
      const container = document.getElementById('viewport-container');
      const badge = document.getElementById('hud-pressure');
      return {
        pixelRatio: vp?.getMetrics().pixelRatio,
        hasContainerWarn: container?.classList.contains('pressure-warn'),
        badgeText: badge?.textContent,
      };
    });

    expect(warnState.pixelRatio).toBe(1);
    expect(warnState.hasContainerWarn).toBe(true);
    expect(warnState.badgeText).toContain('PRESSURE: WARN');

    // 2. Emit synthetic CRITICAL memory pressure from main process
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('aeroshell:memory-pressure', {
        severity: 'CRITICAL',
        reasons: ['Physical memory exhaustion'],
        availPhysMB: 120,
        vramUsagePct: 95,
      });
    });

    await page.waitForTimeout(100);

    const criticalState = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { pixelRatio: number } } }).__cadViewport;
      const container = document.getElementById('viewport-container');
      const badge = document.getElementById('hud-pressure');
      const evictCount = (window as unknown as { __evictCount?: number }).__evictCount;
      return {
        pixelRatio: vp?.getMetrics().pixelRatio,
        hasContainerCritical: container?.classList.contains('pressure-critical'),
        badgeText: badge?.textContent,
        evictCount,
      };
    });

    expect(criticalState.pixelRatio).toBe(1);
    expect(criticalState.hasContainerCritical).toBe(true);
    expect(criticalState.badgeText).toContain('PRESSURE: CRITICAL');
    expect(criticalState.evictCount).toBeGreaterThan(0);
  });

  test('Strict CSP Cleanliness: zero SecurityPolicyViolation events across entire lifecycle', async () => {
    const violations = await page.evaluate(() => {
      return (window as unknown as { __cspViolations?: unknown[] }).__cspViolations || [];
    });

    expect(violations).toEqual([]);
  });

  test('Automated minimize pauses WebGL render loop, restore resumes frame progression', async () => {
    // 1. Initial frame progression
    const frame0 = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport;
      return vp?.getMetrics().frame ?? 0;
    });
    await page.waitForTimeout(500);
    const framePre = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport;
      return vp?.getMetrics().frame ?? 0;
    });
    expect(framePre).toBeGreaterThan(frame0);

    // 2. Minimize window via electronApp.evaluate
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.minimize();
    });

    // Wait for IPC window-state event to reach renderer
    await page.waitForTimeout(200);

    // Check visibilityState and frame delta over 1.5 seconds
    const minState = await page.evaluate(async () => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport;
      const initial = vp?.getMetrics().frame ?? 0;
      const visState = document.visibilityState;
      await new Promise((r) => setTimeout(r, 1500));
      const after = vp?.getMetrics().frame ?? 0;
      return {
        visState,
        frameDelta: after - initial,
        initial,
        after,
      };
    });

    console.log(`[minimize-test] visibilityState during minimize: "${minState.visState}", frameDelta: ${minState.frameDelta}`);
    expect(minState.frameDelta).toBe(0);

    // 3. Restore window via electronApp.evaluate
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.restore();
    });

    await page.waitForTimeout(500);

    const framePost = await page.evaluate(() => {
      const vp = (window as unknown as { __cadViewport?: { getMetrics: () => { frame: number } } }).__cadViewport;
      return vp?.getMetrics().frame ?? 0;
    });

    // Verify render loop resumed
    expect(framePost).toBeGreaterThan(minState.after);
  });

  test('CSP Positive Control: deliberate violation triggers SecurityPolicyViolation listener', async () => {
    // Deliberately violate script-src by setting script src to data: URI (allowed by network policy, blocked by CSP)
    await page.evaluate(async () => {
      try {
        const s = document.createElement('script');
        s.src = 'data:text/javascript,void 0;';
        document.head.appendChild(s);
      } catch {}
      try {
        await fetch('data:text/plain,blocked');
      } catch {}
    });

    await page.waitForTimeout(300);

    const violations = await page.evaluate(() => {
      return (window as unknown as { __cspViolations?: Array<{ directive: string; blockedURI: string }> }).__cspViolations || [];
    });

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.directive).toContain('script-src');
  });
});

test.describe('Software-GL Truth Check (AEROSHELL_TEST_SOFTWARE_GL=1)', () => {
  let swApp: ElectronApplication;
  let swPage: Page;

  test('HUD prominently displays warning when launched with software GL emulation', async () => {
    swApp = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_SOFTWARE_GL: '1',
      },
    });

    swPage = await swApp.firstWindow();
    await swPage.waitForURL(/^aeroshell-app:\/\/app\//, { timeout: 10000 });
    await swPage.waitForLoadState('networkidle');

    const warningLocator = swPage.locator('#hud-gpu-warning');
    await expect(warningLocator).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(warningLocator).toContainText('WARNING:');

    await swApp.close();
  });
});
