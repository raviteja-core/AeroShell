import { test, expect, _electron as electron } from '@playwright/test';
import * as path from 'node:path';

import * as fs from 'node:fs';

import * as os from 'node:os';

const mainEntry = fs.existsSync(path.resolve(process.cwd(), 'dist-test', 'main', 'index.js'))
  ? path.resolve(process.cwd(), 'dist-test', 'main', 'index.js')
  : path.resolve(process.cwd(), 'dist', 'main', 'index.js');

test('electron app launches and displays window', async () => {
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroshell-smoke-'));
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AEROSHELL_TEST_SOFTWARE_GL: '1',
      AEROSHELL_TEST_USER_DATA: tempUserData,
    },
  });

  const window = await app.firstWindow();
  expect(window).toBeDefined();

  // Verify window is active
  const isClosed = window.isClosed();
  expect(isClosed).toBe(false);

  await app.close();
  try {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  } catch {}
});
