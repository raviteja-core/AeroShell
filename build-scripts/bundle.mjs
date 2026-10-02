import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function buildAll() {
  const isDev = process.argv.includes('--dev');
  const isTest = process.argv.includes('--test') || process.env.NODE_ENV === 'test';

  const outBase = isTest ? path.join(rootDir, 'dist-test') : path.join(rootDir, 'dist');

  // Clean output directory
  fs.rmSync(outBase, { recursive: true, force: true });
  fs.mkdirSync(path.join(outBase, 'main'), { recursive: true });
  fs.mkdirSync(path.join(outBase, 'preload'), { recursive: true });
  fs.mkdirSync(path.join(outBase, 'renderer'), { recursive: true });

  const defines = isTest
    ? {}
    : {
        'process.env.AEROSHELL_TEST': 'undefined',
        'process.env.AEROSHELL_TEST_SOFTWARE_GL': 'undefined',
        'process.env.AEROSHELL_TEST_MODEL_ROOT': 'undefined',
        'process.env.AEROSHELL_TEST_CREATE_HOSTILE_WINDOW': 'undefined',
        'process.env.AEROSHELL_TEST_FORCE_RAM_PRESSURE': 'undefined',
      };

  console.log(`[bundle] Bundling Main process (out: ${path.basename(outBase)}, mode: ${isTest ? 'TEST' : isDev ? 'DEV' : 'PRODUCTION'})...`);
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'main', 'index.ts')],
    outfile: path.join(outBase, 'main', 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', '*.node'],
    sourcemap: isDev || isTest ? 'inline' : true,
    minify: !isDev && !isTest,
    define: defines,
    logLevel: 'info',
  });

  console.log('[bundle] Bundling Preload script...');
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'preload', 'index.ts')],
    outfile: path.join(outBase, 'preload', 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
    sourcemap: isDev || isTest ? 'inline' : true,
    minify: !isDev && !isTest,
    logLevel: 'info',
  });

  // Mirror to main/preload.js for path compatibility with path.join(__dirname, 'preload.js')
  fs.copyFileSync(
    path.join(outBase, 'preload', 'index.js'),
    path.join(outBase, 'main', 'preload.js')
  );

  console.log('[bundle] Bundling Renderer scripts...');
  const rendererResult = await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'renderer', 'main.ts')],
    outfile: path.join(outBase, 'renderer', 'main.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome152',
    format: 'iife',
    sourcemap: isDev || isTest ? 'inline' : true,
    minify: !isDev && !isTest,
    metafile: true,
    logLevel: 'info',
  });

  // Bundle background worker
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'renderer', 'parse-worker.ts')],
    outfile: path.join(outBase, 'renderer', 'parse-worker.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome152',
    format: 'iife',
    sourcemap: isDev || isTest ? 'inline' : true,
    minify: !isDev && !isTest,
    logLevel: 'info',
  });

  console.log('[bundle] Copying static renderer assets...');
  if (fs.existsSync(path.join(rootDir, 'src', 'renderer', 'index.html'))) {
    fs.copyFileSync(
      path.join(rootDir, 'src', 'renderer', 'index.html'),
      path.join(outBase, 'renderer', 'index.html')
    );
  }
  if (fs.existsSync(path.join(rootDir, 'src', 'renderer', 'styles.css'))) {
    fs.copyFileSync(
      path.join(rootDir, 'src', 'renderer', 'styles.css'),
      path.join(outBase, 'renderer', 'styles.css')
    );
  }
  if (fs.existsSync(path.join(rootDir, 'src', 'renderer', 'crash-error.html'))) {
    fs.copyFileSync(
      path.join(rootDir, 'src', 'renderer', 'crash-error.html'),
      path.join(outBase, 'renderer', 'crash-error.html')
    );
  }

  // Measure renderer bundle size
  const mainJsStats = fs.statSync(path.join(outBase, 'renderer', 'main.js'));
  console.log(`[bundle] Renderer bundle size (main.js): ${(mainJsStats.size / 1024).toFixed(2)} KB`);

  // In production builds, verify that no file contains AEROSHELL_TEST
  if (!isTest) {
    console.log('[bundle] Verifying zero test flags in production dist...');
    function scanDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.isFile() && !entry.name.endsWith('.map')) {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('AEROSHELL_TEST')) {
            throw new Error(`Production build leakage: ${full} contains AEROSHELL_TEST`);
          }
        }
      }
    }
    scanDir(outBase);
    console.log('[bundle] Production integrity check passed: 0 test flags found.');
  }

  console.log('[bundle] Build completed successfully.');
}

buildAll().catch((err) => {
  console.error('[bundle] Error building bundles:', err);
  process.exit(1);
});
