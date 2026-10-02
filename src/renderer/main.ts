import { CadViewport } from './cad-viewport';
import { Telemetry, PressureEvent } from '../shared/ipc-contract';

// Declare aeroPlatform bridge interface
interface AeroPlatformBridge {
  getTelemetry: () => Promise<Telemetry>;
  captureHeapSnapshot: (reason: string) => Promise<{ file: string }>;
  onMemoryPressure: (cb: (e: PressureEvent) => void) => () => void;
}

declare global {
  interface Window {
    aeroPlatform?: AeroPlatformBridge;
    __cadViewport?: CadViewport;
    __workerOk?: boolean;
    __evictCount?: number;
  }
}

// 1. Acquire DOM elements
const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
const banner = document.getElementById('context-loss-banner');
const hudGpu = document.getElementById('hud-gpu');
const hudVramTotal = document.getElementById('hud-vram-total');
const hudVramBudget = document.getElementById('hud-vram-budget');
const hudFps = document.getElementById('hud-fps');
const hudFrameTime = document.getElementById('hud-frame-time');
const hudMetrics = document.getElementById('hud-metrics');
const hudGpuWarning = document.getElementById('hud-gpu-warning');
const hudPressure = document.getElementById('hud-pressure');

// 2. Initialize CadViewport
const viewport = new CadViewport(canvas, banner);
window.__cadViewport = viewport;
window.__evictCount = 0;

// Controller hook for CRITICAL memory pressure
viewport.onEvictOptionalCaches = () => {
  window.__evictCount = (window.__evictCount ?? 0) + 1;
  console.warn('[renderer] Evicting optional caches under CRITICAL memory pressure.');
};

// 3. Prove worker-src works under COEP using parse-worker with transferable ArrayBuffer
async function testWorkerCOEP(): Promise<void> {
  try {
    const testBuf = new ArrayBuffer(64);
    const worker = new Worker('./parse-worker.js');
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data?.status === 'PARSED') {
          window.__workerOk = true;
          resolve();
        } else {
          reject(new Error('Unexpected worker response'));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ buffer: testBuf }, [testBuf]);
    });
  } catch (err) {
    console.warn('[renderer] Worker COEP verification failed:', err);
  }
}
void testWorkerCOEP();

// 4. Memory pressure listener
if (window.aeroPlatform) {
  window.aeroPlatform.onMemoryPressure((event: PressureEvent) => {
    viewport.setPressure(event.severity);
    if (hudPressure) {
      if (event.severity === 'WARN') {
        hudPressure.textContent = `PRESSURE: WARN (${event.reasons.join(', ')})`;
        hudPressure.classList.remove('hidden', 'pressure-critical');
        hudPressure.classList.add('pressure-warn');
      } else if (event.severity === 'CRITICAL') {
        hudPressure.textContent = `PRESSURE: CRITICAL (${event.reasons.join(', ')})`;
        hudPressure.classList.remove('hidden', 'pressure-warn');
        hudPressure.classList.add('pressure-critical');
      }
    }
  });
}

// 5. Telemetry & GPU truth check
async function updateTelemetry(): Promise<void> {
  if (!window.aeroPlatform) return;
  try {
    const t = await window.aeroPlatform.getTelemetry();
    const highPerfGpu = t.gpus.find((g) => !g.isSoftware) || t.gpus[0];

    if (hudGpu) {
      hudGpu.textContent = `GPU: ${highPerfGpu ? highPerfGpu.name : 'Unknown'}`;
    }
    if (hudVramTotal) {
      hudVramTotal.textContent = `VRAM total: ${highPerfGpu ? highPerfGpu.dedicatedVramMB + ' MB' : 'N/A'}`;
    }
    if (hudVramBudget) {
      hudVramBudget.textContent = `VRAM budget (OS): ${highPerfGpu?.vramBudgetMB !== undefined ? Math.round(highPerfGpu.vramBudgetMB) + ' MB' : 'N/A'}`;
    }


    // GPU truth check:
    // Warn if WebGL is not hardware-enabled or the active device IDs differ from the high-performance DXGI adapter.
    // Compare numeric IDs, not names.
    let warnReason: string | null = null;
    const isHardwareWebgl = t.gpuFeatures?.webgl === 'enabled' || t.gpuFeatures?.webgl === 'enabled_readback';

    if (t.gpuFeatures && !isHardwareWebgl) {
      warnReason = `WebGL is not hardware-enabled (${t.gpuFeatures.webgl || 'unknown'})`;
    } else if (
      t.activeGpu?.vendorId !== undefined &&
      t.activeGpu?.deviceId !== undefined &&
      highPerfGpu?.vendorId !== undefined &&
      highPerfGpu?.deviceId !== undefined
    ) {
      if (t.activeGpu.vendorId !== highPerfGpu.vendorId || t.activeGpu.deviceId !== highPerfGpu.deviceId) {
        warnReason = `GPU device mismatch (Active: 0x${t.activeGpu.vendorId.toString(16)}:0x${t.activeGpu.deviceId.toString(16)} vs DXGI: 0x${highPerfGpu.vendorId.toString(16)}:0x${highPerfGpu.deviceId.toString(16)})`;
      }
    } else if (highPerfGpu?.isSoftware) {
      warnReason = 'Active graphics adapter is software-emulated';
    }


    if (hudGpuWarning) {
      if (warnReason) {
        hudGpuWarning.textContent = `WARNING: ${warnReason}`;
        hudGpuWarning.classList.remove('hidden');
      } else {
        hudGpuWarning.textContent = '';
        hudGpuWarning.classList.add('hidden');
      }
    }
  } catch (err) {
    console.warn('[renderer] Failed to fetch telemetry:', err);
  }
}

void updateTelemetry();
setInterval(updateTelemetry, 2000);

// 6. Real-time HUD frame timing & renderer metrics (strictly textContent updates)
function updateMetricsHud(): void {
  const m = viewport.getMetrics();
  if (hudFps) {
    hudFps.textContent = `FPS: ${m.fps}`;
  }
  if (hudFrameTime) {
    hudFrameTime.textContent = `Frame time: ${m.frameTimeP50.toFixed(1)} ms (p50) / ${m.frameTimeP95.toFixed(1)} ms (p95)`;
  }
  if (hudMetrics) {
    hudMetrics.textContent = `Draw calls: ${m.drawCalls} | Triangles: ${m.triangles} | Geometries: ${m.geometries} | Textures: ${m.textures}`;
  }
}

setInterval(updateMetricsHud, 100);
