import { BrowserWindow, ipcMain, app, contentTracing } from 'electron';
import * as v8 from 'node:v8';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  Channels,
  Telemetry,
  SnapshotRequest,
  CaptureContentTracingRequest,
  CaptureContentTracingResponse,
} from '../shared/ipc-contract';
import { assertTrusted, handleCaptureHeapSnapshot, handleCaptureContentTracing } from './ipc-guards';

function loadNativeAddon() {
  const devPath = path.resolve(__dirname, '../../build/Release/aero_win_bridge.node');
  if (fs.existsSync(devPath)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(devPath);
  }
  const unpackedPath = path.join(
    app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
    'build',
    'Release',
    'aero_win_bridge.node'
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(unpackedPath);
}

// Lazy load addon handle
let nativeAddon: any = null;
function getNative() {
  if (!nativeAddon) {
    nativeAddon = loadNativeAddon();
  }
  return nativeAddon;
}


let activeGpuDevice: { vendorId?: number; deviceId?: number } | undefined = undefined;

function resolveActiveGpu(info: any): { vendorId: number; deviceId: number } | undefined {
  const devices = (info as { gpuDevice?: Array<{ vendorId: number; deviceId: number; active?: boolean }> })?.gpuDevice || [];
  let device = devices.find((d) => d.active);
  if (!device) {
    if (process.env.AEROSHELL_TEST_SOFTWARE_GL === '1') {
      device = devices.find((d) => d.vendorId === 5140 || d.vendorId === 0x1ae0) || { vendorId: 0x1ae0, deviceId: 0xc0de };
    } else {
      device = devices.find((d) => d.vendorId !== 5140) || devices[0];
    }
  }
  if (device && typeof device.vendorId === 'number' && typeof device.deviceId === 'number') {
    return { vendorId: device.vendorId, deviceId: device.deviceId };
  }
  return undefined;
}

export function fetchGpuInfoAfterReady(): void {
  Promise.race([
    app.getGPUInfo('basic'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GPUInfo timeout')), 2000)),
  ])
    .then((info: any) => {
      const active = resolveActiveGpu(info);
      if (active) {
        activeGpuDevice = active;
      }
    })
    .catch((err) => {
      console.warn('[ipc] getGPUInfo failed or timed out:', err?.message);
    });
}


export function getNativeAddon(): any {
  return getNative();
}

export function getActiveGpuDevice(): { vendorId?: number; deviceId?: number } | undefined {
  return activeGpuDevice;
}

async function captureRendererHeapSnapshotCdp(win: BrowserWindow, targetFile: string): Promise<string> {
  const dbg = win.webContents.debugger;
  let attachedByUs = false;

  if (!dbg.isAttached()) {
    dbg.attach('1.3');
    attachedByUs = true;
  }

  const writeStream = fs.createWriteStream(targetFile, { flags: 'w', encoding: 'utf8' });

  const onMessage = (_evt: any, method: string, params: any) => {
    if (method === 'HeapProfiler.addHeapSnapshotChunk' && params?.chunk) {
      writeStream.write(params.chunk);
    }
  };

  dbg.on('message', onMessage);

  try {
    await dbg.sendCommand('HeapProfiler.enable');
    await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: true,
    });
  } finally {
    dbg.off('message', onMessage);
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => {
        if (err) reject(err); else resolve();
      });
    });
    if (attachedByUs && dbg.isAttached()) {
      try {
        dbg.detach();
      } catch {}
    }
  }

  return targetFile;
}

