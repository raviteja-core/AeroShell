import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test.describe('Protocol Handlers and Security Boundaries (E2E)', () => {
  let app: ElectronApplication;
  let page: Page;
  let testDir: string;
  let fixtureDir: string;

  test.beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `aeroshell_e2e_${Date.now()}`);
    fixtureDir = path.join(testDir, 'Models');
    fs.mkdirSync(fixtureDir, { recursive: true });

    // Copy valid glTF 2.0 binary fixture
    const canonicalCube = path.resolve(process.cwd(), 'assets', 'models', 'cube.glb');
    fs.copyFileSync(canonicalCube, path.join(fixtureDir, 'cube.glb'));


    // Generate test WASM binary fixture
    fs.writeFileSync(path.join(fixtureDir, 'sample.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

    // Generate disallowed extension file inside Models
    fs.writeFileSync(path.join(fixtureDir, 'malicious.exe'), 'MZ_HEADER');
    fs.writeFileSync(path.join(fixtureDir, 'notes.txt'), 'Forbidden text');

    // Create outside file for traversal checks
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
        AEROSHELL_TEST_USER_DATA: path.join(testDir, 'userData'),
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
    const gpuEl = page.locator('#hud-gpu');
    await expect(gpuEl).toContainText('GPU:');
  });

  test('Page is cross-origin isolated (COOP + COEP headers active)', async () => {
    const isIsolated = await page.evaluate(() => window.crossOriginIsolated);
    expect(isIsolated).toBe(true);
  });

  test('App protocol serves hardened CSP header and correct MIME types for app assets', async () => {
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
    expect(headers['content-type']).toBe('text/html; charset=utf-8');

    // Verify MIME types for CSS and JS assets
    const cssResp = await page.evaluate(async () => {
      const r = await fetch('aeroshell-app://app/styles.css');
      return r.headers.get('content-type');
    });
    expect(cssResp).toBe('text/css; charset=utf-8');

    const jsResp = await page.evaluate(async () => {
      const r = await fetch('aeroshell-app://app/main.js');
      return r.headers.get('content-type');
    });
    expect(jsResp).toBe('text/javascript; charset=utf-8');
  });

  test('Asset protocol serves application/wasm for .wasm files', async () => {
    const wasmType = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/sample.wasm');
      return resp.headers.get('content-type');
    });
    expect(wasmType).toBe('application/wasm');
  });

  test('Asset protocol supports standard Range request (bytes=0-99)', async () => {
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

    const cubeSize = fs.statSync(path.join(fixtureDir, 'cube.glb')).size;

    expect(res.status).toBe(206);
    expect(res.byteLength).toBe(100);
    expect(res.contentRange).toBe(`bytes 0-99/${cubeSize}`);
    expect(res.acceptRanges).toBe('bytes');
    expect(res.corsOrigin).toBe('aeroshell-app://app');
    expect(res.corp).toBe('same-origin');
    expect(res.contentType).toBe('model/gltf-binary');
  });

  test('Asset protocol supports open-ended Range (bytes=100-)', async () => {
    const cubeSize = fs.statSync(path.join(fixtureDir, 'cube.glb')).size;
    const res = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/cube.glb', {
        headers: { Range: 'bytes=100-' },
      });
      const data = await resp.arrayBuffer();
      return {
        status: resp.status,
        byteLength: data.byteLength,
        contentRange: resp.headers.get('content-range'),
      };
    });

    expect(res.status).toBe(206);
    expect(res.byteLength).toBe(cubeSize - 100);
    expect(res.contentRange).toBe(`bytes 100-${cubeSize - 1}/${cubeSize}`);
  });

  test('Asset protocol supports suffix Range (bytes=-100)', async () => {
    const cubeSize = fs.statSync(path.join(fixtureDir, 'cube.glb')).size;
    const res = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/cube.glb', {
        headers: { Range: 'bytes=-100' },
      });
      const data = await resp.arrayBuffer();
      return {
        status: resp.status,
        byteLength: data.byteLength,
        contentRange: resp.headers.get('content-range'),
      };
    });

    expect(res.status).toBe(206);
    expect(res.byteLength).toBe(100);
    expect(res.contentRange).toBe(`bytes ${cubeSize - 100}-${cubeSize - 1}/${cubeSize}`);
  });


  test('Asset protocol rejects multi-range requests with 416 Range Not Satisfiable', async () => {
    const status = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/cube.glb', {
        headers: { Range: 'bytes=0-50,100-150' },
      });
      return resp.status;
    });
    expect(status).toBe(416);
  });

  test('Asset protocol returns 416 on out-of-bounds Range request', async () => {
    const status = await page.evaluate(async () => {
      const resp = await fetch('aeroshell-asset://models/cube.glb', {
        headers: { Range: 'bytes=9999-10000' },
      });
      return resp.status;
    });
    expect(status).toBe(416);
  });

  test('Asset protocol blocks path traversal attempts (%2e%2e%2f and %2e%2e%5c)', async () => {
    const statusSlash = await page.evaluate(async () => {
      try {
        const resp = await fetch('aeroshell-asset://models/%2e%2e%2fOutside%2fsecret.glb');
        return resp.status;
      } catch {
        return 403;
      }
    });
    expect([403, 404]).toContain(statusSlash);

    const statusBackslash = await page.evaluate(async () => {
      try {
        const resp = await fetch('aeroshell-asset://models/%2e%2e%5cOutside%5csecret.glb');
        return resp.status;
      } catch {
        return 403;
      }
    });
    expect([403, 404]).toContain(statusBackslash);
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

  test('Mid-stream abort releases file handle allowing file deletion on Windows', async () => {
    const abortFilePath = path.join(fixtureDir, 'abort_test.glb');
    const fd = fs.openSync(abortFilePath, 'w');
    fs.ftruncateSync(fd, 256 * 1024 * 1024); // 256MB instantaneous allocation
    fs.closeSync(fd);

    const receivedBytes = await page.evaluate(async () => {
      const controller = new AbortController();
      const resp = await fetch('aeroshell-asset://models/abort_test.glb', {
        signal: controller.signal,
      });
      const reader = resp.body?.getReader();
      let bytes = 0;
      if (reader) {
        const chunk = await reader.read();
        if (chunk.value) {
          bytes += chunk.value.byteLength;
        }
        controller.abort();
      }
      return bytes;
    });

    // Assert received bytes << total 256MB (e.g. received single chunk < 1MB)
    expect(receivedBytes).toBeGreaterThan(0);
    expect(receivedBytes).toBeLessThan(1024 * 1024);

    // Wait 100ms for handle closure
    await page.waitForTimeout(100);

    // Deleting the 256MB file on Windows throws EBUSY / EPERM if a handle remains locked
    expect(() => {
      fs.unlinkSync(abortFilePath);
    }).not.toThrow();
  });
});
