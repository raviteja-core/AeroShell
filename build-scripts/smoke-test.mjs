import { _electron as electron } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function runSmokeTest() {
  console.log('[smoke] Launching Electron app via Playwright _electron...');
  const app = await electron.launch({
    args: [path.join(rootDir, 'dist', 'main', 'index.js')],
    env: {
      ...process.env,
      AEROSHELL_TEST_SOFTWARE_GL: '1',
    },
  });

  console.log('[smoke] Waiting for first window...');
  const window = await app.firstWindow();
  console.log('[smoke] Window acquired. Current URL:', window.url());

  const isClosed = window.isClosed();
  if (isClosed) {
    throw new Error('Smoke test failed: window was closed prematurely');
  }

  console.log('[smoke] Closing Electron app...');
  await app.close();
  console.log('[smoke] Electron app exited cleanly. Smoke test PASSED.');
}

runSmokeTest().catch((err) => {
  console.error('[smoke] Smoke test FAILED:', err);
  process.exit(1);
});