export async function collectTelemetry(): Promise<Telemetry> {
  const native = getNative();
  const heap = v8.getHeapStatistics();

  const metrics = app.getAppMetrics();
  const gpuProc = metrics.find((m) => m.type === 'GPU');
  const rendererProc = metrics.find((m) => m.type === 'Tab');

  const pids: number[] = [];
  if (gpuProc?.pid) pids.push(gpuProc.pid);
  if (rendererProc?.pid) pids.push(rendererProc.pid);

  let pdhCounters: any = null;
  try {
    if (native?.getGpuCounters && pids.length > 0) {
      pdhCounters = await native.getGpuCounters(pids);
    }
  } catch (err) {
    // Degrade gracefully on PDH failure
  }

  const rawGpus = native.getGpuHardwareInfo();
  const gpus = rawGpus.map((g: any) => {
    let adapterVramUsageMB: number | undefined = undefined;
    let gpuProcessVramMB: number | undefined = undefined;

    if (pdhCounters?.adapters && Array.isArray(pdhCounters.adapters)) {
      const match = pdhCounters.adapters.find((a: any) => a.luid === g.luid);
      if (match) {
        adapterVramUsageMB = match.dedicatedUsageMB;
      }
    }

    if (pdhCounters?.processes && Array.isArray(pdhCounters.processes) && gpuProc?.pid) {
      const match = pdhCounters.processes.find((p: any) => p.pid === gpuProc.pid);
      if (match) {
        gpuProcessVramMB = match.dedicatedUsageMB;
      }
    }

    return {
      index: g.index,
      name: g.name,
      vendorId: g.vendorId,
      deviceId: g.deviceId,
      isSoftware: g.isSoftware,
      dedicatedVramMB: g.dedicatedVramMB,
      sharedSystemMB: g.sharedSystemMB,
      vramBudgetMB: g.vramBudgetMB,
      luid: g.luid,
      // DEV-012: Map native vramUsageMB (calling-process VRAM) to mainProcessVramUsageMB
      mainProcessVramUsageMB: g.vramUsageMB,
      adapterVramUsageMB,
      gpuProcessVramMB,
    };
  });

  const system = native.getSystemMemoryInfo();
  const processes = metrics.map((m) => ({
    type: m.type,
    pid: m.pid,
    workingSetMB: m.memory.workingSetSize / 1024, // KB -> MB conversion
  }));

  const v8Stats = {
    usedHeapMB: heap.used_heap_size / (1024 * 1024),
    heapLimitMB: heap.heap_size_limit / (1024 * 1024),
  };

  let gpuFeatures: { webgl?: string; webgl2?: string; gpu_compositing?: string } | undefined = undefined;
  try {
    const status = app.getGPUFeatureStatus();
    gpuFeatures = {
      webgl: status.webgl,
      webgl2: status.webgl2,
      gpu_compositing: status.gpu_compositing,
    };
  } catch {}

  let activeGpu = activeGpuDevice;
  if (!activeGpu) {
    try {
      const info = await Promise.race([
        app.getGPUInfo('basic'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GPUInfo timeout')), 1000)),
      ]);
      const active = resolveActiveGpu(info);
      if (active) {
        activeGpu = active;
        activeGpuDevice = active;
      }
    } catch {}
  }

  return Telemetry.parse({
    gpus,
    system,
    processes,
    v8: v8Stats,
    gpuFeatures,
    activeGpu,
  });
}

export function registerIpc(win: BrowserWindow): void {
  ipcMain.handle(Channels.getTelemetry, async (event) => {
    assertTrusted(event, win);
    const telemetry = await collectTelemetry();
    return Telemetry.parse(telemetry);
  });

  ipcMain.handle(Channels.captureHeapSnapshot, async (event, rawPayload) => {
    assertTrusted(event, win);
    const { reason } = SnapshotRequest.parse(rawPayload);
    const native = getNative();

    return handleCaptureHeapSnapshot({
      userDataDir: app.getPath('userData'),
      reason,
      isDev: !app.isPackaged,
      readRegistry: (area, name) => native.readRegistry(area, name),
      writeHeapSnapshot: (filename) => captureRendererHeapSnapshotCdp(win, filename),
    });
  });

  ipcMain.handle(Channels.captureContentTracing, async (event, rawPayload) => {
    assertTrusted(event, win);
    const { durationSeconds } = CaptureContentTracingRequest.parse(rawPayload);
    const native = getNative();

    const res = await handleCaptureContentTracing({
      durationSeconds,
      userDataDir: app.getPath('userData'),
      isDev: !app.isPackaged,
      readRegistry: (area, name) => native.readRegistry(area, name),
      recordTracing: async (targetFile, duration) => {
        await contentTracing.startRecording({
          included_categories: ['*'],
          excluded_categories: ['*disabled-by-default*'],
        });
        await new Promise((resolve) => setTimeout(resolve, duration * 1000));
        return contentTracing.stopRecording(targetFile);
      },
    });

    return CaptureContentTracingResponse.parse(res);
  });
}
