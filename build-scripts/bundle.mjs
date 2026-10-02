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

  const defines = isTest
    ? {}
    : {
        'process.env.AEROSHELL_TEST': 'undefined',
        'process.env.AEROSHELL_TEST_SOFTWARE_GL': 'undefined',
        'process.env.AEROSHELL_TEST_MODEL_ROOT': 'undefined',
        'process.env.AEROSHELL_TEST_CREATE_HOSTILE_WINDOW': 'undefined',
      };

  console.log(`[bundle] Bundling Main process (mode: ${isTest ? 'TEST' : isDev ? 'DEV' : 'PRODUCTION'})...`);
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'main', 'index.ts')],
    outfile: path.join(rootDir, 'dist', 'main', 'index.js'),
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
  const preloadBuild = await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'preload', 'index.ts')],
    outfile: path.join(rootDir, 'dist', 'preload', 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
    sourcemap: isDev ? 'inline' : true,
    minify: !isDev,
    logLevel: 'info',
  });

  // Mirror to dist/main/preload.js for path compatibility with __dirname/preload.js
  fs.copyFileSync(
    path.join(rootDir, 'dist', 'preload', 'index.js'),
    path.join(rootDir, 'dist', 'main', 'preload.js')
  );

  console.log('[bundle] Bundling Renderer script...');
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'renderer', 'main.ts')],
    outfile: path.join(rootDir, 'dist', 'renderer', 'main.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome152',
    format: 'iife',
    sourcemap: isDev ? 'inline' : true,
    minify: !isDev,
    logLevel: 'info',
  });

  console.log('[bundle] Copying static renderer assets...');
  if (fs.existsSync(path.join(rootDir, 'src', 'renderer', 'index.html'))) {
    fs.copyFileSync(
      path.join(rootDir, 'src', 'renderer', 'index.html'),
      path.join(rootDir, 'dist', 'renderer', 'index.html')
    );
  }
  if (fs.existsSync(path.join(rootDir, 'src', 'renderer', 'styles.css'))) {
    fs.copyFileSync(
      path.join(rootDir, 'src', 'renderer', 'styles.css'),
      path.join(rootDir, 'dist', 'renderer', 'styles.css')
    );
  }

  console.log('[bundle] Build completed successfully.');
}

buildAll().catch((err) => {
  console.error('[bundle] Error building bundles:', err);
  process.exit(1);
});
