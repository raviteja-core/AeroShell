import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { SOAK_CONFIG, evaluateSeries, SoakReportSchema } from '../dist-test/soak/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Parse CLI args
const args = process.argv.slice(2);
function getArgValue(name, defaultValue) {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const totalCycles = parseInt(getArgValue('--cycles', String(SOAK_CONFIG.defaultCycles)), 10);
const leakType = getArgValue('--leak', 'none'); // 'none' | 'jsHeap:<kb>' | 'gpu' | 'dom'
const isQuiet = args.includes('--quiet');

export async function runSoakHarness(options = {}) {
  const cycles = options.cycles ?? totalCycles;
  const leak = options.leak ?? leakType;
  const warmup = SOAK_CONFIG.warmupCycles;

  const startTime = Date.now();
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), `aeroshell-soak-${dateStr}-`));

  const reportsDir = path.join(rootDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const leakConfig = {
    jsHeapKb: leak.startsWith('jsHeap:') ? parseInt(leak.split(':')[1], 10) : 0,
    gpu: leak === 'gpu',
    dom: leak === 'dom',
  };

  if (!options.quiet && !isQuiet) {
    console.log(`[soak] Starting Soak Harness: ${cycles} cycles (warmup: ${warmup}), leak mode: ${leak}`);
  }

  // Ensure test bundles are built
  const mainScript = path.join(rootDir, 'dist-test', 'main', 'index.js');
  if (!fs.existsSync(mainScript)) {
    throw new Error('dist-test/main/index.js not found. Run "npm run bundle:test" first.');
  }

  const app = await electron.launch({
    args: [mainScript],
    env: {
      ...process.env,
      AEROSHELL_TEST: '1',
      AEROSHELL_TEST_USER_DATA: tempUserData,
      AEROSHELL_TEST_MODEL_ROOT: path.resolve(rootDir, 'assets', 'models'),
      ...(leakConfig.jsHeapKb > 0 ? { AEROSHELL_TEST_LEAK_JS_HEAP: String(leakConfig.jsHeapKb) } : {}),
      ...(leakConfig.gpu ? { AEROSHELL_TEST_LEAK_GPU: '1' } : {}),
      ...(leakConfig.dom ? { AEROSHELL_TEST_LEAK_DOM: '1' } : {}),
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#cad-canvas');

  // Configure leak hooks in page
  await page.evaluate((cfg) => {
    if (window.__cadViewport) {
      window.__cadViewport.setTestLeakConfig(cfg);
    }
  }, leakConfig);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Memory.enable').catch(() => {});

  // Probe performance.measureUserAgentSpecificMemory
  const uaMemorySupported = await page.evaluate(async () => {
    if (typeof performance?.measureUserAgentSpecificMemory === 'function') {
      try {
        const mem = await performance.measureUserAgentSpecificMemory();
        return typeof mem?.bytes === 'number';
      } catch {
        return false;
      }
    }
    return false;
  });

  const samples = [];
  const snapshotPaths = [];

  async function takeCdpSnapshot(cycleNum, label) {
    const diagDir = path.join(tempUserData, 'Diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });
    const snapFile = path.join(diagDir, `soak-snapshot-cycle-${cycleNum}-${label}.heapsnapshot`);
    const stream = fs.createWriteStream(snapFile);

    const onChunk = (params) => {
      stream.write(params.chunk);
    };

    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await new Promise((r) => stream.end(r));
    snapshotPaths.push(snapFile);
    return snapFile;
  }

  for (let c = 1; c <= cycles; c++) {
    // 1. Load model with cache disabled for soak testing
    await page.evaluate(async () => {
      if (window.__cadViewport) {
        await window.__cadViewport.loadModelFromAsset('aeroshell-asset://models/cube.glb', false);
      }
    });

    // 2. Render 10 frames
    const startFrame = await page.evaluate(() => window.__cadViewport?.getMetrics().frame || 0);
    const targetFrame = startFrame + 10;
    const t0Frames = Date.now();
    while (Date.now() - t0Frames < 5000) {
      const curFrame = await page.evaluate(() => window.__cadViewport?.getMetrics().frame || 0);
      if (curFrame >= targetFrame) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // 3. Remove model & dispose
    await page.evaluate(() => {
      if (window.__cadViewport) {
        window.__cadViewport.setActiveModel(null);
      }
    });

    // 4. CDP collect garbage twice
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');

    // 5. Settle 300 ms
    await new Promise((r) => setTimeout(r, SOAK_CONFIG.settleMs));

    // Capture snapshot at cycle 6 (first post-warmup cycle) if requested or on failure
    if (c === warmup + 1 && leak !== 'none') {
      await takeCdpSnapshot(c, 'post-warmup');
    }

    // 6. Sample signals
    const heapUsage = await cdp.send('Runtime.getHeapUsage');
    let domCounters = { nodes: 0, jsEventListeners: 0 };
    try {
      domCounters = await cdp.send('Memory.getDOMCounters');
    } catch {}

    const appMetrics = await app.evaluate(({ app: eApp }) => eApp.getAppMetrics());
    const rendererProc = appMetrics.find((m) => m.type === 'Tab');
    const gpuProc = appMetrics.find((m) => m.type === 'GPU');

    const viewportMetrics = await page.evaluate(() => window.__cadViewport?.getMetrics());

    // Native PDH GPU process metrics (null-tolerant)
    let pdhUsageBytes = null;
    if (gpuProc?.pid) {
      const gpuCounters = await app.evaluate(async ({}, gPid) => {
        try {
          const getNative = global.__getNativeAddon;
          if (!getNative) return null;
          const native = getNative();
          if (!native) return null;
          const c = await native.getGpuCounters([gPid]);
          const p = c?.processes?.find((proc) => proc.pid === gPid);
          return p ? p.dedicatedUsageMB * 1024 * 1024 : null;
        } catch {
          return null;
        }
      }, gpuProc.pid);
      pdhUsageBytes = gpuCounters;
    }

    let uaBytes = null;
    if (uaMemorySupported) {
      uaBytes = await page.evaluate(async () => {
        try {
          const res = await performance.measureUserAgentSpecificMemory();
          return res.bytes;
        } catch {
          return null;
        }
      });
    }

    const sample = {
      cycle: c,
      timestamp: new Date().toISOString(),
      signals: {
        rendererJsHeapBytes: heapUsage.usedSize ?? heapUsage.jsHeapUsedSize ?? 0,
        rendererPrivateBytes: (rendererProc?.memory?.workingSetSize || 0) * 1024,
        gpuPrivateBytes: (gpuProc?.memory?.workingSetSize || 0) * 1024,
        pdhGpuDedicatedBytes: pdhUsageBytes,
        geometries: viewportMetrics?.geometries || 0,
        textures: viewportMetrics?.textures || 0,
        domNodes: domCounters.nodes || 0,
        domListeners: domCounters.jsEventListeners || 0,
        userAgentMemoryBytes: uaBytes,
      },
    };

    samples.push(sample);

    if (!options.quiet && !isQuiet && (c % 10 === 0 || c === cycles)) {
      console.log(`[soak] Cycle ${c}/${cycles}: JS Heap=${(sample.signals.rendererJsHeapBytes / 1024).toFixed(1)} KB, Geometries=${sample.signals.geometries}, Textures=${sample.signals.textures}`);
    }
  }

  // Collect environment block
  const versions = await app.evaluate(() => ({
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
  }));

  const cpus = os.cpus();
  const envBlock = {
    platform: process.platform,
    arch: process.arch,
    windowsBuild: os.release(),
    cpu: cpus.length ? cpus[0].model : 'Unknown',
    totalRamMB: Math.round(os.totalmem() / (1024 * 1024)),
    gpuAdapter: 'DXGI Hardware Adapter',
    ...versions,
  };

  // Evaluate post-warmup cycles
  const postWarmup = samples.filter((s) => s.cycle > warmup);
  const cycleNumbers = postWarmup.map((s) => s.cycle);

  const signalKeys = [
    { key: 'rendererJsHeapBytes', tol: SOAK_CONFIG.tolerances.rendererJsHeapBytes },
    { key: 'rendererPrivateBytes', tol: SOAK_CONFIG.tolerances.rendererPrivateBytes },
    { key: 'gpuPrivateBytes', tol: SOAK_CONFIG.tolerances.gpuPrivateBytes },
    { key: 'pdhGpuDedicatedBytes', tol: SOAK_CONFIG.tolerances.pdhGpuDedicatedBytes },
    { key: 'geometries', tol: SOAK_CONFIG.tolerances.geometries },
    { key: 'textures', tol: SOAK_CONFIG.tolerances.textures },
    { key: 'domNodes', tol: SOAK_CONFIG.tolerances.domNodes },
    { key: 'domListeners', tol: SOAK_CONFIG.tolerances.domListeners },
  ];

  const regressions = {};
  const failedSignals = [];

  for (const item of signalKeys) {
    const values = postWarmup.map((s) => s.signals[item.key] || 0);
    const result = evaluateSeries(cycleNumbers, values, item.tol);
    regressions[item.key] = {
      ...result,
      tolerance: item.tol,
    };
    if (result.isLeak) {
      failedSignals.push(item.key);
    }
  }

  const verdict = failedSignals.length === 0 ? 'PASS' : 'FAIL';

  // If FAIL, take final snapshot
  if (verdict === 'FAIL') {
    await takeCdpSnapshot(cycles, 'final-failure');
  }

  await app.close();

  // Clean up temp dir if PASS
  if (verdict === 'PASS') {
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {}
  }

  const totalDuration = Number(((Date.now() - startTime) / 1000).toFixed(1));

  const report = {
    timestamp: new Date().toISOString(),
    durationSeconds: totalDuration,
    totalCycles: cycles,
    warmupCycles: warmup,
    environment: envBlock,
    regressions,
    verdict,
    failedSignals,
    heapSnapshotPaths: snapshotPaths,
    measureUserAgentSpecificMemorySupported: uaMemorySupported,
  };

  // Validate output against Zod schema
  const validatedReport = SoakReportSchema.parse(report);

  // Write report JSON
  const reportPath = path.join(reportsDir, `soak-${dateStr}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(validatedReport, null, 2), 'utf8');

  // Write short summary markdown
  const summaryMdPath = path.join(reportsDir, `soak-${dateStr}.md`);
  const mdSummary = [
    `# Soak Test Report: ${verdict}`,
    `- **Date**: ${validatedReport.timestamp}`,
    `- **Cycles**: ${cycles} (Warmup: ${warmup})`,
    `- **Duration**: ${totalDuration}s`,
    `- **Verdict**: ${verdict} ${verdict === 'FAIL' ? `(Failed Signals: ${failedSignals.join(', ')})` : ''}`,
    `- **UserAgentMemory API Supported**: ${uaMemorySupported}`,
    '',
    '| Signal | OLS Slope | Theil-Sen | 95% CI Lower | 95% CI Upper | Tolerance | Leak? |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(regressions).map(([k, v]) =>
      `| \`${k}\` | ${v.slope} | ${v.theilSenSlope} | ${v.lowerCI95} | ${v.upperCI95} | ${v.tolerance} | **${v.isLeak ? 'LEAK' : 'OK'}** |`
    ),
    ...(snapshotPaths.length > 0 ? ['', '### Captured Diagnostic Heap Snapshots', ...snapshotPaths.map((p) => `- \`${p}\``)] : []),
  ].join('\n');

  fs.writeFileSync(summaryMdPath, mdSummary, 'utf8');

  if (!options.quiet && !isQuiet) {
    console.log(`\n[soak] Soak run complete in ${totalDuration}s: ${verdict}`);
    console.log(`[soak] Report: ${reportPath}`);
    console.log(`[soak] Summary: ${summaryMdPath}`);
  }

  return { report: validatedReport, reportPath, summaryMdPath };
}

// Direct CLI invocation
if (process.argv[1] && process.argv[1].endsWith('soak-runner.mjs')) {
  runSoakHarness().then(({ report }) => {
    process.exit(report.verdict === 'PASS' ? 0 : 1);
  }).catch((err) => {
    console.error('[soak] Fatal error:', err);
    process.exit(1);
  });
}
