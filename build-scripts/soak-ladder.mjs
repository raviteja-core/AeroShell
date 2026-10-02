import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSoakHarness } from './soak-runner.mjs';
import { wilsonConfidenceInterval } from '../dist-test/soak/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const docsSampleDir = path.join(rootDir, 'docs', 'samples');

async function main() {
  console.log('[soak-ladder] Starting Soak Leak Ladder & Statistical Benchmark...');
  fs.mkdirSync(docsSampleDir, { recursive: true });

  const cycles = 20; // Fast cycles for statistical repetitions
  const results = {
    clean: { total: 10, detected: 0, signals: {} },
    jsHeap: { total: 10, detected: 0, signals: {} },
    gpu: { total: 10, detected: 0, signals: {} },
    dom: { total: 10, detected: 0, signals: {} },
    sizeLadder: {},
  };

  // 1. Clean runs (x10) to measure false positive rate
  console.log('\n--- 1. Evaluating Clean Runs (x10) for False Positive Rate ---');
  for (let i = 1; i <= 10; i++) {
    const { report } = await runSoakHarness({ cycles, leak: 'none', quiet: true });
    if (report.verdict === 'FAIL') {
      results.clean.detected++;
      report.failedSignals.forEach((s) => {
        results.clean.signals[s] = (results.clean.signals[s] || 0) + 1;
      });
    }
    process.stdout.write(`.`);
  }
  const cleanFpRate = wilsonConfidenceInterval(results.clean.detected, results.clean.total);
  console.log(`\nClean false positives: ${results.clean.detected}/10 (Wilson 95% CI: [${cleanFpRate[0]}, ${cleanFpRate[1]}])`);

  // 2. JS Heap leak runs (x10 at 500 KB/cycle)
  console.log('\n--- 2. Evaluating JS Heap Leak Runs (x10 at 500 KB/cycle) ---');
  for (let i = 1; i <= 10; i++) {
    const { report } = await runSoakHarness({ cycles, leak: 'jsHeap:500', quiet: true });
    if (report.verdict === 'FAIL') {
      results.jsHeap.detected++;
      report.failedSignals.forEach((s) => {
        results.jsHeap.signals[s] = (results.jsHeap.signals[s] || 0) + 1;
      });
    }
    process.stdout.write(`.`);
  }
  const jsHeapCi = wilsonConfidenceInterval(results.jsHeap.detected, results.jsHeap.total);
  console.log(`\nJS Heap detected: ${results.jsHeap.detected}/10 (Wilson 95% CI: [${jsHeapCi[0]}, ${jsHeapCi[1]}])`);
  console.log(`Signals catching JS heap:`, JSON.stringify(results.jsHeap.signals));

  // 3. GPU leak runs (x10, skip geometry/texture dispose)
  console.log('\n--- 3. Evaluating GPU Leak Runs (x10, skipped geometry/texture dispose) ---');
  for (let i = 1; i <= 10; i++) {
    const { report } = await runSoakHarness({ cycles, leak: 'gpu', quiet: true });
    if (report.verdict === 'FAIL') {
      results.gpu.detected++;
      report.failedSignals.forEach((s) => {
        results.gpu.signals[s] = (results.gpu.signals[s] || 0) + 1;
      });
    }
    process.stdout.write(`.`);
  }
  const gpuCi = wilsonConfidenceInterval(results.gpu.detected, results.gpu.total);
  console.log(`\nGPU leak detected: ${results.gpu.detected}/10 (Wilson 95% CI: [${gpuCi[0]}, ${gpuCi[1]}])`);
  console.log(`Signals catching GPU leak:`, JSON.stringify(results.gpu.signals));

  // 4. DOM / Event Listener leak runs (x10)
  console.log('\n--- 4. Evaluating DOM / Listener Leak Runs (x10) ---');
  for (let i = 1; i <= 10; i++) {
    const { report } = await runSoakHarness({ cycles, leak: 'dom', quiet: true });
    if (report.verdict === 'FAIL') {
      results.dom.detected++;
      report.failedSignals.forEach((s) => {
        results.dom.signals[s] = (results.dom.signals[s] || 0) + 1;
      });
    }
    process.stdout.write(`.`);
  }
  const domCi = wilsonConfidenceInterval(results.dom.detected, results.dom.total);
  console.log(`\nDOM leak detected: ${results.dom.detected}/10 (Wilson 95% CI: [${domCi[0]}, ${domCi[1]}])`);
  console.log(`Signals catching DOM leak:`, JSON.stringify(results.dom.signals));

  // 5. Size ladder (50, 100, 250, 500, 1000 KB/cycle) to determine detection floor
  console.log('\n--- 5. Evaluating JS Heap Size Ladder (50, 100, 250, 500, 1000 KB/cycle) ---');
  const ladderSizes = [50, 100, 250, 500, 1000];
  let detectionFloorKB = null;

  for (const size of ladderSizes) {
    let hits = 0;
    const reps = 3;
    for (let r = 0; r < reps; r++) {
      const { report } = await runSoakHarness({ cycles, leak: `jsHeap:${size}`, quiet: true });
      if (report.verdict === 'FAIL' && report.failedSignals.includes('rendererJsHeapBytes')) {
        hits++;
      }
    }
    const rate = hits / reps;
    results.sizeLadder[size] = { hits, reps, rate };
    console.log(`Size ${size} KB/cycle: ${hits}/${reps} detections (${(rate * 100).toFixed(0)}%)`);
    if (rate >= 0.66 && detectionFloorKB === null) {
      detectionFloorKB = size;
    }
  }

  console.log(`\n[soak-ladder] Empirical JS heap leak detection floor: ${detectionFloorKB} KB/cycle.`);

  // Write committed sample into docs/samples/soak-sample.json
  const sampleReport = await runSoakHarness({ cycles: 30, leak: 'none', quiet: true });
  fs.copyFileSync(sampleReport.reportPath, path.join(docsSampleDir, 'soak-sample.json'));
  console.log(`[soak-ladder] Committed sample saved to: docs/samples/soak-sample.json`);

  const summary = {
    date: new Date().toISOString(),
    cleanFalsePositives: {
      count: `${results.clean.detected}/${results.clean.total}`,
      wilson95CI: cleanFpRate,
    },
    jsHeapLeak: {
      count: `${results.jsHeap.detected}/${results.jsHeap.total}`,
      wilson95CI: jsHeapCi,
      signals: results.jsHeap.signals,
    },
    gpuLeak: {
      count: `${results.gpu.detected}/${results.gpu.total}`,
      wilson95CI: gpuCi,
      signals: results.gpu.signals,
    },
    domLeak: {
      count: `${results.dom.detected}/${results.dom.total}`,
      wilson95CI: domCi,
      signals: results.dom.signals,
    },
    detectionFloorKB,
    sizeLadder: results.sizeLadder,
  };

  const ladderReportPath = path.join(rootDir, 'reports', 'soak-ladder-summary.json');
  fs.writeFileSync(ladderReportPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[soak-ladder] Summary written to: ${ladderReportPath}`);
}

main().catch((err) => {
  console.error('[soak-ladder] Error:', err);
  process.exit(1);
});
