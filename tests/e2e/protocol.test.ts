import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const mainEntry = path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test.describe('Protocol Handlers and Security Boundaries (E2E)', () => {
  let app: ElectronApplication;
  let page: Page;
  let testDir: string;
  let fixtureDir: string;

  test.beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `aeroshell_e2e_${Date.now()}`);
    fixtureDir = path.join(testDir, 'Models');
    fs.mkdirSync(fixtureDir, { recursive: true });

    // Generate test model binary (256 bytes)
    const buf = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) {
      buf[i] = i % 256;
    }
    fs.writeFileSync(path.join(fixtureDir, 'cube.glb'), buf);

    // Generate disallowed extension file inside Models
    fs.writeFileSync(path.join(fixtureDir, 'malicious.exe'), 'MZ_HEADER');
    fs.writeFileSync(path.join(fixtureDir, 'notes.txt'), 'Forbidden text');

    // Create outside file
    const outsideDir = path.join(testDir, 'Outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.glb'), 'SECRET');

    // Launch Electron application with test environment variables
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AEROSHELL_TEST_SOFTWARE_GL: '1',
        AEROSHELL_TEST: '1',
        AEROSHELL_TEST_MODEL_ROOT: fixtureDir,
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
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('UI is served from aeroshell-app://app and runs renderer script', async () => {
    const url = page.url();
    expect(url).toMatch(/^aeroshell-app:\/\/app\//);

    // Verify page script executed via safe textContent
    const gpuEl = page.locator('#gpu');
    await expect(gpuEl).toHaveText('GPU: Initializing...');
  });

  test('Page is cross-origin isolated (COOP + COEP headers active)', async () => {
    const isIsolated = await page.evaluate(() => window.crossOriginIsolated);
    expect(isIsolated).toBe(true);
  });

  test('App protocol serves hardened CSP header without unsafe-inline or unsafe-eval', async () => {
    // Reload cleanly to capture response headers directly
    const response = await page.reload({ waitUntil: 'networkidle' });
    expect(response).not.toBeNull();
    const headers = response!.headers();
    const csp = headers['content-security-policy'];

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  test('Asset protocol supports Range requests returning HTTP 206 and exact byte slices', async () => {
    const res = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/cube.glb', {
        headers: { Range: 'bytes=0-99' },
      });
      const data = await resp.arrayBuffer();
      return {
        status: resp.status,
        byteLength: data.byteLength,
        contentRange: resp.headers.get('content-range'),
        acceptRanges: resp.headers.get('accept-ranges'),
        corsOrigin: resp.headers.get('access-control-allow-origin'),
        corp: resp.headers.get('cross-origin-resource-policy'),
        contentType: resp.headers.get('content-type'),
      };
    });

    expect(res.status).toBe(206);
    expect(res.byteLength).toBe(100);
    expect(res.contentRange).toBe('bytes 0-99/256');
    expect(res.acceptRanges).toBe('bytes');
    expect(res.corsOrigin).toBe('aeroshell-app://app');
    expect(res.corp).toBe('same-origin');
    expect(res.contentType).toBe('model/gltf-binary');
  });

  test('Asset protocol returns 416 on out-of-bounds Range request', async () => {
    const status = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/cube.glb', {
        headers: { Range: 'bytes=500-600' },
      });
      return resp.status;
    });
    expect(status).toBe(416);
  });

  test('Asset protocol blocks path traversal attempts returning 403 or 404', async () => {
    const status = await page.evaluate(async () => {
      try {
        const resp = await fetch('aeroshell-asset://models/..%2fOutside%2fsecret.glb');
        return resp.status;
      } catch {
        return 403;
      }
    });
    expect([403, 404]).toContain(status);
  });

  test('Asset protocol rejects disallowed extensions (.exe, .txt) with 403 Forbidden', async () => {
    const exeStatus = await page.evaluate(async () => {
      try {
        const resp = await fetch('aeroshell-asset://models/malicious.exe');
        return resp.status;
      } catch {
        return 403;
      }
    });
    expect(exeStatus).toBe(403);

    const txtStatus = await page.evaluate(async () => {
      try {
        const resp = await fetch('aeroshell-asset://models/notes.txt');
        return resp.status;
      } catch {
        return 403;
      }
    });
    expect(txtStatus).toBe(403);
  });
});
